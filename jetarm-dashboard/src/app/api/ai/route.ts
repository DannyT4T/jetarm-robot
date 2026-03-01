import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const JETSON_HOST = 'danny@192.168.1.246';

async function ssh(cmd: string, timeout = 15000) {
    try {
        // Wrap the cmd argument in double quotes to work correctly with `bash -c "..."`
        const cmdStr = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JETSON_HOST} "${cmd}"`;
        const { stdout, stderr } = await execAsync(cmdStr, { timeout });
        return { success: true, output: (stdout + '\n' + stderr).trim() };
    } catch (err: any) {
        return { success: false, output: '', error: err.message || 'SSH failed' };
    }
}

export async function POST(req: NextRequest) {
    const body = await req.json();
    const { action } = body;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`🤖 [${ts}] AI ACTION → ${action}`);

    switch (action) {
        case 'start_yolo': {
            // Kill existing instance, then start YOLO detector
            await ssh("pkill -9 -f yolo_detector || true");
            await new Promise(r => setTimeout(r, 1000));
            const startScriptB64 = Buffer.from(
                "source /opt/ros/humble/setup.bash\n" +
                "source /home/danny/JetArm/install/setup.bash\n" +
                "export CUDA_HOME=/usr/local/cuda-12.6\n" +
                "export PATH=$CUDA_HOME/bin:$PATH\n" +
                "export LD_LIBRARY_PATH=$CUDA_HOME/lib64:$LD_LIBRARY_PATH\n" +
                "export FASTRTPS_DEFAULT_PROFILES_FILE=/home/danny/disable_shm.xml\n" +
                "nohup python3 /home/danny/yolo_detector.py > /home/danny/yolo.log 2>&1 &\n"
            ).toString('base64');
            const result = await ssh(
                `bash -c 'echo "${startScriptB64}" | base64 --decode > /home/danny/start_yolo.sh && bash /home/danny/start_yolo.sh'`
            );
            await new Promise(r => setTimeout(r, 3000));
            const check = await ssh("tail -3 /home/danny/yolo.log 2>/dev/null || echo 'No log yet'");
            return NextResponse.json({
                success: true,
                message: 'YOLO detector starting...',
                log: check.output,
            });
        }

        case 'stop_yolo': {
            await ssh("pkill -9 -f yolo_detector || true");
            return NextResponse.json({ success: true, message: 'YOLO detector stopped' });
        }

        case 'yolo_status': {
            const running = await ssh("ps aux | grep -v grep | grep yolo_detector | wc -l");
            const count = parseInt(running.output.trim()) || 0;
            let log = '';
            if (count > 0) {
                const logResult = await ssh("tail -5 /home/danny/yolo.log 2>/dev/null");
                log = logResult.output;
            }
            return NextResponse.json({
                success: true,
                running: count > 0,
                message: count > 0 ? 'YOLO detector is running' : 'YOLO detector is not running',
                log,
            });
        }

        case 'install_yolo': {
            // Install ultralytics on the Jetson
            const result = await ssh("pip install ultralytics --quiet 2>&1 | tail -3", 60000);
            return NextResponse.json({
                success: result.success,
                message: result.success ? 'ultralytics installed' : 'Installation failed',
                log: result.output,
            });
        }

        case 'upload_detector': {
            // This happens via SCP from the Mac side
            try {
                const { stdout } = await execAsync(
                    `scp -o ConnectTimeout=10 "/Users/dxt_mac/Developer/Hi-Wonder Robitic Arm/yolo_detector.py" ${JETSON_HOST}:/home/danny/yolo_detector.py`,
                    { timeout: 15000 }
                );
                return NextResponse.json({ success: true, message: 'yolo_detector.py uploaded to Jetson' });
            } catch (err: any) {
                return NextResponse.json({ success: false, error: err.message });
            }
        }

        case 'detect_yolo': {
            // Check if ultralytics/YOLO is installed on the Jetson (same env as YOLO runs in)
            const checkScriptB64 = Buffer.from(
                "source /opt/ros/humble/setup.bash\n" +
                "export CUDA_HOME=/usr/local/cuda-12.6\n" +
                "export PATH=$CUDA_HOME/bin:$PATH\n" +
                "export LD_LIBRARY_PATH=$CUDA_HOME/lib64:$LD_LIBRARY_PATH\n" +
                "python3 -c \"import ultralytics; print('YOLOv8 version:', ultralytics.__version__)\"\n"
            ).toString('base64');
            const check = await ssh(
                `bash -c 'echo "${checkScriptB64}" | base64 --decode > /home/danny/detect_yolo.sh && bash /home/danny/detect_yolo.sh' 2>&1`
            );
            const installed = check.success && check.output.includes('YOLOv8 version');
            return NextResponse.json({
                success: true,
                installed,
                message: installed ? `YOLO detected — ${check.output.trim()}` : 'YOLO (ultralytics) not found on Jetson',
                log: check.output,
            });
        }

        // ── Fast motion commands via JetArm Bridge (HTTP, ~20ms) ──────────────
        // Bridge runs on Jetson port 8888 as a persistent ROS2 node.
        // Falls back to SSH if bridge is down.
        case 'move_servo':
        case 'move_arm':
        case 'move_to_xyz':
        case 'home':
        case 'read_servos':
        case 'buzzer': {
            try {
                const bridgeRes = await fetch('http://192.168.1.246:8888', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(5000),
                });
                const data = await bridgeRes.json();
                return NextResponse.json(data);
            } catch (bridgeErr: any) {
                // Bridge not running — fall back to SSH for move_servo only
                if (action === 'move_servo') {
                    const sid = Number(body.servo_id) || 1;
                    const pos = Math.max(0, Math.min(1000, Number(body.position) || 500));
                    const dur = Number(body.duration) || 1000;
                    try {
                        const sshCmd = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JETSON_HOST} 'source /opt/ros/humble/setup.bash && source /home/danny/JetArm/install/setup.bash && export FASTRTPS_DEFAULT_PROFILES_FILE=/home/danny/disable_shm.xml && ros2 topic pub --once /ros_robot_controller/bus_servo/set_position ros_robot_controller_msgs/msg/ServosPosition "{duration: ${dur}, position: [{id: ${sid}, position: ${pos}}]}"'`;
                        await execAsync(sshCmd, { timeout: 10000 });
                        return NextResponse.json({ success: true, message: `Servo ${sid} → ${pos} (SSH fallback)` });
                    } catch (sshErr: any) {
                        return NextResponse.json({ success: false, message: 'Both bridge and SSH failed', error: sshErr.message });
                    }
                }
                return NextResponse.json({
                    success: false,
                    message: 'JetArm Bridge not running. Start it: ssh danny@192.168.1.246 "bash /home/danny/start_bridge.sh"',
                    error: bridgeErr.message,
                });
            }
        }

        default:
            return NextResponse.json({ success: false, error: 'Unknown AI action' }, { status: 400 });
    }
}
