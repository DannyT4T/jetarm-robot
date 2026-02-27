#!/usr/bin/env python3
# encoding: utf-8
import os
import math
import time
import rclpy
import numpy as np
import pygame as pg
from enum import Enum
from rclpy.node import Node
from rclpy.executors import MultiThreadedExecutor
from rclpy.callback_groups import ReentrantCallbackGroup
from sensor_msgs.msg import Joy
from std_srvs.srv import Trigger
from chassis_msgs.msg import Mecanum
from sdk import common, buzzer, misc
import kinematics.transform as transform
from servo_controller import bus_servo_control, actions
from kinematics.kinematics_control import set_pose_target
from kinematics_msgs.srv import SetRobotPose, GetRobotPose
from servo_controller_msgs.msg import ServosPosition, ServoPosition, ServoStateList
from ros_robot_controller_msgs.msg import BuzzerState, GetBusServoCmd, MotorsState, MotorState

os.environ["SDL_VIDEODRIVER"] = "dummy"
pg.display.init()

# ─── CORRECTED ZD-V+ Button Map (verified by user test round 2) ──────────────
# pygame idx → physical button name
# 0  = Y (face, green)    6  = L2 (Left Trigger 2)
# 1  = B (face, red)      7  = R2 (Right Trigger 2)
# 2  = A (face, blue)     8  = SELECT
# 3  = X (face, pink)     9  = START
# 4  = L1 (Left Trigger)  10 = (unknown)
# 5  = R1 (Right Trigger) 11 = (unknown)
#                          12 = MODE
# D-Pad → not detected as buttons (may be on axes or hat)

AXES_MAP = ['lx', 'ly', 'rx', 'ry']
BUTTON_MAP = [
    'y',           # 0 - Y face (green)
    'b',           # 1 - B face (red)
    'a',           # 2 - A face (blue)
    'x',           # 3 - X face (pink)
    'l1',          # 4 - Left Trigger 1
    'r1',          # 5 - Right Trigger 1
    'l2',          # 6 - Left Trigger 2
    'r2',          # 7 - Right Trigger 2
    'select',      # 8 - SELECT
    'start',       # 9 - START
    'l3',          # 10 - Left Stick Click
    'r3',          # 11 - Right Stick Click
    'mode',        # 12 - MODE
]

class ButtonState(Enum):
    Normal = 0
    Pressed = 1
    Holding = 2
    Released = 3

