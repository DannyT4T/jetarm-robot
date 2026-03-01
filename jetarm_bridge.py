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
from http.server import HTTPServer, BaseHTTPRequestHandler

import rclpy
from rclpy.node import Node
from rclpy.executors import MultiThreadedExecutor
from rclpy.callback_groups import ReentrantCallbackGroup

from ros_robot_controller_msgs.msg import ServosPosition as BusServosPosition
from ros_robot_controller_msgs.msg import ServoPosition as BusServoPosition
from servo_controller_msgs.msg import ServosPosition, ServoPosition
from ros_robot_controller_msgs.msg import BuzzerState
from kinematics_msgs.srv import SetRobotPose, SetJointValue, GetRobotPose
from kinematics.kinematics_control import set_pose_target

# Global reference to the ROS node
node = None

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

    def move_servos(self, positions, duration=1000):
        """Move servos via bus (direct hardware control)."""
        msg = BusServosPosition()
        msg.duration = float(duration)
        for p in positions:
            sp = BusServoPosition()
            sp.id = int(p['id'])
            sp.position = int(max(0, min(1000, p['position'])))
            msg.position.append(sp)
        self.bus_servo_pub.publish(msg)
        return True

    def move_to_xyz(self, x, y, z, pitch=-90, duration=1500):
        """Move using inverse kinematics."""
        if not self.ik_client.wait_for_service(timeout_sec=2.0):
            return None
        req = set_pose_target([x, y, z], pitch, [-90.0, 90.0], 1.0)
        req.duration = float(duration)
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
                duration = body.get('duration', 1000)
                node.move_servos(positions, duration)
                result = {'success': True, 'message': f'Moved {len(positions)} servos ({duration}ms)'}

            elif action == 'move_servo':
                sid = body.get('servo_id', 1)
                pos = body.get('position', 500)
                dur = body.get('duration', 1000)
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
                else:
                    result = {'success': False, 'message': 'IK solution not found'}

            elif action == 'home':
                dur = body.get('duration', 1500)
                positions = [{'id': i, 'position': 500} for i in [1,2,3,4,5,10]]
                node.move_servos(positions, dur)
                result = {'success': True, 'message': f'Home ({dur}ms)'}

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

            elif action == 'ping':
                result = {'success': True, 'message': 'pong', 'timestamp': time.time()}

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
