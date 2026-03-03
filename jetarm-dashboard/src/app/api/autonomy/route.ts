import { NextResponse } from 'next/server';

const BRIDGE_URL = 'http://192.168.1.246:8888';
const VISION_URL = 'http://192.168.1.246:8889/state';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const CAMERA_SNAPSHOT_URL = 'http://192.168.1.246:8080/snapshot?topic=/depth_cam/color/image_raw';

// Autonomy state — shared across requests
let autonomyState = {
    running: false,
    goal: '',
    step: 0,
    maxSteps: 30,
    log: [] as { step: number; phase: string; content: string; time: number }[],
    startTime: 0,
    sessionId: '' as string,
    systemPrompt: '' as string,
    consecutiveErrors: 0,
};

function addLog(phase: string, content: string) {
    autonomyState.log.push({
        step: autonomyState.step,
        phase,
        content,
        time: Date.now(),
    });
    // Keep last 500 entries
    if (autonomyState.log.length > 500) {
        autonomyState.log = autonomyState.log.slice(-500);
    }
}

async function getWorldState(): Promise<any> {
    try {
        const res = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'world_state' }),
            signal: AbortSignal.timeout(2000),
        });
        const data = await res.json();
        return data.state || {};
    } catch {
        return { error: 'Bridge not reachable' };
    }
}

async function executeAction(action: any): Promise<string> {
    try {
        const res = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action),
            signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        return data.success ? (data.message || 'OK') : (data.error || 'Failed');
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

async function askLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
        const res = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen2.5:7b',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: { temperature: 0.3, num_predict: 300 },
            }),
            signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        return data.message?.content || 'No response';
    } catch (e: any) {
        return `LLM Error: ${e.message}`;
    }
}

// VLM look — uses MiniCPM-V to describe what the camera sees
async function lookWithVLM(question: string): Promise<string> {
    try {
        const imgRes = await fetch(CAMERA_SNAPSHOT_URL, { signal: AbortSignal.timeout(5000) });
        if (!imgRes.ok) return 'Camera not available';
        const imgBuffer = await imgRes.arrayBuffer();
        const imgBase64 = Buffer.from(imgBuffer).toString('base64');

        const visionRes = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'minicpm-v',
                messages: [
                    { role: 'system', content: 'You are the eyes of a robot arm looking through its camera. Describe what you see concisely — focus on objects, their colors, positions (left/center/right, near/far), and sizes. Be specific about colors and shapes. Keep it to 2-4 sentences.' },
                    { role: 'user', content: question, images: [imgBase64] },
                ],
                stream: false,
                options: { num_predict: 200 },
            }),
            signal: AbortSignal.timeout(30000),
        });
        const data = await visionRes.json();
        return data.message?.content || 'Could not analyze image';
    } catch (e: any) {
        return `Vision failed: ${e.message}`;
    }
}

