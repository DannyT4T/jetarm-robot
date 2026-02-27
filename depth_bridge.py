#!/usr/bin/env python3
"""
Depth Bridge — Direct Orbbec SDK → ROS2

Bypasses the broken orbbec_camera ROS2 node (which hangs at libuvc on JetPack 6)
and instead uses pyorbbecsdk to talk directly to the Gemini depth sensor.

Publishes:
  /depth_cam/depth/image_raw   (16UC1 raw depth in mm)
  /depth_cam/depth/color_map   (BGR8 JET colorized depth for dashboard)
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from cv_bridge import CvBridge
import cv2
import numpy as np
import time
import sys

try:
    from pyorbbecsdk import Pipeline, Config, OBSensorType, OBFormat
    from pyorbbecsdk import OBError
except ImportError:
    print("ERROR: pyorbbecsdk not installed. Run:")
    print("  pip3 install https://github.com/orbbec/pyorbbecsdk/releases/download/v2.0.10/pyorbbecsdk-2.0.10-cp310-cp310-linux_aarch64.whl")
    sys.exit(1)


class DepthBridge(Node):
    def __init__(self):
        super().__init__('depth_bridge')

        # Publishers
        self.pub_raw = self.create_publisher(Image, '/depth_cam/depth/image_raw', 5)
        self.pub_color = self.create_publisher(Image, '/depth_cam/depth/color_map', 5)
        self.bridge = CvBridge()

        # Initialize Orbbec pipeline
        self.pipeline = None
        self.get_logger().info('Depth Bridge: Initializing Orbbec SDK...')

        try:
            self.pipeline = Pipeline()
            config = Config()

            # Try to find and configure the depth sensor
            profile_list = self.pipeline.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
            if profile_list is None or profile_list.get_count() == 0:
                self.get_logger().error('No depth profiles found!')
                return

            # Log available profiles
            self.get_logger().info(f'Found {profile_list.get_count()} depth profiles')

            # Try to find a low-bandwidth profile that works on USB 2.0
            # Prefer 320x240 or smallest available
            best_profile = None
            for i in range(profile_list.get_count()):
                try:
                    p = profile_list.get_video_stream_profile(i)
                    self.get_logger().info(
                        f'  Profile {i}: {p.get_width()}x{p.get_height()} @ {p.get_fps()}fps format={p.get_format()}'
                    )
                    # Pick smallest resolution that's reasonable
                    if best_profile is None:
                        best_profile = p
                    elif p.get_width() * p.get_height() < best_profile.get_width() * best_profile.get_height():
                        best_profile = p
                    elif (p.get_width() * p.get_height() == best_profile.get_width() * best_profile.get_height()
                          and p.get_fps() < best_profile.get_fps()):
                        best_profile = p
                except Exception as e:
                    self.get_logger().warn(f'  Profile {i}: error - {e}')

            if best_profile:
                self.get_logger().info(
                    f'Selected: {best_profile.get_width()}x{best_profile.get_height()} '
                    f'@ {best_profile.get_fps()}fps'
                )
                config.enable_stream(best_profile)
            else:
                self.get_logger().error('Could not select a depth profile')
                return

            self.pipeline.start(config)
            self.get_logger().info('Depth Bridge: Pipeline started! Publishing depth data...')

            # Timer to grab frames at ~10 fps
            self.timer = self.create_timer(1.0 / 10, self.grab_frame)
            self.frame_count = 0

        except Exception as e:
            self.get_logger().error(f'Failed to initialize Orbbec pipeline: {e}')
            self.pipeline = None

    def grab_frame(self):
        if self.pipeline is None:
            return

        try:
            frames = self.pipeline.wait_for_frames(100)  # 100ms timeout
            if frames is None:
                return

            depth_frame = frames.get_depth_frame()
            if depth_frame is None:
                return

            # Convert to numpy array
            width = depth_frame.get_width()
            height = depth_frame.get_height()
            data = np.frombuffer(depth_frame.get_data(), dtype=np.uint16)
            depth_image = data.reshape((height, width))

            stamp = self.get_clock().now().to_msg()

            # Publish raw depth (16UC1)
            raw_msg = self.bridge.cv2_to_imgmsg(depth_image, encoding='16UC1')
            raw_msg.header.stamp = stamp
            raw_msg.header.frame_id = 'depth_cam_depth_frame'
            self.pub_raw.publish(raw_msg)

            # Colorize and publish (BGR8)
            depth_adj = cv2.convertScaleAbs(depth_image, alpha=0.05)
            color_map = cv2.applyColorMap(depth_adj, cv2.COLORMAP_JET)
            color_msg = self.bridge.cv2_to_imgmsg(color_map, encoding='bgr8')
            color_msg.header.stamp = stamp
            color_msg.header.frame_id = 'depth_cam_depth_frame'
            self.pub_color.publish(color_msg)

            self.frame_count += 1
            if self.frame_count % 50 == 0:
                self.get_logger().info(f'Published {self.frame_count} depth frames ({width}x{height})')

        except Exception as e:
            self.get_logger().warn(f'Frame grab error: {e}')

    def destroy_node(self):
        if self.pipeline:
            try:
                self.pipeline.stop()
            except:
                pass
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = DepthBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
