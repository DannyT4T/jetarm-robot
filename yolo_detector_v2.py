#!/usr/bin/env python3
"""
YOLO Object Detector v2 — TensorRT Accelerated + Continuous Vision
═══════════════════════════════════════════════════════════════════
Runs YOLOv8n with TensorRT FP16 optimization for 100+ FPS on Jetson Orin Nano.
Auto-exports .engine file on first run, then uses it for all subsequent runs.

Subscribes to:
  /depth_cam/color/image_raw   (RGB frames)
  /depth_cam/depth/image_raw   (Depth frames)

Publishes:
  /yolo/annotated/compressed   (Annotated JPEG stream)
  /yolo/detections             (JSON detection data — world state)

Also serves an HTTP endpoint on port 8889 for instant vision state queries,
so the AI bridge can call GET http://localhost:8889/state without ROS.

Usage:
  python3 yolo_detector_v2.py                    # Auto TensorRT export + run
  python3 yolo_detector_v2.py --export-only      # Just export, don't run detector
  python3 yolo_detector_v2.py --model yolov8s.pt # Use a different model
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
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────────────
DEFAULT_MODEL = 'yolov8n.pt'
ENGINE_DIR = Path.home() / 'yolo_engines'
CONFIDENCE = 0.45
IMG_SIZE = 320       # Smaller = faster. 320 is great for detection.
MAX_DET_FPS = 30     # Max detection rate (TensorRT can do 100+ but no need)
HTTP_PORT = 8889     # Vision state HTTP server
JPEG_QUALITY = 60    # Annotated stream quality


def ensure_tensorrt_engine(model_name='yolov8n.pt', imgsz=320):
    """Export model to TensorRT engine if not already done. Returns engine path."""
    from ultralytics import YOLO

    ENGINE_DIR.mkdir(exist_ok=True)
    stem = Path(model_name).stem
    engine_path = ENGINE_DIR / f'{stem}_imgsz{imgsz}_fp16.engine'

    if engine_path.exists():
        print(f'✅ TensorRT engine found: {engine_path}')
        return str(engine_path)

    print(f'🔧 Exporting {model_name} to TensorRT FP16 (imgsz={imgsz})...')
    print(f'   This takes 2-5 minutes on first run. Subsequent runs use cached engine.')

    model = YOLO(model_name)
    export_path = model.export(
        format='engine',
        imgsz=imgsz,
        half=True,        # FP16
        device=0,
        workspace=4,      # 4GB workspace (fits Orin Nano 8GB)
        verbose=True,
    )

    # Move engine to our directory with descriptive name
    if export_path and os.path.exists(export_path):
        os.rename(export_path, str(engine_path))
        print(f'✅ Engine saved: {engine_path}')
    else:
        # ultralytics may save it with a different name
        auto_path = Path(model_name).with_suffix('.engine')
        if auto_path.exists():
            os.rename(str(auto_path), str(engine_path))
            print(f'✅ Engine saved: {engine_path}')
        else:
            print(f'⚠️ Engine export may have saved to: {export_path}')
            return export_path

    return str(engine_path)


class VisionStateServer(BaseHTTPRequestHandler):
    """Tiny HTTP server for instant vision state queries."""
    vision_state = {'objects': [], 'fps': 0, 'count': 0, 'timestamp': 0}

    def log_message(self, format, *args):
        pass  # Silence logs

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(VisionStateServer.vision_state).encode())


class YoloDetectorV2(Node):
    def __init__(self, engine_path):
        super().__init__('yolo_detector')

        self.detections = []
        self.last_frame = None
        self.last_depth = None
        self.frame_count = 0
        self.fps = 0.0
        self.last_fps_time = time.time()
        self.inference_ms = 0.0

        # Load TensorRT engine
        from ultralytics import YOLO
        self.get_logger().info(f'Loading TensorRT engine: {engine_path}')
        self.model = YOLO(engine_path, task='detect')

        # Warm up (first inference builds CUDA context)
        self.get_logger().info('Warming up TensorRT engine...')
        dummy = np.zeros((IMG_SIZE, IMG_SIZE, 3), dtype=np.uint8)
        for _ in range(3):
            self.model(dummy, verbose=False, imgsz=IMG_SIZE)
        self.get_logger().info('✅ TensorRT engine warm — ready for inference')

        # Subscribe to camera
        self.rgb_sub = self.create_subscription(
            Image, '/depth_cam/color/image_raw', self.rgb_callback, 1)
        self.depth_sub = self.create_subscription(
            Image, '/depth_cam/depth/image_raw', self.depth_callback, 1)

        # Publishers
        self.annotated_pub = self.create_publisher(
            CompressedImage, '/yolo/annotated/compressed', 1)
        self.detections_pub = self.create_publisher(
            String, '/yolo/detections', 1)

        # Detection timer — rate limited
        interval = 1.0 / max(1.0, MAX_DET_FPS)
        self.timer = self.create_timer(interval, self.run_detection)

        self.get_logger().info(
            f'🚀 YOLO v2 TensorRT started — up to {MAX_DET_FPS} FPS, '
            f'imgsz={IMG_SIZE}, conf={CONFIDENCE}'
        )

    @staticmethod
    def imgmsg_to_cv2(msg, target_encoding='bgr8'):
        """Manual image conversion — avoids cv_bridge dependency."""
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

        if msg.encoding == 'rgb8' and target_encoding == 'bgr8':
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        return img

    def depth_callback(self, msg):
        try:
            self.last_depth = self.imgmsg_to_cv2(msg, 'passthrough')
        except Exception:
            pass

    def rgb_callback(self, msg):
        try:
            self.last_frame = self.imgmsg_to_cv2(msg, 'bgr8')
        except Exception:
            pass

    def run_detection(self):
        if self.last_frame is None or self.model is None:
            return

        frame = self.last_frame  # Don't copy — TensorRT is fast enough

        # Run inference with TensorRT
        t0 = time.perf_counter()
        results = self.model(frame, verbose=False, conf=CONFIDENCE, imgsz=IMG_SIZE)
        self.inference_ms = (time.perf_counter() - t0) * 1000

        detections = []
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

        # FPS counter
        self.frame_count += 1
        now = time.time()
        elapsed = now - self.last_fps_time
        if elapsed >= 1.0:
            self.fps = self.frame_count / elapsed
            self.frame_count = 0
            self.last_fps_time = now

        # Update shared vision state (for HTTP server)
        vision_state = {
            'timestamp': round(now, 3),
            'fps': round(self.fps, 1),
            'inference_ms': round(self.inference_ms, 1),
            'count': len(detections),
            'objects': detections,
        }
        VisionStateServer.vision_state = vision_state
        self.detections = detections

        # Publish annotated image
        annotated = results[0].plot()
        label = f'TRT {self.fps:.0f}FPS {self.inference_ms:.0f}ms | {len(detections)} obj'
        cv2.putText(annotated, label, (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        _, buf = cv2.imencode('.jpg', annotated, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        comp_msg = CompressedImage()
        comp_msg.header.stamp = self.get_clock().now().to_msg()
        comp_msg.format = 'jpeg'
        comp_msg.data = buf.tobytes()
        self.annotated_pub.publish(comp_msg)

        # Publish detections JSON
        det_msg = String()
        det_msg.data = json.dumps(vision_state)
        self.detections_pub.publish(det_msg)


def main():
    import argparse
    parser = argparse.ArgumentParser(description='YOLO v2 TensorRT Detector')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='Model to use (e.g. yolov8n.pt)')
    parser.add_argument('--export-only', action='store_true', help='Only export TensorRT engine, then exit')
    parser.add_argument('--imgsz', type=int, default=IMG_SIZE, help='Inference image size')
    args = parser.parse_args()

    # Step 1: Ensure TensorRT engine exists
    print('═' * 60)
    print('  YOLO Detector v2 — TensorRT Accelerated')
    print('═' * 60)
    engine_path = ensure_tensorrt_engine(args.model, args.imgsz)

    if args.export_only:
        print(f'\n✅ Engine exported to: {engine_path}')
        print('   Run without --export-only to start the detector.')
        return

    # Step 2: Start HTTP vision state server in background
    print(f'\n🌐 Starting vision state HTTP server on port {HTTP_PORT}...')
    http_server = HTTPServer(('0.0.0.0', HTTP_PORT), VisionStateServer)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()
    print(f'   GET http://localhost:{HTTP_PORT}/state for instant vision queries')

    # Step 3: Start ROS2 detector node
    rclpy.init()
    node = YoloDetectorV2(engine_path)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        print('\nShutting down YOLO Detector v2')
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