const AUTONOMY_BASE_PROMPT = `You are an autonomous robot arm controller. You receive world state and decide the NEXT SINGLE ACTION.

## Servo IDs & Ranges (0-1000, 500=center)
| ID | Joint | Notes |
|----|-------|-------|
| 1  | Base rotation | 0=right, 500=center, 1000=left |
| 2  | Shoulder | ⚠️ BROKEN GEAR: MIN 400! 400=up, 500=level, 800=forward/down |
| 3  | Elbow | 100=up, 500=level, 800=down |
| 4  | Wrist pitch | 200=up, 800=down |
| 5  | Wrist rotate | 0-1000 rotation |
| 10 | Gripper | 100=closed, 500=open |

## To look DOWN at the table workspace
Move servo 2 to ~750 AND servo 3 to ~400: {"action":"move_arm","positions":[{"id":2,"position":750},{"id":3,"position":400}],"duration":1000}

## Available Actions — USE ONLY THESE EXACT FORMATS
1. Move servos: {"action":"move_arm","positions":[{"id":2,"position":700},{"id":3,"position":400}],"duration":1000}
2. Open gripper: {"action":"move_arm","positions":[{"id":10,"position":500}],"duration":500}
3. Close gripper: {"action":"move_arm","positions":[{"id":10,"position":150}],"duration":500}
4. Go home: {"action":"home","duration":1000}
5. Move to YOLO object: {"action":"move_to_object","class":"bottle","approach_height":0.03,"duration":1500}
6. AI Vision (see scene): {"action":"look","question":"Do you see any colored cubes or blocks? Where are they?"}
7. Done: {"action":"DONE","reason":"goal complete"}
8. Wait: {"action":"WAIT","reason":"waiting for movement"}
9. Cannot: {"action":"CANNOT","reason":"why impossible"}

## CRITICAL RULES
- ONLY use actions listed above! Do NOT invent actions like "rotate_base", "scan", "grab".
- To rotate the base: {"action":"move_arm","positions":[{"id":1,"position":600}],"duration":1000}
- Respond with ONLY a JSON action. No text, no explanation, just the JSON object.

## YOLO Detection Limits
YOLO detects standard objects: person, bottle, cup, bowl, chair, tv, laptop, keyboard, cell phone, book, etc.
YOLO CANNOT detect: colored cubes, blocks, game pieces, markers, cards, small custom objects.

If the goal mentions something YOLO can't detect (like "green cube", "colored block"):
1. First point camera at the table: {"action":"move_arm","positions":[{"id":2,"position":750},{"id":3,"position":400}],"duration":1000}
2. WAIT
3. Use "look" to see with AI vision: {"action":"look","question":"Do you see any green cubes on the table? Where exactly?"}
4. Use the description to guide your servo movements

## Spatial Data
Objects with arm_xyz data and reachable=true can be reached with move_to_object.
Objects without arm_xyz or with reachable=false cannot — use manual servo control to approach.

## Strategy
- Move max 2-3 servos per action
- Duration: 1000ms normal, 1500ms big moves, 500ms gripper
- WAIT after every physical move
- Use "look" when YOLO can't find your target
- Plan efficiently`;

// ═══════════════════════════════════════════════════════════════════════════════
// LEARNING: Fetch memory stats + lessons to inform the AI
// ═══════════════════════════════════════════════════════════════════════════════
async function getMemoryIntel(goal: string): Promise<{ context: string; lessons: string; stats: string }> {
    let context = '';
    let lessons = '';
    let stats = '';

    // 1. Past experience for similar goals
    try {
        const ctxRes = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'memory_context', goal }),
            signal: AbortSignal.timeout(2000),
        });
        const ctxData = await ctxRes.json();
        if (ctxData.context && ctxData.context !== 'No past experience with similar goals.') {
            context = ctxData.context;
        }
    } catch { /* non-critical */ }

    // 2. Learned lessons
    try {
        const lessonRes = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'memory_lessons', limit: 10 }),
            signal: AbortSignal.timeout(2000),
        });
        const lessonData = await lessonRes.json();
        if (lessonData.lessons && lessonData.lessons.length > 0) {
            lessons = lessonData.lessons
                .map((l: any) => `• [${l.category}] ${l.lesson} (confidence: ${(l.confidence * 100).toFixed(0)}%)`)
                .join('\n');
        }
    } catch { /* non-critical */ }

    // 3. Success rate stats
    try {
        const statsRes = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'memory_stats' }),
            signal: AbortSignal.timeout(2000),
        });
        const statsData = await statsRes.json();
        if (statsData.stats) {
            const s = statsData.stats;
            const rate = s.success_rate_24h;
            stats = `Total actions: ${s.total_actions} | Sessions: ${s.total_sessions} | Lessons: ${s.total_lessons}`;
            if (rate.total > 0) {
                stats += ` | 24h success rate: ${rate.rate.toFixed(0)}% (${rate.successes}/${rate.total})`;
            }
            if (s.common_actions?.length > 0) {
                stats += `\nMost used: ${s.common_actions.map((a: any) => `${a.type}(${a.count}x)`).join(', ')}`;
            }
        }
    } catch { /* non-critical */ }

    return { context, lessons, stats };
}

