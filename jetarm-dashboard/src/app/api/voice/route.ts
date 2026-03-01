import { NextRequest, NextResponse } from 'next/server';

const KOKORO_URL = 'http://localhost:8880';

export async function POST(req: NextRequest) {
    const { action, text, voice, speed } = await req.json();

    switch (action) {
        case 'speak': {
            try {
                const res = await fetch(`${KOKORO_URL}/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: text || 'Hello',
                        voice: voice || 'af_heart',
                        speed: speed || 1.0,
                    }),
                });
                if (!res.ok) {
                    return NextResponse.json({ success: false, error: `TTS returned ${res.status}` });
                }
                // Forward the WAV audio directly
                const audioBuffer = await res.arrayBuffer();
                return new Response(audioBuffer, {
                    headers: {
                        'Content-Type': 'audio/wav',
                        'Content-Length': String(audioBuffer.byteLength),
                    },
                });
            } catch (e: unknown) {
                return NextResponse.json({
                    success: false,
                    error: e instanceof Error ? e.message : 'TTS server unreachable',
                }, { status: 500 });
            }
        }

        case 'voices': {
            try {
                const res = await fetch(`${KOKORO_URL}/voices`);
                const data = await res.json();
                return NextResponse.json({ success: true, ...data });
            } catch {
                return NextResponse.json({ success: false, error: 'TTS server unreachable' });
            }
        }

        case 'health': {
            try {
                const res = await fetch(`${KOKORO_URL}/health`);
                const data = await res.json();
                return NextResponse.json({ success: true, ...data });
            } catch {
                return NextResponse.json({ success: false, error: 'TTS server not running' });
            }
        }

        default:
            return NextResponse.json({ success: false, error: 'Unknown voice action' }, { status: 400 });
    }
}
