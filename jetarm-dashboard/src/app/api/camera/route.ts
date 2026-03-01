import { NextResponse } from 'next/server';

const CAMERA_SNAPSHOT = 'http://192.168.1.246:8080/snapshot?topic=/depth_cam/color/image_raw';

// Store the latest look snapshot in memory
let latestSnapshot: ArrayBuffer | null = null;
let latestTimestamp = 0;

export async function GET() {
    // Return the cached snapshot if available and recent
    if (latestSnapshot && Date.now() - latestTimestamp < 30000) {
        return new Response(latestSnapshot, {
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'no-cache',
                'X-Timestamp': latestTimestamp.toString(),
            },
        });
    }
    // Otherwise fetch a fresh one
    try {
        const res = await fetch(CAMERA_SNAPSHOT, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return NextResponse.json({ error: 'Camera unavailable' }, { status: 502 });
        const ab = await res.arrayBuffer();
        latestSnapshot = ab;
        latestTimestamp = Date.now();
        return new Response(ab, {
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' },
        });
    } catch {
        return NextResponse.json({ error: 'Camera fetch failed' }, { status: 502 });
    }
}

// POST: save a snapshot (called by the look tool before vision analysis)
export async function POST() {
    try {
        const res = await fetch(CAMERA_SNAPSHOT, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return NextResponse.json({ success: false });
        latestSnapshot = await res.arrayBuffer();
        latestTimestamp = Date.now();
        return NextResponse.json({ success: true, timestamp: latestTimestamp });
    } catch {
        return NextResponse.json({ success: false });
    }
}
