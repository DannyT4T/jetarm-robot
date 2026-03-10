#!/usr/bin/env python3
"""
SmolVLA Episode Recorder — Records demonstrations for training
Captures camera frames + joint states during joystick demonstrations.
Saves in LeRobot-compatible format.

Runs on Jetson alongside jetarm_bridge.py and camera_bridge.py.
HTTP API on port 8090 for dashboard control.

Cameras:
  camera1 = Orbbec depth cam (wrist-mounted) via camera_bridge HTTP
  camera2 = Overhead USB cam via overhead_camera HTTP
"""

import json
import os
import time
import threading
import cv2
import numpy as np
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime
import urllib.request

# ─── Config ───────────────────────────────────────────────────────────────────
JETSON_IP = "127.0.0.1"
BRIDGE_PORT = 8080          # jetarm_bridge.py
RGB_STREAM_PORT = 8080      # camera_bridge.py (snapshot endpoint)
OVERHEAD_PORT = 8081        # overhead_camera.py
RECORD_FPS = 10             # Frames per second to record
IMAGE_SIZE = 256            # SmolVLA expects 256x256
HTTP_PORT = 8090            # This server's port

# Episode storage
EPISODES_DIR = Path.home() / "smolvla_episodes"
EPISODES_DIR.mkdir(exist_ok=True)

# ─── Global State ─────────────────────────────────────────────────────────────
recorder_state = {
    "status": "idle",       # idle, recording, saving
    "task_name": "pick_object",
    "current_episode": 0,
    "frame_count": 0,
    "start_time": 0,
    "elapsed": 0.0,
    "fps": 0.0,
    "total_episodes": 0,
    "disk_usage_mb": 0,
    "cameras_available": [],
    "error": None,
}
state_lock = threading.Lock()

# Current recording buffers
recording_frames = []       # List of frame dicts
recording_lock = threading.Lock()
record_thread = None
stop_event = threading.Event()


# ─── Camera Capture ───────────────────────────────────────────────────────────

