#!/usr/bin/env python3
"""
Spatial Calibration — Pixel + Depth → Arm XYZ Mapping
══════════════════════════════════════════════════════
Converts YOLO detection coordinates (pixel position + depth in mm)
into real-world arm coordinates (x, y, z in meters) that can be
directly fed to move_to_xyz().

Camera Setup:
  - Orbbec RGB-D mounted on the arm wrist, pointing forward
  - Camera sees objects in front of the arm
  - Depth aligned to color frame

Coordinate Systems:
  Camera frame:          Arm frame (IK):
    Z → forward           X → forward
    X → right             Y → left 
    Y → down              Z → up

Usage:
  # Interactive calibration
  python3 spatial_calibration.py --calibrate
  
  # Test with current YOLO detections
  python3 spatial_calibration.py --test
  
  # Just print the transform for a single point
  python3 spatial_calibration.py --pixel 320 240 --depth 200
"""

import json
import math
import time
import os
import sys
import argparse
import urllib.request
from pathlib import Path

# ─── Camera Intrinsics (from ROS2 /depth_cam/color/camera_info) ──────────
# These are calibrated values from the Orbbec sensor
COLOR_INTRINSICS = {
    'fx': 455.3036,   # Focal length X (pixels)
    'fy': 455.3036,   # Focal length Y (pixels)  
    'cx': 325.3349,   # Principal point X (pixels)
    'cy': 244.1390,   # Principal point Y (pixels)
    'width': 640,
    'height': 480,
}

DEPTH_INTRINSICS = {
    'fx': 239.4822,
    'fy': 239.4822,
    'cx': 160.2313,
    'cy': 99.9886,
    'width': 320,
    'height': 200,
}

# ─── Camera → Arm Transform ────────────────────────────────────────────────
# The camera is mounted on the arm's wrist.
# These offsets describe where the camera optical center is relative to
# the arm base coordinate frame WHEN THE ARM IS AT HOME POSITION.
#
# IMPORTANT: Since the camera moves WITH the arm, we need to account for
# the current arm pose. For simplicity in v1, we assume the camera-to-arm
# transform is roughly fixed (camera always points forward from wrist).
#
# Camera optical frame → arm base frame:
#   arm_x = camera_z + offset_x   (camera Z = forward = arm X)
#   arm_y = -camera_x + offset_y  (camera X = right = arm -Y)  
#   arm_z = -camera_y + offset_z  (camera Y = down = arm -Z)
#
# These offsets need to be calibrated for your specific mount.
# Measure the camera position relative to the arm base.

CALIBRATION_FILE = Path.home() / '.jetarm_calibration.json'

# Default calibration (rough estimate — will be improved by calibration)
DEFAULT_CALIBRATION = {
    'camera_offset_x': 0.0,    # Camera is roughly above arm base, X offset (m)
    'camera_offset_y': 0.0,    # Left-right offset from arm center (m)
    'camera_offset_z': 0.10,   # Camera height above arm base (m)
    # Rotation corrections (degrees) - for fine-tuning
    'roll_correction': 0.0,
    'pitch_correction': 0.0,
    'yaw_correction': 0.0,
    # Scale factor (if depth is consistently off)
    'depth_scale': 1.0,
    # Calibration points (for reference)
    'calibration_points': [],
    'calibrated_at': None,
}


def load_calibration():
    """Load calibration from file, or return defaults."""
    if CALIBRATION_FILE.exists():
        with open(CALIBRATION_FILE) as f:
            cal = json.load(f)
            # Merge with defaults for any missing keys
            merged = {**DEFAULT_CALIBRATION, **cal}
            return merged
    return dict(DEFAULT_CALIBRATION)


