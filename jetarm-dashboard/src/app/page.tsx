"use client";

import React, { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import * as ROSLIB from "roslib";
import {
    Wifi, WifiOff, Gamepad2, Activity, Camera, Cpu, Settings2,
    RefreshCw, Power, PowerOff, RotateCcw, Pencil, Plus, Check,
    X, ChevronLeft, ChevronRight, GripVertical, Trash2
} from "lucide-react";

const JETSON_IP = "192.168.1.246";
const STORAGE_KEY = "jetarm-dashboard-layout";
const LAYOUT_VERSION = 10; // Bump this when default system tabs change

// ─── Types ───────────────────────────────────────────────────────────────────
type ModuleType = 'rgb_feed' | 'depth_feed' | 'gamepad_visualizer' | 'telemetry' | 'control_scheme' | 'system_controls'
    | 'ai_detection_feed' | 'ai_detections_log' | 'ai_controls' | 'ai_chat' | 'voice_assistant'
    | 'vision_v2_controls' | 'vision_v2_state' | 'autonomy'
    | 'overhead_feed' | 'overhead_detection_feed';

interface YoloDetection {
    class: string; confidence: number;
    bbox: number[]; center_px: number[]; size_px: number[]; depth_mm: number;
}

interface ModuleInstance { id: string; type: ModuleType; }
interface Tab { id: string; name: string; isSystem: boolean; modules: ModuleInstance[]; }
interface DashboardLayout { tabs: Tab[]; activeTabId: string; }

interface GamepadState {
    lx: number; ly: number; rx: number; ry: number;
    buttons: number[]; axes: number[];
}

interface SharedState {
    rosConnected: boolean; controllerActive: boolean;
    jointPos: number[]; gamepad: GamepadState;
    rgbStatus: 'idle' | 'live' | 'failed'; depthStatus: 'idle' | 'live' | 'failed';
    streamKey: number; depthColormap: 'raw' | 'jet' | 'gray' | 'plasma';
    yoloDetections: YoloDetection[]; yoloFps: number; yoloCount: number;
    setRgbStatus: (s: 'idle' | 'live' | 'failed') => void;
    setDepthStatus: (s: 'idle' | 'live' | 'failed') => void;
    setStreamKey: (k: number) => void;
    setDepthColormap: (c: 'raw' | 'jet' | 'gray' | 'plasma') => void;
}

// ─── Module Registry ─────────────────────────────────────────────────────────
const MODULE_REGISTRY: Record<ModuleType, { name: string; icon: string; desc: string }> = {
    rgb_feed: { name: 'RGB Camera Feed', icon: '📷', desc: 'Live RGB camera stream from Jetson' },
    depth_feed: { name: 'Depth Sensor Feed', icon: '🌊', desc: 'Depth camera with colormap options' },
    gamepad_visualizer: { name: 'Controller Visualizer', icon: '🎮', desc: 'Live gamepad SVG + raw data' },
    telemetry: { name: 'Telemetry Metrics', icon: '📊', desc: 'Joint positions and servo states' },
    control_scheme: { name: 'Control Scheme', icon: '⌨️', desc: 'Button-to-action mapping table' },
    system_controls: { name: 'System Controls', icon: '⚡', desc: 'Start/Stop/Restart robot processes' },
    ai_detection_feed: { name: 'YOLO Detection', icon: '🧠', desc: 'YOLO annotated camera stream' },
    ai_detections_log: { name: 'YOLO Detections', icon: '📝', desc: 'Live object detection table' },
    ai_controls: { name: 'YOLO Controls', icon: '🚀', desc: 'Start/Stop YOLO detector' },
    ai_chat: { name: 'AI Chat', icon: '💬', desc: 'Chat with JetArm AI — control the robot with language' },
    voice_assistant: { name: 'Voice Assistant', icon: '🎤', desc: 'Talk to the robot — voice commands + spoken responses' },
    vision_v2_controls: { name: 'Vision v2 Controls', icon: '🚀', desc: 'TensorRT-accelerated YOLO v2 — start/stop/export' },
    vision_v2_state: { name: 'Vision v2 State', icon: '👁️', desc: 'Real-time vision detections from TensorRT YOLO' },
    autonomy: { name: 'Autonomy', icon: '🤖', desc: 'Autonomous sense→think→act loop' },
    overhead_feed: { name: 'Overhead Camera', icon: '🎥', desc: 'Third-person USB webcam — raw feed' },
    overhead_detection_feed: { name: 'Overhead Detections', icon: '🔭', desc: 'Third-person webcam with YOLO overlay' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_HOME_MODULES: ModuleInstance[] = [
    { id: uid(), type: 'rgb_feed' },
    { id: uid(), type: 'depth_feed' },
    { id: uid(), type: 'telemetry' },
    { id: uid(), type: 'gamepad_visualizer' },
    { id: uid(), type: 'control_scheme' },
    { id: uid(), type: 'system_controls' },
];

const defaultLayout: DashboardLayout = {
    tabs: [
        { id: 'home', name: 'Home', isSystem: true, modules: DEFAULT_HOME_MODULES },
        {
            id: 'yolo', name: 'YOLO', isSystem: true, modules: [
                { id: uid(), type: 'vision_v2_controls' },
                { id: uid(), type: 'ai_detection_feed' },
                { id: uid(), type: 'overhead_detection_feed' },
                { id: uid(), type: 'vision_v2_state' },
                { id: uid(), type: 'rgb_feed' },
                { id: uid(), type: 'depth_feed' },
                { id: uid(), type: 'telemetry' },
            ]
        },
        {
            id: 'autonomy', name: 'Autonomy', isSystem: true, modules: [
                { id: uid(), type: 'autonomy' },
                { id: uid(), type: 'overhead_detection_feed' },
                { id: uid(), type: 'ai_detection_feed' },
                { id: uid(), type: 'vision_v2_state' },
                { id: uid(), type: 'rgb_feed' },
            ]
        },
        {
            id: 'ai', name: 'AI', isSystem: true, modules: [
                { id: uid(), type: 'ai_chat' },
                { id: uid(), type: 'voice_assistant' },
                { id: uid(), type: 'rgb_feed' },
                { id: uid(), type: 'depth_feed' },
                { id: uid(), type: 'telemetry' },
            ]
        },
    ],
    activeTabId: 'home',
};

function loadLayout(): DashboardLayout {
    if (typeof window === 'undefined') return defaultLayout;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            // If version mismatch, reset system tabs but keep user tabs
            if (saved._version !== LAYOUT_VERSION) {
                const userTabs = (saved.tabs || []).filter((t: Tab) => !t.isSystem);
                return { ...defaultLayout, tabs: [...defaultLayout.tabs, ...userTabs] };
            }
            return saved as DashboardLayout;
        }
    } catch { /* ignore */ }
    return defaultLayout;
}

function saveLayout(layout: DashboardLayout) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...layout, _version: LAYOUT_VERSION })); } catch { /* ignore */ }
}

// ─── Button Names (ZD-V+ verified) ──────────────────────────────────────────
const BUTTON_NAMES: Record<number, string> = {
    0: 'Y', 1: 'B', 2: 'A', 3: 'X', 4: 'L1', 5: 'R1',
    6: 'L2', 7: 'R2', 8: 'SELECT', 9: 'START', 10: 'L3', 11: 'R3', 12: 'MODE',
};

const defaultGamepad: GamepadState = { lx: 0, ly: 0, rx: 0, ry: 0, buttons: [], axes: [] };
function btn(gp: GamepadState, idx: number): boolean { return (gp.buttons[idx] ?? 0) === 1; }