function buildSystemPrompt(memoryContext: string, memoryLessons: string, memoryStats: string): string {
    let prompt = AUTONOMY_BASE_PROMPT;

    if (memoryStats) {
        prompt += `\n\n## Your Performance Stats\n${memoryStats}`;
    }

    if (memoryLessons) {
        prompt += `\n\n## Lessons Learned (from past experience — follow these!)\n${memoryLessons}`;
    }

    if (memoryContext) {
        prompt += `\n\n## Past Experience With Similar Goals\n${memoryContext}`;
    }

    return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-LESSON EXTRACTION: After a session, LLM analyzes what happened
// ═══════════════════════════════════════════════════════════════════════════════
async function extractLessonsFromSession(goal: string, log: typeof autonomyState.log, wasSuccess: boolean, sessionId: string) {
    // Build a summary of what happened
    const actionLog = log
        .filter(l => ['ACT', 'RESULT', 'LOOK', 'DONE', 'CANNOT', 'ERROR'].includes(l.phase))
        .map(l => `Step ${l.step} [${l.phase}]: ${l.content}`)
        .join('\n');

    if (!actionLog) return; // Nothing to analyze

    const analysisPrompt = `You are a robot learning system. A robot arm just completed an autonomy session. Analyze what happened and extract 1-3 specific, actionable lessons.

Goal: "${goal}"
Outcome: ${wasSuccess ? 'SUCCESS ✅' : 'FAILED ❌'}
Total Steps: ${log.length}

Action Log:
${actionLog}

For each lesson, respond with EXACTLY this JSON format (array of objects):
[{"category": "grasping|navigation|vision|planning|servo_positions", "lesson": "specific actionable lesson", "confidence": 0.5-1.0}]

Examples of GOOD lessons:
- {"category": "servo_positions", "lesson": "To look at the table, servo 2=750 and servo 3=400 works well", "confidence": 0.8}
- {"category": "grasping", "lesson": "Closing gripper to 150 is too tight for cups, use 200 instead", "confidence": 0.7}
- {"category": "planning", "lesson": "Always look before trying to grab — blind grabs fail 80% of the time", "confidence": 0.9}
- {"category": "vision", "lesson": "YOLO cannot detect colored blocks, must use look action for custom objects", "confidence": 1.0}

Respond with ONLY the JSON array. No other text.`;

    try {
        const response = await askLLM('You extract lessons from robot arm sessions. Respond only with a JSON array.', analysisPrompt);
        const jsonMatch = response.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (!jsonMatch) return;

        const lessons = JSON.parse(jsonMatch[0]);
        let savedCount = 0;

        for (const lesson of lessons) {
            if (lesson.category && lesson.lesson) {
                try {
                    await fetch(BRIDGE_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'memory_lesson',
                            category: lesson.category,
                            lesson: lesson.lesson,
                            confidence: lesson.confidence || 0.5,
                            session_id: sessionId,
                        }),
                        signal: AbortSignal.timeout(2000),
                    });
                    savedCount++;
                } catch { /* non-critical */ }
            }
        }

        if (savedCount > 0) {
            addLog('LEARN', `🧠 Extracted ${savedCount} lesson(s) from this session`);
        }
    } catch { /* lesson extraction is non-critical */ }
}