def capture_camera(name, url):
    """Capture a single frame from an HTTP camera endpoint."""
    try:
        req = urllib.request.urlopen(url, timeout=1)
        arr = np.frombuffer(req.read(), dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is not None:
            img = cv2.resize(img, (IMAGE_SIZE, IMAGE_SIZE))
            return img
    except Exception:
        pass
    return None


def capture_all_cameras():
    """Capture frames from all available cameras."""
    frames = {}

    # Camera 1: Orbbec depth cam (wrist-mounted) — via camera_bridge snapshot
    img1 = capture_camera("camera1", f"http://{JETSON_IP}:{RGB_STREAM_PORT}/snapshot")
    if img1 is not None:
        frames["observation.images.camera1"] = img1

    # Camera 2: Overhead USB cam
    img2 = capture_camera("camera2", f"http://{JETSON_IP}:{OVERHEAD_PORT}/snapshot")
    if img2 is not None:
        frames["observation.images.camera2"] = img2

    return frames


def get_joint_state():
    """Get current joint positions from jetarm_bridge."""
    try:
        req = urllib.request.Request(
            f"http://{JETSON_IP}:{BRIDGE_PORT}",
            data=json.dumps({"command": "get_state"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        res = urllib.request.urlopen(req, timeout=1)
        data = json.loads(res.read())
        servos = data.get("servos", {})
        # Extract joint positions in order: servo 6,5,4,3,2,1 (base to gripper)
        state = []
        for servo_id in [6, 5, 4, 3, 2, 1]:
            sid = str(servo_id)
            if sid in servos:
                state.append(servos[sid].get("position", 500))
            else:
                state.append(500)
        return state
    except Exception:
        return [500, 500, 500, 500, 500, 500]


def detect_cameras():
    """Check which cameras are available."""
    available = []
    if capture_camera("camera1", f"http://{JETSON_IP}:{RGB_STREAM_PORT}/snapshot") is not None:
        available.append("camera1 (Orbbec wrist)")
    if capture_camera("camera2", f"http://{JETSON_IP}:{OVERHEAD_PORT}/snapshot") is not None:
        available.append("camera2 (Overhead USB)")
    return available


# ─── Recording Logic ──────────────────────────────────────────────────────────

def recording_loop():
    """Main recording loop — captures frames at RECORD_FPS."""
    global recording_frames
    interval = 1.0 / RECORD_FPS
    frame_idx = 0

    while not stop_event.is_set():
        t0 = time.time()

        # Capture cameras + joint state simultaneously
        cameras = capture_all_cameras()
        joint_state = get_joint_state()

        frame_data = {
            "timestamp": time.time(),
            "frame_index": frame_idx,
            "observation.state": joint_state,
        }

        # Add camera images (stored as numpy arrays for now)
        for cam_key, img in cameras.items():
            frame_data[cam_key] = img

        with recording_lock:
            recording_frames.append(frame_data)

        frame_idx += 1

        # Update state
        with state_lock:
            recorder_state["frame_count"] = frame_idx
            recorder_state["elapsed"] = time.time() - recorder_state["start_time"]
            recorder_state["fps"] = frame_idx / max(recorder_state["elapsed"], 0.1)

        # Sleep to maintain FPS
        elapsed = time.time() - t0
        sleep_time = interval - elapsed
        if sleep_time > 0:
            stop_event.wait(sleep_time)


def start_recording(task_name="pick_object"):
    """Start recording a new episode."""
    global record_thread, recording_frames

    with state_lock:
        if recorder_state["status"] == "recording":
            return {"success": False, "error": "Already recording"}

    stop_event.clear()
    with recording_lock:
        recording_frames = []

    with state_lock:
        recorder_state["status"] = "recording"
        recorder_state["task_name"] = task_name
        recorder_state["frame_count"] = 0
        recorder_state["start_time"] = time.time()
        recorder_state["elapsed"] = 0
        recorder_state["fps"] = 0
        recorder_state["error"] = None

    record_thread = threading.Thread(target=recording_loop, daemon=True)
    record_thread.start()

    return {"success": True, "message": f"Recording started for task: {task_name}"}


def stop_recording():
    """Stop recording and save the episode."""
    global record_thread

    with state_lock:
        if recorder_state["status"] != "recording":
            return {"success": False, "error": "Not recording"}
        recorder_state["status"] = "saving"

    stop_event.set()
    if record_thread:
        record_thread.join(timeout=5)

    # Save episode
    with recording_lock:
        frames = list(recording_frames)
        recording_frames = []

    if len(frames) < 5:
        with state_lock:
            recorder_state["status"] = "idle"
        return {"success": False, "error": f"Too few frames ({len(frames)}), discarded"}

    # Save to disk
    episode_id = int(time.time())
    task_name = recorder_state["task_name"]
    episode_dir = EPISODES_DIR / f"episode_{episode_id}"
    episode_dir.mkdir(exist_ok=True)

    # Save camera images as JPEGs
    for cam_key in ["observation.images.camera1", "observation.images.camera2", "observation.images.camera3"]:
        cam_dir = episode_dir / cam_key.replace(".", "_")
        cam_dir.mkdir(exist_ok=True)

    states = []
    actions = []

    for i, frame in enumerate(frames):
        # Save state
        states.append(frame["observation.state"])

        # Compute action (next state - current state, or zero for last frame)
        if i < len(frames) - 1:
            next_state = frames[i + 1]["observation.state"]
            action = [n - c for c, n in zip(frame["observation.state"], next_state)]
        else:
            action = [0] * 6
        actions.append(action)

        # Save camera images
        for cam_key in ["observation.images.camera1", "observation.images.camera2", "observation.images.camera3"]:
            if cam_key in frame:
                cam_dir = episode_dir / cam_key.replace(".", "_")
                img_path = cam_dir / f"frame_{i:05d}.jpg"
                cv2.imwrite(str(img_path), frame[cam_key], [cv2.IMWRITE_JPEG_QUALITY, 95])

    # Save metadata
    metadata = {
        "episode_id": episode_id,
        "task": task_name,
        "source": "joystick",
        "timestamp": datetime.now().isoformat(),
        "num_frames": len(frames),
        "fps": RECORD_FPS,
        "duration_s": round(frames[-1]["timestamp"] - frames[0]["timestamp"], 2),
        "cameras": list(set(
            cam for frame in frames
            for cam in frame.keys()
            if cam.startswith("observation.images")
        )),
        "state_dim": 6,
        "action_dim": 6,
    }

    # Save states and actions as JSON
    episode_data = {
        "metadata": metadata,
        "states": states,
        "actions": actions,
    }
    with open(episode_dir / "episode.json", "w") as f:
        json.dump(episode_data, f, indent=2)

    # Update global state
    total = len(list(EPISODES_DIR.glob("episode_*")))
    disk = sum(f.stat().st_size for f in EPISODES_DIR.rglob("*") if f.is_file()) / (1024 * 1024)

    with state_lock:
        recorder_state["status"] = "idle"
        recorder_state["current_episode"] = episode_id
        recorder_state["total_episodes"] = total
        recorder_state["disk_usage_mb"] = round(disk, 1)

    return {
        "success": True,
        "episode_id": episode_id,
        "frames": len(frames),
        "duration": metadata["duration_s"],
        "cameras": metadata["cameras"],
    }


def discard_recording():
    """Discard current recording without saving."""
    global record_thread

    stop_event.set()
    if record_thread:
        record_thread.join(timeout=5)

    with recording_lock:
        recording_frames.clear()

    with state_lock:
        recorder_state["status"] = "idle"
        recorder_state["frame_count"] = 0

    return {"success": True, "message": "Recording discarded"}


def list_episodes():
    """List all saved episodes."""
    episodes = []
    for ep_dir in sorted(EPISODES_DIR.glob("episode_*"), reverse=True):
        meta_file = ep_dir / "episode.json"
        if meta_file.exists():
            with open(meta_file) as f:
                data = json.load(f)
                meta = data.get("metadata", {})
                # Get thumbnail (first frame of camera1)
                thumb_path = ep_dir / "observation_images_camera1" / "frame_00000.jpg"
                meta["has_thumbnail"] = thumb_path.exists()
                meta["dir"] = str(ep_dir)
                episodes.append(meta)
    return episodes


def get_episode_thumbnail(episode_id):
    """Get first frame thumbnail for an episode."""
    ep_dir = EPISODES_DIR / f"episode_{episode_id}"
    for cam in ["observation_images_camera1", "observation_images_camera2"]:
        thumb_path = ep_dir / cam / "frame_00000.jpg"
        if thumb_path.exists():
            return thumb_path
    return None


def delete_episode(episode_id):
    """Delete an episode."""
    import shutil
    ep_dir = EPISODES_DIR / f"episode_{episode_id}"
    if ep_dir.exists():
        shutil.rmtree(ep_dir)
        return {"success": True, "message": f"Episode {episode_id} deleted"}
    return {"success": False, "error": "Episode not found"}


def get_stats():
    """Get overall recording stats."""
    episodes = list_episodes()
    total = len(episodes)
    tasks = {}
    total_frames = 0
    for ep in episodes:
        task = ep.get("task", "unknown")
        tasks[task] = tasks.get(task, 0) + 1
        total_frames += ep.get("num_frames", 0)

    disk = sum(f.stat().st_size for f in EPISODES_DIR.rglob("*") if f.is_file()) / (1024 * 1024)

    return {
        "total_episodes": total,
        "total_frames": total_frames,
        "tasks": tasks,
        "disk_usage_mb": round(disk, 1),
        "episodes_dir": str(EPISODES_DIR),
    }


# ─── HTTP Server ──────────────────────────────────────────────────────────────

class RecorderHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress logs

    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/status":
            with state_lock:
                data = dict(recorder_state)
            self._json(data)

        elif path == "/episodes":
            self._json(list_episodes())

        elif path == "/stats":
            self._json(get_stats())

        elif path.startswith("/thumbnail/"):
            try:
                ep_id = int(path.split("/")[-1])
                thumb = get_episode_thumbnail(ep_id)
                if thumb:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    with open(thumb, "rb") as f:
                        self.wfile.write(f.read())
                    return
            except Exception:
                pass
            self.send_error(404)

        elif path == "/cameras":
            self._json({"cameras": detect_cameras()})

        else:
            self._json({"error": "Unknown endpoint", "endpoints": [
                "GET /status", "GET /episodes", "GET /stats",
                "GET /thumbnail/<id>", "GET /cameras",
                "POST /start", "POST /stop", "POST /discard", "POST /delete",
            ]})

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
        path = self.path.split("?")[0]

        if path == "/start":
            task = body.get("task", "pick_object")
            result = start_recording(task)
            self._json(result)

        elif path == "/stop":
            result = stop_recording()
            self._json(result)

        elif path == "/discard":
            result = discard_recording()
            self._json(result)

        elif path == "/delete":
            ep_id = body.get("episode_id")
            if ep_id:
                result = delete_episode(ep_id)
            else:
                result = {"success": False, "error": "Missing episode_id"}
            self._json(result)

        else:
            self._json({"error": "Unknown endpoint"})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def main():
    # Detect cameras on startup
    print(f"SmolVLA Episode Recorder v1.0")
    print(f"Episodes dir: {EPISODES_DIR}")
    print(f"Recording FPS: {RECORD_FPS}")
    print(f"Image size: {IMAGE_SIZE}x{IMAGE_SIZE}")
    print()

    cameras = detect_cameras()
    with state_lock:
        recorder_state["cameras_available"] = cameras
        recorder_state["total_episodes"] = len(list(EPISODES_DIR.glob("episode_*")))

    print(f"Cameras detected: {len(cameras)}")
    for c in cameras:
        print(f"  ✅ {c}")
    if not cameras:
        print("  ⚠️  No cameras found — recording will have state data only")
    print()

    stats = get_stats()
    print(f"Existing episodes: {stats['total_episodes']}")
    print(f"Disk usage: {stats['disk_usage_mb']} MB")
    print()

    class ThreadingHTTPServer(HTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), RecorderHandler)
    print(f"🎬 Episode Recorder running on http://0.0.0.0:{HTTP_PORT}")
    print(f"   POST /start  — Start recording")
    print(f"   POST /stop   — Stop & save episode")
    print(f"   GET  /status — Recording status")
    print(f"   GET  /episodes — List all episodes")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping recorder...")
        stop_event.set()
        server.shutdown()


if __name__ == "__main__":
    main()
