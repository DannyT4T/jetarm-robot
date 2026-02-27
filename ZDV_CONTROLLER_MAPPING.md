# ZD-V+ Controller Mapping for JetArm (Hiwonder)

> **Controller:** ZD-V+ Wireless 2.4GHz (PS2-style body, Xbox ABXY labels)  
> **Receiver:** USB dongle connected to Jetson Orin Nano via Hiwonder base board  
> **Driver:** pygame (SDL) via `/dev/input/js0`  
> **Verified:** February 2026

---

## Physical Button Layout

```
        [L2]                        [R2]
        [L1]                        [R1]

                                 ( Y )
    [SEL]  [START]            ( X )   ( B )
                                 ( A )
   ▲
 ◀   ▶       (L3)         (R3)
   ▼

   D-Pad          L-Stick    R-Stick    Face Buttons
```

---

## Pygame Button Index Map

| Pygame Index | Physical Button | Color/Position | Notes |
|:---:|---|---|---|
| **0** | Y | 🟢 Green (top face) | Detected ✅ |
| **1** | B | 🔴 Red (right face) | Detected ✅ |
| **2** | A | 🔵 Blue (bottom face) | Detected ✅ |
| **3** | X | 🩷 Pink (left face) | Detected ✅ |
| **4** | L1 | Left bumper | Detected ✅ |
| **5** | R1 | Right bumper | Detected ✅ |
| **6** | L2 | Left trigger | Detected ✅ |
| **7** | R2 | Right trigger | Detected ✅ |
| **8** | SELECT | Center left | Detected ✅ |
| **9** | START | Center right | Detected ✅ |
| **10** | L3 | Left stick click | Detected ✅ |
| **11** | R3 | Right stick click | Detected ✅ |
| **12** | MODE | Center (round) | Detected ✅ |

> **D-Pad:** Reports as a **hat** (not individual buttons). Read via `pygame.joystick.Joystick.get_hat(0)` which returns `(x, y)` where each is `-1`, `0`, or `1`.

---

## D-Pad (Hat) Values

| Direction | hat_x | hat_y |
|:---:|:---:|:---:|
| Up | 0 | 1 |
| Down | 0 | -1 |
| Left | -1 | 0 |
| Right | 1 | 0 |
| Up-Left | -1 | 1 |
| Up-Right | 1 | 1 |
| Down-Left | -1 | -1 |
| Down-Right | 1 | -1 |
| Neutral | 0 | 0 |

---

## Pygame Axes Map

| Axis Index | Physical Input | Range | Notes |
|:---:|---|---|---|
| **0** | Left Stick X | -1.0 (left) to +1.0 (right) | Deadzone ~0.08 |
| **1** | Left Stick Y | -1.0 (up) to +1.0 (down) | Inverted in code for arm control |
| **2** | Right Stick X | -1.0 (left) to +1.0 (right) | Deadzone ~0.08 |
| **3** | Right Stick Y | -1.0 (up) to +1.0 (down) | Inverted in code for arm control |

---

## JetArm Robot Control Mapping

### Active Controls (joystick_control_fixed.py)

| Physical Input | Robot Action | Servo ID | Details |
|---|---|---|---|
| **L Stick X** (Axis 0) | Base Rotate | ID:1 | Left = rotate left, Right = rotate right |
| **L Stick Y** (Axis 1) | Shoulder Up/Down | ID:2 | Forward = up, Back = down |
| **R Stick Y** (Axis 3) | Elbow Up/Down | ID:3 | Forward = up, Back = down |
| **R Stick X** (Axis 2) | Wrist Pitch | ID:4 | Left/Right tilts wrist |
| **L1** (Index 4) | Wrist Rotate CCW | ID:5 | +25 pulse per tick (hold for continuous) |
| **L2** (Index 6) | Wrist Rotate CW | ID:5 | -25 pulse per tick (hold for continuous) |
| **R1** (Index 5) | Gripper Open | ID:10 | +35 pulse per tick (max 1000) |
| **R2** (Index 7) | Gripper Close | ID:10 | -35 pulse per tick (min 0) |
| **START** (Index 9) | Home / Center | All | Moves all servos to 500 (center) |
| **SELECT + START** (8+9) | Mode Toggle | — | Toggles between Manual and Coordinate mode |

### Unmapped (Available for Programming)

| Physical Input | Pygame Index / Source | Potential Use |
|---|---|---|
| Y button | Index 0 | Save position / Record waypoint |
| B button | Index 1 | Emergency stop |
| A button | Index 2 | Play recorded sequence |
| X button | Index 3 | Toggle camera view |
| L3 (left stick click) | Index 11 | Fine control mode |
| R3 (right stick click) | Index 12 | Reset single joint |
| D-Pad Up | Hat Y = 1 | Speed up |
| D-Pad Down | Hat Y = -1 | Speed down |
| D-Pad Left | Hat X = -1 | Previous preset |
| D-Pad Right | Hat X = 1 | Next preset |

---

## Python Reference Code

```python
import pygame as pg

# Initialize
pg.joystick.init()
joy = pg.joystick.Joystick(0)
joy.init()

# Button map for ZD-V+ controller
BUTTON_MAP = [
    'y',           # 0 - Y face (green)
    'b',           # 1 - B face (red)
    'a',           # 2 - A face (blue)
    'x',           # 3 - X face (pink)
    'l1',          # 4 - Left Trigger 1
    'r1',          # 5 - Right Trigger 1
    'l2',          # 6 - Left Trigger 2
    'r2',          # 7 - Right Trigger 2
    'select',      # 8 - SELECT
    'start',       # 9 - START
    'l3',          # 10 - Left Stick Click
    'r3',          # 11 - Right Stick Click
    'mode',        # 12 - MODE
]

# Read buttons
pg.event.pump()
for i in range(joy.get_numbuttons()):
    if joy.get_button(i):
        name = BUTTON_MAP[i] if i < len(BUTTON_MAP) else f'btn_{i}'
        print(f'Button {i} ({name}) pressed')

# Read axes (sticks)
for i in range(joy.get_numaxes()):
    val = joy.get_axis(i)
    if abs(val) > 0.1:
        print(f'Axis {i}: {val:.2f}')

# Read D-Pad (hat)
if joy.get_numhats() > 0:
    hat_x, hat_y = joy.get_hat(0)
    if hat_x != 0 or hat_y != 0:
        print(f'D-Pad: x={hat_x}, y={hat_y}')
```

---

## ROS 2 Integration

The controller state is published to the `/joy` ROS topic as `sensor_msgs/Joy`:

```bash
# View live controller data
ros2 topic echo /joy

# Check publish rate (~20Hz)
ros2 topic hz /joy
```

**Topic Fields:**
- `axes[0]` — Left Stick X
- `axes[1]` — Left Stick Y
- `axes[2]` — Right Stick X
- `axes[3]` — Right Stick Y
- `axes[4]` — D-Pad Hat X (-1=left, 0=center, 1=right)
- `axes[5]` — D-Pad Hat Y (-1=down, 0=center, 1=up)
- `buttons[0-12]` — Button states: `[Y, B, A, X, L1, R1, L2, R2, SELECT, START, L3, R3, MODE]`

---

## Hardware Notes

- The ZD-V+ uses a **2.4GHz wireless USB dongle** (not Bluetooth)
- The dongle must be plugged into an available USB-A port on the Jetson or Hiwonder base board
- The controller appears at `/dev/input/js0` when connected
- Battery: 2x AA batteries in the back compartment
- LED indicator: Blinks when searching, solid when connected
- MODE button may toggle analog/digital mode internally on the controller
- L3/R3 are activated by pressing down on the analog sticks
