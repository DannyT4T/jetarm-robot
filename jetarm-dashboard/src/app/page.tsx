"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
// @ts-ignore
import * as ROSLIB from "roslib";
import {
    Wifi,
    WifiOff,
    Gamepad2,
    Activity,
    Camera,
    Cpu,
    Settings2,
    RefreshCw,
    Power,
    PowerOff,
    RotateCcw
} from "lucide-react";

const JETSON_IP = "192.168.1.246";

// Corrected ZD-V+ button index → physical label (final)
const BUTTON_NAMES: Record<number, string> = {
    0: 'Y',
    1: 'B',
    2: 'A',
    3: 'X',
    4: 'L1',
    5: 'R1',
    6: 'L2',
    7: 'R2',
    8: 'SELECT',
    9: 'START',
    10: 'L3',
    11: 'R3',
    12: 'MODE',
};

// ─── ZD-V+ Gamepad Visualizer (SVG) ─────────────────────────────────────────
interface GamepadState {
    lx: number; ly: number; rx: number; ry: number;
    buttons: number[];  // raw button values from /joy
    axes: number[];     // raw axes from /joy
}

const defaultGamepad: GamepadState = {
    lx: 0, ly: 0, rx: 0, ry: 0,
    buttons: [],
    axes: [],
};

function btn(gp: GamepadState, idx: number): boolean {
    return (gp.buttons[idx] ?? 0) === 1;
}

