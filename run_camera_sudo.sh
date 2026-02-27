#!/bin/bash
source /opt/ros/humble/setup.bash
source /home/danny/JetArm/install/setup.bash
export need_compile=True
export CAMERA_TYPE=GEMINI
export ROBOT_TYPE=JetArm
ros2 launch peripherals depth_camera.launch.py
