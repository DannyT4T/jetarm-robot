# A-Frame VR Training Simulator for JetArm

> **Status:** Planning / Documentation Phase
> **Purpose:** Use A-Frame + WebXR hand tracking to teach the JetArm robot via VR demonstrations, generating training data for SmolVLA.

---

## Overview

A browser-based VR training environment built on A-Frame that lets users teach the JetArm robot arm by physically demonstrating tasks using VR hand tracking. Demonstrations are recorded as training episodes and fed into SmolVLA for fine-tuning.

This approach is used by top robotics labs (Stanford ALOHA, Figure AI, Google DeepMind RT-2) but typically via custom VR apps. Our implementation is **browser-based**, making it accessible via a shared link on any WebXR headset (Quest, Vision Pro, etc.).

---

## Architecture

```
┌─── XR Creator Studio (A-Frame + WebXR) ──────────────────────────┐
│                                                                    │
│   🖐️ User's Hands (WebXR Hand Tracking API)                      │
│        │                                                           │
│        ▼                                                           │
│   ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│   │ Virtual       │    │ Virtual      │    │ Episode Recorder  │   │
│   │ JetArm        │───▶│ Camera       │───▶│ (joint states +   │   │
│   │ (URDF Model)  │    │ (AI POV)     │    │  camera frames)   │   │
│   └──────┬────────┘    └──────────────┘    └─────────┬─────────┘   │
│          │                                           │             │
│   IK Solver maps                          WebSocket / REST API     │
│   hand position →                                │                 │
│   joint angles                                   ▼                 │
│                                       ┌──────────────────┐        │
│                                       │ Training Server   │        │
│                                       │ (Mac Mini)        │        │
│                                       │ SmolVLA Fine-tune │        │
│                                       └────────┬─────────┘        │
│                                                │                   │
│                                                ▼                   │
│                                     Deploy to Real JetArm          │
└────────────────────────────────────────────────────────────────────┘
```

---

## Three Operating Modes

### Mode 1: VR Teach 🖐️
- User wears VR headset (Quest, Vision Pro, etc.)
- Virtual JetArm loaded from URDF in the A-Frame scene
- User grabs the gripper or arm segments with hand tracking
- IK solver converts hand positions → joint angles
- System records joint angles + virtual camera view at 10 Hz
- Each demonstration = one training episode
- Goal: collect 50-100 demonstrations per task

### Mode 2: VR + Real Robot (Teleoperation) 🤖
- Same as Mode 1, BUT the real JetArm mirrors VR movements in real-time
- WebSocket bridge: VR hand position → Jetson → servo commands
- Real camera feed shown as a PiP overlay in VR
- Best quality data: real camera visuals + VR-guided precise control
- Latency target: < 100ms VR-to-servo

### Mode 3: VR Watch AI 👀
- Trained SmolVLA model runs in the virtual environment
- User watches the virtual arm attempt tasks in 3D
- AI's "vision" and "decisions" displayed as overlays
- Debug tool: see what the model sees, why it fails
- Iterate: identify failure cases, record more demos for those

---

## Technical Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| 3D Scene | **A-Frame** | Core rendering framework |
| Robot Model | **URDF → A-Frame entities** | Custom `urdf-robot` component |
| Hand Tracking | **WebXR Hand API** | `hand-tracking-controls` component |
| Inverse Kinematics | **Custom IK solver** or `three-ik` | Maps hand position → joint angles |
| Physics | **Rapier.js** (WASM) or `cannon-es` | Object collision, gravity, gripper |
| Episode Recording | **Custom JS module** | Captures joint states + rendered frames |
| Virtual Camera | **A-Frame camera entity** | Renders 256x256 view for training data |
| Real Robot Link | **WebSocket to Jetson** | Real-time servo control (Mode 2) |
| Training Backend | **Python on Mac** | SmolVLA fine-tuning via LeRobot |
| Data Storage | **IndexedDB / REST API** | Episodes stored locally or on server |

---

## A-Frame Components to Build

### 1. `urdf-robot` Component
Loads a URDF file and creates an A-Frame entity hierarchy.

```html
<a-entity urdf-robot="src: /models/jetarm.urdf; 
                       scale: 1;
                       jointHighlight: true"
          position="0 1 -2">
</a-entity>
```

**Responsibilities:**
- Parse URDF XML → extract joints, links, meshes
- Create `<a-entity>` for each link with correct transforms
- Create joint controls with min/max limits
- Expose API: `setJointAngle(name, angle)`, `getJointAngles()`
- Visual: highlight active joints, show angle labels

