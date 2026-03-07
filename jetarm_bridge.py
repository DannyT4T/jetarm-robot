#!/usr/bin/env python3
"""
JetArm Control Bridge — persistent ROS2 node with HTTP API
Runs on the Jetson. Eliminates SSH + ros2 topic pub overhead.
Exposes a fast local HTTP endpoint for servo control.
"""
import json
import time
import math
import threading
import urllib.request
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler

# Add project root to path for spatial_calibration import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spatial_calibration import pixel_depth_to_arm_xyz, load_calibration
from action_memory import get_memory

import rclpy
from rclpy.node import Node
from rclpy.executors import MultiThreadedExecutor
from rclpy.callback_groups import ReentrantCallbackGroup

from ros_robot_controller_msgs.msg import ServosPosition as BusServosPosition
from ros_robot_controller_msgs.msg import ServoPosition as BusServoPosition
from ros_robot_controller_msgs.msg import SetBusServoState, BusServoState
from servo_controller_msgs.msg import ServosPosition, ServoPosition
from ros_robot_controller_msgs.msg import BuzzerState
from kinematics_msgs.srv import SetRobotPose, SetJointValue, GetRobotPose
from kinematics.kinematics_control import set_pose_target

# Global reference to the ROS node
node = None

# ═══════════════════════════════════════════════════════════════════════════════
# SAFETY LAYER — Hardware-level joint limits enforced on EVERY move command
# ═══════════════════════════════════════════════════════════════════════════════
SAFETY_LIMITS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'safety_limits.json')

# Default safety limits per servo — [min_position, max_position]
# These are enforced BEFORE any command reaches the hardware
DEFAULT_SAFETY_LIMITS = {
    1:  {'min': 0,   'max': 1000, 'name': 'Base rotation'},
    2:  {'min': 0,   'max': 1000, 'name': 'Shoulder'},
    3:  {'min': 0,   'max': 1000, 'name': 'Elbow'},
    4:  {'min': 0,   'max': 1000, 'name': 'Wrist pitch'},
    5:  {'min': 0,   'max': 1000, 'name': 'Wrist rotate'},
    10: {'min': 0,   'max': 1000, 'name': 'Gripper'},
}

# Max movement speed — limits duration to prevent jerky moves
MIN_DURATION_MS = 200    # Minimum movement duration
MAX_MOVE_PER_STEP = 500  # Max pulse change per command (safety)

# Safety event log
safety_log = []
MAX_SAFETY_LOG = 100

def load_safety_limits():
    """Load safety limits from file, fallback to defaults."""
    if os.path.exists(SAFETY_LIMITS_FILE):
        try:
            with open(SAFETY_LIMITS_FILE) as f:
                saved = json.load(f)
                limits = dict(DEFAULT_SAFETY_LIMITS)
                for k, v in saved.items():
                    sid = int(k)
                    if sid in limits:
                        limits[sid].update(v)
                return limits
        except:
            pass
    return dict(DEFAULT_SAFETY_LIMITS)

def save_safety_limits(limits):
    """Save safety limits to file."""
    serializable = {str(k): v for k, v in limits.items()}
    with open(SAFETY_LIMITS_FILE, 'w') as f:
        json.dump(serializable, f, indent=2)

def log_safety_event(event_type, message, servo_id=None, requested=None, clamped=None):
    """Log a safety event."""
    global safety_log
    entry = {
        'time': time.time(),
        'type': event_type,
        'message': message,
        'servo_id': servo_id,
    }
    if requested is not None:
        entry['requested'] = requested
    if clamped is not None:
        entry['clamped'] = clamped
    safety_log.append(entry)
    if len(safety_log) > MAX_SAFETY_LOG:
        safety_log = safety_log[-MAX_SAFETY_LOG:]
    print(f'  ⚠️ SAFETY: {message}')

