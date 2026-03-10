import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { z } from 'zod';

const ollama = createOllama({ baseURL: 'http://localhost:11434' });
const AI_API = 'http://localhost:3000/api/ai';
const BRIDGE_URL = 'http://192.168.1.246:8888';
const CAMERA_SNAPSHOT = 'http://192.168.1.246:8080/snapshot?topic=/depth_cam/color/image_raw';
// Single unified model: Qwen 3.5 handles text + vision + tools + thinking
const UNIFIED_MODEL = 'qwen3.5:9b';

const BASE_PROMPT = `You are JetArm AI — the intelligent brain of a HiWonder JetArm 5-DOF robotic arm. You are fast, responsive, and move with purpose.

## Your Capabilities
- **look**: SEE through the camera! ALWAYS use this when asked what you see.
- **move_arm**: Move multiple servos at once for fluid motion (PREFERRED — always use this)
- **move_to_position**: Move gripper to XYZ coordinates using inverse kinematics
- **set_gripper**: Open/close the gripper
- **go_home**: Return to neutral center position
- **read_servo_positions**: Check current servo positions
- **play_buzzer**: Beep sound

## Servo Map (all range 0-1000 pulse, 500=center)
| ID | Joint | Notes |
|----|-------|-------|
| 1 | Base | Left/right rotation |
| 2 | Shoulder | Higher = arm up |
| 3 | Elbow | Higher = elbow up |
| 4 | Wrist pitch | Higher = tilt up |
| 5 | Wrist rotate | Twist wrist |
| 10 | Gripper | 100=closed, 500=open |

## SPEED RULES
The joystick controller moves at 40ms micro-steps. Since you send single big moves, use longer durations:
1. **Default duration: 1000ms** — matches the joystick feel for normal moves
2. **Use 800ms** for small moves (< 100 pulse change)
3. **Use 1500ms** for large moves (> 300 pulse change)
4. **Use 500ms** for gripper open/close
5. Move ALL relevant servos in ONE move_arm call
6. For gestures (wave, nod), use 600-800ms per step
7. When asked what you see, ALWAYS use look — never guess
8. Keep responses concise and action-oriented`;

// Fetch current servo positions from bridge to give AI context
async function getServoContext(): Promise<string> {
    try {
        const res = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'read_servos' }),
            signal: AbortSignal.timeout(2000),
        });
        const data = await res.json();
        if (data.success && data.servos) {
            const positions = data.servos
                .map((s: { id: number; position: number }) => `S${s.id}=${s.position}`)
                .join(' ');
            return `\n\n## Current Arm Position\n${positions}\n(Use these as starting reference. Plan moves relative to these values.)`;
        }
    } catch { /* bridge offline */ }
    return '';
}

// Fetch real-time YOLO detections (with depth) from TensorRT vision server
async function getVisionContext(): Promise<string> {
    try {
        const res = await fetch('http://192.168.1.246:8889/state', {
            signal: AbortSignal.timeout(1000),
        });
        const data = await res.json();
        if (data.objects && data.objects.length > 0) {
            const objs = data.objects.map((o: any) =>
                `- ${o.class} (${(o.confidence * 100).toFixed(0)}%) at pixel[${o.center_px[0]},${o.center_px[1]}]${o.depth_mm > 0 ? ` depth:${o.depth_mm}mm` : ''} size:${o.size_px[0]}x${o.size_px[1]}px`
            ).join('\n');
            return `\n\n## What I Can See Right Now (YOLO TensorRT ${data.fps} FPS)\n${objs}\n\nUse depth_mm to estimate distance. Objects at 80-280mm are within arm reach.`;
        }
        return '\n\n## Vision: No objects detected in view';
    } catch {
        return '\n\n## Vision: YOLO not running';
    }
}

async function callAI(action: string, params: Record<string, any> = {}) {
    const res = await fetch(AI_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...params }),
    });
    return res.json();
}