async function runOneStep() {
    if (!autonomyState.running) return;

    autonomyState.step++;
    if (autonomyState.step > autonomyState.maxSteps) {
        addLog('STOP', `Reached max steps (${autonomyState.maxSteps})`);
        autonomyState.running = false;
        return;
    }

    // 1. SENSE — get world state
    addLog('SENSE', 'Reading world state...');
    const worldState = await getWorldState();

    const stateStr = JSON.stringify({
        servos: worldState.servos,
        gripper: worldState.gripper,
        arm_objects: worldState.objects?.map((o: any) => ({
            class: o.class,
            confidence: Math.round(o.confidence * 100) + '%',
            pixel: o.center_px,
            depth_mm: o.depth_mm,
            size: o.size_px,
            arm_xyz: o.arm_xyz ? {
                x: o.arm_xyz.x,
                y: o.arm_xyz.y,
                z: o.arm_xyz.z,
                reachable: o.arm_xyz.reachable,
                distance: o.arm_xyz.distance,
            } : null,
        })),
        overhead_objects: worldState.overhead_objects?.map((o: any) => ({
            class: o.class,
            confidence: Math.round(o.confidence * 100) + '%',
            pixel: o.center_px,
            size: o.size_px,
        })),
        vision_fps: worldState.vision_fps,
        overhead_fps: worldState.overhead_fps,
        last_action: worldState.last_action,
        last_result: worldState.last_action_result,
    }, null, 2);

    const armCount = worldState.objects?.length || 0;
    const overheadCount = worldState.overhead_objects?.length || 0;
    addLog('SENSE', `Arm: ${armCount} obj | Overhead: ${overheadCount} obj | Gripper: ${worldState.gripper}`);

    // 2. THINK — ask LLM what to do next
    addLog('THINK', 'Asking LLM for next action...');

    const history = autonomyState.log
        .filter(l => l.phase === 'ACT' || l.phase === 'RESULT' || l.phase === 'LOOK')
        .slice(-10)
        .map(l => `Step ${l.step}: ${l.content}`)
        .join('\n');

    const userPrompt = `GOAL: ${autonomyState.goal}
STEP: ${autonomyState.step}/${autonomyState.maxSteps}
WORLD STATE:
${stateStr}
HISTORY:
${history || 'No actions taken yet'}

What is the next single action?`;

    const llmResponse = await askLLM(autonomyState.systemPrompt, userPrompt);
    addLog('THINK', llmResponse.substring(0, 200));

    // 3. PARSE — extract JSON action from response (with repair for common LLM errors)
    let action: any;
    try {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            let jsonStr = jsonMatch[0];
            // Repair common LLM JSON errors:
            // 1. Trailing quotes after numbers: 1000" → 1000
            jsonStr = jsonStr.replace(/(\d)"(\s*[},\]])/g, '$1$2');
            // 2. Trailing commas before closing braces/brackets
            jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
            // 3. Strip markdown code fence markers
            jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '');
            action = JSON.parse(jsonStr);
        } else {
            addLog('ERROR', 'LLM did not return valid JSON');
            autonomyState.consecutiveErrors = (autonomyState.consecutiveErrors || 0) + 1;
            if (autonomyState.consecutiveErrors >= 3) {
                addLog('STOP', `Stopping: ${autonomyState.consecutiveErrors} consecutive parse errors`);
                autonomyState.running = false;
            }
            return;
        }
    } catch (e) {
        addLog('ERROR', `Failed to parse LLM response: ${llmResponse.substring(0, 100)}`);
        autonomyState.consecutiveErrors = (autonomyState.consecutiveErrors || 0) + 1;
        if (autonomyState.consecutiveErrors >= 3) {
            addLog('STOP', `Stopping: ${autonomyState.consecutiveErrors} consecutive parse errors`);
            autonomyState.running = false;
        }
        return;
    }
    // Reset error counter on successful parse
    autonomyState.consecutiveErrors = 0;

    // 4. CHECK for terminal actions
    if (action.action === 'DONE') {
        addLog('DONE', action.reason || 'Goal completed');
        autonomyState.running = false;
        return;
    }
    if (action.action === 'CANNOT') {
        addLog('CANNOT', action.reason || 'Cannot complete goal');
        autonomyState.running = false;
        return;
    }
    if (action.action === 'WAIT') {
        addLog('WAIT', action.reason || 'Waiting...');
        return;
    }

    // 5. HANDLE "look" action — use VLM
    if (action.action === 'look') {
        const question = action.question || 'Describe what you see, including any objects, colors, and positions.';
        addLog('LOOK', `Looking: "${question}"`);
        const description = await lookWithVLM(question);
        addLog('LOOK', `Vision: ${description}`);
        return; // Description will be in history for next step
    }

    // 6. ACT — execute the action
    addLog('ACT', JSON.stringify(action));
    const result = await executeAction(action);
    const isSuccess = !result.toLowerCase().includes('fail') && !result.toLowerCase().includes('error');
    addLog('RESULT', result);

    // 7. LOG TO MEMORY — persist for learning
    try {
        await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'memory_log',
                goal: autonomyState.goal,
                step: autonomyState.step,
                action_type: action.action,
                action_json: action,
                result: result,
                success: isSuccess,
                servo_positions: worldState.servos,
                gripper_state: worldState.gripper,
                scene_objects: worldState.objects?.map((o: any) => o.class),
                session_id: autonomyState.sessionId,
            }),
            signal: AbortSignal.timeout(2000),
        });
    } catch { /* memory logging is non-critical */ }

    // 7. Wait for movement to settle
    const duration = action.duration || 1000;
    await new Promise(r => setTimeout(r, duration + 500));
}