def enforce_safety(positions, duration_ms):
    """Enforce safety limits on servo positions. Returns (safe_positions, safe_duration, warnings)."""
    limits = load_safety_limits()
    safe_positions = []
    warnings = []
    
    # Enforce minimum duration
    safe_duration = max(MIN_DURATION_MS, duration_ms)
    
    for p in positions:
        sid = int(p['id'])
        requested_pos = int(p['position'])
        
        if sid in limits:
            lim = limits[sid]
            clamped_pos = max(lim['min'], min(lim['max'], requested_pos))
            
            if clamped_pos != requested_pos:
                msg = f"Servo {sid} ({lim['name']}): {requested_pos} clamped to {clamped_pos} (limits: {lim['min']}-{lim['max']})"
                warnings.append(msg)
                log_safety_event('CLAMP', msg, servo_id=sid, requested=requested_pos, clamped=clamped_pos)
            
            safe_positions.append({'id': sid, 'position': clamped_pos})
        else:
            # Unknown servo — allow but warn
            clamped_pos = max(0, min(1000, requested_pos))
            safe_positions.append({'id': sid, 'position': clamped_pos})
    
    return safe_positions, safe_duration, warnings

# World state — unified view of robot + environment
world_state = {
    'servos': {},
    'gripper': 'unknown',
    'objects': [],
    'vision_fps': 0,
    'overhead_objects': [],
    'overhead_fps': 0,
    'last_action': None,
    'last_action_result': None,
    'last_action_time': 0,
    'timestamp': 0,
}

def update_world_state():
    """Update world state from all sources."""
    global world_state
    # Servo positions
    if node and node.servo_states:
        world_state['servos'] = {str(k): v['position'] for k, v in node.servo_states.items()}
        # Estimate gripper state from servo 10
        grip = node.servo_states.get(10, {}).get('position', 500)
        if grip < 200:
            world_state['gripper'] = 'closed'
        elif grip > 400:
            world_state['gripper'] = 'open'
        else:
            world_state['gripper'] = 'partial'
    
    # Arm camera YOLO (port 8889)
    try:
        req = urllib.request.Request('http://localhost:8889/state')
        with urllib.request.urlopen(req, timeout=0.5) as resp:
            vision = json.loads(resp.read())
            objects = vision.get('objects', [])
            # Enrich objects with arm XYZ from spatial calibration
            cal = load_calibration()
            for obj in objects:
                depth = obj.get('depth_mm', 0)
                if depth > 0:
                    px, py = obj['center_px']
                    spatial = pixel_depth_to_arm_xyz(px, py, depth, cal)
                    obj['arm_xyz'] = spatial
            world_state['objects'] = objects
            world_state['vision_fps'] = vision.get('fps', 0)
    except:
        pass  # YOLO not running
    
    # Overhead camera YOLO (port 8081)
    try:
        req = urllib.request.Request('http://localhost:8081/state')
        with urllib.request.urlopen(req, timeout=0.5) as resp:
            overhead = json.loads(resp.read())
            world_state['overhead_objects'] = overhead.get('objects', [])
            world_state['overhead_fps'] = overhead.get('fps', 0)
    except:
        pass  # Overhead camera not running
    
    world_state['timestamp'] = time.time()