### 2. `hand-ik-control` Component
Maps VR hand positions to robot joint angles via inverse kinematics.

```html
<a-entity hand-ik-control="target: #jetarm;
                            hand: right;
                            mode: gripper">
</a-entity>
```

**Responsibilities:**
- Track right hand pinch gesture → gripper open/close
- Track hand position → IK solve for joint angles
- Smooth output to prevent jitter
- Visual: show ghost target position

### 3. `episode-recorder` Component
Records training episodes from VR demonstrations.

```html
<a-entity episode-recorder="fps: 10;
                             cameraEntity: #virtual-cam;
                             robotEntity: #jetarm;
                             taskName: pick_red_block">
</a-entity>
```

**Responsibilities:**
- Record joint angles at specified FPS
- Capture virtual camera renders as image frames (256x256)
- Save episodes in LeRobot-compatible format
- Track episode count, duration, metadata
- Upload to training server via REST API

### 4. `virtual-camera` Component
Renders the scene from the robot's camera perspective.

```html
<a-entity id="virtual-cam"
          virtual-camera="width: 256; height: 256; fps: 10"
          position="0 1.5 -1.5"
          rotation="-30 0 0">
</a-entity>
```

**Responsibilities:**
- Render to offscreen canvas at specified resolution
- Match real camera FOV and position on JetArm
- Output frames as base64 or ImageData for recording
- Display as PiP in VR for user reference

---

## Scene Layout

```html
<a-scene>
  <!-- Environment -->
  <a-plane position="0 0 0" rotation="-90 0 0" width="4" height="4" 
           color="#444" shadow></a-plane>
  
  <!-- Robot Arm (from URDF) -->
  <a-entity id="jetarm"
            urdf-robot="src: /models/jetarm.urdf"
            position="0 1 -2"
            episode-recorder="fps: 10; cameraEntity: #robot-cam">
  </a-entity>
  
  <!-- Task Objects -->
  <a-box id="red-block" color="#e74c3c" width="0.04" height="0.04" depth="0.04"
         position="0.15 1.02 -2" dynamic-body class="grabbable">
  </a-box>
  <a-box id="blue-block" color="#3498db" width="0.04" height="0.04" depth="0.04"
         position="-0.1 1.02 -2.1" dynamic-body class="grabbable">
  </a-box>
  <a-cylinder id="target-zone" color="#2ecc71" radius="0.08" height="0.005"
              position="0.2 1.001 -1.8" opacity="0.5">
  </a-cylinder>
  
  <!-- Robot's Camera View (matches real camera position) -->
  <a-entity id="robot-cam"
            virtual-camera="width: 256; height: 256"
            position="0 1.4 -1.6" rotation="-35 0 0">
  </a-entity>
  
  <!-- Hand Tracking -->
  <a-entity id="left-hand" hand-tracking-controls="hand: left"></a-entity>
  <a-entity id="right-hand" hand-tracking-controls="hand: right"
            hand-ik-control="target: #jetarm; mode: gripper">
  </a-entity>
  
  <!-- UI Panel -->
  <a-entity position="-1 1.5 -2" rotation="0 30 0">
    <a-plane width="0.6" height="0.4" color="#1a1a2e" opacity="0.9">
      <a-text value="JetArm VR Trainer" position="0 0.15 0.01" 
              align="center" color="#fff" width="0.5"></a-text>
      <a-text id="episode-count" value="Episodes: 0/50" 
              position="0 0.05 0.01" align="center" color="#0f0" width="0.4"></a-text>
      <a-text id="status" value="Status: Ready" 
              position="0 -0.05 0.01" align="center" color="#ff0" width="0.4"></a-text>
    </a-plane>
  </a-entity>
  
  <!-- Lighting -->
  <a-light type="ambient" intensity="0.6"></a-light>
  <a-light type="directional" position="1 3 2" intensity="0.8" 
           cast-shadow="true"></a-light>
</a-scene>
```

---

## Episode Data Format (LeRobot Compatible)

Each recorded episode produces:

```json
{
  "episode_id": 42,
  "task": "pick_red_block",
  "source": "vr_simulation",
  "fps": 10,
  "num_frames": 53,
  "frames": [
    {
      "timestamp": 0.0,
      "observation": {
        "state": [145.2, 67.8, 23.1, 90.0, 156.3, 0.0],
        "images": {
          "camera1": "base64_encoded_256x256_image..."
        }
      },
      "action": [146.1, 68.2, 22.8, 90.1, 155.9, 0.0]
    }
  ]
}
```