class JoystickController(Node):
    def __init__(self, name):
        rclpy.init()
        super().__init__(name, allow_undeclared_parameters=True, automatically_declare_parameters_from_overrides=True)
        self.count = 0
        self.joy = None
        self.mode = 0  # 0: Manual, 1: Coordinate
        self.min_value = 0.1
        self.buzzer_pub = buzzer.BuzzerController()
        self.current_servo_position = np.array([500]*6) # 1,2,3,4,5,10
        self.servos_pub = self.create_publisher(ServosPosition, '/servo_controller', 1)
        self.joy_pub = self.create_publisher(Joy, '/joy', 5)
        
        try:
            self.chassis_type = os.environ['CHASSIS_TYPE']
        except:
            self.chassis_type = 'None'

        timer_cb_group = ReentrantCallbackGroup()
        self.get_current_pose_client = self.create_client(GetRobotPose, '/kinematics/get_current_pose', callback_group=timer_cb_group)
        self.kinematics_client = self.create_client(SetRobotPose, '/kinematics/set_pose_target', callback_group=timer_cb_group)
        
        self.create_subscription(ServoStateList, '/controller_manager/servo_states', self.servo_states_callback, 1)
        
        self.last_axes = {k: 0.0 for k in AXES_MAP}
        self.last_buttons = {k: 0 for k in BUTTON_MAP if k}
        
        self.update_timer = self.create_timer(0.05, self.joy_callback)
        
        # Proactively center the arm at startup
        bus_servo_control.set_servo_position(self.servos_pub, 1.0, ((1, 500), (2, 500), (3, 500), (4, 500), (5, 500), (10, 500)))
        self.get_logger().info('Joystick Control: ZD-V+ mapping active — L1/L2=Wrist, R1/R2=Gripper, Sticks=Arm')

    def servo_states_callback(self, msg):
        pos = []
        for s in msg.servo_state:
            pos.append(s.position)
        if len(pos) >= 6:
            self.current_servo_position = np.array(pos)

    def axes_callback(self, axes):
        lx, ly, rx, ry = axes['lx'], axes['ly'], axes['rx'], axes['ry']
        
        if self.mode == 0: # Manual Servo Mode
            # LX: Base (ID1)
            if abs(lx) > self.min_value:
                new_pos = int(self.current_servo_position[0] + lx * 15)
                bus_servo_control.set_servo_position(self.servos_pub, 0.04, ((1, new_pos),))
            # LY: Shoulder (ID2)
            if abs(ly) > self.min_value:
                new_pos = int(self.current_servo_position[1] + ly * 15)
                bus_servo_control.set_servo_position(self.servos_pub, 0.04, ((2, new_pos),))
            # RY: Elbow (ID3)
            if abs(ry) > self.min_value:
                new_pos = int(self.current_servo_position[2] + ry * 15)
                bus_servo_control.set_servo_position(self.servos_pub, 0.04, ((3, new_pos),))
            # RX: Wrist Pitch (ID4)
            if abs(rx) > self.min_value:
                new_pos = int(self.current_servo_position[3] + rx * 15)
                bus_servo_control.set_servo_position(self.servos_pub, 0.04, ((4, new_pos),))

    def l1_callback(self, state): # Wrist Rotate CCW
        if state in [ButtonState.Pressed, ButtonState.Holding]:
            new_pos = int(self.current_servo_position[4] + 25)
            bus_servo_control.set_servo_position(self.servos_pub, 0.05, ((5, new_pos),))

    def l2_callback(self, state): # Wrist Rotate CW
        if state in [ButtonState.Pressed, ButtonState.Holding]:
            new_pos = int(self.current_servo_position[4] - 25)
            bus_servo_control.set_servo_position(self.servos_pub, 0.05, ((5, new_pos),))

    def r1_callback(self, state): # Gripper Open
        if state in [ButtonState.Pressed, ButtonState.Holding]:
            new_pos = int(self.current_servo_position[5] + 35)
            new_pos = min(new_pos, 1000)
            bus_servo_control.set_servo_position(self.servos_pub, 0.05, ((10, new_pos),))

    def r2_callback(self, state): # Gripper Close
        if state in [ButtonState.Pressed, ButtonState.Holding]:
            new_pos = int(self.current_servo_position[5] - 35)
            new_pos = max(new_pos, 0)
            bus_servo_control.set_servo_position(self.servos_pub, 0.05, ((10, new_pos),))

    def start_callback(self, state):
        if state == ButtonState.Pressed:
            if self.last_buttons.get('select', 0): # Toggle Mode
                self.mode = 1 if self.mode == 0 else 0
                self.buzzer_pub.set_buzzer(1000, 0.1, 0.5, self.mode + 1)
                self.get_logger().info('Mode toggled to %d' % self.mode)
            else: # RESET ALL TO 500 (Start button only)
                self.get_logger().info('Start Button: Centering all servos to 500')
                bus_servo_control.set_servo_position(self.servos_pub, 1.2, ((1, 500), (2, 500), (3, 500), (4, 500), (5, 500), (10, 500)))

    def joy_callback(self):
        if not os.path.exists("/dev/input/js0"):
            self.joy = None
            return
        
        if self.joy is None:
            pg.joystick.init()
            if pg.joystick.get_count() > 0:
                self.joy = pg.joystick.Joystick(0)
                self.joy.init()
            else:
                return

        pg.event.pump()

        # Read all raw axes and buttons for /joy publishing
        num_axes = self.joy.get_numaxes()
        num_buttons = self.joy.get_numbuttons()
        raw_axes = [self.joy.get_axis(i) for i in range(num_axes)]
        raw_buttons = [float(self.joy.get_button(i)) for i in range(num_buttons)]

        # Read D-Pad hat (reports as hat, not buttons on ZD-V+)
        hat_x, hat_y = 0.0, 0.0
        if self.joy.get_numhats() > 0:
            hat_x, hat_y = self.joy.get_hat(0)  # (-1,0,1) for each axis

        # Publish Joy message for dashboard visualizer
        # axes[0-3] = sticks, axes[4] = hat_x (dpad L/R), axes[5] = hat_y (dpad U/D)
        joy_msg = Joy()
        joy_msg.header.stamp = self.get_clock().now().to_msg()
        joy_msg.axes = raw_axes + [float(hat_x), float(hat_y)]
        joy_msg.buttons = [int(b) for b in raw_buttons]
        self.joy_pub.publish(joy_msg)

        # Read first 4 axes for arm control
        try:
            # Standard PS2 mapping: 0=LX, 1=LY, 2=RX, 3=RY
            # Invert Y axes: -1 is UP in pygame but we want +pos for joint movement
            axes = {'lx': raw_axes[0], 'ly': -raw_axes[1], 'rx': raw_axes[2], 'ry': -raw_axes[3]}
            self.axes_callback(axes)
        except:
            pass

        # Read Buttons using corrected BUTTON_MAP
        for i in range(min(len(BUTTON_MAP), num_buttons)):
            btn_name = BUTTON_MAP[i]
            if not btn_name: continue
            val = self.joy.get_button(i)
            last_val = self.last_buttons.get(btn_name, 0)
            
            if val != last_val:
                state = ButtonState.Pressed if val else ButtonState.Released
            elif val:
                state = ButtonState.Holding
            else:
                state = ButtonState.Normal
            
            if state != ButtonState.Normal:
                callback = getattr(self, btn_name + '_callback', None)
                if callback: callback(state)
            
            self.last_buttons[btn_name] = val

def main():
    node = JoystickController('joystick_control')
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    executor.spin()
    node.destroy_node()

if __name__ == '__main__':
    main()