class JetArmBridge(Node):
    def __init__(self):
        super().__init__('jetarm_bridge')
        cb = ReentrantCallbackGroup()
        
        # Publishers - persistent, no subscriber wait needed!
        self.bus_servo_pub = self.create_publisher(
            BusServosPosition, '/ros_robot_controller/bus_servo/set_position', 10)
        self.servo_pub = self.create_publisher(
            ServosPosition, '/servo_controller', 10)
        self.buzzer_pub = self.create_publisher(
            BuzzerState, '/ros_robot_controller/set_buzzer', 10)
        self.servo_state_pub = self.create_publisher(
            SetBusServoState, '/ros_robot_controller/bus_servo/set_state', 10)
        
        # Kinematics service clients
        self.ik_client = self.create_client(
            SetRobotPose, '/kinematics/set_pose_target', callback_group=cb)
        self.ik_smooth_client = self.create_client(
            SetRobotPose, '/kinematics/set_pose_target_smooth', callback_group=cb)
        self.fk_client = self.create_client(
            SetJointValue, '/kinematics/set_joint_value_target', callback_group=cb)
        self.get_pose_client = self.create_client(
            GetRobotPose, '/kinematics/get_current_pose', callback_group=cb)
        
        # Subscribe to servo states for reading positions
        self.servo_states = {}
        from servo_controller_msgs.msg import ServoStateList
        self.create_subscription(
            ServoStateList, '/controller_manager/servo_states',
            self._servo_state_cb, 10)
        
        self.get_logger().info('🤖 JetArm Bridge ready!')

    def _servo_state_cb(self, msg):
        for s in msg.servo_state:
            self.servo_states[s.id] = {
                'id': s.id, 'position': s.position,
                'goal': s.goal, 'voltage': s.voltage
            }

    def move_servos(self, positions, duration_ms=500):
        """Move servos via bus with SAFETY LIMITS enforced."""
        # ⚠️ SAFETY: Enforce limits before ANY command reaches hardware
        safe_positions, safe_duration, warnings = enforce_safety(positions, duration_ms)
        
        msg = BusServosPosition()
        msg.duration = float(safe_duration / 1000.0)  # Convert ms → seconds
        for p in safe_positions:
            sp = BusServoPosition()
            sp.id = int(p['id'])
            sp.position = int(p['position'])
            msg.position.append(sp)
        self.bus_servo_pub.publish(msg)
        return True, warnings

    def move_to_xyz(self, x, y, z, pitch=-90, duration=1500):
        """Move using inverse kinematics."""
        if not self.ik_client.wait_for_service(timeout_sec=2.0):
            return None
        req = set_pose_target([x, y, z], pitch, [-90.0, 90.0], 1.0)
        req.duration = float(duration / 1000.0)  # Convert ms → seconds
        future = self.ik_client.call_async(req)
        rclpy.spin_until_future_complete(self, future, timeout_sec=3.0)
        if future.done() and future.result():
            res = future.result()
            if res.pulse:
                # Move servos to IK solution
                positions = [{'id': i+1, 'position': int(p)} for i, p in enumerate(res.pulse)]
                self.move_servos(positions, duration)
                return list(res.pulse)
        return None

    def buzzer(self, freq=1000, on_time=0.2, off_time=0.1, repeat=1):
        msg = BuzzerState()
        msg.freq = int(freq)
        msg.on_time = float(on_time)
        msg.off_time = float(off_time)
        msg.repeat = int(repeat)
        self.buzzer_pub.publish(msg)

    def get_servo_states(self):
        return list(self.servo_states.values())