function GamepadVisualizer({ gp }: { gp: GamepadState }) {
    const active = (on: boolean) => on ? '#3b82f6' : '#334155';
    const activeText = (on: boolean) => on ? '#ffffff' : '#64748b';

    const stickDot = (cx: number, cy: number, sx: number, sy: number, pressed: boolean) => {
        const ox = cx + sx * 14;
        const oy = cy + sy * 14;
        return (
            <g>
                <circle cx={cx} cy={cy} r={18} fill="#1e293b" stroke="#475569" strokeWidth={1.5} />
                <circle cx={ox} cy={oy} r={8} fill={pressed ? '#3b82f6' : '#94a3b8'} stroke={pressed ? '#60a5fa' : '#64748b'} strokeWidth={1} />
            </g>
        );
    };

    const faceBtn = (cx: number, cy: number, label: string, on: boolean, color: string) => (
        <g>
            <circle cx={cx} cy={cy} r={10} fill={on ? color : '#1e293b'} stroke={on ? color : '#475569'} strokeWidth={1.5} />
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize="9" fontWeight="bold" fill={on ? '#fff' : '#64748b'}>{label}</text>
        </g>
    );

    const shoulderBtn = (x: number, y: number, w: number, label: string, on: boolean) => (
        <g>
            <rect x={x} y={y} width={w} height={14} rx={4} fill={active(on)} stroke={on ? '#60a5fa' : '#475569'} strokeWidth={1} />
            <text x={x + w / 2} y={y + 10} textAnchor="middle" fontSize="7" fontWeight="bold" fill={activeText(on)}>{label}</text>
        </g>
    );

    const smallBtn = (cx: number, cy: number, label: string, on: boolean) => (
        <g>
            <rect x={cx - 16} y={cy - 7} width={32} height={14} rx={3} fill={active(on)} stroke={on ? '#60a5fa' : '#475569'} strokeWidth={1} />
            <text x={cx} y={cy + 3} textAnchor="middle" fontSize="6" fontWeight="bold" fill={activeText(on)}>{label}</text>
        </g>
    );

    const modeBtn = (cx: number, cy: number, on: boolean) => (
        <g>
            <circle cx={cx} cy={cy} r={7} fill={on ? '#f59e0b' : '#1e293b'} stroke={on ? '#fbbf24' : '#475569'} strokeWidth={1} />
            <text x={cx} y={cy + 3} textAnchor="middle" fontSize="5" fontWeight="bold" fill={on ? '#fff' : '#64748b'}>M</text>
        </g>
    );

    // Map pygame button indices to ZD-V+ physical buttons
    // BUTTON_MAP = ['cross(0)', 'circle(1)', '(2)', 'square(3)', 'triangle(4)', '(5)', 'l1(6)', 'r1(7)', 'l2(8)', 'r2(9)', 'select(10)', 'start(11)', '(12=mode?)', 'l3(13)', 'r3(14)', ...]
    const hasData = gp.buttons.length > 0;

    return (
        <div>
            <svg viewBox="0 0 300 160" className="w-full" style={{ maxWidth: 360 }}>
                {/* Body */}
                <path d="M60,40 Q60,25 75,22 L125,18 Q150,16 175,18 L225,22 Q240,25 240,40 L245,85 Q248,115 230,130 Q218,140 205,135 L190,120 Q180,112 170,112 L130,112 Q120,112 110,120 L95,135 Q82,140 70,130 Q52,115 55,85 Z"
                    fill="#0f172a" stroke="#334155" strokeWidth={1.5} />

                {/* D-Pad: read from hat axes — axes[4]=hat_x, axes[5]=hat_y */}
                {(() => {
                    const hatX = gp.axes[4] ?? 0;
                    const hatY = gp.axes[5] ?? 0;
                    const dUp = hatY > 0.5;
                    const dDown = hatY < -0.5;
                    const dLeft = hatX < -0.5;
                    const dRight = hatX > 0.5;
                    return <>
                        <rect x={73} y={52} width={10} height={10} rx={2} fill={dUp ? '#3b82f6' : '#1e293b'} stroke={dUp ? '#60a5fa' : '#475569'} strokeWidth={1} />
                        <rect x={73} y={76} width={10} height={10} rx={2} fill={dDown ? '#3b82f6' : '#1e293b'} stroke={dDown ? '#60a5fa' : '#475569'} strokeWidth={1} />
                        <rect x={60} y={64} width={10} height={10} rx={2} fill={dLeft ? '#3b82f6' : '#1e293b'} stroke={dLeft ? '#60a5fa' : '#475569'} strokeWidth={1} />
                        <rect x={86} y={64} width={10} height={10} rx={2} fill={dRight ? '#3b82f6' : '#1e293b'} stroke={dRight ? '#60a5fa' : '#475569'} strokeWidth={1} />
                        <text x={78} y={59} textAnchor="middle" fontSize="7" fill={dUp ? '#fff' : '#475569'}>▲</text>
                        <text x={78} y={83} textAnchor="middle" fontSize="7" fill={dDown ? '#fff' : '#475569'}>▼</text>
                        <text x={65} y={71} textAnchor="middle" fontSize="7" fill={dLeft ? '#fff' : '#475569'}>◀</text>
                        <text x={91} y={71} textAnchor="middle" fontSize="7" fill={dRight ? '#fff' : '#475569'}>▶</text>
                    </>;
                })()}

                {/* Left Stick (L3 click = idx 10) */}
                {stickDot(110, 95, gp.lx, gp.ly, btn(gp, 10))}
                {/* Right Stick (R3 click = idx 11) */}
                {stickDot(190, 95, gp.rx, gp.ry, btn(gp, 11))}

                {/* Face buttons: Y=idx0, B=idx1, A=idx2, X=idx3 */}
                {faceBtn(222, 52, 'Y', btn(gp, 0), '#22c55e')}          {/* Top = Y (green) */}
                {faceBtn(207, 67, 'X', btn(gp, 3), '#ec4899')}         {/* Left = X (pink) */}
                {faceBtn(237, 67, 'B', btn(gp, 1), '#ef4444')}         {/* Right = B (red) */}
                {faceBtn(222, 82, 'A', btn(gp, 2), '#3b82f6')}         {/* Bottom = A (blue) */}

                {/* Shoulder buttons: L1=idx4, R1=idx5, L2=idx6, R2=idx7 */}
                {shoulderBtn(68, 10, 40, 'L1', btn(gp, 4))}
                {shoulderBtn(68, -4, 40, 'L2', btn(gp, 6))}
                {shoulderBtn(192, 10, 40, 'R1', btn(gp, 5))}
                {shoulderBtn(192, -4, 40, 'R2', btn(gp, 7))}

                {/* SELECT=idx8, MODE (visual only), START=idx9 */}
                {smallBtn(120, 50, 'SELECT', btn(gp, 8))}
                {modeBtn(150, 65, btn(gp, 12))}
                {smallBtn(180, 50, 'START', btn(gp, 9))}

                {/* Connection indicator */}
                {!hasData && <text x={150} y={78} textAnchor="middle" fontSize="10" fill="#ef4444" fontWeight="bold">No controller data</text>}

                {/* Label */}
                <text x={150} y={152} textAnchor="middle" fontSize="8" fill="#64748b" fontWeight="600">ZD-V+ Live Input (via Jetson)</text>
            </svg>

            {/* RAW DEBUG PANEL */}
            <div className="mt-2 bg-slate-950 border border-slate-800 rounded-lg p-3 text-[10px] font-mono text-slate-500 space-y-1">
                <div className="text-slate-400 font-bold mb-1">🎮 Raw Jetson /joy Data</div>
                <div className="flex flex-wrap gap-1">
                    {gp.buttons.length > 0 ? gp.buttons.map((val, idx) => (
                        <span key={idx} className={`px-1.5 py-0.5 rounded ${val ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-600'}`}>
                            {BUTTON_NAMES[idx] || `B${idx}`}
                        </span>
                    )) : <span className="text-slate-600">Waiting for /joy messages...</span>}
                </div>
                {gp.axes.length > 0 && (
                    <div className="flex gap-3 mt-1">
                        {gp.axes.map((val, idx) => (
                            <span key={idx} className={`${Math.abs(val) > 0.1 ? 'text-blue-400' : 'text-slate-600'}`}>
                                A{idx}:{val.toFixed(2)}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Server-side debug logger ────────────────────────────────────────────────
let debugTimeout: NodeJS.Timeout | null = null;
function logToServer(data: Record<string, unknown>) {
    // Debounce to avoid flooding
    if (debugTimeout) clearTimeout(debugTimeout);
    debugTimeout = setTimeout(() => {
        fetch('/api/debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        }).catch(() => { }); // fire and forget
    }, 50);
}

// ─── System Controls Component ───────────────────────────────────────────────
function SystemControls() {
    const [loading, setLoading] = useState<string | null>(null);
    const [statusMsg, setStatusMsg] = useState<string>('');

    const runAction = async (action: string) => {
        setLoading(action);
        setStatusMsg('');
        try {
            const res = await fetch('/api/system', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            const data = await res.json();
            setStatusMsg(data.message || (data.success ? 'Done' : 'Failed'));
            if (data.processes && Array.isArray(data.processes)) {
                setStatusMsg(`${data.count} processes: ${data.processes.join(', ')}`);
            }
        } catch {
            setStatusMsg('Error: Could not reach server');
        }
        setLoading(null);
    };

    return (
        <div className="flex items-center space-x-3">
            {statusMsg && (
                <span className="text-xs text-slate-400 max-w-[300px] truncate">{statusMsg}</span>
            )}
            <button
                onClick={() => runAction('start_all')}
                disabled={loading !== null}
                className="flex items-center space-x-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold"
            >
                <Power size={16} />
                <span>{loading === 'start_all' ? 'Starting...' : 'Start Robot'}</span>
            </button>
            <button
                onClick={() => runAction('restart_joystick')}
                disabled={loading !== null}
                className="flex items-center space-x-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold"
            >
                <RotateCcw size={16} />
                <span>{loading === 'restart_joystick' ? 'Restarting...' : 'Restart Controller'}</span>
            </button>
            <button
                onClick={() => runAction('status')}
                disabled={loading !== null}
                className="flex items-center space-x-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold"
            >
                <span>{loading === 'status' ? 'Checking...' : 'Status'}</span>
            </button>
            <button
                onClick={() => runAction('stop_all')}
                disabled={loading !== null}
                className="flex items-center space-x-2 px-3 py-2 bg-red-600/80 hover:bg-red-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold"
            >
                <PowerOff size={16} />
                <span>{loading === 'stop_all' ? 'Stopping...' : 'Stop All'}</span>
            </button>
        </div>
    );
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────
export default function Dashboard() {
    const [rosConnected, setRosConnected] = useState(false);
    const [controllerActive, setControllerActive] = useState(false);

    const [jointPos, setJointPos] = useState([500, 500, 500, 500, 500, 500]);

    const [rgbStatus, setRgbStatus] = useState<'idle' | 'live' | 'failed'>('idle');
    const [depthStatus, setDepthStatus] = useState<'idle' | 'live' | 'failed'>('idle');
    const [streamKey, setStreamKey] = useState(0);
    const [depthColormap, setDepthColormap] = useState<'raw' | 'jet' | 'gray' | 'plasma'>('raw');

    const [gamepad, setGamepad] = useState<GamepadState>(defaultGamepad);
    const lastDebugRef = useRef<string>('');

    // Initialize streamKey on client only (fixes hydration)
    useEffect(() => {
        setStreamKey(Date.now());
    }, []);

    // Delay stream loading
    useEffect(() => {
        if (streamKey === 0) return;
        const t = setTimeout(() => {
            if (rgbStatus === 'idle') setRgbStatus('live');
            if (depthStatus === 'idle') setDepthStatus('live');
        }, 1000);
        return () => clearTimeout(t);
    }, [streamKey, rgbStatus, depthStatus]);

    const handleRefreshStreams = () => {
        setRgbStatus('idle');
        setDepthStatus('idle');
        setStreamKey(Date.now());
    };

    // ── ROS Connection ──
    useEffect(() => {
        const ros = new ROSLIB.Ros({
            url: `ws://${JETSON_IP}:9090`
        });

        ros.on('connection', () => setRosConnected(true));
        ros.on('error', () => setRosConnected(false));
        ros.on('close', () => setRosConnected(false));

        // Listen for arm commands (activity indicator)
        const joyListener = new ROSLIB.Topic({
            ros: ros,
            name: '/servo_controller',
            messageType: 'servo_controller_msgs/msg/ServosPosition'
        });

        let timeout: NodeJS.Timeout;
        joyListener.subscribe(() => {
            setControllerActive(true);
            clearTimeout(timeout);
            timeout = setTimeout(() => setControllerActive(false), 2000);
        });

        // Listen for Servo States
        const servoListener = new ROSLIB.Topic({
            ros: ros,
            name: '/controller_manager/servo_states',
            messageType: 'servo_controller_msgs/ServoStateList'
        });

        servoListener.subscribe((msg: any) => {
            const states = msg.servo_state || [];
            setJointPos((prev) => {
                const newPos = [...prev];
                states.forEach((s: any) => {
                    if (s.id === 1) newPos[0] = s.position;
                    else if (s.id === 2) newPos[1] = s.position;
                    else if (s.id === 3) newPos[2] = s.position;
                    else if (s.id === 4) newPos[3] = s.position;
                    else if (s.id === 5) newPos[4] = s.position;
                    else if (s.id === 10) newPos[5] = s.position;
                });
                return newPos;
            });
        });

        // ── Subscribe to /joy from Jetson ──
        const joyInputListener = new ROSLIB.Topic({
            ros: ros,
            name: '/joy',
            messageType: 'sensor_msgs/Joy'
        });

        joyInputListener.subscribe((msg: any) => {
            const axes: number[] = msg.axes || [];
            const buttons: number[] = msg.buttons || [];

            setGamepad({
                lx: Math.abs(axes[0] ?? 0) > 0.08 ? (axes[0] ?? 0) : 0,
                ly: Math.abs(axes[1] ?? 0) > 0.08 ? (axes[1] ?? 0) : 0,
                rx: Math.abs(axes[2] ?? 0) > 0.08 ? (axes[2] ?? 0) : 0,
                ry: Math.abs(axes[3] ?? 0) > 0.08 ? (axes[3] ?? 0) : 0,
                buttons: buttons,
                axes: axes,
            });

            // Send debug to server (Next.js terminal) when buttons change
            const pressedNames = buttons
                .map((v: number, i: number) => v ? (BUTTON_NAMES[i] || `B${i}`) : null)
                .filter(Boolean);
            const activeAxes = axes
                .map((v: number, i: number) => Math.abs(v) > 0.15 ? `A${i}:${v.toFixed(2)}` : null)
                .filter(Boolean);
            const debugStr = [...pressedNames, ...activeAxes].join(',');
            if (debugStr && debugStr !== lastDebugRef.current) {
                logToServer({ type: 'raw', buttons: pressedNames, axes: activeAxes });
            }
            lastDebugRef.current = debugStr || '';
        });

        return () => {
            joyListener.unsubscribe();
            servoListener.unsubscribe();
            joyInputListener.unsubscribe();
            ros.close();
        };
    }, []);

    // ── Control scheme data (matches joystick_control_fixed.py) ──
    const controlScheme = [
        { action: 'Base Rotate', control: 'L Stick X', color: 'text-blue-400' },
        { action: 'Shoulder Up/Down', control: 'L Stick Y', color: 'text-blue-400' },
        { action: 'Elbow Up/Down', control: 'R Stick Y', color: 'text-cyan-400' },
        { action: 'Wrist Pitch', control: 'R Stick X', color: 'text-cyan-400' },
        { action: 'Wrist Rotate CCW', control: 'L1', color: 'text-purple-400' },
        { action: 'Wrist Rotate CW', control: 'L2', color: 'text-purple-400' },
        { action: 'Gripper Open', control: 'R1', color: 'text-emerald-400' },
        { action: 'Gripper Close', control: 'R2', color: 'text-emerald-400' },
        { action: 'Home Position', control: 'START', color: 'text-yellow-400' },
        { action: 'Mode Toggle', control: 'SEL + START', color: 'text-orange-400' },
        { action: '(unmapped)', control: 'A / B / X / Y', color: 'text-slate-600' },
        { action: '(unmapped)', control: 'D-Pad', color: 'text-slate-600' },
    ];

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 p-8 font-sans">
            <div className="max-w-7xl mx-auto space-y-6">

                {/* HEADER */}
                <div className="flex justify-between items-center mb-10 border-b border-slate-800 pb-6">
                    <div className="flex items-center space-x-4">
                        <div className="p-3 bg-blue-600/20 text-blue-400 rounded-xl">
                            <Cpu size={28} />
                        </div>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight">JetArm AI Command Center</h1>
                            <p className="text-slate-400">Local dashboard connected to {JETSON_IP}</p>
                        </div>
                    </div>

                    <div className="flex items-center space-x-6">
                        <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-slate-400">Connection</span>
                            {rosConnected ? (
                                <div className="flex items-center space-x-2 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-sm font-semibold">
                                    <Wifi size={16} /> <span>Live</span>
                                </div>
                            ) : (
                                <div className="flex items-center space-x-2 px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-full text-sm font-semibold">
                                    <WifiOff size={16} /> <span>Offline</span>
                                </div>
                            )}
                        </div>

                        <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-slate-400">Controller</span>
                            {controllerActive ? (
                                <div className="flex items-center space-x-2 px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full text-sm font-semibold animate-pulse">
                                    <Gamepad2 size={16} /> <span>Active</span>
                                </div>
                            ) : (
                                <div className="flex items-center space-x-2 px-3 py-1.5 bg-slate-800/50 text-slate-400 border border-slate-700/50 rounded-full text-sm font-semibold">
                                    <Gamepad2 size={16} /> <span>Idle</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* MAIN GRID */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                    {/* LEFT COL: CAMERAS */}
                    <div className="lg:col-span-2 space-y-6">

                        {/* STREAM HEADER / CONTROLS */}
                        <div className="flex justify-between items-center bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
                            <div className="flex space-x-6 text-sm font-medium">
                                <div className="flex items-center space-x-2">
                                    <span className="text-slate-400">RGB Stream:</span>
                                    {rgbStatus === 'live' ? <span className="text-emerald-400">Live</span> :
                                        rgbStatus === 'failed' ? <span className="text-red-400">Failed</span> :
                                            <span className="text-yellow-400 animate-pulse">Waiting...</span>}
                                </div>
                                <div className="flex items-center space-x-2">
                                    <span className="text-slate-400">Depth Stream:</span>
                                    {depthStatus === 'live' ? <span className="text-emerald-400">Live</span> :
                                        depthStatus === 'failed' ? <span className="text-red-400">Failed</span> :
                                            <span className="text-yellow-400 animate-pulse">Waiting...</span>}
                                </div>
                            </div>
                            <button
                                onClick={handleRefreshStreams}
                                className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 transition-colors text-white rounded-lg text-sm font-semibold"
                            >
                                <RefreshCw size={16} /> <span>Refresh Feeds</span>
                            </button>
                        </div>

                        {/* RGB CAMERA */}
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
                            <div className="absolute top-4 left-4 flex items-center space-x-2 px-3 py-1.5 bg-black/50 backdrop-blur text-white rounded-lg text-sm font-semibold border border-white/10 z-10">
                                <Camera size={16} /> <span>RGB Main Feed</span>
                            </div>
                            <div className="aspect-video bg-black flex items-center justify-center relative">
                                {rgbStatus !== 'idle' && streamKey > 0 && (
                                    <img
                                        src={`http://${JETSON_IP}:8080/stream?topic=/depth_cam/color/image_raw&type=ros_compressed&_k=${streamKey}`}
                                        className={`w-full h-full object-cover transition-opacity duration-300 ${rgbStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
                                        alt="JetArm RGB Feed"
                                        onError={() => setRgbStatus('failed')}
                                    />
                                )}
                                {rgbStatus !== 'live' && (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                                        <Camera size={48} className="mb-4 opacity-20" />
                                        <p>{rgbStatus === 'failed' ? 'RGB Stream not available.' : 'Connecting...'}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* DEPTH CAMERA */}
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
                            <div className="absolute top-4 left-4 flex items-center space-x-2 px-3 py-1.5 bg-black/50 backdrop-blur text-white rounded-lg text-sm font-semibold border border-white/10 z-10">
                                <Camera size={16} className="text-emerald-400" /> <span className="text-emerald-400">Depth Sensor Feed</span>
                            </div>

                            <div className="absolute top-4 right-4 flex bg-black/50 backdrop-blur border border-white/10 rounded-lg overflow-hidden z-10 text-xs font-semibold">
                                {(['raw', 'jet', 'plasma', 'gray'] as const).map((cm, i) => (
                                    <button
                                        key={cm}
                                        onClick={() => setDepthColormap(cm)}
                                        className={`px-3 py-1.5 transition-colors ${i > 0 ? 'border-l border-white/10' : ''} ${depthColormap === cm ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                                    >
                                        {cm.toUpperCase()}
                                    </button>
                                ))}
                            </div>

                            <div className="aspect-video bg-black flex items-center justify-center relative">
                                {depthStatus !== 'idle' && streamKey > 0 && (
                                    <img
                                        src={`http://${JETSON_IP}:8080/stream?topic=/depth_cam/depth/color_map/${depthColormap}&type=ros_compressed&_k=${streamKey}`}
                                        className={`w-full h-full object-cover transition-opacity duration-300 ${depthStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
                                        alt="JetArm Depth Feed"
                                        onError={() => setDepthStatus('failed')}
                                    />
                                )}
                                {depthStatus !== 'live' && (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                                        <Camera size={48} className="mb-4 opacity-20" />
                                        <p>{depthStatus === 'failed' ? 'Depth Stream not available.' : 'Connecting...'}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                    </div>

                    {/* RIGHT COL: TELEMETRY & CONTROLS */}
                    <div className="space-y-6">

                        {/* JOINT POSITIONS */}
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                            <div className="flex items-center space-x-3 mb-6">
                                <Activity className="text-blue-400" />
                                <h2 className="text-xl font-semibold">Teleoperation Metrics</h2>
                            </div>

                            <div className="space-y-4">
                                {['Base (ID:1)', 'Shoulder (ID:2)', 'Elbow (ID:3)', 'Wrist Pitch (ID:4)', 'Wrist Roll (ID:5)', 'Gripper (ID:10)'].map((joint, idx) => (
                                    <div key={idx} className="space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-slate-400">{joint}</span>
                                            <span className="font-mono text-blue-300">{jointPos[idx]} Pulse</span>
                                        </div>
                                        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out"
                                                style={{ width: `${(jointPos[idx] / 1000) * 100}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* GAMEPAD VISUALIZER + CONTROL SCHEME */}
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                            <div className="flex items-center space-x-3 mb-4">
                                <Settings2 className="text-emerald-400" />
                                <h2 className="text-xl font-semibold">Control Scheme</h2>
                            </div>

                            {/* Live Gamepad Visualizer — fed from Jetson /joy topic */}
                            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 mb-5">
                                <GamepadVisualizer gp={gamepad} />
                            </div>

                            {/* Mapping Table */}
                            <div className="space-y-2 text-sm">
                                {controlScheme.map((item, idx) => (
                                    <div key={idx} className="flex justify-between items-center border-b border-slate-800/50 pb-2 last:border-0">
                                        <span className="text-slate-400">{item.action}</span>
                                        <span className={`bg-slate-800 px-2.5 py-1 rounded font-mono text-xs font-bold ${item.color}`}>
                                            {item.control}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                    </div>

                    {/* FULL WIDTH: SYSTEM CONTROLS */}
                    <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                                <Power className="text-amber-400" />
                                <h2 className="text-xl font-semibold">System Controls</h2>
                                <span className="text-sm text-slate-500">SSH → {JETSON_IP}</span>
                            </div>
                            <SystemControls />
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
