#!/bin/bash
# Master Launch Script for JetArm
# Optimized for USB 2.0 Bandwidth

source /opt/ros/humble/setup.bash
source /home/danny/JetArm/install/setup.bash
source /home/danny/orbbec_v1_ws/install/setup.bash 2>/dev/null || true

export need_compile=True
export CHASSIS_TYPE=None
export CAMERA_TYPE=GEMINI
export ROBOT_TYPE=JetArm
export FASTRTPS_DEFAULT_PROFILES_FILE=/home/danny/disable_shm.xml

pkill -9 -f camera_bridge.py || true
pkill -9 -f depth_colorizer.py || true
pkill -9 -f ros_robot_controller || true
pkill -9 -f servo_controller || true
pkill -9 -f kinematics || true
pkill -9 -f joystick_control || true
pkill -9 -f rosbridge || true
pkill -9 -f web_video_server || true
pkill -9 -f camera_container || true
sleep 1

echo '>>> Optimizing USB Subsystem...'
# Increase USB memory for high-bandwidth streams
echo 1024 | sudo -S <<< "091302" tee /sys/module/usbcore/parameters/usbfs_memory_mb || true
# Disable autosuspend
echo -1 | sudo -S <<< "091302" tee /sys/module/usbcore/parameters/autosuspend || true

echo '>>> Starting ROS Bridge & Video Server...'
ros2 launch rosbridge_server rosbridge_websocket_launch.xml &
ros2 run web_video_server web_video_server &

# (Removed separate camera_bridge since V1 SDK handles both streams)
sleep 2

# Start the Orbbec Driver for BOTH Depth and RGB via v1 SDK
echo '>>> Starting Unified Depth/RGB Driver...'
ros2 launch orbbec_camera ob_camera.launch.py \
    camera_name:=depth_cam \
    depth_width:=320 depth_height:=200 depth_fps:=10 depth_format:=Y11 \
    color_width:=640 color_height:=480 color_fps:=15 color_format:=MJPG \
    enable_color:=true \
    enable_ir:=false \
    enable_heartbeat:=false &
sleep 5

# Start the Depth Colorizer (To make it visible on dashboard)
echo '>>> Starting Depth Colorizer...'
nohup python3 /home/danny/depth_colorizer.py > /home/danny/colorizer.log 2>&1 &
sleep 2

echo '>>> Starting Robot Drivers...'
ros2 launch ros_robot_controller ros_robot_controller.launch.py &
ros2 launch servo_controller servo_controller.launch.py &
ros2 launch kinematics kinematics_node.launch.py &
sleep 3

# Final Init
ros2 service call /ros_robot_controller/init_finish std_srvs/srv/Trigger '{}' || true
ros2 service call /controller_manager/init_finish std_srvs/srv/Trigger '{}' || true
ros2 service call /kinematics/init_finish std_srvs/srv/Trigger '{}' || true

echo '>>> Starting Joystick Controller...'
nohup ros2 run peripherals joystick_control > /home/danny/joystick_final.log 2>&1 &

echo '>>> SYSTEM FULLY INITIALIZED.'