class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Silence HTTP logs

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        action = body.get('action', '')
        result = {'success': False, 'error': 'Unknown action'}

        try:
            if action == 'move_arm':
                positions = body.get('positions', [])
                duration = body.get('duration', 500)
                _, warnings = node.move_servos(positions, duration)
                msg = f'Moved {len(positions)} servos ({duration}ms)'
                if warnings:
                    msg += ' | Safety: ' + '; '.join(warnings)
                result = {'success': True, 'message': msg, 'warnings': warnings}
                world_state['last_action'] = f'move_arm({len(positions)} servos, {duration}ms)'
                world_state['last_action_result'] = 'success'
                world_state['last_action_time'] = time.time()

            elif action == 'move_servo':
                sid = body.get('servo_id', 1)
                pos = body.get('position', 500)
                dur = body.get('duration', 500)
                node.move_servos([{'id': sid, 'position': pos}], dur)
                result = {'success': True, 'message': f'Servo {sid} → {pos} ({dur}ms)'}

            elif action == 'move_to_xyz':
                x = body.get('x', 0.15)
                y = body.get('y', 0.0)
                z = body.get('z', 0.20)
                pitch = body.get('pitch', -90)
                dur = body.get('duration', 1500)
                pulses = node.move_to_xyz(x, y, z, pitch, dur)
                if pulses:
                    result = {'success': True, 'message': f'Moved to ({x},{y},{z})', 'pulses': pulses}
                    world_state['last_action'] = f'move_to_xyz({x},{y},{z})'
                    world_state['last_action_result'] = 'success'
                else:
                    result = {'success': False, 'message': 'IK solution not found'}
                    world_state['last_action'] = f'move_to_xyz({x},{y},{z})'
                    world_state['last_action_result'] = 'FAILED: IK not found'
                world_state['last_action_time'] = time.time()

            elif action == 'home':
                dur = body.get('duration', 500)
                positions = [{'id': i, 'position': 500} for i in [1,2,3,4,5,10]]
                node.move_servos(positions, dur)
                result = {'success': True, 'message': f'Home ({dur}ms)'}

            elif action == 'emergency_stop':
                # TRUE EMERGENCY STOP: Kill torque on ALL servos — arm goes completely limp
                # This is the safest approach: no movement, no torque, instant release.
                # Critical for safety if hair/clothing/fingers are caught.
                servo_ids = [1, 2, 3, 4, 5, 10]
                for sid in servo_ids:
                    msg = SetBusServoState()
                    servo = BusServoState()
                    servo.present_id = [1, sid]       # [flag=1, servo_id]
                    servo.enable_torque = [1, 0]      # [flag=1, value=0 (torque OFF)]
                    msg.state = [servo]
                    msg.duration = 0.0
                    node.servo_state_pub.publish(msg)
                log_safety_event('ESTOP', 'Emergency stop — ALL servo torque killed, arm is limp')
                result = {'success': True, 'message': '🛑 Emergency stop — all servo torque killed'}

            elif action == 'resume':
                # Resume from E-STOP: Re-enable torque on all servos
                servo_ids = [1, 2, 3, 4, 5, 10]
                for sid in servo_ids:
                    msg = SetBusServoState()
                    servo = BusServoState()
                    servo.present_id = [1, sid]
                    servo.enable_torque = [1, 1]      # [flag=1, value=1 (torque ON)]
                    msg.state = [servo]
                    msg.duration = 0.0
                    node.servo_state_pub.publish(msg)
                log_safety_event('RESUME', 'Torque re-enabled on all servos')
                result = {'success': True, 'message': '✅ Torque re-enabled — servos active'}

            elif action == 'read_servos':
                result = {'success': True, 'servos': node.get_servo_states()}

            elif action == 'buzzer':
                node.buzzer(
                    body.get('freq', 1000),
                    body.get('on_time', 0.2),
                    body.get('off_time', 0.1),
                    body.get('repeat', 1)
                )
                result = {'success': True, 'message': 'Buzzer played'}

            elif action == 'world_state':
                update_world_state()
                result = {'success': True, 'state': world_state}

            elif action == 'move_to_object':
                # Find object by class name, compute arm XYZ, move there
                target_class = body.get('class', '').lower()
                approach_height = body.get('approach_height', 0.03)  # 3cm above
                pitch = body.get('pitch', -90)
                dur = body.get('duration', 1500)
                gripper_action = body.get('gripper', None)  # 'open', 'close', or None
                
                # Get latest detections
                update_world_state()
                found = None
                for obj in world_state.get('objects', []):
                    if obj['class'].lower() == target_class and obj.get('arm_xyz'):
                        if obj['arm_xyz'].get('reachable'):
                            found = obj
                            break
                        elif found is None:
                            found = obj  # Keep unreachable as fallback
                
                if not found:
                    result = {'success': False, 'error': f'Object "{target_class}" not found in view'}
                elif not found.get('arm_xyz'):
                    result = {'success': False, 'error': f'No depth data for "{target_class}"'}
                else:
                    xyz = found['arm_xyz']
                    x, y, z = xyz['x'], xyz['y'], xyz['z'] + approach_height
                    
                    # Open gripper first if requested
                    if gripper_action == 'open':
                        node.move_servos([{'id': 10, 'position': 500}], 400)
                        time.sleep(0.5)
                    
                    # Move to object position
                    pulses = node.move_to_xyz(x, y, z, pitch, dur)
                    if pulses:
                        result = {
                            'success': True,
                            'message': f'Moved to {target_class} at ({x:.3f}, {y:.3f}, {z:.3f})',
                            'object': found['class'],
                            'arm_xyz': xyz,
                            'pulses': pulses,
                        }
                        world_state['last_action'] = f'move_to_object({target_class})'
                        world_state['last_action_result'] = 'success'
                        
                        # Close gripper after if requested
                        if gripper_action == 'close':
                            time.sleep(dur / 1000.0 + 0.3)
                            node.move_servos([{'id': 10, 'position': 150}], 500)
                    else:
                        result = {
                            'success': False,
                            'error': f'IK failed for {target_class} at ({x:.3f}, {y:.3f}, {z:.3f})',
                            'arm_xyz': xyz,
                        }
                        world_state['last_action'] = f'move_to_object({target_class})'
                        world_state['last_action_result'] = 'FAILED: IK not found'
                    world_state['last_action_time'] = time.time()

            elif action == 'ping':
                result = {'success': True, 'message': 'pong', 'timestamp': time.time()}

            elif action == 'safety_status':
                limits = load_safety_limits()
                result = {
                    'success': True,
                    'limits': {str(k): v for k, v in limits.items()},
                    'log': safety_log[-20:],
                    'total_events': len(safety_log),
                }

            elif action == 'set_safety_limits':
                limits = load_safety_limits()
                updates = body.get('limits', {})
                for k, v in updates.items():
                    sid = int(k)
                    if sid in limits:
                        if 'min' in v:
                            limits[sid]['min'] = int(v['min'])
                        if 'max' in v:
                            limits[sid]['max'] = int(v['max'])
                save_safety_limits(limits)
                log_safety_event('CONFIG', f'Safety limits updated: {json.dumps(updates)}')
                result = {'success': True, 'message': 'Safety limits updated', 'limits': {str(k): v for k, v in limits.items()}}

            elif action == 'memory_log':
                memory = get_memory()
                memory.log_action(
                    goal=body.get('goal', ''),
                    step=body.get('step', 0),
                    action_type=body.get('action_type', 'unknown'),
                    action_json=body.get('action_json', {}),
                    result=body.get('result', ''),
                    success=body.get('success', False),
                    scene_objects=body.get('scene_objects'),
                    servo_positions=body.get('servo_positions'),
                    gripper_state=body.get('gripper_state'),
                    notes=body.get('notes'),
                    session_id=body.get('session_id'),
                )
                result = {'success': True, 'message': 'Action logged to memory'}

            elif action == 'memory_context':
                memory = get_memory()
                goal = body.get('goal', '')
                context = memory.get_context_for_goal(goal)
                result = {'success': True, 'context': context}

            elif action == 'memory_stats':
                memory = get_memory()
                stats = memory.get_stats()
                result = {'success': True, 'stats': stats}

            elif action == 'memory_session_start':
                memory = get_memory()
                session_id = memory.start_session(body.get('goal', ''))
                result = {'success': True, 'session_id': session_id}

            elif action == 'memory_session_end':
                memory = get_memory()
                memory.end_session(
                    body.get('session_id', ''),
                    body.get('total_steps', 0),
                    body.get('success', False),
                    body.get('final_result', '')
                )
                result = {'success': True, 'message': 'Session ended'}

            elif action == 'memory_lesson':
                memory = get_memory()
                memory.add_lesson(
                    category=body.get('category', 'general'),
                    lesson=body.get('lesson', ''),
                    confidence=body.get('confidence', 0.5),
                    source_session=body.get('session_id'),
                )
                result = {'success': True, 'message': 'Lesson recorded'}

            elif action == 'memory_lessons':
                memory = get_memory()
                lessons = memory.get_lessons(
                    category=body.get('category'),
                    limit=body.get('limit', 10),
                )
                result = {'success': True, 'lessons': lessons}

            elif action == 'restart_overhead':
                import subprocess
                # Kill existing overhead_camera.py process
                subprocess.run(['pkill', '-f', 'overhead_camera.py'], capture_output=True)
                time.sleep(2)
                # Restart it in background
                subprocess.Popen(
                    ['python3', '/home/danny/overhead_camera.py'],
                    stdout=open('/tmp/overhead.log', 'w'),
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                time.sleep(3)
                # Verify it's back online
                try:
                    import urllib.request as urlreq
                    check = json.loads(urlreq.urlopen('http://localhost:8081/state', timeout=3).read())
                    result = {
                        'success': True,
                        'message': f"Overhead camera restarted — {check.get('fps', 0):.0f} FPS",
                        'fps': check.get('fps', 0),
                        'camera_name': check.get('camera_name', ''),
                    }
                except:
                    result = {'success': True, 'message': 'Overhead camera restart initiated (warming up...)'}

        except Exception as e:
            result = {'success': False, 'error': str(e)}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()


def main():
    global node
    rclpy.init()
    node = JetArmBridge()
    
    # Spin ROS in background
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    spin_thread = threading.Thread(target=executor.spin, daemon=True)
    spin_thread.start()
    
    # Start HTTP server
    port = 8888
    server = HTTPServer(('0.0.0.0', port), BridgeHandler)
    print(f'🤖 JetArm Bridge running on http://0.0.0.0:{port}')
    print(f'   Persistent publishers active — zero latency servo control')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
