#!/usr/bin/env python3
"""
Overhead Camera — Third-Person View + YOLO Detection
Captures from USB webcam (Logitech C922), runs TensorRT YOLO,
serves MJPEG stream + annotated stream + detection state via HTTP.

Ports:
  8081 — MJPEG streams + detection state
    /raw       — raw camera MJPEG stream
    /annotated — YOLO-annotated MJPEG stream
    /state     — JSON detection state (instant query)
"""
import cv2
import json
import time
import threading
import subprocess
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

# ─── Config ───────────────────────────────────────────────────────────
CAMERA_DEV = None  # Auto-detected below
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480
CAMERA_FPS = 30
HTTP_PORT = 8081
YOLO_CONF = 0.40
YOLO_IMGSZ = 320
ENGINE_DIR = Path.home() / "yolo_engines"


def auto_detect_camera():
    """Find the USB webcam device (skip Orbbec depth camera)."""
    import glob
    # Get all /dev/video* devices
    video_devs = sorted(glob.glob('/dev/video*'))
    for dev in video_devs:
        try:
            idx = int(dev.replace('/dev/video', ''))
            # Check camera name via v4l2
            result = subprocess.run(
                ['v4l2-ctl', '-d', dev, '--info'],
                capture_output=True, text=True, timeout=3
            )
            info = result.stdout.lower()
            # Skip Orbbec depth camera and metadata devices
            if 'orbbec' in info or 'depth' in info:
                continue
            # Check if it's an actual video capture device
            if 'video capture' in info:
                print(f"🔍 Found USB webcam: {dev}")
                return idx
        except Exception:
            continue
    # Fallback: try index 0
    print("⚠️  No USB webcam auto-detected, trying /dev/video0")
    return 0


# ─── Global state ─────────────────────────────────────────────────────
raw_frame = None
annotated_frame = None
frame_lock = threading.Lock()
camera_name = "Unknown Camera"
state = {
    "camera": "overhead",
    "camera_name": camera_name,
    "fps": 0,
    "inference_ms": 0,
    "objects": [],
    "timestamp": 0,
}
state_lock = threading.Lock()


def detect_camera_name(dev_index=0):
    """Detect the USB camera name from the system."""
    try:
        # Try v4l2-ctl first
        result = subprocess.run(
            ['v4l2-ctl', f'--device=/dev/video{dev_index}', '--info'],
            capture_output=True, text=True, timeout=3
        )
        for line in result.stdout.splitlines():
            if 'Card type' in line:
                name = line.split(':', 1)[1].strip()
                if name:
                    return name
    except Exception:
        pass
    
    try:
        # Fallback to /proc/bus/input/devices
        with open('/proc/bus/input/devices', 'r') as f:
            content = f.read()
        for block in content.split('\n\n'):
            if 'video' in block.lower() or 'camera' in block.lower() or 'cam' in block.lower():
                for line in block.splitlines():
                    if line.startswith('N: Name='):
                        name = line.split('"')[1] if '"' in line else line.split('=', 1)[1]
                        if 'touch' not in name.lower() and 'mouse' not in name.lower():
                            return name.strip()
    except Exception:
        pass
    
    try:
        # Fallback to lsusb
        result = subprocess.run(['lsusb'], capture_output=True, text=True, timeout=3)
        for line in result.stdout.splitlines():
            lower = line.lower()
            if 'cam' in lower or 'webcam' in lower or 'video' in lower:
                # Extract the name portion after ID xxxx:xxxx
                parts = line.split(' ', 6)
                if len(parts) >= 7:
                    return parts[6].strip()
    except Exception:
        pass
    
    return "USB Camera"


def load_yolo():
    """Load TensorRT YOLO model (reuses same engine as arm camera)."""
    try:
        from ultralytics import YOLO
        engine_path = ENGINE_DIR / f"yolov8n_imgsz{YOLO_IMGSZ}_fp16.engine"
        if engine_path.exists():
            print(f"✅ Loading cached TensorRT engine: {engine_path}")
            model = YOLO(str(engine_path), task='detect')
        else:
            print("🔧 No cached engine, using PyTorch model (slower)...")
            model = YOLO("yolov8n.pt")
        # Warm up
        dummy = np.zeros((YOLO_IMGSZ, YOLO_IMGSZ, 3), dtype=np.uint8)
        model.predict(dummy, imgsz=YOLO_IMGSZ, conf=YOLO_CONF, verbose=False)
        print("✅ YOLO model warm for overhead camera")
        return model
    except Exception as e:
        print(f"⚠️  YOLO not available: {e}")
        return None


# Global reference to YOLO model — set by background loader thread
yolo_model = None
yolo_model_lock = threading.Lock()


def yolo_loader_thread():
    """Load YOLO in background so camera can start streaming immediately."""
    global yolo_model
    print("🔧 Loading YOLO model in background (camera streaming raw in the meantime)...")
    model = load_yolo()
    with yolo_model_lock:
        yolo_model = model
    if model:
        print("🎯 YOLO ready — overhead detection now active")
    else:
        print("⚠️  YOLO failed to load — raw stream only")


