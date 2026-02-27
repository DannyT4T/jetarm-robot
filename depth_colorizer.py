import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from cv_bridge import CvBridge
import cv2
import numpy as np

class DepthColorizer(Node):
    def __init__(self):
        super().__init__('depth_colorizer')
        self.bridge = CvBridge()
        self.subscription = self.create_subscription(
            Image,
            '/depth_cam/depth/image_raw',
            self.listener_callback,
            10)
        
        self.pub_jet = self.create_publisher(Image, '/depth_cam/depth/color_map/jet', 5)
        self.pub_gray = self.create_publisher(Image, '/depth_cam/depth/color_map/gray', 5)
        self.pub_plasma = self.create_publisher(Image, '/depth_cam/depth/color_map/plasma', 5)
        self.pub_raw = self.create_publisher(Image, '/depth_cam/depth/color_map/raw', 5)
        self.get_logger().info('Depth Colorizer Node Started (Jet, Gray, Plasma, Raw)')

    def listener_callback(self, msg):
        try:
            depth_image = self.bridge.imgmsg_to_cv2(msg, desired_encoding='passthrough')
            
            # --- RAW LEGACY MODE ---
            depth_adj_raw = cv2.convertScaleAbs(depth_image, alpha=0.05)
            cmap_raw = cv2.applyColorMap(depth_adj_raw, cv2.COLORMAP_JET)

            # --- SENSITIVITY FIX MODES ---
            # To get more contrast/sensitivity, we scale 0 -> 3000mm (3 meters)
            # We clip values above 3000 so they just become solid color at the end of the scale
            depth_clipped = np.clip(depth_image, 0, 3000)
            
            # Map 0-3000 to 0-255 (alpha = 255/3000)
            depth_adj = cv2.convertScaleAbs(depth_clipped, alpha=0.085)
            
            # Identify invalid pixels (0 depth usually means too close or out of structural light range)
            invalid_mask = (depth_image == 0)
            
            # Generate color maps
            cmap_jet = cv2.applyColorMap(depth_adj, cv2.COLORMAP_JET)
            cmap_plasma = cv2.applyColorMap(depth_adj, cv2.COLORMAP_PLASMA)
            cmap_gray = cv2.cvtColor(depth_adj, cv2.COLOR_GRAY2BGR)
            
            # Black out the invalid pixels so they aren't painted blue
            cmap_jet[invalid_mask] = [0, 0, 0]
            cmap_plasma[invalid_mask] = [0, 0, 0]
            cmap_gray[invalid_mask] = [0, 0, 0]
            
            # Publish all 4
            msg_raw = self.bridge.cv2_to_imgmsg(cmap_raw, encoding='bgr8')
            msg_raw.header = msg.header
            self.pub_raw.publish(msg_raw)

            msg_jet = self.bridge.cv2_to_imgmsg(cmap_jet, encoding='bgr8')
            msg_jet.header = msg.header
            self.pub_jet.publish(msg_jet)
            
            msg_gray = self.bridge.cv2_to_imgmsg(cmap_gray, encoding='bgr8')
            msg_gray.header = msg.header
            self.pub_gray.publish(msg_gray)

            msg_plasma = self.bridge.cv2_to_imgmsg(cmap_plasma, encoding='bgr8')
            msg_plasma.header = msg.header
            self.pub_plasma.publish(msg_plasma)
            
        except Exception as e:
            self.get_logger().error(f'Error processing depth: {e}')

def main(args=None):
    rclpy.init(args=args)
    node = DepthColorizer()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()

if __name__ == '__main__':
    main()
