# 🤖 JetArm + Jetson Orin Nano Super — Complete Setup Guide & System State

> **Last Updated:** February 19, 2026  
> **Compiled From:** Previous Antigravity AI sessions  
> **Author:** Setup performed remotely from Mac Mini via Antigravity AI

---

## Table of Contents

1. [Hardware Inventory](#-hardware-inventory)
2. [Software Stack](#️-software-stack)
3. [Network & Access](#-network--access)
4. [What's Working](#-whats-working)
5. [Known Issues](#️-known-issues)
6. [Persistent Configuration](#-persistent-configuration-survives-reboot)
7. [Key Directories on Jetson](#-key-directories-on-jetson)
8. [Available ROS 2 Topics](#-available-ros-2-topics)
9. [Quick Start from Mac Mini](#-quick-start-from-mac-mini)
10. [SD Card Flashing Workflow](#-sd-card-flashing-workflow)
11. [Next Steps](#-next-steps)
12. [Lessons Learned](#-lessons-learned)

---

## 📋 Hardware Inventory

| Component | Model | Notes |
|-----------|-------|-------|
| **SBC** | NVIDIA Jetson Orin Nano Super Developer Kit | 8GB RAM, 7.4 GiB usable |
| **Storage** | 64GB SD Card | 57 GB partition, 33 GB free (40% used) |
| **Robot Arm** | Hiwonder JetArm Standard Kit | 5-DOF bus servo arm |
| **Servo Controller** | STM32 via CH340 USB-Serial | 1,000,000 baud, protocol: 0xAA 0x55 |
| **Depth Camera** | Orbbec Gemini (330 series) | RGB: 0x0511, Depth: 0x0614 |
| **Mouse** | Logitech M196 | Bluetooth LE, MAC: `D1:01:02:1F:03:6C` |
| **Control Machine** | M4 Mac Mini | SSH remote control |

---

## 🖥️ Software Stack

| Software | Version | Status |
|----------|---------|--------|
| **JetPack** | 6.2.1 | ✅ Installed |
| **Linux Kernel** | 5.15.148-tegra | ✅ Running |
| **Ubuntu** | 22.04 (Jammy) | ✅ Base OS |
| **Power Mode** | MAXN SUPER (Mode 2) | ✅ Enabled |
| **ROS 2** | Humble | ✅ Installed via apt |
| **JetArm ROS Packages** | Jetson_nano_ros2 branch | ✅ Built (21 packages) |
| **Orbbec SDK ROS2** | v2-main | ✅ Built from source (depth stalled) |
| **Python** | 3.10 | ✅ System default |
| **OpenCV** | 4.5.4 | ✅ Installed |
| **pyserial** | python3-serial | ✅ Installed |
| **CH341 Driver** | WCH v1.9 (Dec 2025) | ✅ Compiled from source |
| **Chromium** | apt install | ✅ Installed |

---

## 🌐 Network & Access

- **Jetson IP:** `192.168.1.246`
- **Jetson Username:** `danny`
- **SSH:** Password-free key-based auth from Mac Mini
- **SSH Command:** `ssh danny@192.168.1.246`
- **File Transfer:** `scp danny@192.168.1.246:/remote/path /local/path`

> 🔒 Passwords intentionally excluded from this document.

---

## ✅ What's Working

### 1. Robot Arm Control (via ROS 2)
The arm is fully controllable from the Mac Mini via SSH + ROS 2 topics.

**Start the controller:**
```bash
ssh danny@192.168.1.246 "source /opt/ros/humble/setup.bash && \
  source /home/danny/JetArm/install/setup.bash && \
  export need_compile=True && \
  ros2 launch ros_robot_controller ros_robot_controller.launch.py"
```

**Initialize (required before first use):**
```bash
ros2 service call /ros_robot_controller/init_finish std_srvs/srv/Trigger '{}'
```

**Move servos (IDs 1–5, positions 0–1000, 500=center):**
```bash
ros2 topic pub --once /ros_robot_controller/bus_servo/set_position \
  ros_robot_controller_msgs/msg/ServosPosition \
  '{duration: 1.0, position: [{id: 1, position: 500}, {id: 2, position: 500}, {id: 3, position: 500}, {id: 4, position: 500}, {id: 5, position: 500}]}'
```

**Buzzer test (3 short beeps):**
```bash
ros2 topic pub --once /ros_robot_controller/set_buzzer \
  ros_robot_controller_msgs/msg/BuzzerState \
  '{freq: 1000, on_time: 0.1, off_time: 0.2, repeat: 3}'
```

> ⚠️ **NEVER** send a continuous buzzer (repeat: 0 or 1 with no off_time). Always use repeat: 3 with off_time for testing.

### 2. RGB Camera (via OpenCV)
The Orbbec RGB camera works perfectly via OpenCV at `/dev/video0`.

**Capture a test image:**
```bash
ssh danny@192.168.1.246 "python3 << 'EOF'
import cv2
cap = cv2.VideoCapture(0)
ret, frame = cap.read()
if ret:
    cv2.imwrite('/tmp/camera_test.jpg', frame)
    print('Captured:', frame.shape)
cap.release()
EOF"
```

**Pull image to Mac:**
```bash
scp danny@192.168.1.246:/tmp/camera_test.jpg ./
```

**Supported resolutions (MJPG):**
- 2592x1944 @ 25fps (5MP)
- 2560x1440 @ 30fps
- 1920x1080 @ 30fps
- 1280x720 @ 30fps
- 640x480 @ 60fps
- 320x240 @ 60fps

### 3. Bluetooth
```bash
# Connect Logi M196 (trust + connect, skip pair)
sudo bluetoothctl trust D1:01:02:1F:03:6C
sudo bluetoothctl connect D1:01:02:1F:03:6C
```

> **Tip:** Logitech BLE mice fail `pair` with AuthenticationFailed. Use `trust` + `connect` directly instead.

### 4. Serial Communication
- **CH341 USB-Serial** → `/dev/ttyCH341USB0`
- **Symlink** → `/dev/rrc` (auto-created via udev rule)
- **Baud rate:** 1,000,000
- **Protocol:** 0xAA 0x55 header, CRC8 checksum

---

## ⚠️ Known Issues

### 1. Depth Sensor Not Streaming
The Orbbec depth sensor (product ID `0x0614`) is detected on USB but the Orbbec SDK's `libuvc` backend stalls during device enumeration on JetPack 6.x. This is a known compatibility issue.

**What works:**
- USB device is detected (`lsusb` shows it)
- `list_ob_devices.sh` script finds both RGB and depth devices
- The node loads but hangs at `setUvcBackendType:libuvc`

**Attempted fixes (all failed):**
- apt-installed `ros-humble-orbbec-camera` (v2.5.5)
- OrbbecSDK_ROS2 v2-main built from source
- `uvc_backend:=v4l2` parameter
- Running as root
- Disabling USB autosuspend
- Multiple launch files (gemini_330_series, gemini305, orbbec_camera)

**Potential solutions:**
- Orbbec SDK update for JetPack 6.x
- Hiwonder's pre-built image (may include patched SDK)
- Firmware update for the Orbbec sensor
- File GitHub issue at [orbbec/OrbbecSDK_ROS2](https://github.com/orbbec/OrbbecSDK_ROS2)

### 2. NVIDIA Bootloader Update Pending
A notification appeared: _"nvidia-l4t-bootloader Post Install Notification. Reboot is required to complete the installation."_ One more reboot will finalize this.

---

## 🔧 Persistent Configuration (Survives Reboot)

### CH341 Serial Driver Auto-Load
```
/etc/modules-load.d/ch341.conf
  → contains: ch341
```

### Udev Rules
```
/etc/udev/rules.d/99-jetarm.rules
  → Auto-creates /dev/rrc symlink when CH340 is connected
  → SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", SYMLINK+="rrc", MODE="0666"

/etc/udev/rules.d/99-obsensor-libusb.rules
  → Orbbec camera permissions (from OrbbecSDK)

/etc/udev/rules.d/99-orbbec.rules
  → Additional Orbbec USB permissions
```

### brltty Removed
The `brltty` package (braille display driver) was removed because it incorrectly claimed CH340/CH341 USB devices, preventing the serial driver from creating `/dev/ttyCH341USB0`.

### Bash Environment (~/.bashrc)
ROS 2 and JetArm are sourced automatically on login:
```bash
source /opt/ros/humble/setup.bash
source /home/danny/JetArm/install/setup.bash
```

---

## 📁 Key Directories on Jetson

| Path | Contents |
|------|----------|
| `/home/danny/JetArm/` | Hiwonder JetArm ROS2 packages (cloned from GitHub) |
| `/home/danny/JetArm/src/` | Source code (driver, peripherals, app, example, etc.) |
| `/home/danny/JetArm/install/` | Built ROS2 packages |
| `/home/danny/orbbec_ws/` | Orbbec SDK ROS2 v2 (built from source) |
| `/lib/modules/5.15.148-tegra/kernel/drivers/usb/serial/ch341.ko` | Compiled CH341 driver |

---

## 🎮 Available ROS 2 Topics

```
/ros_robot_controller/bus_servo/set_position   # Move servos
/ros_robot_controller/bus_servo/set_state       # Configure servos
/ros_robot_controller/bus_servo/get_state       # Query servo state (service)
/ros_robot_controller/set_buzzer                # Buzzer control
/ros_robot_controller/set_led                   # LED control
/ros_robot_controller/set_motor                 # Motor control
/ros_robot_controller/set_oled                  # OLED display
/ros_robot_controller/battery                   # Battery voltage
/ros_robot_controller/button                    # Button press events
/ros_robot_controller/imu_raw                   # IMU data
/ros_robot_controller/joy                       # Gamepad input
/ros_robot_controller/sbus                      # RC remote input
/ros_robot_controller/enable_reception          # Enable data reception
/ros_robot_controller/init_finish               # Init service (call first!)
/ros_robot_controller/pwm_servo/set_state       # PWM servo control
```

---

## 🚀 Quick Start (From Mac Mini)

```bash
# 1. SSH into Jetson
ssh danny@192.168.1.246

# 2. Start robot controller
source /opt/ros/humble/setup.bash
source /home/danny/JetArm/install/setup.bash
export need_compile=True
ros2 launch ros_robot_controller ros_robot_controller.launch.py &

# 3. Initialize
ros2 service call /ros_robot_controller/init_finish std_srvs/srv/Trigger '{}'

# 4. Move arm to center
ros2 topic pub --once /ros_robot_controller/bus_servo/set_position \
  ros_robot_controller_msgs/msg/ServosPosition \
  '{duration: 1.0, position: [{id: 1, position: 500}, {id: 2, position: 500}, {id: 3, position: 500}, {id: 4, position: 500}, {id: 5, position: 500}]}'

# 5. Don't forget to turn on the STM32 power switch!
```

---

## 💾 SD Card Flashing Workflow

### Prerequisites
- 32GB+ microSD card (64GB recommended by NVIDIA, 32GB will work but tight)
- Mac Mini M4 with internet connection
- SD card reader/adapter
- Jetson Orin Nano Super Developer Kit
- Hiwonder JetArm Standard Kit
- Monitor + keyboard + mouse for initial Jetson setup

### Phase 1: Download the JetPack 6.2 SD Card Image
1. Go to: https://developer.nvidia.com/embedded/jetpack
2. Find "JetPack 6.2" (or latest 6.x)
3. Download the **SD Card Image** for "Jetson Orin Nano Developer Kit"
4. The file will be ~18GB zipped — save to ~/Downloads/

### Phase 2: Install Flashing Tool on Mac

**Option A: balenaEtcher (GUI)**
```bash
brew install --cask balenaetcher
```
⚠️ Note: Some M4 Mac users report verification failures. If Etcher fails, use Option B.

**Option B: Command Line (dd) - More reliable on M4**
No installation needed — uses built-in macOS tools.

### Phase 3: Flash the SD Card

**Using balenaEtcher:**
1. Launch balenaEtcher
2. Click "Select image" → choose the downloaded .zip file
3. Insert SD card → it should auto-detect
4. Click "Flash!" → enter Mac password if prompted
5. Wait ~10-15 min → eject when done

**Using Command Line (dd):**
1. Before inserting SD card, run:
   ```bash
   diskutil list external | fgrep '/dev/disk'
   ```
2. Insert SD card, click "Ignore" if Mac shows unreadable dialog
3. Run the same command again to find the new disk:
   ```bash
   diskutil list external | fgrep '/dev/disk'
   ```
4. Note the disk number (e.g., /dev/disk2)
5. Clear partitions:
   ```bash
   sudo diskutil partitionDisk /dev/disk<n> 1 GPT "Free Space" "%noformat%" 100%
   ```
6. Flash the image (use rdisk for faster writes):
   ```bash
   /usr/bin/unzip -p ~/Downloads/<jetpack-image>.zip | sudo /bin/dd of=/dev/rdisk<n> bs=1m
   ```
7. Wait for completion (no progress shown, press Ctrl+T for status)
8. Click "Eject" when Mac shows unreadable disk dialog

### Phase 4: First Boot - Check/Update Firmware

> ⚠️ **IMPORTANT: Firmware Compatibility Check**
> The Jetson Orin Nano may have OLD firmware that is NOT compatible with JetPack 6.x.
> Since yours is a "Super" model purchased in 2025/2026, it likely has compatible firmware already.

**Quick Test (Try JetPack 6.x first):**
1. Insert the flashed SD card into Jetson (slot on underside of module)
2. Connect monitor via DisplayPort (you'll need DP-to-HDMI adapter)
3. Connect USB keyboard and mouse
4. Plug in the 19V power supply (DO NOT connect JetArm's 12V yet)
5. Watch for Ubuntu boot screen

**If Ubuntu desktop appears within 3 minutes → firmware is fine!**

**If screen stays BLACK for 3+ minutes → firmware needs updating:**
- Power off the Jetson
- Follow the microSD-only firmware update method at:
  https://www.jetson-ai-lab.com/tutorials/initial-setup-jetson-orin-nano/
- This involves downloading JetPack 5.1.3 SD card image first, booting with it,
  running QSPI updater, then rebooting with JetPack 6.x card

### Phase 5: Initial Ubuntu Setup (First Boot)
1. Accept NVIDIA Jetson software EULA
2. Select system language, keyboard layout, timezone
3. Connect to your WiFi network
4. Create username and password
5. Log in to Ubuntu desktop

### Phase 6: Enable MAXN SUPER Mode
1. Click the NVIDIA icon on the right side of Ubuntu's top bar
2. Select "Power Mode"
3. Choose "MAXN SUPER" for maximum performance (default is 25W)

### Phase 7: Install Hiwonder JetArm Software

**Option A: Get Hiwonder's pre-built image (Recommended)**
Email support@hiwonder.com with:
- Your order number
- That you have JetArm Standard + separate Orin Nano Super
- Request their system image or setup scripts

**Option B: Manual installation from Hiwonder's GitHub/resources**
(Hiwonder typically provides ROS packages and Python scripts)

### Phase 8: Mount Jetson into JetArm
1. Mount Jetson Orin Nano onto JetArm baseplate
2. Connect cables per JetArm manual
3. Power on: 19V to Jetson FIRST → 12V to STM32 SECOND
4. Connect via display or NoMachine for remote access

### Phase 9: Configure JetArm
1. Run Robot Version Config Tool
2. Set: JetArm Advanced + Gemini camera + None mic
3. Test arm movement and camera feed

### SD Card Notes
- 32GB SD card will be tight — JetPack 6.2 uses ~14-16GB base
- Consider upgrading to 64GB+ SD card if you run out of space
- Hiwonder's software + ROS + depth camera drivers may need 10-20GB additional

---

## 🔮 Next Steps

1. **Finalize bootloader** — One more reboot to complete nvidia-l4t-bootloader update
2. **Depth camera** — Monitor Orbbec SDK updates for JetPack 6.x support
3. **Color sorting demo** — Can run with RGB camera only (no depth needed)
4. **Object tracking** — Works with RGB camera
5. **AprilTag detection** — Works with RGB camera
6. **Ollama on Mac Mini** — Set up AI reasoning for intelligent arm control
7. **Game controller** — Test joystick control of the arm

---

## 📝 Lessons Learned

1. **brltty steals CH340 devices** — Always remove `brltty` on systems using CH340/CH341 USB-serial
2. **Logitech BLE mice** — Skip `pair`, just `trust` + `connect`
3. **JetPack 6.x CH341** — Kernel doesn't include the driver; must compile WCH ch341ser_linux from source
4. **STM32 power switch** — Must be physically switched ON for servos to respond (buzzer works without it)
5. **Orbbec + JetPack 6.x** — libuvc backend has compatibility issues; RGB works fine via standard UVC/OpenCV
6. **`/dev/rrc`** — Hiwonder's custom symlink that the robot controller expects for the serial port
7. **`need_compile=True`** — Environment variable required by Hiwonder's launch files when using colcon-built packages
8. **Continuous buzzer** — Never send repeat=1 without off_time, it won't stop until freq=0 is sent