// ─── Debug Logger ────────────────────────────────────────────────────────────
let debugTimeout: NodeJS.Timeout | null = null;
function logToServer(data: Record<string, unknown>) {
    if (debugTimeout) clearTimeout(debugTimeout);
    debugTimeout = setTimeout(() => {
        fetch('/api/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => { });
    }, 50);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WIDGET COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Gamepad SVG ──────────────────────────────────────────────────────────────
function GamepadVisualizer({ gp }: { gp: GamepadState }) {
    const active = (on: boolean) => on ? '#3b82f6' : '#334155';
    const activeText = (on: boolean) => on ? '#ffffff' : '#64748b';
    const stickDot = (cx: number, cy: number, sx: number, sy: number, pressed: boolean) => {
        const ox = cx + sx * 14, oy = cy + sy * 14;
        return <g><circle cx={cx} cy={cy} r={18} fill="#1e293b" stroke="#475569" strokeWidth={1.5} /><circle cx={ox} cy={oy} r={8} fill={pressed ? '#3b82f6' : '#94a3b8'} stroke={pressed ? '#60a5fa' : '#64748b'} strokeWidth={1} /></g>;
    };
    const faceBtn = (cx: number, cy: number, label: string, on: boolean, color: string) => (
        <g><circle cx={cx} cy={cy} r={10} fill={on ? color : '#1e293b'} stroke={on ? color : '#475569'} strokeWidth={1.5} /><text x={cx} y={cy + 4} textAnchor="middle" fontSize="9" fontWeight="bold" fill={on ? '#fff' : '#64748b'}>{label}</text></g>
    );
    const shoulderBtn = (x: number, y: number, w: number, label: string, on: boolean) => (
        <g><rect x={x} y={y} width={w} height={14} rx={4} fill={active(on)} stroke={on ? '#60a5fa' : '#475569'} strokeWidth={1} /><text x={x + w / 2} y={y + 10} textAnchor="middle" fontSize="7" fontWeight="bold" fill={activeText(on)}>{label}</text></g>
    );
    const smallBtn = (cx: number, cy: number, label: string, on: boolean) => (
        <g><rect x={cx - 16} y={cy - 7} width={32} height={14} rx={3} fill={active(on)} stroke={on ? '#60a5fa' : '#475569'} strokeWidth={1} /><text x={cx} y={cy + 3} textAnchor="middle" fontSize="6" fontWeight="bold" fill={activeText(on)}>{label}</text></g>
    );
    const modeBtn = (cx: number, cy: number, on: boolean) => (
        <g><circle cx={cx} cy={cy} r={7} fill={on ? '#f59e0b' : '#1e293b'} stroke={on ? '#fbbf24' : '#475569'} strokeWidth={1} /><text x={cx} y={cy + 3} textAnchor="middle" fontSize="5" fontWeight="bold" fill={on ? '#fff' : '#64748b'}>M</text></g>
    );
    const hasData = gp.buttons.length > 0;
    return (
        <div>
            <svg viewBox="0 0 300 160" className="w-full" style={{ maxWidth: 360 }}>
                <path d="M60,40 Q60,25 75,22 L125,18 Q150,16 175,18 L225,22 Q240,25 240,40 L245,85 Q248,115 230,130 Q218,140 205,135 L190,120 Q180,112 170,112 L130,112 Q120,112 110,120 L95,135 Q82,140 70,130 Q52,115 55,85 Z" fill="#0f172a" stroke="#334155" strokeWidth={1.5} />
                {(() => {
                    const hatX = gp.axes[4] ?? 0, hatY = gp.axes[5] ?? 0;
                    const dUp = hatY > 0.5, dDown = hatY < -0.5, dLeft = hatX < -0.5, dRight = hatX > 0.5;
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
                {stickDot(110, 95, gp.lx, gp.ly, btn(gp, 10))}
                {stickDot(190, 95, gp.rx, gp.ry, btn(gp, 11))}
                {faceBtn(222, 52, 'Y', btn(gp, 0), '#22c55e')}
                {faceBtn(207, 67, 'X', btn(gp, 3), '#ec4899')}
                {faceBtn(237, 67, 'B', btn(gp, 1), '#ef4444')}
                {faceBtn(222, 82, 'A', btn(gp, 2), '#3b82f6')}
                {shoulderBtn(68, 10, 40, 'L1', btn(gp, 4))}
                {shoulderBtn(68, -4, 40, 'L2', btn(gp, 6))}
                {shoulderBtn(192, 10, 40, 'R1', btn(gp, 5))}
                {shoulderBtn(192, -4, 40, 'R2', btn(gp, 7))}
                {smallBtn(120, 50, 'SELECT', btn(gp, 8))}
                {modeBtn(150, 65, btn(gp, 12))}
                {smallBtn(180, 50, 'START', btn(gp, 9))}
                {!hasData && <text x={150} y={78} textAnchor="middle" fontSize="10" fill="#ef4444" fontWeight="bold">No controller data</text>}
                <text x={150} y={152} textAnchor="middle" fontSize="8" fill="#64748b" fontWeight="600">ZD-V+ Live Input (via Jetson)</text>
            </svg>
            <div className="mt-2 bg-slate-950 border border-slate-800 rounded-lg p-3 text-[10px] font-mono text-slate-500 space-y-1">
                <div className="text-slate-400 font-bold mb-1">🎮 Raw Jetson /joy Data</div>
                <div className="flex flex-wrap gap-1">
                    {gp.buttons.length > 0 ? gp.buttons.map((val, idx) => (
                        <span key={idx} className={`px-1.5 py-0.5 rounded ${val ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-600'}`}>{BUTTON_NAMES[idx] || `B${idx}`}</span>
                    )) : <span className="text-slate-600">Waiting for /joy messages...</span>}
                </div>
                {gp.axes.length > 0 && (
                    <div className="flex gap-3 mt-1">
                        {gp.axes.map((val, idx) => (<span key={idx} className={`${Math.abs(val) > 0.1 ? 'text-blue-400' : 'text-slate-600'}`}>A{idx}:{val.toFixed(2)}</span>))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── System Controls ──────────────────────────────────────────────────────────
function SystemControlsWidget() {
    const [loading, setLoading] = useState<string | null>(null);
    const [statusMsg, setStatusMsg] = useState('');
    const runAction = async (action: string) => {
        setLoading(action); setStatusMsg('');
        try {
            const res = await fetch('/api/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
            const data = await res.json();
            setStatusMsg(data.message || (data.success ? 'Done' : 'Failed'));
            if (data.processes && Array.isArray(data.processes)) setStatusMsg(`${data.count} processes: ${data.processes.join(', ')}`);
        } catch { setStatusMsg('Error: Could not reach server'); }
        setLoading(null);
    };
    return (
        <div className="space-y-3">
            <div className="flex items-center space-x-3 flex-wrap gap-y-2">
                <button onClick={() => runAction('start_all')} disabled={!!loading} className="flex items-center space-x-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <Power size={16} /><span>{loading === 'start_all' ? 'Starting...' : 'Start Robot'}</span>
                </button>
                <button onClick={() => runAction('restart_joystick')} disabled={!!loading} className="flex items-center space-x-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <RotateCcw size={16} /><span>{loading === 'restart_joystick' ? 'Restarting...' : 'Restart Controller'}</span>
                </button>
                <button onClick={() => runAction('status')} disabled={!!loading} className="flex items-center space-x-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <span>{loading === 'status' ? 'Checking...' : 'Status'}</span>
                </button>
                <button onClick={() => runAction('stop_all')} disabled={!!loading} className="flex items-center space-x-2 px-3 py-2 bg-red-600/80 hover:bg-red-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <PowerOff size={16} /><span>{loading === 'stop_all' ? 'Stopping...' : 'Stop All'}</span>
                </button>
            </div>
            {statusMsg && <p className="text-xs text-slate-400">{statusMsg}</p>}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI CHAT WIDGET (Vercel AI SDK v6 + Ollama + Kokoro TTS)
// ═══════════════════════════════════════════════════════════════════════════════
function AIChatWidget() {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [input, setInput] = useState('');
    const [ttsEnabled, setTtsEnabled] = useState(false);
    const [speaking, setSpeaking] = useState<string | null>(null);

    // Streaming TTS state
    const audioQueueRef = useRef<HTMLAudioElement[]>([]);
    const isPlayingRef = useRef(false);
    const spokenLengthRef = useRef(0);
    const lastAssistantTextRef = useRef('');

    const playNextInQueue = () => {
        if (audioQueueRef.current.length === 0) {
            isPlayingRef.current = false;
            setSpeaking(null);
            return;
        }
        isPlayingRef.current = true;
        const audio = audioQueueRef.current.shift()!;
        audio.onended = () => {
            URL.revokeObjectURL(audio.src);
            playNextInQueue();
        };
        audio.play().catch(() => playNextInQueue());
    };

    const queueSpeak = async (text: string) => {
        if (!text.trim() || text.trim().length < 2) return;
        try {
            const res = await fetch('/api/voice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'speak', text: text.trim(), voice: 'af_heart', speed: 1.1 }),
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audioQueueRef.current.push(audio);
                if (!isPlayingRef.current) {
                    setSpeaking('streaming');
                    playNextInQueue();
                }
            }
        } catch { /* skip failed chunk */ }
    };

    // Check for new complete sentences in streaming text
    const checkForNewSentences = (fullText: string) => {
        if (!ttsEnabled) return;
        const alreadySpoken = spokenLengthRef.current;
        const newText = fullText.slice(alreadySpoken);
        // Find sentence boundaries
        const sentenceEnd = newText.search(/[.!?]\s|[.!?]$/);
        if (sentenceEnd >= 0) {
            const sentence = newText.slice(0, sentenceEnd + 1);
            spokenLengthRef.current = alreadySpoken + sentenceEnd + 1;
            queueSpeak(sentence);
        }
    };

    const { messages, sendMessage, status, error, setMessages, stop } = useChat({
        onFinish: ({ message: msg }) => {
            if (ttsEnabled && msg.role === 'assistant') {
                const text = msg.parts
                    .filter((p: any) => p.type === 'text')
                    .map((p: any) => p.text).join('');
                // Speak any remaining unspoken text
                const remaining = text.slice(spokenLengthRef.current);
                if (remaining.trim()) queueSpeak(remaining);
                spokenLengthRef.current = 0;
                lastAssistantTextRef.current = '';
            }
        },
    });

    const isStreaming = status === 'streaming' || status === 'submitted';

    // Track streaming text and trigger sentence-by-sentence TTS
    useEffect(() => {
        if (!isStreaming || !ttsEnabled) return;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role !== 'assistant') return;
        const fullText = lastMsg.parts
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text).join('');
        if (fullText !== lastAssistantTextRef.current) {
            lastAssistantTextRef.current = fullText;
            checkForNewSentences(fullText);
        }
    }, [messages, isStreaming, ttsEnabled]);

    // Reset spoken tracking when a new message starts
    useEffect(() => {
        if (status === 'submitted') {
            spokenLengthRef.current = 0;
            lastAssistantTextRef.current = '';
        }
    }, [status]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages, status]);

    const speakText = async (text: string, id?: string) => {
        // Stop any current streaming TTS
        audioQueueRef.current.forEach(a => { try { a.pause(); URL.revokeObjectURL(a.src); } catch { } });
        audioQueueRef.current = [];
        isPlayingRef.current = false;
        // Speak full text
        try {
            setSpeaking(id || 'manual');
            const res = await fetch('/api/voice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'speak', text, voice: 'af_heart', speed: 1.1 }),
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onended = () => { URL.revokeObjectURL(url); setSpeaking(null); };
                audio.play();
            } else { setSpeaking(null); }
        } catch { setSpeaking(null); }
    };

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isStreaming) return;
        sendMessage({ text: input });
        setInput('');
    };

    const quickSend = (text: string) => {
        if (isStreaming) return;
        sendMessage({ text });
    };

    // Helper to extract text from UIMessage parts
    const getMessageText = (m: UIMessage): string => {
        return m.parts
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('');
    };

    return (
        <div className="flex flex-col h-[500px]">
            {/* TTS Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/50">
                <span className="text-xs text-slate-400 font-medium">💬 AI Chat — Qwen 2.5 7B</span>
                <button onClick={() => setTtsEnabled(!ttsEnabled)}
                    className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${ttsEnabled ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-500 border border-slate-700'
                        }`}>
                    <span>{ttsEnabled ? '🔊' : '🔇'}</span>
                    <span>{ttsEnabled ? 'TTS On' : 'TTS Off'}</span>
                </button>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 p-3 scrollbar-thin">
                {messages.length === 0 && (
                    <div className="text-center py-12 text-slate-600">
                        <span className="text-4xl">🤖</span>
                        <p className="mt-3 text-sm font-medium text-slate-300">JetArm AI</p>
                        <p className="text-xs text-slate-500 mt-1">Ask me to move the arm, describe what I see, or pick up objects</p>
                        <div className="mt-4 flex flex-wrap gap-2 justify-center">
                            {['What do you see?', 'Move servo 1 to 300', 'Open the gripper', 'Check arm status'].map(q => (
                                <button key={q} onClick={() => quickSend(q)}
                                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-full border border-slate-700 transition-colors">
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {messages.map((m: UIMessage) => (
                    <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === 'user'
                            ? 'bg-blue-600 text-white rounded-br-md'
                            : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-bl-md'
                            }`}>
                            {m.role === 'assistant' && <span className="text-xs text-blue-400 font-semibold block mb-1">🤖 JetArm AI</span>}
                            <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_code]:bg-slate-700 [&_code]:px-1 [&_code]:rounded [&_code]:text-emerald-300 [&_strong]:text-white [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm">
                                <ReactMarkdown>{getMessageText(m)}</ReactMarkdown>
                            </div>
                            {m.role === 'assistant' && getMessageText(m) && (
                                <button onClick={() => speakText(getMessageText(m), m.id)}
                                    className={`mt-1.5 text-xs px-2 py-0.5 rounded transition-all ${speaking === m.id ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50'}`}>
                                    {speaking === m.id ? '🔊 Speaking...' : '🔈 Speak'}
                                </button>
                            )}
                            {/* Show tool invocations */}
                            {m.parts.filter(p => p.type.startsWith('tool-')).map((p: any, i: number) => {
                                // AI SDK v6 tool parts — result can be at different paths
                                const toolResult = p.output || p.result || p.toolInvocation?.result;
                                const toolState = p.state || p.toolInvocation?.state;
                                const toolName = p.toolName || p.toolInvocation?.toolName || p.type;
                                return (
                                    <div key={i} className="mt-2 px-3 py-2 bg-slate-900/50 border border-slate-600/50 rounded-lg text-xs">
                                        <span className="text-amber-400 font-mono">⚡ {toolName}</span>
                                        {toolResult && (
                                            <>
                                                {/* Show camera image for look tool */}
                                                {toolResult?.snapshot_url && (
                                                    <div className="mt-2 rounded-lg overflow-hidden border border-slate-600">
                                                        <img
                                                            src={`${toolResult.snapshot_url}?t=${Date.now()}`}
                                                            alt="Robot camera view"
                                                            className="w-full max-w-[400px] rounded-lg"
                                                        />
                                                        <p className="text-[10px] text-slate-500 px-2 py-1 bg-slate-900">📷 Camera snapshot</p>
                                                    </div>
                                                )}
                                                {toolResult?.description && (
                                                    <p className="text-slate-300 mt-1.5 text-xs leading-relaxed">{toolResult.description}</p>
                                                )}
                                                {!toolResult?.snapshot_url && !toolResult?.description && (
                                                    <pre className="text-slate-400 mt-1 overflow-x-auto">{JSON.stringify(toolResult, null, 2)}</pre>
                                                )}
                                            </>
                                        )}
                                        {!toolResult && (
                                            <span className="text-slate-500 ml-2 animate-pulse">⏳ running...</span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
                {isStreaming && (
                    <div className="flex justify-start">
                        <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-bl-md px-4 py-3">
                            <div className="flex space-x-1.5">
                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border-t border-red-500/20">⚠️ {error.message}</div>}

            {/* Input */}
            <form onSubmit={onSubmit} className="border-t border-slate-700 p-3 flex items-center space-x-2">
                <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder="Tell JetArm what to do..."
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
                    disabled={isStreaming}
                />
                {isStreaming ? (
                    <button type="button" onClick={() => stop()}
                        className="p-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl transition-all">
                        <X size={16} />
                    </button>
                ) : (
                    <button type="submit" disabled={!input.trim()}
                        className="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl transition-all">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
                    </button>
                )}
                {messages.length > 0 && !isStreaming && (
                    <button type="button" onClick={() => setMessages([])} title="Clear chat"
                        className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl transition-all">
                        <Trash2 size={16} />
                    </button>
                )}
            </form>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE ASSISTANT WIDGET — Conversational Mode (like ChatGPT voice)
// ═══════════════════════════════════════════════════════════════════════════════
function VoiceAssistantWidget() {
    const [ttsStatus, setTtsStatus] = useState<'checking' | 'online' | 'offline'>('checking');
    const [voice, setVoice] = useState('af_heart');
    const [conversationOn, setConversationOn] = useState(false);
    const [phase, setPhase] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
    const [interimText, setInterimText] = useState('');
    const [history, setHistory] = useState<{ role: 'user' | 'ai'; text: string }[]>([]);
    const [textInput, setTextInput] = useState('');
    const recognitionRef = useRef<any>(null);
    const audioQueueRef = useRef<HTMLAudioElement[]>([]);
    const isPlayingRef = useRef(false);
    const conversationOnRef = useRef(false);
    const historyRef = useRef<{ id: string; role: 'user' | 'assistant'; parts: { type: string; text: string }[] }[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Keep ref in sync
    useEffect(() => { conversationOnRef.current = conversationOn; }, [conversationOn]);

    // TTS health check
    useEffect(() => {
        const check = async () => {
            try {
                const res = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'health' }) });
                const data = await res.json();
                setTtsStatus(data.success ? 'online' : 'offline');
            } catch { setTtsStatus('offline'); }
        };
        check();
        const iv = setInterval(check, 15000);
        return () => clearInterval(iv);
    }, []);

    // Auto-scroll
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [history, interimText]);

    // ── Audio Queue ──────────────────────────────────────────────────────────
    const playNextAudio = () => {
        if (audioQueueRef.current.length === 0) {
            isPlayingRef.current = false;
            setPhase(prev => prev === 'speaking' ? 'idle' : prev);
            // Auto-resume listening after AI finishes speaking
            if (conversationOnRef.current) {
                setTimeout(() => startListening(), 300);
            }
            return;
        }
        isPlayingRef.current = true;
        const audio = audioQueueRef.current.shift()!;
        audio.onended = () => { URL.revokeObjectURL(audio.src); playNextAudio(); };
        audio.onerror = () => playNextAudio();
        audio.play().catch(() => playNextAudio());
    };

    const queueSpeak = async (text: string) => {
        if (!text.trim() || text.trim().length < 2) return;
        try {
            const res = await fetch('/api/voice', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'speak', text: text.trim(), voice, speed: 1.1 }),
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audioQueueRef.current.push(audio);
                if (!isPlayingRef.current) {
                    setPhase('speaking');
                    playNextAudio();
                }
            }
        } catch { /* skip */ }
    };

    // ── Send to AI with streaming TTS ────────────────────────────────────────
    const sendToAI = async (text: string) => {
        if (!text.trim()) return;
        setHistory(prev => [...prev, { role: 'user', text }]);
        setInterimText('');
        setPhase('thinking');

        // Clear previous audio
        audioQueueRef.current.forEach(a => { try { a.pause(); URL.revokeObjectURL(a.src); } catch { } });
        audioQueueRef.current = [];
        isPlayingRef.current = false;

        // Add to message history for context
        historyRef.current.push({
            id: Date.now().toString(),
            role: 'user',
            parts: [{ type: 'text', text }],
        });

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: historyRef.current }),
            });
            const reader = res.body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder();
            let fullText = '';
            let spokenLen = 0;
            // Add placeholder AI message to history and update it as text streams
            const aiIdx = history.length + 1; // after the user message we just added
            setHistory(prev => [...prev, { role: 'ai' as const, text: '...' }]);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                for (const line of chunk.split('\n').filter(l => l.startsWith('data: '))) {
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (d.type === 'text-delta') fullText += d.delta;
                    } catch { /* skip */ }
                }
                // Update the AI message in history as text streams in
                if (fullText) {
                    const text = fullText;
                    setHistory(prev => {
                        const updated = [...prev];
                        const lastAi = updated.length - 1;
                        if (lastAi >= 0 && updated[lastAi].role === 'ai') {
                            updated[lastAi] = { role: 'ai', text };
                        }
                        return updated;
                    });
                }
                // Stream TTS: sentence boundaries
                const newText = fullText.slice(spokenLen);
                const sentenceEnd = newText.search(/[.!?]\s|[.!?]$/);
                if (sentenceEnd >= 0) {
                    const sentence = newText.slice(0, sentenceEnd + 1);
                    spokenLen += sentenceEnd + 1;
                    queueSpeak(sentence);
                }
            }
            if (fullText) {
                const remaining = fullText.slice(spokenLen);
                if (remaining.trim()) queueSpeak(remaining);
                // Final update
                setHistory(prev => {
                    const updated = [...prev];
                    const lastAi = updated.length - 1;
                    if (lastAi >= 0 && updated[lastAi].role === 'ai') {
                        updated[lastAi] = { role: 'ai', text: fullText };
                    }
                    return updated;
                });
                // Add AI response to context history
                historyRef.current.push({
                    id: (Date.now() + 1).toString(),
                    role: 'assistant',
                    parts: [{ type: 'text', text: fullText }],
                });
                // Keep last 10 messages for context
                if (historyRef.current.length > 10) {
                    historyRef.current = historyRef.current.slice(-10);
                }
            } else {
                // No text generated — remove placeholder
                setHistory(prev => {
                    const updated = [...prev];
                    const lastAi = updated.length - 1;
                    if (lastAi >= 0 && updated[lastAi].role === 'ai' && updated[lastAi].text === '...') {
                        updated[lastAi] = { role: 'ai', text: '(Action completed)' };
                    }
                    return updated;
                });
            }
        } catch (err: any) {
            setHistory(prev => [...prev, { role: 'ai', text: 'Error: ' + (err.message || 'Failed') }]);
        }
    };

    // ── Speech Recognition ───────────────────────────────────────────────────
    const startListening = () => {
        if (!conversationOnRef.current) return;
        if (phase === 'speaking' || isPlayingRef.current) return;

        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SR) return;

        // Stop any existing recognition
        try { recognitionRef.current?.stop(); } catch { }

        const r = new SR();
        r.continuous = false;
        r.interimResults = true;
        r.lang = 'en-US';

        r.onresult = (e: any) => {
            const result = e.results[e.results.length - 1];
            setInterimText(result[0].transcript);
            if (result.isFinal) {
                const finalText = result[0].transcript;
                setInterimText('');
                sendToAI(finalText);
            }
        };

        r.onerror = (e: any) => {
            // "no-speech" is normal — just restart listening
            if (e.error === 'no-speech' && conversationOnRef.current) {
                setTimeout(() => startListening(), 200);
            }
        };

        r.onend = () => {
            // Auto-restart if conversation is on and we're not speaking
            if (conversationOnRef.current && !isPlayingRef.current) {
                // Small delay to avoid rapid restarts
                setTimeout(() => {
                    if (conversationOnRef.current && !isPlayingRef.current) {
                        startListening();
                    }
                }, 300);
            }
        };

        recognitionRef.current = r;
        r.start();
        setPhase('listening');
    };

    // ── Toggle Conversation ──────────────────────────────────────────────────
    const toggleConversation = () => {
        if (conversationOn) {
            // Turn off
            setConversationOn(false);
            conversationOnRef.current = false;
            try { recognitionRef.current?.stop(); } catch { }
            audioQueueRef.current.forEach(a => { try { a.pause(); URL.revokeObjectURL(a.src); } catch { } });
            audioQueueRef.current = [];
            isPlayingRef.current = false;
            setPhase('idle');
            setInterimText('');
        } else {
            // Turn on
            setConversationOn(true);
            conversationOnRef.current = true;
            startListening();
        }
    };

    const clearHistory = () => {
        setHistory([]);
        historyRef.current = [];
        setInterimText('');
    };

    // Orb colors based on phase
    const orbClasses = {
        idle: 'bg-slate-800 border-2 border-slate-600',
        listening: 'bg-blue-500/20 border-2 border-blue-400 shadow-[0_0_40px_rgba(59,130,246,0.4)] animate-pulse',
        thinking: 'bg-amber-500/20 border-2 border-amber-400 shadow-[0_0_40px_rgba(245,158,11,0.4)] animate-pulse',
        speaking: 'bg-emerald-500/20 border-2 border-emerald-400 shadow-[0_0_40px_rgba(16,185,129,0.4)]',
    };
    const orbEmoji = { idle: '🎙️', listening: '👂', thinking: '🧠', speaking: '🔊' };
    const statusText = {
        idle: ttsStatus === 'offline' ? 'Start Kokoro TTS server first' : 'Tap to start conversation',
        listening: interimText || 'Listening...',
        thinking: 'Thinking...',
        speaking: 'Speaking...',
    };

    return (
        <div className="flex flex-col h-[400px]">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/50">
                <div className="flex items-center space-x-2">
                    <span className="text-xs text-slate-400 font-medium">🎤 Voice Chat</span>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${ttsStatus === 'online' ? 'bg-emerald-500/20 text-emerald-400' : ttsStatus === 'offline' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                        {ttsStatus === 'online' ? '● Kokoro TTS' : ttsStatus === 'offline' ? '○ TTS Offline' : '◌ Checking...'}
                    </span>
                    {conversationOn && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/20 text-blue-400 animate-pulse">
                            ● Live
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-2">
                    <select value={voice} onChange={e => setVoice(e.target.value)} className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1">
                        <option value="af_heart">Heart ♀</option>
                        <option value="af_bella">Bella ♀</option>
                        <option value="af_sarah">Sarah ♀</option>
                        <option value="am_adam">Adam ♂</option>
                        <option value="am_michael">Michael ♂</option>
                        <option value="bf_emma">Emma 🇬🇧 ♀</option>
                        <option value="bm_george">George 🇬🇧 ♂</option>
                    </select>
                    {history.length > 0 && (
                        <button onClick={clearHistory} className="text-slate-500 hover:text-red-400 transition-colors" title="Clear chat">
                            🗑️
                        </button>
                    )}
                </div>
            </div>

            {/* Conversation history */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
                {history.length === 0 && !conversationOn && (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-3">
                        <div className="text-4xl">🎙️</div>
                        <p className="text-sm text-slate-400">Tap the button below to start a real-time conversation with JetArm AI</p>
                        <p className="text-xs text-slate-600">It will listen, think, speak, then listen again — just like talking to a person</p>
                    </div>
                )}
                {history.map((h, i) => (
                    <div key={i} className={`flex ${h.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${h.role === 'user'
                            ? 'bg-blue-600 text-white rounded-br-md'
                            : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-bl-md'
                            }`}>
                            {h.role === 'ai' && <span className="text-[10px] text-blue-400 block mb-0.5">🤖 JetArm</span>}
                            {h.text ? (
                                <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_code]:bg-slate-700 [&_code]:px-1 [&_code]:rounded [&_code]:text-emerald-300 [&_strong]:text-white">
                                    <ReactMarkdown>{h.text}</ReactMarkdown>
                                </div>
                            ) : (
                                <span className="text-slate-500 italic">No response text</span>
                            )}
                        </div>
                    </div>
                ))}
                {interimText && phase === 'listening' && (
                    <div className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl px-3 py-2 text-sm bg-blue-600/50 text-white/70 rounded-br-md italic">
                            {interimText}...
                        </div>
                    </div>
                )}
                {phase === 'thinking' && (
                    <div className="flex justify-start">
                        <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-bl-md px-3 py-2">
                            <div className="flex space-x-1">
                                <div className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                <div className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                <div className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom controls */}
            <div className="border-t border-slate-700 p-3">
                <div className="flex items-center justify-center space-x-4 mb-2">
                    <button onClick={toggleConversation} disabled={ttsStatus === 'offline'}
                        className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500 ${orbClasses[phase]} ${conversationOn ? '' : 'hover:border-blue-500/50 hover:shadow-[0_0_20px_rgba(59,130,246,0.2)]'}`}>
                        <span className="text-2xl">{conversationOn ? orbEmoji[phase] : '🎙️'}</span>
                    </button>
                </div>
                <p className="text-[11px] text-slate-500 text-center mb-2">{conversationOn ? statusText[phase] : statusText.idle}</p>
                <form onSubmit={(e) => { e.preventDefault(); if (textInput.trim()) { sendToAI(textInput); setTextInput(''); } }} className="flex items-center space-x-2">
                    <input value={textInput} onChange={e => setTextInput(e.target.value)} placeholder="Or type here..." className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" disabled={phase === 'speaking' || phase === 'thinking'} />
                    <button type="submit" disabled={!textInput.trim() || phase === 'speaking' || phase === 'thinking'} className="p-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl transition-all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
                    </button>
                </form>
            </div>
        </div>
    );
}

// ── AI Controls Widget ───────────────────────────────────────────────────────
function AIControlsWidget() {
    const [loading, setLoading] = useState<string | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [yoloRunning, setYoloRunning] = useState(false);

    const addLog = (msg: string) => setLogs(prev => [...prev.slice(-8), `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`]);

    // Silently check YOLO status on mount (don't log, just sync the indicator)
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'yolo_status' }) });
                const data = await res.json();
                if (data.success) setYoloRunning(data.running);
            } catch { /* Jetson may be offline — just leave indicator as inactive */ }
        })();
    }, []);

    const runAI = async (action: string, label: string) => {
        setLoading(action);
        addLog(`⏳ ${label}...`);
        try {
            const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
            const data = await res.json();
            addLog(data.success ? `✅ ${data.message}` : `❌ ${data.error || 'Failed'}`);
            if (data.log) addLog(`📋 ${data.log}`);
            if (action === 'yolo_status') setYoloRunning(data.running);
            if (action === 'start_yolo') setYoloRunning(true);
            if (action === 'stop_yolo') setYoloRunning(false);
        } catch (e) {
            addLog('❌ Network error — could not reach server');
        }
        setLoading(null);
    };

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <div className="flex items-center space-x-3 mb-5">
                <span className="text-2xl">🚀</span>
                <h2 className="text-xl font-semibold">YOLO Controls</h2>
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${yoloRunning ? 'bg-emerald-600/30 text-emerald-400 animate-pulse' : 'bg-slate-700 text-slate-500'}`}>
                    {yoloRunning ? '● YOLO Active' : '○ YOLO Inactive'}
                </span>
            </div>

            {/* Primary controls */}
            <div className="flex flex-wrap gap-2 mb-4">
                <button onClick={() => runAI('start_yolo', 'Starting YOLO detector')} disabled={!!loading}
                    className="flex items-center space-x-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold shadow-lg shadow-purple-600/20">
                    <span>🧠</span><span>{loading === 'start_yolo' ? 'Starting...' : 'Start YOLO'}</span>
                </button>
                <button onClick={() => runAI('stop_yolo', 'Stopping YOLO detector')} disabled={!!loading}
                    className="flex items-center space-x-2 px-4 py-2.5 bg-red-600/80 hover:bg-red-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <PowerOff size={16} /><span>{loading === 'stop_yolo' ? 'Stopping...' : 'Stop YOLO'}</span>
                </button>
                <button onClick={() => runAI('detect_yolo', 'Detecting YOLO installation')} disabled={!!loading}
                    className="flex items-center space-x-2 px-3 py-2.5 bg-amber-600/80 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <span>{loading === 'detect_yolo' ? '⏳' : '🔎'}</span><span>Detect YOLO</span>
                </button>
                <button onClick={() => runAI('yolo_status', 'Checking YOLO status')} disabled={!!loading}
                    className="flex items-center space-x-2 px-3 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <span>{loading === 'yolo_status' ? '⏳' : '🔍'}</span><span>Status</span>
                </button>
            </div>

            {/* Log output */}
            {logs.length > 0 && (
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 max-h-40 overflow-auto">
                    <div className="flex justify-end space-x-2 mb-2">
                        <button onClick={() => { navigator.clipboard.writeText(logs.join('\n')); }} className="text-[10px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition-colors">Copy</button>
                        <button onClick={() => setLogs([])} className="text-[10px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition-colors">Clear</button>
                    </div>
                    <div className="space-y-1 text-xs font-mono text-slate-400">
                        {logs.map((log, i) => (<div key={i} className={log.includes('❌') ? 'text-red-400' : log.includes('✅') ? 'text-emerald-400' : ''}>{log}</div>))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERHEAD CAMERA Widget — Third-person view with live status + refresh
// ═══════════════════════════════════════════════════════════════════════════════
function OverheadCameraWidget({ mode }: { mode: 'raw' | 'annotated' }) {
    const [isLive, setIsLive] = useState(false);
    const [fps, setFps] = useState(0);
    const [objectCount, setObjectCount] = useState(0);
    const [inferenceMs, setInferenceMs] = useState(0);
    const [streamKey, setStreamKey] = useState(Date.now());
    const [lastUpdate, setLastUpdate] = useState(0);
    const [cameraName, setCameraName] = useState('');

    // Poll /state every 2s to check connectivity
    useEffect(() => {
        let alive = true;
        const poll = async () => {
            while (alive) {
                try {
                    const res = await fetch(`http://${JETSON_IP}:8081/state`, {
                        signal: AbortSignal.timeout(2000),
                    });
                    const data = await res.json();
                    if (alive) {
                        const now = Date.now();
                        const stale = data.timestamp && (now / 1000 - data.timestamp) > 5;
                        setIsLive(!stale);
                        setFps(data.fps || 0);
                        setObjectCount(data.objects?.length || 0);
                        setInferenceMs(data.inference_ms || 0);
                        setCameraName(data.camera_name || '');
                        setLastUpdate(now);
                    }
                } catch {
                    if (alive) setIsLive(false);
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        };
        poll();
        return () => { alive = false; };
    }, []);

    const [isRestarting, setIsRestarting] = useState(false);

    const handleRefresh = async () => {
        if (!isLive) {
            // Camera is offline — do a full process restart via bridge
            setIsRestarting(true);
            try {
                const res = await fetch(`http://${JETSON_IP}:8888`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'restart_overhead' }),
                    signal: AbortSignal.timeout(15000), // restart takes ~5s
                });
                const data = await res.json();
                if (data.success) {
                    setStreamKey(Date.now());
                    // Give it a moment then re-poll
                    await new Promise(r => setTimeout(r, 2000));
                }
            } catch { /* ignore */ }
            setIsRestarting(false);
        }

        // Always refresh the stream and re-check state
        setStreamKey(Date.now());
        try {
            const res = await fetch(`http://${JETSON_IP}:8081/state`, {
                signal: AbortSignal.timeout(2000),
            });
            const data = await res.json();
            const now = Date.now();
            const stale = data.timestamp && (now / 1000 - data.timestamp) > 5;
            setIsLive(!stale);
            setFps(data.fps || 0);
            setObjectCount(data.objects?.length || 0);
            setInferenceMs(data.inference_ms || 0);
            setCameraName(data.camera_name || '');
            setLastUpdate(now);
        } catch {
            setIsLive(false);
        }
    };

    const streamUrl = `http://${JETSON_IP}:8081/${mode}?t=${streamKey}`;
    const isAnnotated = mode === 'annotated';

    return (
        <div className="bg-black rounded-xl overflow-hidden border border-slate-800">
            {/* Header */}
            <div className="flex items-center justify-between p-3 bg-slate-900/80">
                <div className="flex items-center space-x-2">
                    {/* Pulsing live indicator */}
                    <div className="relative flex items-center">
                        <div className={`w-2.5 h-2.5 rounded-full ${isLive ? 'bg-green-500' : 'bg-red-500'}`} />
                        {isLive && (
                            <div className="absolute w-2.5 h-2.5 rounded-full bg-green-500 animate-ping opacity-75" />
                        )}
                    </div>
                    <span className="text-sm font-semibold text-slate-300">
                        {isAnnotated ? '🔭' : '🎥'} Overhead Camera
                    </span>
                    {isAnnotated && (
                        <span className="text-[10px] px-2 py-0.5 bg-green-600/30 text-green-400 rounded-full font-bold">
                            YOLO
                        </span>
                    )}
                    {cameraName && <span className="text-[10px] text-slate-500">{cameraName}</span>}
                </div>
                <div className="flex items-center space-x-3">
                    {/* Stats */}
                    {isLive && (
                        <div className="flex items-center space-x-2 text-[10px] text-slate-400">
                            <span>{fps.toFixed(0)} FPS</span>
                            {isAnnotated && <span>{inferenceMs.toFixed(0)}ms</span>}
                            <span className={`font-bold ${objectCount > 0 ? 'text-cyan-400' : 'text-slate-500'}`}>
                                {objectCount} obj
                            </span>
                        </div>
                    )}
                    {/* Refresh button */}
                    <button
                        onClick={handleRefresh}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-all"
                        title="Reconnect stream"
                    >
                        <RefreshCw size={14} />
                    </button>
                </div>
            </div>

            {/* Stream or offline message */}
            {isLive ? (
                <img
                    key={streamKey}
                    src={streamUrl}
                    alt={`Overhead ${mode}`}
                    className="w-full"
                />
            ) : (
                <div className="flex flex-col items-center justify-center py-12 space-y-3">
                    <Camera size={48} className={`opacity-20 text-slate-500 ${isRestarting ? 'animate-pulse' : ''}`} />
                    <div className="text-sm text-red-400 font-semibold">
                        {isRestarting ? 'RESTARTING...' : 'OFFLINE'}
                    </div>
                    <div className="text-xs text-slate-500">
                        {isRestarting ? 'Killing and restarting overhead camera process...' : 'Overhead camera not responding'}
                    </div>
                    <button
                        onClick={handleRefresh}
                        disabled={isRestarting}
                        className={`flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs transition-all ${isRestarting
                            ? 'bg-yellow-800/30 text-yellow-400 cursor-wait'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                            }`}
                    >
                        <RefreshCw size={12} className={isRestarting ? 'animate-spin' : ''} />
                        <span>{isRestarting ? 'Restarting Camera...' : 'Restart Camera'}</span>
                    </button>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTONOMY Widget — Autonomous sense→think→act loop
// ═══════════════════════════════════════════════════════════════════════════════
function AutonomyWidget() {
    const [goal, setGoal] = useState('');
    const [running, setRunning] = useState(false);
    const [step, setStep] = useState(0);
    const [maxSteps, setMaxSteps] = useState(() => {
        if (typeof window === 'undefined') return 30;
        const saved = localStorage.getItem('jetarm-autonomy-maxsteps');
        return saved ? parseInt(saved, 10) : 30;
    });
    const [log, setLog] = useState<{ step: number; phase: string; content: string; time: number }[]>([]);
    const [loading, setLoading] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [copied, setCopied] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);

    // Poll status while running
    useEffect(() => {
        if (!running) return;
        const interval = setInterval(async () => {
            try {
                const res = await fetch('/api/autonomy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'status' }),
                });
                const data = await res.json();
                if (data.success) {
                    setRunning(data.running);
                    setStep(data.step);
                    setLog(data.log || []);
                    setElapsed(data.elapsed || 0);
                }
            } catch { }
        }, 1500);
        return () => clearInterval(interval);
    }, [running]);

    // Auto-scroll log
    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [log]);

    const startAutonomy = async () => {
        if (!goal.trim()) return;
        setLoading(true);
        try {
            const res = await fetch('/api/autonomy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'start', goal: goal.trim(), maxSteps }),
            });
            const data = await res.json();
            if (data.success) {
                setRunning(true);
                setStep(0);
                setLog([]);
            }
        } catch { }
        setLoading(false);
    };

    const stopAutonomy = async () => {
        try {
            await fetch('/api/autonomy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'stop' }),
            });
            setRunning(false);
        } catch { }
    };

    const phaseColor = (phase: string) => {
        switch (phase) {
            case 'SENSE': return 'text-blue-400';
            case 'THINK': return 'text-purple-400';
            case 'ACT': return 'text-amber-400';
            case 'RESULT': return 'text-emerald-400';
            case 'DONE': return 'text-green-400 font-bold';
            case 'CANNOT': return 'text-red-400 font-bold';
            case 'ERROR': return 'text-red-500';
            case 'WAIT': return 'text-slate-500';
            case 'START': return 'text-cyan-400 font-bold';
            case 'LOOK': return 'text-cyan-400';
            case 'MEMORY': return 'text-purple-400';
            case 'LEARN': return 'text-teal-400 font-semibold';
            case 'STOP': case 'END': return 'text-orange-400 font-bold';
            default: return 'text-slate-400';
        }
    };

    const phaseIcon = (phase: string) => {
        switch (phase) {
            case 'SENSE': return '👁️';
            case 'THINK': return '🧠';
            case 'ACT': return '⚡';
            case 'RESULT': return '✅';
            case 'DONE': return '🎉';
            case 'CANNOT': return '❌';
            case 'ERROR': return '💥';
            case 'WAIT': return '⏳';
            case 'START': return '🚀';
            case 'LOOK': return '🔍';
            case 'MEMORY': return '💾';
            case 'LEARN': return '🧠';
            case 'STOP': case 'END': return '🛑';
            default: return '•';
        }
    };

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <div className="flex items-center space-x-3 mb-2">
                <span className="text-2xl">🤖</span>
                <h2 className="text-xl font-semibold">Autonomous Mode</h2>
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${running ? 'bg-green-600/30 text-green-400 animate-pulse' : 'bg-slate-700 text-slate-500'}`}>
                    {running ? `● Running (Step ${step}/${maxSteps})` : '○ Idle'}
                </span>
                {elapsed > 0 && (
                    <span className="text-xs text-slate-500">{Math.round(elapsed / 1000)}s</span>
                )}
            </div>
            <p className="text-xs text-slate-500 mb-4">Set a goal → robot runs sense→think→act loop autonomously</p>

            {/* Goal input */}
            <div className="flex gap-2 mb-4">
                <input
                    type="text"
                    value={goal}
                    onChange={e => setGoal(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !running && startAutonomy()}
                    placeholder="e.g., Pick up the nearest object"
                    disabled={running}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 disabled:opacity-50"
                />
                {!running ? (
                    <>
                        <select
                            value={maxSteps}
                            onChange={e => {
                                const v = parseInt(e.target.value, 10);
                                setMaxSteps(v);
                                localStorage.setItem('jetarm-autonomy-maxsteps', String(v));
                            }}
                            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-2.5 text-xs text-slate-300 focus:outline-none focus:border-purple-500 appearance-none cursor-pointer"
                            title="Max steps"
                        >
                            {[5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 300, 500, 999].map(n => (
                                <option key={n} value={n}>{n} steps</option>
                            ))}
                        </select>
                        <button onClick={startAutonomy} disabled={loading || !goal.trim()}
                            className="px-5 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white rounded-lg text-sm font-semibold shadow-lg shadow-green-600/20">
                            {loading ? '⏳' : '▶'} Start
                        </button>
                    </>
                ) : (
                    <button onClick={stopAutonomy}
                        className="px-5 py-2.5 bg-red-600 hover:bg-red-500 transition-colors text-white rounded-lg text-sm font-semibold shadow-lg shadow-red-600/20 animate-pulse">
                        ⏹ E-STOP
                    </button>
                )}
            </div>

            {/* Preset goals */}
            {!running && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                    {['Look around the workspace', 'Pick up the nearest object', 'Wave hello', 'Nod yes then shake no', 'Touch the closest thing'].map(preset => (
                        <button key={preset} onClick={() => setGoal(preset)}
                            className="text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-md transition-colors border border-slate-700/50">
                            {preset}
                        </button>
                    ))}
                </div>
            )}

            {/* Action log */}
            {log.length > 0 && (
                <>
                    {/* Pinned controls — always visible above scroll */}
                    <div className="flex justify-between items-center mb-2 bg-slate-900 sticky top-0 z-10 py-1">
                        <span className="text-[10px] text-slate-600 font-semibold uppercase tracking-wide">Action Log ({log.length} entries)</span>
                        <div className="flex gap-1">
                            <button
                                onClick={() => {
                                    const text = log.map(e => `[Step ${e.step}] ${e.phase}: ${e.content}`).join('\n');
                                    navigator.clipboard.writeText(text);
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 2000);
                                }}
                                className="text-[10px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition-colors"
                            >{copied ? '✓ Copied' : 'Copy'}</button>
                            <button onClick={() => setLog([])} className="text-[10px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition-colors">Clear</button>
                        </div>
                    </div>
                    <div ref={logRef} className="bg-slate-950 border border-slate-800 rounded-lg p-3 max-h-96 overflow-auto">
                        <div className="space-y-0.5 text-xs font-mono">
                            {log.map((entry, i) => (
                                <div key={i} className={`flex gap-2 ${phaseColor(entry.phase)}`}>
                                    <span className="opacity-50 w-6 text-right shrink-0">{entry.step}</span>
                                    <span className="w-4 shrink-0">{phaseIcon(entry.phase)}</span>
                                    <span className="font-bold w-14 shrink-0">{entry.phase}</span>
                                    <span className="text-slate-300 break-all">{entry.content}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISION V2 — TensorRT Controls Widget
// ═══════════════════════════════════════════════════════════════════════════════
function VisionV2ControlsWidget() {
    const [loading, setLoading] = useState<string | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [v2Running, setV2Running] = useState(false);

    const addLog = (msg: string) => setLogs(prev => [...prev.slice(-8), `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'yolo_v2_status' }) });
                const data = await res.json();
                if (data.success) setV2Running(data.running);
            } catch { }
        })();
    }, []);

    const runAction = async (action: string, label: string) => {
        setLoading(action);
        addLog(`⏳ ${label}...`);
        try {
            const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
            const data = await res.json();
            addLog(data.success ? `✅ ${data.message}` : `❌ ${data.error || data.message || 'Failed'}`);
            if (data.log) addLog(`📋 ${data.log}`);
            if (action === 'yolo_v2_status') {
                setV2Running(data.running);
                if (data.vision) addLog(`👁️ Vision: ${data.vision.count} objects, ${data.vision.fps} FPS, ${data.vision.inference_ms}ms`);
            }
            if (action === 'start_yolo_v2') setV2Running(true);
            if (action === 'stop_yolo_v2') setV2Running(false);
        } catch (e) {
            addLog('❌ Network error');
        }
        setLoading(null);
    };

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <div className="flex items-center space-x-3 mb-2">
                <span className="text-2xl">🚀</span>
                <h2 className="text-xl font-semibold">YOLO v2 — TensorRT</h2>
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${v2Running ? 'bg-emerald-600/30 text-emerald-400 animate-pulse' : 'bg-slate-700 text-slate-500'}`}>
                    {v2Running ? '● TensorRT Active' : '○ Inactive'}
                </span>
            </div>
            <p className="text-xs text-slate-500 mb-4">YOLOv8n + TensorRT FP16 — up to 100+ FPS on Orin Nano Super</p>

            <div className="flex flex-wrap gap-2 mb-4">
                <button onClick={() => runAction('export_tensorrt', 'Exporting TensorRT engine (2-5 min)')} disabled={!!loading}
                    className="flex items-center space-x-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold shadow-lg shadow-amber-600/20">
                    <span>🔧</span><span>{loading === 'export_tensorrt' ? 'Exporting...' : 'Export Engine'}</span>
                </button>
                <button onClick={() => runAction('start_yolo_v2', 'Starting YOLO v2 TensorRT')} disabled={!!loading}
                    className="flex items-center space-x-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold shadow-lg shadow-purple-600/20">
                    <span>🧠</span><span>{loading === 'start_yolo_v2' ? 'Starting...' : 'Start v2'}</span>
                </button>
                <button onClick={() => runAction('stop_yolo_v2', 'Stopping YOLO v2')} disabled={!!loading}
                    className="flex items-center space-x-2 px-4 py-2.5 bg-red-600/80 hover:bg-red-500 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <PowerOff size={16} /><span>{loading === 'stop_yolo_v2' ? 'Stopping...' : 'Stop v2'}</span>
                </button>
                <button onClick={() => runAction('yolo_v2_status', 'Checking v2 status')} disabled={!!loading}
                    className="flex items-center space-x-2 px-3 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait transition-colors text-white rounded-lg text-sm font-semibold">
                    <span>{loading === 'yolo_v2_status' ? '⏳' : '🔍'}</span><span>Status</span>
                </button>
            </div>

            {logs.length > 0 && (
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 max-h-40 overflow-auto">
                    <div className="flex justify-end space-x-2 mb-2">
                        <button onClick={() => setLogs([])} className="text-[10px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition-colors">Clear</button>
                    </div>
                    <div className="space-y-1 text-xs font-mono text-slate-400">
                        {logs.map((log, i) => (<div key={i} className={log.includes('❌') ? 'text-red-400' : log.includes('✅') ? 'text-emerald-400' : log.includes('👁️') ? 'text-blue-400' : ''}>{log}</div>))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISION V2 — Live State Widget (polls HTTP endpoint)
// ═══════════════════════════════════════════════════════════════════════════════
function VisionV2StateWidget() {
    const [vision, setVision] = useState<{ fps: number; inference_ms: number; count: number; objects: any[] } | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        const poll = async () => {
            try {
                const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_vision' }) });
                const data = await res.json();
                if (data.success && data.vision) {
                    setVision(data.vision);
                    setError(false);
                } else {
                    setError(true);
                }
            } catch { setError(true); }
        };
        poll();
        const interval = setInterval(poll, 2000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-3">
                    <span className="text-2xl">👁️</span>
                    <h2 className="text-xl font-semibold">Vision v2 State</h2>
                    {vision && (
                        <>
                            <span className="text-xs bg-purple-600/30 text-purple-300 px-2 py-1 rounded-full font-bold">{vision.fps} FPS</span>
                            <span className="text-xs bg-blue-600/30 text-blue-300 px-2 py-1 rounded-full font-bold">{vision.inference_ms}ms</span>
                            <span className="text-xs bg-emerald-600/30 text-emerald-400 px-2 py-1 rounded-full font-bold">{vision.count} obj</span>
                        </>
                    )}
                </div>
            </div>

            {error && !vision ? (
                <div className="text-center py-8 text-slate-600">
                    <span className="text-3xl opacity-30">👁️</span>
                    <p className="mt-2 text-sm">YOLO v2 not running — start it from the controls above</p>
                </div>
            ) : vision && vision.objects.length > 0 ? (
                <div className="overflow-auto max-h-64 rounded-lg border border-slate-800">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-800/50 sticky top-0">
                            <tr className="text-slate-400 text-left">
                                <th className="px-3 py-2">Object</th>
                                <th className="px-3 py-2">Confidence</th>
                                <th className="px-3 py-2">Depth</th>
                                <th className="px-3 py-2">Position</th>
                                <th className="px-3 py-2">Size</th>
                            </tr>
                        </thead>
                        <tbody>
                            {vision.objects.map((det: any, i: number) => (
                                <tr key={i} className="border-t border-slate-800/50 hover:bg-slate-800/30">
                                    <td className="px-3 py-2 font-semibold text-white">{det.class}</td>
                                    <td className="px-3 py-2">
                                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${det.confidence > 0.8 ? 'bg-emerald-600/30 text-emerald-400' : det.confidence > 0.5 ? 'bg-yellow-600/30 text-yellow-400' : 'bg-red-600/30 text-red-400'}`}>
                                            {(det.confidence * 100).toFixed(1)}%
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 font-mono text-blue-300">{det.depth_mm > 0 ? `${det.depth_mm}mm` : '—'}</td>
                                    <td className="px-3 py-2 font-mono text-slate-400 text-xs">{det.center_px[0]}, {det.center_px[1]}</td>
                                    <td className="px-3 py-2 font-mono text-slate-400 text-xs">{det.size_px[0]}×{det.size_px[1]}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : vision ? (
                <div className="text-center py-8 text-slate-600">
                    <span className="text-3xl opacity-30">✅</span>
                    <p className="mt-2 text-sm">Running at {vision.fps} FPS — no objects in view</p>
                </div>
            ) : (
                <div className="text-center py-8 text-slate-600">
                    <span className="text-3xl opacity-30 animate-spin">⏳</span>
                    <p className="mt-2 text-sm">Connecting to vision server...</p>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE RENDERER (dispatches to correct widget)
// ═══════════════════════════════════════════════════════════════════════════════
function ModuleContent({ type, shared }: { type: ModuleType; shared: SharedState }) {
    switch (type) {
        case 'rgb_feed': {
            const refreshRgb = () => { shared.setRgbStatus('idle'); shared.setStreamKey(Date.now()); };
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
                    <div className="absolute top-3 left-3 flex items-center space-x-2 px-3 py-1.5 bg-black/50 backdrop-blur text-white rounded-lg text-sm font-semibold border border-white/10 z-10">
                        <Camera size={16} /><span>RGB Main Feed</span>
                        {shared.rgbStatus === 'live' && <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />}
                    </div>
                    <button onClick={refreshRgb} className="absolute top-3 right-3 p-2 bg-black/50 backdrop-blur border border-white/10 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors z-10">
                        <RefreshCw size={14} />
                    </button>
                    <div className="aspect-video bg-black flex items-center justify-center relative">
                        {shared.rgbStatus !== 'idle' && shared.streamKey > 0 && (
                            <img src={`http://${JETSON_IP}:8080/stream?topic=/depth_cam/color/image_raw&type=ros_compressed&_k=${shared.streamKey}`}
                                className={`w-full h-full object-cover transition-opacity duration-300 ${shared.rgbStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
                                alt="RGB Feed" onError={() => shared.setRgbStatus('failed')} />
                        )}
                        {shared.rgbStatus !== 'live' && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                                <Camera size={48} className="mb-4 opacity-20" /><p>{shared.rgbStatus === 'failed' ? 'RGB Stream not available.' : 'Connecting...'}</p>
                            </div>
                        )}
                    </div>
                </div>
            );
        }
        case 'depth_feed': {
            const refreshDepth = () => { shared.setDepthStatus('idle'); shared.setStreamKey(Date.now()); };
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
                    <div className="absolute top-3 left-3 flex items-center space-x-2 px-3 py-1.5 bg-black/50 backdrop-blur text-emerald-400 rounded-lg text-sm font-semibold border border-white/10 z-10">
                        <Camera size={16} /><span>Depth Sensor Feed</span>
                    </div>
                    <div className="absolute top-3 right-3 flex items-center space-x-2 z-10">
                        <div className="flex bg-black/50 backdrop-blur border border-white/10 rounded-lg overflow-hidden text-xs font-semibold">
                            {(['raw', 'jet', 'plasma', 'gray'] as const).map((cm, i) => (
                                <button key={cm} onClick={() => shared.setDepthColormap(cm)} className={`px-3 py-1.5 transition-colors ${i > 0 ? 'border-l border-white/10' : ''} ${shared.depthColormap === cm ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>{cm.toUpperCase()}</button>
                            ))}
                        </div>
                        <button onClick={refreshDepth} className="p-2 bg-black/50 backdrop-blur border border-white/10 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                    <div className="aspect-video bg-black flex items-center justify-center relative">
                        {shared.depthStatus !== 'idle' && shared.streamKey > 0 && (
                            <img src={`http://${JETSON_IP}:8080/stream?topic=/depth_cam/depth/color_map/${shared.depthColormap}&type=ros_compressed&_k=${shared.streamKey}`}
                                className={`w-full h-full object-cover transition-opacity duration-300 ${shared.depthStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
                                alt="Depth Feed" onError={() => shared.setDepthStatus('failed')} />
                        )}
                        {shared.depthStatus !== 'live' && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                                <Camera size={48} className="mb-4 opacity-20" /><p>{shared.depthStatus === 'failed' ? 'Depth Stream not available.' : 'Connecting...'}</p>
                            </div>
                        )}
                    </div>
                </div>
            );
        }
        case 'gamepad_visualizer':
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
                    <div className="flex items-center space-x-3 mb-4"><Settings2 className="text-emerald-400" /><h2 className="text-xl font-semibold">Controller Visualizer</h2></div>
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-4"><GamepadVisualizer gp={shared.gamepad} /></div>
                </div>
            );
        case 'telemetry': {
            const SERVO_IDS = [1, 2, 3, 4, 5, 10];
            const SERVO_NAMES = ['Base (ID:1)', 'Shoulder (ID:2)', 'Elbow (ID:3)', 'Wrist Pitch (ID:4)', 'Wrist Roll (ID:5)', 'Gripper (ID:10)'];
            const [showConstraints, setShowConstraints] = useState(false);
            const [constraints, setConstraints] = useState<Record<number, { min: number, max: number }>>(() => {
                // Load from localStorage on init
                if (typeof window !== 'undefined') {
                    try {
                        const saved = localStorage.getItem('jetarm_servo_constraints');
                        if (saved) return JSON.parse(saved);
                    } catch { }
                }
                return { 1: { min: 0, max: 1000 }, 2: { min: 0, max: 1000 }, 3: { min: 0, max: 1000 }, 4: { min: 0, max: 1000 }, 5: { min: 0, max: 1000 }, 10: { min: 0, max: 1000 } };
            });
            const [constraintsSaved, setConstraintsSaved] = useState(true);
            const [constraintsLoading, setConstraintsLoading] = useState(false);

            // Load constraints from bridge
            const loadFromBridge = async () => {
                setConstraintsLoading(true);
                try {
                    const res = await fetch(`http://${JETSON_IP}:8888`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'safety_status' }),
                    });
                    const data = await res.json();
                    if (data.success && data.limits) {
                        const newConstraints: Record<number, { min: number, max: number }> = {};
                        for (const [k, v] of Object.entries(data.limits) as any) {
                            newConstraints[parseInt(k)] = { min: v.min, max: v.max };
                        }
                        setConstraints(newConstraints);
                        localStorage.setItem('jetarm_servo_constraints', JSON.stringify(newConstraints));
                        setConstraintsSaved(true);
                    }
                } catch { } finally { setConstraintsLoading(false); }
            };

            // Save constraints to bridge + localStorage
            const saveConstraints = async (newConstraints: Record<number, { min: number, max: number }>) => {
                setConstraints(newConstraints);
                localStorage.setItem('jetarm_servo_constraints', JSON.stringify(newConstraints));
                setConstraintsLoading(true);
                try {
                    const limitsPayload: Record<string, { min: number, max: number }> = {};
                    for (const [k, v] of Object.entries(newConstraints)) {
                        limitsPayload[k] = { min: v.min, max: v.max };
                    }
                    const res = await fetch(`http://${JETSON_IP}:8888`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'set_safety_limits', limits: limitsPayload }),
                    });
                    const data = await res.json();
                    if (data.success) setConstraintsSaved(true);
                } catch { } finally { setConstraintsLoading(false); }
            };

            const updateConstraint = (servoId: number, field: 'min' | 'max', value: number) => {
                const clamped = Math.max(0, Math.min(1000, value));
                const updated = { ...constraints, [servoId]: { ...constraints[servoId], [field]: clamped } };
                // Ensure min <= max
                if (field === 'min' && clamped > updated[servoId].max) updated[servoId].max = clamped;
                if (field === 'max' && clamped < updated[servoId].min) updated[servoId].min = clamped;
                setConstraintsSaved(false);
                setConstraints(updated);
            };

            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                    <div className="flex items-center space-x-3 mb-6"><Activity className="text-blue-400" /><h2 className="text-xl font-semibold">Teleoperation Metrics</h2></div>
                    <div className="space-y-4">
                        {SERVO_NAMES.map((joint, idx) => {
                            const servoId = SERVO_IDS[idx];
                            const c = constraints[servoId] || { min: 0, max: 1000 };
                            const pos = shared.jointPos[idx];
                            const isOutOfBounds = pos < c.min || pos > c.max;
                            return (
                                <div key={idx} className="space-y-1.5">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-slate-400">{joint}</span>
                                        <span className={`font-mono ${isOutOfBounds ? 'text-red-400' : 'text-blue-300'}`}>
                                            {pos} Pulse
                                            {isOutOfBounds && <span className="text-red-500 text-xs ml-1">⚠️</span>}
                                        </span>
                                    </div>
                                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden relative">
                                        {/* Constrained range indicator */}
                                        <div className="absolute h-full bg-slate-700/50 rounded-full" style={{ left: `${(c.min / 1000) * 100}%`, width: `${((c.max - c.min) / 1000) * 100}%` }} />
                                        {/* Min marker */}
                                        {c.min > 0 && <div className="absolute h-full w-0.5 bg-red-500/70 z-10" style={{ left: `${(c.min / 1000) * 100}%` }} />}
                                        {/* Max marker */}
                                        {c.max < 1000 && <div className="absolute h-full w-0.5 bg-red-500/70 z-10" style={{ left: `${(c.max / 1000) * 100}%` }} />}
                                        {/* Position bar */}
                                        <div className={`h-full rounded-full transition-all duration-300 ease-out relative z-20 ${isOutOfBounds ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${(pos / 1000) * 100}%` }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Servo Constraints Section */}
                    <div className="mt-6 border-t border-slate-800 pt-4">
                        <button
                            onClick={() => { setShowConstraints(!showConstraints); if (!showConstraints) loadFromBridge(); }}
                            className="flex items-center justify-between w-full text-sm group"
                        >
                            <div className="flex items-center space-x-2">
                                <span className="text-amber-400">🔒</span>
                                <span className="text-slate-300 font-medium group-hover:text-white transition-colors">Servo Constraints</span>
                                {!constraintsSaved && <span className="text-xs text-amber-400 bg-amber-900/30 px-1.5 py-0.5 rounded">unsaved</span>}
                            </div>
                            <span className={`text-slate-500 transition-transform duration-200 ${showConstraints ? 'rotate-180' : ''}`}>▼</span>
                        </button>

                        {showConstraints && (
                            <div className="mt-4 space-y-3 animate-in fade-in duration-200">
                                <p className="text-xs text-slate-500">Set min/max pulse limits per servo. Changes are enforced on ALL commands (AI, gamepad, chat).</p>

                                {SERVO_NAMES.map((joint, idx) => {
                                    const servoId = SERVO_IDS[idx];
                                    const c = constraints[servoId] || { min: 0, max: 1000 };
                                    const defaults: Record<number, { min: number, max: number }> = { 1: { min: 0, max: 1000 }, 2: { min: 0, max: 1000 }, 3: { min: 0, max: 1000 }, 4: { min: 0, max: 1000 }, 5: { min: 0, max: 1000 }, 10: { min: 0, max: 1000 } };
                                    const d = defaults[servoId] || { min: 0, max: 1000 };
                                    const isModified = c.min !== d.min || c.max !== d.max;
                                    return (
                                        <div key={servoId} className={`flex items-center gap-2 text-sm p-2 rounded-lg ${isModified ? 'bg-amber-900/10 border border-amber-800/30' : 'bg-slate-800/30'}`}>
                                            <span className="text-slate-400 w-28 shrink-0 text-xs">{joint.split('(')[0].trim()}</span>
                                            <div className="flex items-center gap-1.5 flex-1">
                                                <span className="text-slate-500 text-xs">Min</span>
                                                <input
                                                    type="number" min={0} max={1000} value={c.min}
                                                    onChange={(e) => updateConstraint(servoId, 'min', parseInt(e.target.value) || 0)}
                                                    className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-300 focus:border-amber-500 focus:outline-none"
                                                />
                                                <div className="flex-1 h-1 bg-slate-800 rounded-full mx-1 relative">
                                                    <div className="absolute h-full bg-emerald-600/50 rounded-full" style={{ left: `${(c.min / 1000) * 100}%`, width: `${((c.max - c.min) / 1000) * 100}%` }} />
                                                </div>
                                                <span className="text-slate-500 text-xs">Max</span>
                                                <input
                                                    type="number" min={0} max={1000} value={c.max}
                                                    onChange={(e) => updateConstraint(servoId, 'max', parseInt(e.target.value) || 0)}
                                                    className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-300 focus:border-amber-500 focus:outline-none"
                                                />
                                            </div>
                                        </div>
                                    );
                                })}

                                <div className="flex items-center justify-between pt-2">
                                    <button
                                        onClick={() => {
                                            const defaults: Record<number, { min: number, max: number }> = { 1: { min: 0, max: 1000 }, 2: { min: 0, max: 1000 }, 3: { min: 0, max: 1000 }, 4: { min: 0, max: 1000 }, 5: { min: 0, max: 1000 }, 10: { min: 0, max: 1000 } };
                                            setConstraints(defaults);
                                            setConstraintsSaved(false);
                                        }}
                                        className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                                    >
                                        Reset to defaults
                                    </button>
                                    <button
                                        onClick={() => saveConstraints(constraints)}
                                        disabled={constraintsSaved || constraintsLoading}
                                        className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${constraintsSaved
                                            ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/30'
                                            : constraintsLoading
                                                ? 'bg-slate-700 text-slate-400 animate-pulse'
                                                : 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/30'
                                            }`}
                                    >
                                        {constraintsSaved ? '✓ Saved' : constraintsLoading ? 'Saving...' : 'Save to Robot'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            );
        }
        case 'control_scheme': {
            const scheme = [
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
            ];
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                    <div className="flex items-center space-x-3 mb-4"><Settings2 className="text-emerald-400" /><h2 className="text-xl font-semibold">Control Scheme</h2></div>
                    <div className="space-y-2 text-sm">
                        {scheme.map((item, idx) => (
                            <div key={idx} className="flex justify-between items-center border-b border-slate-800/50 pb-2 last:border-0">
                                <span className="text-slate-400">{item.action}</span>
                                <span className={`bg-slate-800 px-2.5 py-1 rounded font-mono text-xs font-bold ${item.color}`}>{item.control}</span>
                            </div>
                        ))}
                    </div>
                </div>
            );
        }
        case 'system_controls':
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
                    <div className="flex items-center space-x-3 mb-4"><Power className="text-amber-400" /><h2 className="text-xl font-semibold">System Controls</h2><span className="text-sm text-slate-500">SSH → {JETSON_IP}</span></div>
                    <SystemControlsWidget />
                </div>
            );
        default:
            return <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-slate-500">Unknown module: {type}</div>;
        case 'ai_detection_feed': {
            const [yoloStreamKey, setYoloStreamKey] = useState(Date.now());
            const [yoloStreamStatus, setYoloStreamStatus] = useState<'idle' | 'live' | 'failed'>('live');
            const refreshYolo = () => { setYoloStreamStatus('idle'); setYoloStreamKey(Date.now()); setTimeout(() => setYoloStreamStatus('live'), 500); };
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
                    <div className="absolute top-3 left-3 flex items-center space-x-2 px-3 py-1.5 bg-black/50 backdrop-blur rounded-lg text-sm font-semibold border border-white/10 z-10">
                        <span className="text-2xl">🧠</span><span className="text-purple-400">YOLO Detection</span>
                        {shared.yoloFps > 0 && <span className="text-xs bg-purple-600/50 px-2 py-0.5 rounded-full text-purple-200">{shared.yoloFps} FPS</span>}
                        {shared.yoloCount > 0 && <span className="text-xs bg-emerald-600/50 px-2 py-0.5 rounded-full text-emerald-200">{shared.yoloCount} obj</span>}
                    </div>
                    <button onClick={refreshYolo} className="absolute top-3 right-3 p-2 bg-black/50 backdrop-blur border border-white/10 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors z-10">
                        <RefreshCw size={14} />
                    </button>
                    <div className="aspect-video bg-black flex items-center justify-center relative">
                        {yoloStreamStatus === 'live' && (
                            <img
                                src={`http://${JETSON_IP}:8080/stream?topic=/yolo/annotated&type=ros_compressed&_k=${yoloStreamKey}`}
                                className="w-full h-full object-cover"
                                alt="YOLO Detection Feed"
                                onError={() => setYoloStreamStatus('failed')}
                            />
                        )}
                        {yoloStreamStatus !== 'live' && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                                <span className="text-5xl mb-4 opacity-30">🧠</span>
                                <p className="text-sm">{yoloStreamStatus === 'failed' ? 'YOLO stream not available. Start the detector first.' : 'Connecting...'}</p>
                            </div>
                        )}
                    </div>
                </div>
            );
        }
        case 'ai_detections_log':
            return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center space-x-3">
                            <span className="text-2xl">📝</span>
                            <h2 className="text-xl font-semibold">YOLO Detections</h2>
                            {shared.yoloCount > 0 && <span className="text-xs bg-emerald-600/30 text-emerald-400 px-2 py-1 rounded-full font-semibold">{shared.yoloCount} objects</span>}
                        </div>
                        <div className="flex items-center space-x-2">
                            {shared.yoloDetections.length > 0 && (
                                <button onClick={() => navigator.clipboard.writeText(JSON.stringify(shared.yoloDetections, null, 2))} className="text-[10px] px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition-colors">Copy JSON</button>
                            )}
                            {shared.yoloFps > 0 && <span className="text-xs text-slate-500">{shared.yoloFps} FPS</span>}
                        </div>
                    </div>
                    {shared.yoloDetections.length > 0 ? (
                        <div className="overflow-auto max-h-64 rounded-lg border border-slate-800">
                            <table className="w-full text-sm">
                                <thead className="bg-slate-800/50 sticky top-0">
                                    <tr className="text-slate-400 text-left">
                                        <th className="px-3 py-2">Object</th>
                                        <th className="px-3 py-2">Confidence</th>
                                        <th className="px-3 py-2">Depth</th>
                                        <th className="px-3 py-2">Position</th>
                                        <th className="px-3 py-2">Size</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {shared.yoloDetections.map((det, i) => (
                                        <tr key={i} className="border-t border-slate-800/50 hover:bg-slate-800/30">
                                            <td className="px-3 py-2 font-semibold text-white">{det.class}</td>
                                            <td className="px-3 py-2">
                                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${det.confidence > 0.8 ? 'bg-emerald-600/30 text-emerald-400' : det.confidence > 0.5 ? 'bg-yellow-600/30 text-yellow-400' : 'bg-red-600/30 text-red-400'}`}>
                                                    {(det.confidence * 100).toFixed(1)}%
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 font-mono text-blue-300">{det.depth_mm > 0 ? `${det.depth_mm}mm` : '—'}</td>
                                            <td className="px-3 py-2 font-mono text-slate-400 text-xs">{det.center_px[0]}, {det.center_px[1]}</td>
                                            <td className="px-3 py-2 font-mono text-slate-400 text-xs">{det.size_px[0]}×{det.size_px[1]}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="text-center py-10 text-slate-600">
                            <span className="text-3xl opacity-30">📝</span>
                            <p className="mt-2 text-sm">No detections — start the YOLO detector to see objects</p>
                        </div>
                    )}
                </div>
            );
        case 'ai_controls':
            return <AIControlsWidget />;
        case 'ai_chat':
            return <AIChatWidget />;
        case 'voice_assistant':
            return <VoiceAssistantWidget />;
        case 'vision_v2_controls':
            return <VisionV2ControlsWidget />;
        case 'vision_v2_state':
            return <VisionV2StateWidget />;
        case 'autonomy':
            return <AutonomyWidget />;
        case 'overhead_feed':
            return <OverheadCameraWidget mode="raw" />;
        case 'overhead_detection_feed':
            return <OverheadCameraWidget mode="annotated" />;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE WRAPPER (edit mode controls + drag-and-drop)
// ═══════════════════════════════════════════════════════════════════════════════
function ModuleWrapper({ mod, isEditing, isFirst, isLast, onDelete, onMoveLeft, onMoveRight,
    isDragging, isDragOver, dragSide, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, children }: {
        mod: ModuleInstance; isEditing: boolean; isFirst: boolean; isLast: boolean;
        onDelete: () => void; onMoveLeft: () => void; onMoveRight: () => void;
        isDragging: boolean; isDragOver: boolean; dragSide: 'left' | 'right' | null;
        onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void;
        onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void;
        children: React.ReactNode;
    }) {
    if (!isEditing) return <>{children}</>;
    return (
        <div
            className={`relative group transition-all duration-300 ease-out ${isDragging ? 'opacity-40 scale-95' : 'opacity-100 scale-100'
                }`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {/* Drop indicator — left side */}
            <div className={`absolute -left-3 top-0 bottom-0 w-1.5 rounded-full transition-all duration-200 ${isDragOver && dragSide === 'left' ? 'bg-blue-500 shadow-lg shadow-blue-500/50 opacity-100' : 'opacity-0'
                }`} />
            {/* Drop indicator — right side */}
            <div className={`absolute -right-3 top-0 bottom-0 w-1.5 rounded-full transition-all duration-200 ${isDragOver && dragSide === 'right' ? 'bg-blue-500 shadow-lg shadow-blue-500/50 opacity-100' : 'opacity-0'
                }`} />

            {/* Edit toolbar */}
            <div className="absolute -top-3 left-0 right-0 flex items-center justify-between z-20 px-2">
                <div
                    draggable
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    className="flex items-center space-x-1 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 shadow-lg cursor-grab active:cursor-grabbing hover:bg-slate-700 hover:border-blue-500/50 transition-colors select-none"
                >
                    <GripVertical size={14} className="text-blue-400" />
                    <span className="text-xs text-slate-400 font-medium">{MODULE_REGISTRY[mod.type]?.name || mod.type}</span>
                </div>
                <div className="flex items-center space-x-1 bg-slate-800 border border-slate-700 rounded-lg px-1 py-1 shadow-lg">
                    <button onClick={onMoveLeft} disabled={isFirst} className="p-1 hover:bg-slate-700 rounded disabled:opacity-30 transition-colors"><ChevronLeft size={14} className="text-slate-300" /></button>
                    <button onClick={onMoveRight} disabled={isLast} className="p-1 hover:bg-slate-700 rounded disabled:opacity-30 transition-colors"><ChevronRight size={14} className="text-slate-300" /></button>
                    <div className="w-px h-4 bg-slate-600 mx-1" />
                    <button onClick={onDelete} className="p-1 hover:bg-red-600/50 rounded transition-colors"><Trash2 size={14} className="text-red-400" /></button>
                </div>
            </div>

            {/* Module content with highlight */}
            <div className={`rounded-2xl transition-all duration-200 ${isDragOver ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-slate-950 scale-[1.02]' : 'ring-2 ring-blue-500/30 ring-offset-2 ring-offset-slate-950'
                }`}>
                {children}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE SELECTOR MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function ModuleSelector({ onSelect, onClose }: { onSelect: (type: ModuleType) => void; onClose: () => void }) {
    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
                <div className="flex justify-between items-center mb-5">
                    <h3 className="text-lg font-bold text-white">Add Module</h3>
                    <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded-lg transition-colors"><X size={20} className="text-slate-400" /></button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    {(Object.entries(MODULE_REGISTRY) as [ModuleType, typeof MODULE_REGISTRY[ModuleType]][]).map(([type, info]) => (
                        <button key={type} onClick={() => { onSelect(type); onClose(); }}
                            className="flex items-start space-x-3 p-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-blue-500/50 rounded-xl transition-all text-left group">
                            <span className="text-2xl mt-0.5">{info.icon}</span>
                            <div>
                                <div className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors">{info.name}</div>
                                <div className="text-xs text-slate-500 mt-0.5">{info.desc}</div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAG & DROP GRID
// ═══════════════════════════════════════════════════════════════════════════════
function DragDropGrid({ modules, isEditing, shared, onReorder, onDelete, onMove }: {
    modules: ModuleInstance[]; isEditing: boolean; shared: SharedState;
    onReorder: (fromId: string, toId: string) => void;
    onDelete: (id: string) => void; onMove: (id: string, dir: -1 | 1) => void;
}) {
    const [draggedId, setDraggedId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const [dragSide, setDragSide] = useState<'left' | 'right' | null>(null);

    const handleDragStart = (e: React.DragEvent, id: string) => {
        setDraggedId(id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        // Custom drag image — semi-transparent
        const el = (e.target as HTMLElement).closest('[data-module-id]') as HTMLElement | null;
        if (el) {
            const clone = el.cloneNode(true) as HTMLElement;
            clone.style.cssText = 'position:fixed;top:-9999px;transform:rotate(2deg);opacity:0.85;';
            document.body.appendChild(clone);
            e.dataTransfer.setDragImage(clone, 100, 30);
            requestAnimationFrame(() => document.body.removeChild(clone));
        }
    };

    const handleDragOver = (e: React.DragEvent, id: string) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (id === draggedId) return;
        setDragOverId(id);
        // Determine which side of the module the cursor is on
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        setDragSide(e.clientX < midX ? 'left' : 'right');
    };

    const handleDrop = (e: React.DragEvent, targetId: string) => {
        e.preventDefault();
        const fromId = e.dataTransfer.getData('text/plain');
        if (fromId && fromId !== targetId) {
            onReorder(fromId, targetId);
        }
        setDraggedId(null);
        setDragOverId(null);
        setDragSide(null);
    };

    const handleDragEnd = () => {
        setDraggedId(null);
        setDragOverId(null);
        setDragSide(null);
    };

    if (modules.length === 0) {
        return (
            <div className="flex-1 p-8">
                <div className="max-w-7xl mx-auto flex flex-col items-center justify-center py-32 text-slate-600">
                    <Plus size={48} className="mb-4 opacity-30" />
                    <p className="text-lg font-medium mb-2">No modules on this tab</p>
                    <p className="text-sm text-slate-700 mb-4">Click the pencil icon in the header to enter edit mode, then add modules.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 p-8">
            <div className="max-w-7xl mx-auto">
                <div className={`grid gap-6 ${isEditing ? 'gap-y-10' : ''} grid-cols-1 lg:grid-cols-2`}>
                    {modules.map((mod, idx) => (
                        <div
                            key={mod.id}
                            data-module-id={mod.id}
                            className={`${mod.type === 'system_controls' ? 'lg:col-span-2' : ''} transition-transform duration-300 ease-out`}
                        >
                            <ModuleWrapper
                                mod={mod} isEditing={isEditing}
                                isFirst={idx === 0} isLast={idx === modules.length - 1}
                                onDelete={() => onDelete(mod.id)}
                                onMoveLeft={() => onMove(mod.id, -1)}
                                onMoveRight={() => onMove(mod.id, 1)}
                                isDragging={draggedId === mod.id}
                                isDragOver={dragOverId === mod.id && draggedId !== mod.id}
                                dragSide={dragOverId === mod.id ? dragSide : null}
                                onDragStart={(e) => handleDragStart(e, mod.id)}
                                onDragEnd={handleDragEnd}
                                onDragOver={(e) => handleDragOver(e, mod.id)}
                                onDragLeave={() => { if (dragOverId === mod.id) { setDragOverId(null); setDragSide(null); } }}
                                onDrop={(e) => handleDrop(e, mod.id)}
                            >
                                <ModuleContent type={mod.type} shared={shared} />
                            </ModuleWrapper>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB BAR
// ═══════════════════════════════════════════════════════════════════════════════
function TabBar({ tabs, activeTabId, onTabChange, onAddTab, onDeleteTab, isEditing }: {
    tabs: Tab[]; activeTabId: string; onTabChange: (id: string) => void;
    onAddTab: () => void; onDeleteTab: (id: string) => void; isEditing: boolean;
}) {
    const systemTabs = tabs.filter(t => t.isSystem);
    const userTabs = tabs.filter(t => !t.isSystem);

    return (
        <div className="flex items-center space-x-1 bg-slate-900/50 border-b border-slate-800 px-4 py-1">
            {systemTabs.map(tab => (
                <button key={tab.id} onClick={() => onTabChange(tab.id)}
                    className={`px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors relative ${activeTabId === tab.id ? 'bg-slate-900 text-white border border-slate-700 border-b-slate-900 -mb-px' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
                    {tab.name}
                    {tab.modules.length > 0 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-slate-700 rounded-full text-slate-400">{tab.modules.length}</span>}
                </button>
            ))}
            {userTabs.length > 0 && <div className="w-px h-6 bg-slate-700 mx-2" />}
            {userTabs.map(tab => (
                <div key={tab.id} className={`flex items-center rounded-t-lg transition-colors ${activeTabId === tab.id ? 'bg-slate-900 border border-slate-700 border-b-slate-900 -mb-px' : 'hover:bg-slate-800/50'}`}>
                    <button onClick={() => onTabChange(tab.id)} className={`px-4 py-2 text-sm font-semibold ${activeTabId === tab.id ? 'text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                        {tab.name}
                    </button>
                    {isEditing && (
                        <button onClick={(e) => { e.stopPropagation(); onDeleteTab(tab.id); }} className="pr-2 text-slate-500 hover:text-red-400 transition-colors"><X size={14} /></button>
                    )}
                </div>
            ))}
            <button onClick={onAddTab} className="p-1.5 text-slate-500 hover:text-blue-400 hover:bg-slate-800 rounded-lg transition-colors ml-1" title="New Tab">
                <Plus size={16} />
            </button>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
    // ── Layout state ──
    const [layout, setLayout] = useState<DashboardLayout>(defaultLayout);
    const [isEditing, setIsEditing] = useState(false);
    const [showSelector, setShowSelector] = useState(false);
    const [showNewTab, setShowNewTab] = useState(false);
    const [newTabName, setNewTabName] = useState('');
    const [mounted, setMounted] = useState(false);

    // ── Shared robot state ──
    const [rosConnected, setRosConnected] = useState(false);
    const [rosBooting, setRosBooting] = useState(false);
    const [controllerActive, setControllerActive] = useState(false);
    const [jointPos, setJointPos] = useState([500, 500, 500, 500, 500, 500]);
    const [rgbStatus, setRgbStatus] = useState<'idle' | 'live' | 'failed'>('idle');
    const [depthStatus, setDepthStatus] = useState<'idle' | 'live' | 'failed'>('idle');
    const [streamKey, setStreamKey] = useState(0);
    const [depthColormap, setDepthColormap] = useState<'raw' | 'jet' | 'gray' | 'plasma'>('raw');
    const [gamepad, setGamepad] = useState<GamepadState>(defaultGamepad);
    const [yoloDetections, setYoloDetections] = useState<YoloDetection[]>([]);
    const [yoloFps, setYoloFps] = useState(0);
    const [yoloCount, setYoloCount] = useState(0);
    const lastDebugRef = useRef<string>('');
    const estopLastRef = useRef<number>(0);
    const [estopActive, setEstopActive] = useState(false);

    const shared: SharedState = {
        rosConnected, controllerActive, jointPos, gamepad,
        rgbStatus, depthStatus, streamKey, depthColormap,
        yoloDetections, yoloFps, yoloCount,
        setRgbStatus, setDepthStatus, setStreamKey, setDepthColormap,
    };

    // ── Load layout from localStorage ──
    useEffect(() => {
        setLayout(loadLayout());
        setStreamKey(Date.now());
        setMounted(true);
    }, []);

    // ── Save layout on change ──
    useEffect(() => { if (mounted) saveLayout(layout); }, [layout, mounted]);

    // ── Stream init ──
    useEffect(() => {
        if (streamKey === 0) return;
        const t = setTimeout(() => {
            if (rgbStatus === 'idle') setRgbStatus('live');
            if (depthStatus === 'idle') setDepthStatus('live');
        }, 1000);
        return () => clearTimeout(t);
    }, [streamKey, rgbStatus, depthStatus]);

    // ── ROS Connection ──
    useEffect(() => {
        let ros: any;
        let reconnectTimer: NodeJS.Timeout;

        const connect = () => {
            ros = new ROSLIB.Ros({ url: `ws://${JETSON_IP}:9090` });
            ros.on('connection', () => { setRosConnected(true); setRosBooting(false); });
            ros.on('error', () => setRosConnected(false));
            ros.on('close', () => {
                setRosConnected(false);
                // Auto-retry connection every 5 seconds
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connect, 5000);
            });

            const joyListener = new ROSLIB.Topic({ ros, name: '/servo_controller', messageType: 'servo_controller_msgs/msg/ServosPosition' });
            let timeout: NodeJS.Timeout;
            joyListener.subscribe(() => { setControllerActive(true); clearTimeout(timeout); timeout = setTimeout(() => setControllerActive(false), 2000); });

            const servoListener = new ROSLIB.Topic({ ros, name: '/controller_manager/servo_states', messageType: 'servo_controller_msgs/ServoStateList' });
            servoListener.subscribe((msg: any) => {
                const states = msg.servo_state || [];
                setJointPos(prev => {
                    const np = [...prev];
                    states.forEach((s: any) => { const map: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 10: 5 }; if (map[s.id] !== undefined) np[map[s.id]] = s.position; });
                    return np;
                });
            });

            const joyInputListener = new ROSLIB.Topic({ ros, name: '/joy', messageType: 'sensor_msgs/Joy' });
            joyInputListener.subscribe((msg: any) => {
                const axes: number[] = msg.axes || [], buttons: number[] = msg.buttons || [];
                setGamepad({
                    lx: Math.abs(axes[0] ?? 0) > 0.08 ? (axes[0] ?? 0) : 0,
                    ly: Math.abs(axes[1] ?? 0) > 0.08 ? (axes[1] ?? 0) : 0,
                    rx: Math.abs(axes[2] ?? 0) > 0.08 ? (axes[2] ?? 0) : 0,
                    ry: Math.abs(axes[3] ?? 0) > 0.08 ? (axes[3] ?? 0) : 0,
                    buttons, axes,
                });
                const pressedNames = buttons.map((v: number, i: number) => v ? (BUTTON_NAMES[i] || `B${i}`) : null).filter(Boolean);
                const activeAxes = axes.map((v: number, i: number) => Math.abs(v) > 0.15 ? `A${i}:${v.toFixed(2)}` : null).filter(Boolean);
                const debugStr = [...pressedNames, ...activeAxes].join(',');
                if (debugStr && debugStr !== lastDebugRef.current) logToServer({ type: 'raw', buttons: pressedNames, axes: activeAxes });
                lastDebugRef.current = debugStr || '';

                // 🛑 KILL SWITCH: SELECT button (index 8) triggers emergency stop
                if (buttons[8] === 1 && Date.now() - estopLastRef.current > 1000) {
                    estopLastRef.current = Date.now();
                    setEstopActive(true);
                    fetch(`http://${JETSON_IP}:8888`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'emergency_stop' }),
                    }).catch(() => { });
                }

                // ▶️ RESUME: START button (index 9) clears e-stop and re-enables torque
                if (buttons[9] === 1 && estopActive) {
                    setEstopActive(false);
                    fetch(`http://${JETSON_IP}:8888`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'resume' }),
                    }).catch(() => { });
                }
            });

            // Subscribe to YOLO detections
            const yoloListener = new ROSLIB.Topic({ ros, name: '/yolo/detections', messageType: 'std_msgs/String' });
            yoloListener.subscribe((msg: any) => {
                try {
                    const data = JSON.parse(msg.data);
                    setYoloDetections(data.objects || []);
                    setYoloFps(data.fps || 0);
                    setYoloCount(data.count || 0);
                } catch { /* ignore parse errors */ }
            });

            return () => { joyListener.unsubscribe(); servoListener.unsubscribe(); joyInputListener.unsubscribe(); yoloListener.unsubscribe(); ros.close(); };
        };

        connect();
        return () => { clearTimeout(reconnectTimer); if (ros) ros.close(); };
    }, []);

    // ── Layout mutations ─────────────────────────────────────────────────────
    const activeTab = layout.tabs.find(t => t.id === layout.activeTabId) || layout.tabs[0];

    const updateTab = useCallback((tabId: string, updater: (tab: Tab) => Tab) => {
        setLayout(prev => ({
            ...prev,
            tabs: prev.tabs.map(t => t.id === tabId ? updater(t) : t),
        }));
    }, []);

    const addModule = useCallback((type: ModuleType) => {
        updateTab(layout.activeTabId, tab => ({
            ...tab,
            modules: [...tab.modules, { id: uid(), type }],
        }));
    }, [layout.activeTabId, updateTab]);

    const deleteModule = useCallback((moduleId: string) => {
        updateTab(layout.activeTabId, tab => ({
            ...tab,
            modules: tab.modules.filter(m => m.id !== moduleId),
        }));
    }, [layout.activeTabId, updateTab]);

    const moveModule = useCallback((moduleId: string, dir: -1 | 1) => {
        updateTab(layout.activeTabId, tab => {
            const mods = [...tab.modules];
            const idx = mods.findIndex(m => m.id === moduleId);
            if (idx < 0) return tab;
            const newIdx = idx + dir;
            if (newIdx < 0 || newIdx >= mods.length) return tab;
            [mods[idx], mods[newIdx]] = [mods[newIdx], mods[idx]];
            return { ...tab, modules: mods };
        });
    }, [layout.activeTabId, updateTab]);

    const addTab = useCallback(() => {
        setNewTabName('');
        setShowNewTab(true);
    }, []);

    const confirmAddTab = useCallback(() => {
        if (!newTabName.trim()) return;
        const newTab: Tab = { id: uid(), name: newTabName.trim(), isSystem: false, modules: [] };
        setLayout(prev => ({
            ...prev,
            tabs: [...prev.tabs, newTab],
            activeTabId: newTab.id,
        }));
        setShowNewTab(false);
        setNewTabName('');
    }, [newTabName]);

    const deleteTab = useCallback((tabId: string) => {
        setLayout(prev => {
            const filtered = prev.tabs.filter(t => t.id !== tabId);
            return { ...prev, tabs: filtered, activeTabId: filtered[filtered.length - 1]?.id || 'home' };
        });
    }, []);

    const setActiveTab = useCallback((tabId: string) => {
        setLayout(prev => ({ ...prev, activeTabId: tabId }));
    }, []);

    if (!mounted) return <div className="min-h-screen bg-slate-950" />;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
            {/* ── HEADER ── */}
            <div className="flex justify-between items-center px-8 py-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-30">
                <div className="flex items-center space-x-4">
                    <div className="p-2.5 bg-blue-600/20 text-blue-400 rounded-xl"><Cpu size={24} /></div>
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">JetArm AI Command Center</h1>
                        <p className="text-sm text-slate-500">{JETSON_IP}</p>
                    </div>
                </div>
                <div className="flex items-center space-x-4">
                    {/* Status badges */}
                    <div className="flex items-center space-x-2">
                        {estopActive && (
                            <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-red-600/20 text-red-400 border border-red-500/40 rounded-full text-xs font-bold animate-pulse shadow-lg shadow-red-600/20">
                                <span className="text-sm">🛑</span><span>E-STOP</span>
                            </div>
                        )}
                        {rosConnected ? (
                            <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-xs font-semibold"><Wifi size={14} /><span>Live</span></div>
                        ) : rosBooting ? (
                            <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full text-xs font-semibold animate-pulse"><RotateCcw size={14} className="animate-spin" /><span>Booting...</span></div>
                        ) : (
                            <div className="flex items-center space-x-2">
                                <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-full text-xs font-semibold"><WifiOff size={14} /><span>Offline</span></div>
                                <button
                                    onClick={async () => {
                                        setRosBooting(true);
                                        try {
                                            await fetch('/api/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start_all' }) });
                                            // Give the ROS stack time to initialize and rosbridge to open
                                            // The rosConnected state will flip to true automatically via the WebSocket listener
                                            setTimeout(() => { if (!rosConnected) setRosBooting(false); }, 30000);
                                        } catch {
                                            setRosBooting(false);
                                        }
                                    }}
                                    className="p-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/20 rounded-full transition-all hover:shadow-lg hover:shadow-emerald-600/10"
                                    title="Start ROS stack on Jetson"
                                >
                                    <Power size={14} />
                                </button>
                            </div>
                        )}
                        {controllerActive ? (
                            <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full text-xs font-semibold animate-pulse"><Gamepad2 size={14} /><span>Active</span></div>
                        ) : (
                            <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-800/50 text-slate-500 border border-slate-700/50 rounded-full text-xs font-semibold"><Gamepad2 size={14} /><span>Idle</span></div>
                        )}
                    </div>
                    {/* Edit toggle */}
                    <button onClick={() => setIsEditing(!isEditing)}
                        className={`p-2.5 rounded-xl transition-all ${isEditing ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30' : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'}`}
                        title={isEditing ? 'Exit edit mode' : 'Edit layout'}>
                        <Pencil size={18} />
                    </button>
                </div>
            </div>

            {/* ── TAB BAR ── */}
            <TabBar tabs={layout.tabs} activeTabId={layout.activeTabId} onTabChange={setActiveTab} onAddTab={addTab} onDeleteTab={deleteTab} isEditing={isEditing} />

            {/* ── EDIT TOOLBAR ── */}
            {isEditing && (
                <div className="flex items-center justify-between px-8 py-3 bg-blue-950/30 border-b border-blue-500/20">
                    <div className="flex items-center space-x-3">
                        <button onClick={() => setShowSelector(true)} className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors">
                            <Plus size={16} /><span>Add Module</span>
                        </button>
                        <span className="text-sm text-blue-300/60">Editing <strong className="text-blue-300">{activeTab?.name}</strong> — drag to reorder, arrows to nudge, trash to remove</span>
                    </div>
                    <button onClick={() => setIsEditing(false)} className="flex items-center space-x-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold transition-colors">
                        <Check size={16} /><span>Done</span>
                    </button>
                </div>
            )}

            {/* ── MODULE GRID ── */}
            <DragDropGrid
                modules={activeTab?.modules || []}
                isEditing={isEditing}
                shared={shared}
                onReorder={(fromId, toId) => {
                    updateTab(layout.activeTabId, tab => {
                        const mods = [...tab.modules];
                        const fromIdx = mods.findIndex(m => m.id === fromId);
                        const toIdx = mods.findIndex(m => m.id === toId);
                        if (fromIdx < 0 || toIdx < 0) return tab;
                        const [moved] = mods.splice(fromIdx, 1);
                        mods.splice(toIdx, 0, moved);
                        return { ...tab, modules: mods };
                    });
                }}
                onDelete={deleteModule}
                onMove={moveModule}
            />

            {/* ── MODULE SELECTOR MODAL ── */}
            {showSelector && <ModuleSelector onSelect={addModule} onClose={() => setShowSelector(false)} />}

            {/* ── NEW TAB MODAL ── */}
            {showNewTab && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowNewTab(false)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-white mb-4">New Tab</h3>
                        <input
                            autoFocus
                            type="text"
                            placeholder="Tab name..."
                            value={newTabName}
                            onChange={e => setNewTabName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') confirmAddTab(); if (e.key === 'Escape') setShowNewTab(false); }}
                            className="w-full px-4 py-3 bg-slate-800 border border-slate-600 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                        />
                        <div className="flex justify-end space-x-3 mt-5">
                            <button onClick={() => setShowNewTab(false)} className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white transition-colors">Cancel</button>
                            <button onClick={confirmAddTab} disabled={!newTabName.trim()} className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors">Create</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