def camera_loop():
    """Capture frames and optionally run YOLO detection once model is ready."""
    global raw_frame, annotated_frame, state

    cap = cv2.VideoCapture(CAMERA_DEV)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
    cap.set(cv2.CAP_PROP_FPS, CAMERA_FPS)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))

    if not cap.isOpened():
        print(f"❌ Cannot open {CAMERA_DEV}")
        return

    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"📷 Overhead camera opened: {actual_w}x{actual_h} — {camera_name}")

    fps_counter = 0
    fps_time = time.time()
    current_fps = 0.0

    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.1)
            continue

        # FPS tracking
        fps_counter += 1
        elapsed = time.time() - fps_time
        if elapsed >= 1.0:
            current_fps = fps_counter / elapsed
            fps_counter = 0
            fps_time = time.time()

        # Store raw frame
        with frame_lock:
            _, raw_jpg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            raw_frame = raw_jpg.tobytes()

        # Try to get YOLO model (may not be loaded yet)
        with yolo_model_lock:
            model = yolo_model

        # Run YOLO if available
        if model is not None:
            t0 = time.time()
            results = model.predict(frame, imgsz=YOLO_IMGSZ, conf=YOLO_CONF,
                                     verbose=False, half=True)
            inf_ms = (time.time() - t0) * 1000

            objects = []
            ann_frame = frame.copy()

            for r in results:
                for box in r.boxes:
                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    conf = float(box.conf[0])
                    cls = int(box.cls[0])
                    name = model.names[cls]
                    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

                    objects.append({
                        "class": name,
                        "confidence": round(conf, 3),
                        "bbox": [x1, y1, x2, y2],
                        "center_px": [cx, cy],
                        "size_px": [x2 - x1, y2 - y1],
                    })

                    # Draw bounding box
                    color = (0, 255, 128)
                    cv2.rectangle(ann_frame, (x1, y1), (x2, y2), color, 2)
                    label = f"{name} {conf:.0%}"
                    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                    cv2.rectangle(ann_frame, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
                    cv2.putText(ann_frame, label, (x1 + 2, y1 - 4),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

            # Add overlay text
            overlay = f"OVERHEAD | {current_fps:.0f} FPS | {inf_ms:.0f}ms | {len(objects)} obj"
            cv2.putText(ann_frame, overlay, (10, 25),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 128), 2)

            with frame_lock:
                _, ann_jpg = cv2.imencode('.jpg', ann_frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                annotated_frame = ann_jpg.tobytes()

            with state_lock:
                state = {
                    "camera": "overhead",
                    "camera_name": camera_name,
                    "fps": round(current_fps, 1),
                    "inference_ms": round(inf_ms, 1),
                    "objects": objects,
                    "timestamp": time.time(),
                }
        else:
            # No YOLO — just serve raw frame as annotated too
            with frame_lock:
                annotated_frame = raw_frame
            with state_lock:
                state = {
                    "camera": "overhead",
                    "camera_name": camera_name,
                    "fps": round(current_fps, 1),
                    "inference_ms": 0,
                    "objects": [],
                    "timestamp": time.time(),
                }

        # Throttle to ~15 FPS for YOLO processing
        time.sleep(0.033)


class OverheadHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        # Strip query params for matching (e.g. /annotated?t=123 → /annotated)
        path = self.path.split('?')[0]
        if path == '/raw':
            self._stream('raw')
        elif path == '/annotated':
            self._stream('annotated')
        elif path == '/state':
            self._json_state()
        elif path == '/snapshot':
            self._snapshot()
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b"""<html><body style='background:#000;color:#fff;font-family:monospace'>
                <h2>Overhead Camera (Logitech C922)</h2>
                <p><a href='/raw'>Raw MJPEG Stream</a></p>
                <p><a href='/annotated'>YOLO Annotated Stream</a></p>
                <p><a href='/state'>Detection State (JSON)</a></p>
                <p><a href='/snapshot'>Snapshot (JPEG)</a></p>
            </body></html>""")

    def _stream(self, stream_type):
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        try:
            while True:
                with frame_lock:
                    frame_data = annotated_frame if stream_type == 'annotated' else raw_frame
                if frame_data:
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n\r\n')
                    self.wfile.write(frame_data)
                    self.wfile.write(b'\r\n')
                time.sleep(0.066)  # ~15 FPS stream
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json_state(self):
        with state_lock:
            data = json.dumps(state)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data.encode())

    def _snapshot(self):
        with frame_lock:
            data = annotated_frame or raw_frame
        if data:
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(503)
            self.end_headers()

def main():
    print("=" * 60)
    print("  Overhead Camera — Third-Person YOLO Detection")
    print("=" * 60)

    # Auto-detect camera device
    global CAMERA_DEV, camera_name
    CAMERA_DEV = auto_detect_camera()
    camera_name = detect_camera_name(CAMERA_DEV)
    print(f"📷 Detected camera: {camera_name} (device index {CAMERA_DEV})")

    # Start HTTP server FIRST so dashboard can reach /state immediately
    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        allow_reuse_address = True
        daemon_threads = True
    server = ThreadingHTTPServer(('0.0.0.0', HTTP_PORT), OverheadHandler)
    print(f"🌐 Overhead camera HTTP server on port {HTTP_PORT}")
    print(f"   Raw stream:      http://0.0.0.0:{HTTP_PORT}/raw")
    print(f"   Annotated:       http://0.0.0.0:{HTTP_PORT}/annotated")
    print(f"   State JSON:      http://0.0.0.0:{HTTP_PORT}/state")
    print(f"   Snapshot:        http://0.0.0.0:{HTTP_PORT}/snapshot")

    # Start camera capture immediately (raw stream available right away)
    cam_thread = threading.Thread(target=camera_loop, daemon=True)
    cam_thread.start()

    # Load YOLO in background (detection starts once loaded)
    yolo_thread = threading.Thread(target=yolo_loader_thread, daemon=True)
    yolo_thread.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Overhead camera stopped")


if __name__ == '__main__':
    main()
