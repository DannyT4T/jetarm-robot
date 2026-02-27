import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    const data = await req.json();
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 1 });

    if (data.type === 'button') {
        console.log(`🎮 [${ts}] BUTTON → ${data.name} (index: ${data.index}) ${data.pressed ? 'PRESSED' : 'RELEASED'}`);
    } else if (data.type === 'axis') {
        console.log(`🎮 [${ts}] AXIS → ${data.axes}`);
    } else if (data.type === 'raw') {
        console.log(`🎮 [${ts}] RAW → Buttons: [${data.buttons}] Axes: [${data.axes}]`);
    }

    return NextResponse.json({ ok: true });
}