**State vector (6 DOF):** `[joint1, joint2, joint3, joint4, joint5, gripper]`
- Joints 1-5: degrees (matching real servo range)
- Gripper: 0.0 (open) to 1.0 (closed)

---

## URDF Loading Pipeline

### Step 1: Parse URDF
```
HiWonder URDF file (.urdf)
    ↓ XML Parser
Joint/Link hierarchy + mesh references
    ↓ 
Create A-Frame entity tree
    ↓
Apply joint limits, visual meshes
```

### Step 2: JetArm Joint Mapping
| URDF Joint | Servo ID | Range | DOF |
|-----------|----------|-------|-----|
| joint1 (base rotation) | ID 6 | 0-240° | Yaw |
| joint2 (shoulder) | ID 5 | 0-240° | Pitch |
| joint3 (elbow) | ID 4 | 0-240° | Pitch |
| joint4 (wrist pitch) | ID 3 | 0-240° | Pitch |
| joint5 (wrist rotate) | ID 2 | 0-240° | Roll |
| gripper | ID 1 | open/close | Grip |

### Step 3: Mesh Loading
- URDF may reference STL or DAE mesh files
- Convert to glTF/GLB for A-Frame compatibility
- If no meshes provided, use primitive shapes (cylinders, boxes)

---

## Integration with Robo Monitor Dashboard

The VR simulator can be launched from the Robo Monitor dashboard:

### Dashboard UI
```
[Control] [Camera] [Training] [🆕 Simulator]

┌─ Simulator Tab ──────────────────────────────────┐
│                                                    │
│  🎮 Launch VR Training                            │
│  Opens XR Creator Studio with JetArm scene         │
│                                                    │
│  📊 Episodes Collected: 47/50                      │
│  ├─ Real (Joystick): 12                           │
│  ├─ VR Sim: 28                                    │
│  └─ Auto Sim: 7                                   │
│                                                    │
│  🧠 Training Status                               │
│  Model: SmolVLA v2                                 │
│  Last trained: 2 hours ago                         │
│  Loss: 0.019                                       │
│                                                    │
│  [🚀 Start Training] [📦 Deploy to Jetson]        │
│                                                    │
└────────────────────────────────────────────────────┘
```

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/episodes` | GET | List all collected episodes |
| `/api/episodes` | POST | Upload new episode from VR |
| `/api/training/start` | POST | Start SmolVLA fine-tuning |
| `/api/training/status` | GET | Training progress, loss, ETA |
| `/api/model/deploy` | POST | Send trained model to Jetson |
| `/api/model/versions` | GET | List model versions |
| `/api/simulator/config` | GET | Get URDF path, task config |

---

## Crowdsourced Training (Future)

Since this is browser-based:
1. Share a link to the VR training scene
2. Anyone with a Quest/Vision Pro can demonstrate tasks
3. Episodes upload to your training server
4. More demonstrations = better model
5. Track contributor stats, episode quality scores

---

## Dependencies

### NPM Packages
```
aframe                    # Core A-Frame
aframe-extras             # Additional controls
three                     # Underlying 3D engine (URDF parsing)
urdf-loader               # Three.js URDF parser (use under the hood)
rapier3d-compat           # WASM physics engine (optional)
```

### Custom Components to Build
```
src/aframe/
  ├── urdf-robot.js           # URDF loader component
  ├── hand-ik-control.js      # Hand tracking → IK → joint angles
  ├── episode-recorder.js     # Record demos as training episodes
  ├── virtual-camera.js       # Render from robot camera POV
  ├── joint-visualizer.js     # Show joint angles, limits
  └── websocket-bridge.js     # Connect to real robot (Mode 2)
```

---

## Build Phases

### Phase 1: Static URDF Viewer
- Load URDF into A-Frame
- Render robot arm with correct joint hierarchy
- Manual joint angle sliders for testing

### Phase 2: Hand Tracking Control
- WebXR hand tracking integration
- IK solver for hand → joint mapping
- Smooth joint interpolation

### Phase 3: Episode Recording
- Virtual camera rendering
- Joint state capture at 10 Hz
- LeRobot-compatible episode format
- Upload to training server

### Phase 4: Real Robot Bridge
- WebSocket to Jetson for teleoperation
- Real camera feed overlay in VR
- Latency optimization (< 100ms)

### Phase 5: AI Visualization
- Load trained model in browser (ONNX runtime)
- Show predicted actions in VR
- Confidence visualization
- Failure case identification