export async function POST(req: Request) {
    try {
        const { messages: uiMessages } = await req.json() as { messages: UIMessage[] };
        const modelMessages = await convertToModelMessages(uiMessages);

        // Fetch both servo state AND vision state in parallel
        const [servoContext, visionContext] = await Promise.all([
            getServoContext(),
            getVisionContext(),
        ]);
        const systemPrompt = BASE_PROMPT + servoContext + visionContext;

        const result = streamText({
            model: ollama(UNIFIED_MODEL),
            system: systemPrompt,
            messages: modelMessages,
            tools: {
                move_arm: {
                    description: 'Move multiple servos simultaneously for smooth, fluid motion. Always prefer this over move_servo. Send all servos that need to move in one call.',
                    inputSchema: z.object({
                        positions: z.array(z.object({
                            id: z.number().describe('Servo ID: 1=base, 2=shoulder, 3=elbow, 4=wrist, 5=wrist_rotate, 10=gripper'),
                            position: z.number().min(0).max(1000).describe('Target position 0-1000 (500=center)'),
                        })).describe('Array of servo positions to set simultaneously'),
                        duration: z.number().min(200).max(5000).default(1000).describe('Movement duration in ms. 800=fast, 1000=normal, 1500=slow/safe.'),
                    }),
                    execute: async ({ positions, duration }: { positions: { id: number; position: number }[]; duration: number }) => {
                        const data = await callAI('move_arm', { positions, duration: duration || 1000 });
                        return { success: data.success, message: data.message };
                    },
                },

                move_to_position: {
                    description: 'Move the arm end-effector to XYZ coordinates using inverse kinematics. Best for reaching specific positions in 3D space. Units in meters. Workspace: x=0.08-0.28, y=-0.15-0.15, z=0.02-0.35.',
                    inputSchema: z.object({
                        x: z.number().describe('Forward distance in meters (0.08-0.28, typical: 0.15-0.20)'),
                        y: z.number().describe('Left/right in meters (-0.15 to 0.15, 0=center)'),
                        z: z.number().describe('Height in meters (0.02-0.35, 0.10=low, 0.25=high)'),
                        pitch: z.number().default(-90).describe('Gripper pitch angle in degrees (-90=pointing down, 0=horizontal)'),
                        duration: z.number().min(500).max(5000).default(1200).describe('Duration ms. 1000=normal, 1500=smooth.'),
                    }),
                    execute: async ({ x, y, z, pitch, duration }: { x: number; y: number; z: number; pitch: number; duration: number }) => {
                        const data = await callAI('move_to_xyz', { x, y, z, pitch: pitch || -90, duration: duration || 1200 });
                        return { success: data.success, message: data.message, pulses: data.pulses };
                    },
                },

                move_servo: {
                    description: 'Move a single servo. Use move_arm instead for multi-servo moves.',
                    inputSchema: z.object({
                        servo_id: z.number().min(1).max(10).describe('Servo ID'),
                        position: z.number().min(0).max(1000).describe('Position 0-1000'),
                        duration: z.number().min(200).max(5000).default(1000).describe('Duration ms'),
                    }),
                    execute: async ({ servo_id, position, duration }: { servo_id: number; position: number; duration: number }) => {
                        const data = await callAI('move_servo', { servo_id, position, duration: duration || 1000 });
                        return { success: data.success, message: data.message };
                    },
                },

                set_gripper: {
                    description: 'Open or close the robot gripper.',
                    inputSchema: z.object({
                        state: z.enum(['open', 'close']).describe('open or close'),
                    }),
                    execute: async ({ state }: { state: 'open' | 'close' }) => {
                        const position = state === 'open' ? 500 : 100;
                        const data = await callAI('move_servo', { servo_id: 10, position, duration: 500 });
                        return { success: data.success, message: `Gripper ${state}ed` };
                    },
                },

                go_home: {
                    description: 'Return the robot arm to its neutral home position (all servos centered at 500).',
                    inputSchema: z.object({
                        duration: z.number().default(1500).describe('Duration ms'),
                    }),
                    execute: async ({ duration }: { duration: number }) => {
                        const data = await callAI('home', { duration: duration || 1500 });
                        return { success: data.success, message: data.message };
                    },
                },

                read_servo_positions: {
                    description: 'Read the current position of all servos on the robot.',
                    inputSchema: z.object({}),
                    execute: async () => {
                        const data = await callAI('read_servos');
                        return { success: data.success, servos: data.servos };
                    },
                },

                look: {
                    description: 'Look through the robot camera and describe what you see using AI vision. Use this whenever asked what you see, to find objects, or before interacting with the environment.',
                    inputSchema: z.object({
                        question: z.string().default('Describe what you see in detail, including objects, their colors, positions, and approximate distances from the robot.').describe('Specific question to ask about the scene'),
                    }),
                    execute: async ({ question }: { question: string }) => {
                        try {
                            // Save snapshot via camera API (for frontend to display)
                            await fetch('http://localhost:3000/api/camera', { method: 'POST' });

                            // Grab camera frame for vision analysis
                            const imgRes = await fetch(CAMERA_SNAPSHOT, { signal: AbortSignal.timeout(5000) });
                            if (!imgRes.ok) return { success: false, description: 'Camera not available' };
                            const imgBuffer = await imgRes.arrayBuffer();
                            const imgBase64 = Buffer.from(imgBuffer).toString('base64');

                            const visionContext = `You are the eyes of a HiWonder JetArm 5-DOF robotic arm looking through an Orbbec depth camera. Your workspace is a table/desk in front of you. Focus on objects the robot could interact with — their colors, sizes, positions (left/right/center, near/far). Keep your description practical and concise (2-4 sentences).`;

                            // Use the SAME Qwen2.5-VL model for vision — no separate model needed!
                            const visionRes = await fetch('http://localhost:11434/api/chat', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model: UNIFIED_MODEL,
                                    messages: [
                                        { role: 'system', content: visionContext },
                                        { role: 'user', content: question || 'What do you see?', images: [imgBase64] },
                                    ],
                                    stream: false,
                                }),
                                signal: AbortSignal.timeout(30000),
                            });
                            const visionData = await visionRes.json();
                            return {
                                success: true,
                                description: visionData.message?.content || 'Could not analyze image',
                                snapshot_url: '/api/camera',
                            };
                        } catch (err: any) {
                            return { success: false, description: 'Vision failed: ' + (err.message || 'unknown error') };
                        }
                    },
                },

                play_buzzer: {
                    description: 'Play a beep sound on the robot.',
                    inputSchema: z.object({
                        freq: z.number().default(1000).describe('Frequency in Hz'),
                        repeat: z.number().default(1).describe('Number of beeps'),
                    }),
                    execute: async ({ freq, repeat }: { freq: number; repeat: number }) => {
                        const data = await callAI('buzzer', { freq: freq || 1000, on_time: 0.2, repeat: repeat || 1 });
                        return { success: data.success, message: data.message };
                    },
                },
            },
            stopWhen: stepCountIs(5),
            onError: (error) => {
                console.error('💬 Chat streamText error:', error);
            },
        });

        return result.toUIMessageStreamResponse();
    } catch (err) {
        console.error('💬 Chat route error:', err);
        return new Response(JSON.stringify({ error: 'Chat failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
