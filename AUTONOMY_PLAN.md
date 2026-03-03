# JetArm Autonomous Robot — Implementation Plan

## Current System Architecture

```
┌────────────────────────────────────┐         ┌─────────────────────────┐
│     JETSON ORIN NANO               │         │       MAC MINI          │
│     (Edge / Real-time)             │  HTTP   │    (Brain / Planning)   │
│                                    │◄───────►│                         │
│  Camera (Orbbec RGB-D)             │  :8888  │  LLM (Qwen via Ollama) │
│  TensorRT YOLO (30 FPS)           │  :8889  │  TTS (Kokoro)           │
│  Depth Sensor                      │         │  Dashboard (Next.js)    │
│  Servo Control (ROS2)              │         │  Scene VLM (MiniCPM-V)  │
│  Bridge API + Safety Layer         │         │                         │
│  Vision API                        │         │                         │
│  Action Memory (SQLite)            │         │                         │
│  Gamepad Input                     │         │                         │
└────────────────────────────────────┘         └─────────────────────────┘
```

## Progress Status

| Phase | Feature | Status | Details |
|-------|---------|--------|---------|
| 1 | Wire Vision Into AI | ✅ Done | YOLO state fetched before every AI call |
| 2 | World State Model | ✅ Done | Unified `/world_state` endpoint in bridge |
| 3 | Camera Calibration | ✅ Done | pixel+depth → arm XYZ transform |
| 4 | Autonomous Loop | ✅ Done | Sense→Think→Act loop with LLM |
| 4b | VLM Integration | ✅ Done | `look` action for scene understanding |
| **5** | **Safety Layer** | **✅ Done** | **Hardware-level joint limits, clamping, safety log** |
| 6 | Overhead Camera | ✅ Done | Third-person workspace view |
| **7** | **Memory & Learning** | **✅ Done** | **SQLite action log, session tracking, lessons** |
| 8 | Autonomy Dashboard | ✅ Done | Goal input, live action log, start/stop |

---

## ⚠️ Hardware Issues

| Issue | Status | Details |
|-------|--------|---------|
| Shoulder gear (servo 2) | 🔴 Broken | Cannot go below position 400 or arm collapses. Safety layer enforces min=400. |
| Camera orientation | 🟡 Needs work | Camera faces upward at home position. Correct table-view angles not yet found. |

---

## Phase 5: Safety Layer ✅ IMPLEMENTED

### What It Does
**Hardware-level protection** that runs in the bridge on EVERY move command — regardless of source (dashboard, chat, autonomy, gamepad). No command can bypass it.

### Features
1. **Joint Limits** — Configurable per-servo min/max position limits
   - Servo 2 (shoulder): min 400 (broken gear protection)
   - Servo 10 (gripper): range 50-600
   - All others: full 0-1000 range (configurable)
2. **Automatic Clamping** — Dangerous positions silently clamped to safe range
3. **Safety Event Log** — Every clamped command logged with timestamp, servo ID, requested vs actual
4. **Minimum Duration** — 200ms minimum move time to prevent jerky movements
5. **Configurable via API** — Limits can be updated at runtime via `set_safety_limits` action
6. **Persistent Config** — Limits saved to `safety_limits.json`

### API Endpoints
```
POST /bridge { action: "safety_status" }        → Current limits + event log
POST /bridge { action: "set_safety_limits", limits: { "2": { "min": 450 } } }  → Update limits
```

### Files Modified
- `jetarm_bridge.py` — Safety enforcement in `move_servos()`, limit config, endpoints

---

## Phase 7: Memory & Learning ✅ IMPLEMENTED

### What It Does
Persistent **SQLite database** logging every autonomous action and its result, so the AI can learn from past experience.

### Features
1. **Action Log** — Every action stored with: goal, step, action type, JSON details, result, success/fail, scene context, servo positions
2. **Session Tracking** — Each autonomy run is a session (start time, end time, goal, success)
3. **Lessons Learned** — Manual or AI-generated insights stored with confidence scores
4. **Context Retrieval** — Before each autonomy run, past experience for similar goals is loaded and fed to the LLM
5. **Success Rate Tracking** — Per-action-type and overall success rates
6. **Query API** — Multiple endpoints for stats, context, logging

### API Endpoints
```
POST /bridge { action: "memory_session_start", goal: "..." }  → Start session
POST /bridge { action: "memory_log", goal, step, action_type, result, success, ... }  → Log action
POST /bridge { action: "memory_context", goal: "..." }        → Get past experience
POST /bridge { action: "memory_stats" }                        → Get overall stats
POST /bridge { action: "memory_session_end", session_id, total_steps, success }  → End session
POST /bridge { action: "memory_lesson", category, lesson, confidence }  → Add learned lesson
```

### How the AI Uses Memory
At the start of each autonomy run:
1. A session is created in the DB
2. Past experience for similar goals is retrieved
3. The context is injected into the LLM prompt
4. Every action → result is logged in real-time
5. Session ends with success/failure status

### Files Created
- `action_memory.py` — SQLite-backed memory system with ActionMemory class
- `jetarm_memory.db` — Persistent database on Jetson (auto-created)

### Files Modified
- `jetarm_bridge.py` — Memory API endpoints (6 new actions)
- `autonomy/route.ts` — Session tracking + action logging + context retrieval
- `page.tsx` — MEMORY phase display in autonomy log

---

## Remaining Work

### 🔴 Critical (Needed for Object Manipulation)
| Task | Priority | Details |
|------|----------|---------|
| Fix camera angle | 🔥🔥🔥 | Find servo positions that point camera at table. Essential for vision-guided tasks. |
| Repair/replace shoulder servo | 🔥🔥🔥 | Servo 2 gear is broken. Limits downward reach significantly. |

### 🟡 Important (Enhances Autonomy)
| Task | Priority | Details |
|------|----------|---------|
| Auto-lesson extraction | 🔥🔥 | After each session, have the LLM analyze what worked/failed and write lessons |
| Depth-based collision check | 🔥🔥 | Use depth map to check movement path is clear before acting |
| Memory-informed prompting | 🔥 | Feed success rates and learned lessons into the autonomy prompt |
| Workspace boundary IK check | 🔥 | Validate IK targets are within reachable workspace before attempting |

### 🟢 Nice to Have (Future Improvements)
| Task | Priority | Details |
|------|----------|---------|
| Fine-tune on successful grasps | ⭐ | Train a small model on historical success patterns |
| Multi-step planning | ⭐ | Break complex goals into verified sub-goals |
| Object permanence | ⭐ | Track objects across frames, remember where things are |
| Adaptive approach angles | ⭐ | Adjust grasp angles based on historical success rates |

---

## Quick Reference: Key Endpoints

| Endpoint | Port | What It Does |
|----------|------|-------------|
| JetArm Bridge | `:8888` | Servo control, IK, safety, memory, world state |
| Vision State | `:8889` | YOLO detections + FPS (instant) |
| Camera Stream | `:8080` | MJPEG video streams |
| Dashboard | `:3000` | Web UI (Mac Mini) |
| Ollama LLM | `:11434` | Qwen 2.5 7B reasoning |

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| `jetarm_bridge.py` | Jetson | Core control bridge with safety + memory |
| `action_memory.py` | Jetson | SQLite memory system |
| `spatial_calibration.py` | Jetson | Camera-to-arm coordinate transform |
| `safety_limits.json` | Jetson | Configurable joint limits |
| `jetarm_memory.db` | Jetson | Persistent action/session database |
| `autonomy/route.ts` | Mac Mini | Autonomy loop + LLM integration |
| `page.tsx` | Mac Mini | Dashboard UI |