def save_calibration(cal):
    """Save calibration to file."""
    cal['calibrated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
    with open(CALIBRATION_FILE, 'w') as f:
        json.dump(cal, f, indent=2)
    print(f"✅ Calibration saved to {CALIBRATION_FILE}")


def pixel_depth_to_camera_xyz(pixel_x, pixel_y, depth_mm, intrinsics=None):
    """Convert pixel coordinates + depth → 3D point in camera frame.
    
    Args:
        pixel_x: X coordinate in color image (0-639)
        pixel_y: Y coordinate in color image (0-479)
        depth_mm: Depth in millimeters
        intrinsics: Camera intrinsics dict (defaults to color camera)
    
    Returns:
        (cam_x, cam_y, cam_z) in meters in camera optical frame
        cam_z = forward, cam_x = right, cam_y = down
    """
    if intrinsics is None:
        intrinsics = COLOR_INTRINSICS
    
    fx = intrinsics['fx']
    fy = intrinsics['fy']
    cx = intrinsics['cx']
    cy = intrinsics['cy']
    
    z = depth_mm / 1000.0  # Convert mm → meters
    x = (pixel_x - cx) * z / fx  # Right is positive
    y = (pixel_y - cy) * z / fy  # Down is positive
    
    return (x, y, z)


def camera_xyz_to_arm_xyz(cam_x, cam_y, cam_z, calibration=None):
    """Transform camera optical frame → arm base frame.
    
    Camera optical frame: Z=forward, X=right, Y=down
    Arm frame:            X=forward, Y=left, Z=up
    
    Args:
        cam_x, cam_y, cam_z: Point in camera optical frame (meters)
        calibration: Calibration dict with offsets
    
    Returns:
        (arm_x, arm_y, arm_z) in arm base frame (meters)
    """
    if calibration is None:
        calibration = load_calibration()
    
    scale = calibration.get('depth_scale', 1.0)
    
    # Apply depth scale
    cam_x *= scale
    cam_y *= scale
    cam_z *= scale
    
    # Camera → arm coordinate mapping
    # Camera Z (forward) → Arm X (forward)
    # Camera X (right)   → Arm Y (left, negated)
    # Camera Y (down)    → Arm Z (up, negated)
    arm_x = cam_z + calibration['camera_offset_x']
    arm_y = -cam_x + calibration['camera_offset_y']
    arm_z = -cam_y + calibration['camera_offset_z']
    
    return (arm_x, arm_y, arm_z)


def pixel_depth_to_arm_xyz(pixel_x, pixel_y, depth_mm, calibration=None):
    """Full pipeline: pixel + depth → arm XYZ coordinates.
    
    Args:
        pixel_x: X in color image (0-639)
        pixel_y: Y in color image (0-479)
        depth_mm: Depth in millimeters
        calibration: Optional calibration overrides
    
    Returns:
        dict with 'x', 'y', 'z' in meters (arm frame),
        plus 'reachable' flag and 'distance' from base
    """
    if calibration is None:
        calibration = load_calibration()
    
    # Step 1: Pixel + depth → camera 3D
    cam_x, cam_y, cam_z = pixel_depth_to_camera_xyz(pixel_x, pixel_y, depth_mm)
    
    # Step 2: Camera 3D → arm 3D
    arm_x, arm_y, arm_z = camera_xyz_to_arm_xyz(cam_x, cam_y, cam_z, calibration)
    
    # Step 3: Check reachability
    distance = math.sqrt(arm_x**2 + arm_y**2)
    reachable = (0.08 <= distance <= 0.28) and (0.02 <= arm_z <= 0.35)
    
    return {
        'x': round(arm_x, 4),
        'y': round(arm_y, 4),
        'z': round(arm_z, 4),
        'distance': round(distance, 4),
        'reachable': reachable,
        'camera_xyz': [round(cam_x, 4), round(cam_y, 4), round(cam_z, 4)],
    }


def get_current_detections():
    """Fetch current YOLO detections from vision API."""
    try:
        req = urllib.request.Request('http://localhost:8889/state')
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            return data.get('objects', [])
    except:
        return []


def get_arm_position():
    """Get current arm servo positions from bridge."""
    try:
        data = json.dumps({'action': 'world_state'}).encode()
        req = urllib.request.Request(
            'http://localhost:8888', data=data,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            result = json.loads(resp.read())
            return result.get('state', {}).get('servos', {})
    except:
        return {}


def test_current_detections():
    """Test spatial mapping on current YOLO detections."""
    cal = load_calibration()
    objects = get_current_detections()
    
    if not objects:
        print("⚠️  No objects detected by YOLO")
        return
    
    print(f"\n📸 Found {len(objects)} objects:\n")
    print(f"{'Object':<15} {'Pixel':<15} {'Depth':<10} {'Arm XYZ (m)':<25} {'Reach':<8}")
    print("─" * 75)
    
    for obj in objects:
        px, py = obj['center_px']
        depth = obj.get('depth_mm', 0)
        
        if depth > 0:
            result = pixel_depth_to_arm_xyz(px, py, depth, cal)
            xyz = f"({result['x']:.3f}, {result['y']:.3f}, {result['z']:.3f})"
            reach = "✅ YES" if result['reachable'] else "❌ NO"
        else:
            xyz = "(no depth)"
            reach = "?"
        
        conf = f"{obj['confidence']*100:.0f}%"
        print(f"{obj['class']:<15} [{px:3d},{py:3d}]       {depth:>5d}mm   {xyz:<25} {reach}")
    
    print()


def interactive_calibration():
    """Interactive calibration using the arm's known positions."""
    cal = load_calibration()
    
    print("═" * 60)
    print("  JetArm Spatial Calibration")
    print("═" * 60)
    print()
    print("This will calibrate the camera-to-arm coordinate transform.")
    print("You'll move the arm to known positions and record what the camera sees.")
    print()
    print("Prerequisites:")
    print("  - YOLO detector running (port 8889)")
    print("  - Bridge running (port 8888)")
    print("  - A small object (e.g., colored cube) in the workspace")
    print()
    
    calibration_points = []
    
    while True:
        print("\n" + "─" * 40)
        print("Commands:")
        print("  1. Record calibration point")
        print("  2. Move arm to home")
        print("  3. Show current detections")
        print("  4. Test current calibration")
        print("  5. Auto-compute offsets from points")
        print("  6. Manual offset adjustment")
        print("  7. Save & exit")
        print("  q. Quit without saving")
        
        choice = input("\n> ").strip()
        
        if choice == '1':
            # Record a calibration point
            print("\nPlace an object where the gripper can reach it.")
            print("Then move the arm to that object using the dashboard/gamepad.")
            input("Press ENTER when the arm is touching/holding the object...")
            
            # Get arm position
            servos = get_arm_position()
            if not servos:
                print("❌ Cannot read arm position. Is bridge running?")
                continue
            
            # Get detections
            objects = get_current_detections()
            if not objects:
                print("❌ No objects detected. Is YOLO running?")
                continue
            
            # Let user pick which detection
            print("\nDetected objects:")
            for i, obj in enumerate(objects):
                px, py = obj['center_px']
                depth = obj.get('depth_mm', 0)
                print(f"  {i+1}. {obj['class']} ({obj['confidence']*100:.0f}%) "
                      f"at [{px},{py}] depth={depth}mm")
            
            idx = input("Which object number? ").strip()
            try:
                obj = objects[int(idx) - 1]
            except:
                print("Invalid selection")
                continue
            
            # Ask for real arm position (from IK or measurement)
            print(f"\nArm servos: {json.dumps(servos)}")
            print("Enter the real arm XYZ where the gripper IS right now.")
            print("(You can estimate from servo positions or measure)")
            try:
                ax = float(input("  arm_x (forward, meters, e.g. 0.15): "))
                ay = float(input("  arm_y (left+, meters, e.g. 0.0): "))
                az = float(input("  arm_z (up, meters, e.g. 0.05): "))
            except:
                print("Invalid input")
                continue
            
            point = {
                'pixel': obj['center_px'],
                'depth_mm': obj.get('depth_mm', 0),
                'arm_xyz': [ax, ay, az],
                'servos': servos,
                'object_class': obj['class'],
                'timestamp': time.time(),
            }
            calibration_points.append(point)
            print(f"✅ Point recorded! ({len(calibration_points)} total)")
        
        elif choice == '2':
            try:
                data = json.dumps({'action': 'home', 'duration': 1000}).encode()
                req = urllib.request.Request(
                    'http://localhost:8888', data=data,
                    headers={'Content-Type': 'application/json'}
                )
                urllib.request.urlopen(req, timeout=3)
                print("✅ Arm moved to home position")
            except Exception as e:
                print(f"❌ Failed: {e}")
        
        elif choice == '3':
            test_current_detections()
        
        elif choice == '4':
            print("\nCurrent calibration offsets:")
            print(f"  camera_offset_x: {cal['camera_offset_x']:.4f}m")
            print(f"  camera_offset_y: {cal['camera_offset_y']:.4f}m")
            print(f"  camera_offset_z: {cal['camera_offset_z']:.4f}m")
            print(f"  depth_scale:     {cal['depth_scale']:.3f}")
            test_current_detections()
        
        elif choice == '5':
            if len(calibration_points) < 1:
                print("❌ Need at least 1 calibration point. Record some first.")
                continue
            
            # Compute offsets from calibration points
            offset_x_sum = 0
            offset_y_sum = 0
            offset_z_sum = 0
            scale_sum = 0
            n = 0
            
            for pt in calibration_points:
                px, py = pt['pixel']
                depth = pt['depth_mm']
                ax, ay, az = pt['arm_xyz']
                
                if depth <= 0:
                    print(f"  Skipping point with no depth")
                    continue
                
                # Compute camera XYZ
                cam_x, cam_y, cam_z = pixel_depth_to_camera_xyz(px, py, depth)
                
                # What offsets make camera→arm correct?
                # arm_x = cam_z + offset_x  →  offset_x = arm_x - cam_z
                # arm_y = -cam_x + offset_y →  offset_y = arm_y + cam_x
                # arm_z = -cam_y + offset_z →  offset_z = arm_z + cam_y
                ox = ax - cam_z
                oy = ay + cam_x
                oz = az + cam_y
                
                offset_x_sum += ox
                offset_y_sum += oy
                offset_z_sum += oz
                n += 1
                
                print(f"  Point: pixel[{px},{py}] d={depth}mm → "
                      f"cam({cam_x:.3f},{cam_y:.3f},{cam_z:.3f}) → "
                      f"offsets({ox:.3f},{oy:.3f},{oz:.3f})")
            
            if n > 0:
                cal['camera_offset_x'] = round(offset_x_sum / n, 4)
                cal['camera_offset_y'] = round(offset_y_sum / n, 4)
                cal['camera_offset_z'] = round(offset_z_sum / n, 4)
                cal['calibration_points'] = calibration_points
                
                print(f"\n✅ Computed offsets from {n} points:")
                print(f"  camera_offset_x: {cal['camera_offset_x']:.4f}m")
                print(f"  camera_offset_y: {cal['camera_offset_y']:.4f}m")
                print(f"  camera_offset_z: {cal['camera_offset_z']:.4f}m")
        
        elif choice == '6':
            print(f"\nCurrent offsets:")
            print(f"  camera_offset_x: {cal['camera_offset_x']:.4f}m")
            print(f"  camera_offset_y: {cal['camera_offset_y']:.4f}m")
            print(f"  camera_offset_z: {cal['camera_offset_z']:.4f}m")
            print(f"  depth_scale:     {cal['depth_scale']:.3f}")
            try:
                val = input("  New camera_offset_x (or ENTER to skip): ").strip()
                if val: cal['camera_offset_x'] = float(val)
                val = input("  New camera_offset_y (or ENTER to skip): ").strip()
                if val: cal['camera_offset_y'] = float(val)
                val = input("  New camera_offset_z (or ENTER to skip): ").strip()
                if val: cal['camera_offset_z'] = float(val)
                val = input("  New depth_scale (or ENTER to skip): ").strip()
                if val: cal['depth_scale'] = float(val)
                print("✅ Offsets updated")
            except:
                print("Invalid input")
        
        elif choice == '7':
            cal['calibration_points'] = calibration_points
            save_calibration(cal)
            break
        
        elif choice == 'q':
            print("Exiting without saving.")
            break


def main():
    parser = argparse.ArgumentParser(description='JetArm Spatial Calibration')
    parser.add_argument('--calibrate', action='store_true', help='Interactive calibration')
    parser.add_argument('--test', action='store_true', help='Test with current detections')
    parser.add_argument('--pixel', nargs=2, type=int, help='Pixel X Y')
    parser.add_argument('--depth', type=int, help='Depth in mm')
    args = parser.parse_args()
    
    if args.calibrate:
        interactive_calibration()
    elif args.test:
        test_current_detections()
    elif args.pixel and args.depth:
        result = pixel_depth_to_arm_xyz(args.pixel[0], args.pixel[1], args.depth)
        print(json.dumps(result, indent=2))
    else:
        # Show current calibration
        cal = load_calibration()
        print("Current calibration:")
        print(json.dumps(cal, indent=2))
        print("\nUse --calibrate for interactive calibration")
        print("Use --test to test with current YOLO detections")


if __name__ == '__main__':
    main()
