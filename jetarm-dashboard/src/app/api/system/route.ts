import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const JETSON_HOST = 'danny@192.168.1.246';

interface CommandResult {
    success: boolean;
    output: string;
    error?: string;
}

async function sshCommand(cmd: string, timeoutMs: number = 30000): Promise<CommandResult> {
    try {
        const { stdout, stderr } = await execAsync(
            `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JETSON_HOST} "${cmd}"`,
            { timeout: timeoutMs }
        );
        return { success: true, output: stdout.trim() + (stderr ? '\n' + stderr.trim() : '') };
    } catch (err: any) {
        return { success: false, output: '', error: err.message || 'SSH command failed' };
    }
}

export async function POST(req: NextRequest) {
    const { action } = await req.json();
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

    console.log(`🤖 [${ts}] SYSTEM ACTION → ${action}`);

    switch (action) {
        case 'start_all': {
            // Upload latest scripts first, then run start_joystick.sh
            console.log(`🤖 [${ts}] Starting full robot system...`);
            const result = await sshCommand(
                "bash -c 'source /opt/ros/humble/setup.bash && source /home/danny/JetArm/install/setup.bash && source /home/danny/orbbec_v1_ws/install/setup.bash 2>/dev/null || true && export need_compile=True && export CHASSIS_TYPE=None && export CAMERA_TYPE=GEMINI && export ROBOT_TYPE=JetArm && export FASTRTPS_DEFAULT_PROFILES_FILE=/home/danny/disable_shm.xml && nohup bash /home/danny/start_joystick.sh > /home/danny/startup.log 2>&1 &'",
                15000
            );
            // Give it time to start, then check
            await new Promise(r => setTimeout(r, 3000));
            const check = await sshCommand("ps aux | grep -v grep | grep -c 'joystick_control\\|rosbridge\\|servo_controller' || echo '0'");
            const count = parseInt(check.output.trim()) || 0;
            console.log(`🤖 [${ts}] Startup result: ${count} processes running`);
            return NextResponse.json({ success: count > 0, processes: count, message: count > 0 ? `System starting — ${count} processes detected` : 'Startup initiated, waiting for processes...' });
        }

        case 'stop_all': {
            console.log(`🤖 [${ts}] Stopping all robot processes...`);
            await sshCommand("pkill -9 -f joystick_control; pkill -9 -f depth_colorizer; pkill -9 -f 'camera_container|ob_camera'; pkill -9 -f servo_controller; pkill -9 -f kinematics; pkill -9 -f ros_robot_controller; pkill -9 -f rosbridge; pkill -9 -f web_video_server");
            return NextResponse.json({ success: true, message: 'All processes stopped' });
        }

        case 'restart_joystick': {
            console.log(`🤖 [${ts}] Restarting joystick controller...`);
            await sshCommand("pkill -9 -f joystick_control || true");
            await new Promise(r => setTimeout(r, 1000));
            await sshCommand("bash -c 'source /opt/ros/humble/setup.bash && source /home/danny/JetArm/install/setup.bash && export FASTRTPS_DEFAULT_PROFILES_FILE=/home/danny/disable_shm.xml && export CHASSIS_TYPE=None && nohup ros2 run peripherals joystick_control > /home/danny/joystick_final.log 2>&1 &'");
            return NextResponse.json({ success: true, message: 'Joystick controller restarted' });
        }

        case 'status': {
            const status = await sshCommand("ps aux | grep -v grep | grep -E 'joystick_control|rosbridge|servo_controller|web_video_server|depth_colorizer|ob_camera' | awk '{print $11}' | sort");
            const procs = status.output.split('\n').filter(Boolean);
            return NextResponse.json({ success: true, processes: procs, count: procs.length });
        }

        case 'check_connection': {
            const ping = await sshCommand("echo ok", 5000);
            return NextResponse.json({ success: ping.success, message: ping.success ? 'Connected' : 'Cannot reach Jetson' });
        }

        default:
            return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
    }
}
