import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image, CompressedImage
from cv_bridge import CvBridge
import cv2
import numpy as np
import time

class CameraBridge(Node):
    def __init__(self):
        super().__init__('camera_bridge')
        self.publisher_rgb = self.create_publisher(Image, '/depth_cam/rgb/image_raw', 5)
        self.publisher_depth = self.create_publisher(Image, '/depth_cam/depth/image_raw', 5)
        
        # High-speed GStreamer pipeline for Jetson (RGB Sensor)
        gst_pipeline = (
            "v4l2src device=/dev/video0 ! "
            "video/x-raw, width=640, height=480, framerate=30/1 ! "
            "videoconvert ! video/x-raw, format=BGR ! appsink"
        )
        
        self.cap_rgb = cv2.VideoCapture(gst_pipeline, cv2.CAP_GSTREAMER)
        
        # Orbbec Depth is usually on video1 but needs specific handling, 
        # for now let's try to get RGB at 30fps first
        self.bridge = CvBridge()
        self.timer = self.create_timer(1.0/30, self.timer_callback)
        self.get_logger().info('GStreamer Optimized Camera Bridge Started (30 FPS)')

    def timer_callback(self):
        ret, frame = self.cap_rgb.read()
        if ret:
            # Drop frames if we are behind to maintain real-time feel
            msg = self.bridge.cv2_to_imgmsg(frame, encoding='bgr8')
            msg.header.stamp = self.get_clock().now().to_msg()
            self.publisher_rgb.publish(msg)

def main(args=None):
    rclpy.init(args=args)
    node = CameraBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()

if __name__ == '__main__':
    main()