// Main autonomy loop
async function autonomyLoop() {
    // 1. Start memory session
    try {
        const memRes = await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'memory_session_start', goal: autonomyState.goal }),
            signal: AbortSignal.timeout(2000),
        });
        const memData = await memRes.json();
        if (memData.session_id) autonomyState.sessionId = memData.session_id;
    } catch { /* memory is non-critical */ }

    // 2. Gather ALL memory intelligence
    addLog('MEMORY', '🧠 Loading past experience, lessons, and stats...');
    const intel = await getMemoryIntel(autonomyState.goal);

    // 3. Build a personalized system prompt with memory context
    autonomyState.systemPrompt = buildSystemPrompt(intel.context, intel.lessons, intel.stats);

    addLog('START', `Goal: "${autonomyState.goal}"`);
    if (intel.context) addLog('MEMORY', `📚 Loaded past experience for similar goals`);
    if (intel.lessons) addLog('MEMORY', `📝 Loaded ${intel.lessons.split('\n').length} learned lessons`);
    if (intel.stats) addLog('MEMORY', `📊 ${intel.stats.split('\n')[0]}`);

    // 4. Run the autonomy loop
    while (autonomyState.running) {
        await runOneStep();
        // Small delay between steps
        await new Promise(r => setTimeout(r, 500));
    }

    // 5. End memory session
    const lastLog = autonomyState.log[autonomyState.log.length - 1];
    const wasSuccess = lastLog?.phase === 'DONE';
    try {
        await fetch(BRIDGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'memory_session_end',
                session_id: autonomyState.sessionId,
                total_steps: autonomyState.step,
                success: wasSuccess,
                final_result: lastLog?.content || 'unknown',
            }),
            signal: AbortSignal.timeout(2000),
        });
    } catch { /* non-critical */ }

    // 6. AUTO-LESSON EXTRACTION — LLM analyzes what happened and writes lessons
    if (autonomyState.step > 1) {
        addLog('LEARN', '🧠 Analyzing session to extract lessons...');
        await extractLessonsFromSession(
            autonomyState.goal,
            autonomyState.log,
            wasSuccess,
            autonomyState.sessionId
        );
    }

    addLog('END', `Autonomy ended after ${autonomyState.step} steps`);
}

export async function POST(req: Request) {
    const body = await req.json();
    const { action } = body;

    switch (action) {
        case 'start': {
            if (autonomyState.running) {
                return NextResponse.json({ success: false, message: 'Already running' });
            }
            autonomyState = {
                running: true,
                goal: body.goal || 'Explore the workspace',
                step: 0,
                maxSteps: body.maxSteps || 30,
                log: [],
                startTime: Date.now(),
                sessionId: '',
                systemPrompt: '',
                consecutiveErrors: 0,
            };
            // Start loop in background (non-blocking)
            autonomyLoop().catch(e => {
                addLog('ERROR', e.message);
                autonomyState.running = false;
            });
            return NextResponse.json({ success: true, message: 'Autonomy started', goal: autonomyState.goal });
        }

        case 'stop': {
            autonomyState.running = false;
            addLog('STOP', 'Stopped by user');
            return NextResponse.json({ success: true, message: 'Autonomy stopped' });
        }

        case 'status': {
            return NextResponse.json({
                success: true,
                running: autonomyState.running,
                goal: autonomyState.goal,
                step: autonomyState.step,
                maxSteps: autonomyState.maxSteps,
                log: autonomyState.log,
                elapsed: autonomyState.startTime ? Date.now() - autonomyState.startTime : 0,
            });
        }

        default:
            return NextResponse.json({ success: false, error: 'Unknown action' });
    }
}
