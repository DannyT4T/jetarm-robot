#!/usr/bin/env python3
"""
YOLO Object Detector for JetArm
─────────────────────────────────
Subscribes to RGB + Depth camera, runs YOLOv8 inference,
publishes annotated feed and detection data via ROS 2.

Topics:
  IN:  /depth_cam/color/image_raw   (RGB frames)
  IN:  /depth_cam/depth/image_raw   (Depth frames)
  OUT: /yolo/annotated/compressed   (Annotated JPEG stream)
  OUT: /yolo/detections             (JSON detection data)

Install: pip install ultralytics
Model:   yolov8n.pt (auto-downloads on first run, ~6MB)
"""
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image, CompressedImage
from std_msgs.msg import String
import cv2
import numpy as np
import json
import time
import os

class YoloDetector(Node):
    def __init__(self):
        super().__init__('yolo_detector')

        self.model = None
        self.detections = []
        self.last_frame = None
        self.last_depth = None
        self.enabled = True
        self.frame_count = 0
        self.fps = 0.0
        self.last_fps_time = time.time()

        # Parameters
        self.declare_parameter('confidence', 0.45)
        self.declare_parameter('model', 'yolov8n.pt')
        self.declare_parameter('max_fps', 8.0)
        self.declare_parameter('imgsz', 320)  # smaller = faster

        conf = self.get_parameter('confidence').value
        model_name = self.get_parameter('model').value
        max_fps = self.get_parameter('max_fps').value

        # Load YOLO model
        try:
            from ultralytics import YOLO
            self.get_logger().info(f'Loading YOLO model: {model_name}')
            self.model = YOLO(model_name)
            # Warm up with a dummy frame at target size
            imgsz = self.get_parameter('imgsz').value
            dummy = np.zeros((480, 640, 3), dtype=np.uint8)
            self.model(dummy, verbose=False, imgsz=imgsz, half=True)
            self.get_logger().info(f'YOLOv8 loaded — conf:{conf} imgsz:{imgsz} half:True')
        except ImportError:
            self.get_logger().error(
                'ultralytics not installed! Run: pip install ultralytics'
            )
            return
        except Exception as e:
            self.get_logger().error(f'Failed to load YOLO model: {e}')
            return

        # CV Bridge (manual — avoids cv_bridge dependency issues on Jetson)
        self.rgb_sub = self.create_subscription(
            Image, '/depth_cam/color/image_raw', self.rgb_callback, 5)
        self.depth_sub = self.create_subscription(
            Image, '/depth_cam/depth/image_raw', self.depth_callback, 5)

        # Publishers
        self.annotated_pub = self.create_publisher(
            CompressedImage, '/yolo/annotated/compressed', 5)
        self.detections_pub = self.create_publisher(
            String, '/yolo/detections', 5)

        # Timer for inference (rate-limited)
        interval = 1.0 / max(1.0, max_fps)
        self.timer = self.create_timer(interval, self.run_detection)

        self.get_logger().info(
            f'YOLO Detector started — {max_fps} FPS max, '
            f'publishing to /yolo/annotated and /yolo/detections'
        )

    # ── Image conversion (avoids cv_bridge) ──
    @staticmethod
    def imgmsg_to_cv2(msg, target_encoding='bgr8'):
        dtype = np.uint8
        if '16' in msg.encoding:
            dtype = np.uint16
        elif '32' in msg.encoding:
            dtype = np.float32

        channels = 1
        if 'rgb' in msg.encoding.lower() or 'bgr' in msg.encoding.lower():
            channels = 3
        elif 'rgba' in msg.encoding.lower() or 'bgra' in msg.encoding.lower():
            channels = 4

        img = np.frombuffer(msg.data, dtype=dtype)

        if channels > 1:
            img = img.reshape(msg.height, msg.width, channels)
        else:
            img = img.reshape(msg.height, msg.width)

        # Convert RGB → BGR if needed
        if msg.encoding == 'rgb8' and target_encoding == 'bgr8':
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

        return img

    def depth_callback(self, msg):
        try:
            self.last_depth = self.imgmsg_to_cv2(msg, 'passthrough')
        except Exception as e:
            self.get_logger().debug(f'Depth decode error: {e}')

    def rgb_callback(self, msg):
        try:
            self.last_frame = self.imgmsg_to_cv2(msg, 'bgr8')
        except Exception as e:
            self.get_logger().debug(f'RGB decode error: {e}')

    def run_detection(self):
        if self.last_frame is None or self.model is None or not self.enabled:
            return

        frame = self.last_frame.copy()
        conf_thresh = self.get_parameter('confidence').value
        imgsz = self.get_parameter('imgsz').value

        # Run YOLO — half precision + reduced resolution for speed
        results = self.model(frame, verbose=False, conf=conf_thresh, imgsz=imgsz, half=True)

        detections = []
        annotated = results[0].plot()

        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                cls_name = self.model.names[cls_id]
                conf = float(box.conf[0])
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].cpu().numpy()]
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                w, h = x2 - x1, y2 - y1

                # Get depth at object center
                depth_mm = 0
                if self.last_depth is not None:
                    dh, dw = self.last_depth.shape[:2]
                    fh, fw = frame.shape[:2]
                    dx = int(cx * dw / fw)
                    dy = int(cy * dh / fh)
                    dx = max(0, min(dx, dw - 1))
                    dy = max(0, min(dy, dh - 1))
                    # Average a small region for stability
                    region = self.last_depth[
                        max(0, dy-3):min(dh, dy+4),
                        max(0, dx-3):min(dw, dx+4)
                    ]
                    valid = region[region > 0]
                    if len(valid) > 0:
                        depth_mm = int(np.median(valid))

                detections.append({
                    'class': str(cls_name),
                    'confidence': round(float(conf), 3),
                    'bbox': [x1, y1, x2, y2],
                    'center_px': [int(cx), int(cy)],
                    'size_px': [int(w), int(h)],
                    'depth_mm': int(depth_mm),
                })

        # Draw FPS counter on annotated frame
        self.frame_count += 1
        now = time.time()
        elapsed = now - self.last_fps_time
        if elapsed >= 1.0:
            self.fps = self.frame_count / elapsed
            self.frame_count = 0
            self.last_fps_time = now

        cv2.putText(annotated, f'YOLO {self.fps:.1f} FPS | {len(detections)} obj',
                     (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        # Publish annotated image as compressed
        _, buf = cv2.imencode('.jpg', annotated, [cv2.IMWRITE_JPEG_QUALITY, 60])
        comp_msg = CompressedImage()
        comp_msg.header.stamp = self.get_clock().now().to_msg()
        comp_msg.format = 'jpeg'
        comp_msg.data = buf.tobytes()
        self.annotated_pub.publish(comp_msg)

        # Publish detections as JSON
        det_msg = String()
        det_msg.data = json.dumps({
            'timestamp': round(now, 3),
            'fps': round(self.fps, 1),
            'count': len(detections),
            'objects': detections,
        })
        self.detections_pub.publish(det_msg)

        self.detections = detections


def main():
    rclpy.init()
    node = YoloDetector()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
