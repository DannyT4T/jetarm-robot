import { NextResponse } from "next/server";
import { spawn } from "child_process";

const JETSON_IP = "192.168.1.246";
const RECORDER_PORT = 8090;   // episode_recorder.py
const INFERENCE_PORT = 8091;  // smolvla_server.py

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function jetsonGet(port: number, path: string) {
    const res = await fetch(`http://${JETSON_IP}:${port}${path}`, { cache: "no-store" });
    return res.json();
}

async function jetsonPost(port: number, path: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`http://${JETSON_IP}:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res.json();
}

// ─── Training State (Mac-side) ───────────────────────────────────────────────

let trainingProcess: ReturnType<typeof spawn> | null = null;
let trainingState = {
    status: "idle" as "idle" | "running" | "complete" | "error",
    epoch: 0,
    totalEpochs: 0,
    step: 0,
    totalSteps: 0,
    loss: 0,
    bestLoss: Infinity,
    lr: 0,
    eta: "",
    lossHistory: [] as number[],
    startTime: 0,
    error: null as string | null,
};

// ─── GET Handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    try {
        switch (action) {
            // ── Episode Recording (Jetson) ────────────────────────────────
            case "recording_status":
                return NextResponse.json(await jetsonGet(RECORDER_PORT, "/status"));

            case "list_episodes":
                return NextResponse.json(await jetsonGet(RECORDER_PORT, "/episodes"));

            case "episode_stats":
                return NextResponse.json(await jetsonGet(RECORDER_PORT, "/stats"));

            case "cameras":
                return NextResponse.json(await jetsonGet(RECORDER_PORT, "/cameras"));

            case "episode_thumbnail": {
                const id = url.searchParams.get("id");
                const res = await fetch(
                    `http://${JETSON_IP}:${RECORDER_PORT}/thumbnail/${id}`,
                    { cache: "no-store" }
                );
                if (res.ok) {
                    const buffer = await res.arrayBuffer();
                    return new NextResponse(buffer, {
                        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
                    });
                }
                return NextResponse.json({ error: "Thumbnail not found" }, { status: 404 });
            }

            // ── Inference (Jetson) ────────────────────────────────────────
            case "inference_status":
                return NextResponse.json(await jetsonGet(INFERENCE_PORT, "/status"));

            case "list_models":
                return NextResponse.json(await jetsonGet(INFERENCE_PORT, "/models"));

            // ── Training (Mac local) ──────────────────────────────────────
            case "training_status":
                return NextResponse.json(trainingState);

            // ── Mac Status ────────────────────────────────────────────────
            case "mac_status": {
                const hasPython = await checkPython();
                return NextResponse.json({
                    connected: true,
                    python: hasPython,
                    training: trainingState.status,
                });
            }

            default:
                return NextResponse.json({
                    error: "Unknown action", actions: [
                        "recording_status", "list_episodes", "episode_stats", "cameras",
                        "episode_thumbnail", "inference_status", "list_models",
                        "training_status", "mac_status",
                    ]
                });
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

// ─── POST Handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    const body = await req.json();
    const { action, ...params } = body;

    try {
        switch (action) {
            // ── Episode Recording (Jetson) ────────────────────────────────
            case "start_recording":
                return NextResponse.json(
                    await jetsonPost(RECORDER_PORT, "/start", { task: params.task || "pick_object" })
                );

            case "stop_recording":
                return NextResponse.json(await jetsonPost(RECORDER_PORT, "/stop"));

            case "discard_recording":
                return NextResponse.json(await jetsonPost(RECORDER_PORT, "/discard"));

            case "delete_episode":
                return NextResponse.json(
                    await jetsonPost(RECORDER_PORT, "/delete", { episode_id: params.episode_id })
                );

            // ── Sync Episodes Jetson → Mac ────────────────────────────────
            case "sync_to_mac": {
                const result = await syncEpisodes();
                return NextResponse.json(result);
            }

            // ── Training (Mac local) ──────────────────────────────────────
            case "start_training": {
                const result = startTraining(params.config || {});
                return NextResponse.json(result);
            }

            case "stop_training": {
                const result = stopTraining();
                return NextResponse.json(result);
            }

            // ── Inference (Jetson) ────────────────────────────────────────
            case "load_model":
                return NextResponse.json(
                    await jetsonPost(INFERENCE_PORT, "/load", { model: params.model || "lerobot/smolvla_base" })
                );

            case "unload_model":
                return NextResponse.json(await jetsonPost(INFERENCE_PORT, "/unload"));

            case "start_inference":
                return NextResponse.json(
                    await jetsonPost(INFERENCE_PORT, "/start", { task: params.task || "pick_object" })
                );

            case "stop_inference":
                return NextResponse.json(await jetsonPost(INFERENCE_PORT, "/stop"));

            // ── Model Deployment ──────────────────────────────────────────
            case "deploy_model": {
                const result = await deployModel(params.version || "latest");
                return NextResponse.json(result);
            }

            default:
                return NextResponse.json({ error: "Unknown action" });
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

// ─── Mac-side Functions ──────────────────────────────────────────────────────

async function checkPython(): Promise<boolean> {
    try {
        const res = await new Promise<boolean>((resolve) => {
            const p = spawn("python3.12", ["-c", "import lerobot; print('ok')"], { timeout: 10000 });
            p.on("close", (code) => resolve(code === 0));
            p.on("error", () => resolve(false));
        });
        return res;
    } catch {
        return false;
    }
}

async function syncEpisodes(): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
        const localDir = `${process.env.HOME}/smolvla_episodes`;
        const p = spawn("rsync", [
            "-avz", "--progress",
            `danny@${JETSON_IP}:~/smolvla_episodes/`,
            localDir + "/",
        ], { timeout: 300000 });

        let output = "";
        p.stdout?.on("data", (d) => output += d.toString());
        p.stderr?.on("data", (d) => output += d.toString());
        p.on("close", (code) => {
            resolve({
                success: code === 0,
                message: code === 0 ? `Synced to ${localDir}` : `Sync failed: ${output.slice(-200)}`,
            });
        });
        p.on("error", (err) => resolve({ success: false, message: err.message }));
    });
}

function startTraining(config: Record<string, unknown>): { success: boolean; message?: string; error?: string } {
    if (trainingState.status === "running") {
        return { success: false, error: "Training already running" };
    }

    const epochs = (config.epochs as number) || 50;
    const batchSize = (config.batchSize as number) || 8;
    const lr = (config.lr as number) || 1e-4;

    trainingState = {
        status: "running",
        epoch: 0,
        totalEpochs: epochs,
        step: 0,
        totalSteps: 0,
        loss: 0,
        bestLoss: Infinity,
        lr: lr,
        eta: "Calculating...",
        lossHistory: [],
        startTime: Date.now(),
        error: null,
    };

    // Launch training process
    const smolvlaEnv = `${process.env.HOME}/Developer/Hi-Wonder Robitic Arm/smolvla_env/bin/python3`;
    trainingProcess = spawn(smolvlaEnv, [
        "-m", "lerobot.scripts.train",
        "--policy.type=smolvla",
        `--training.num_epochs=${epochs}`,
        `--training.batch_size=${batchSize}`,
        `--training.lr=${lr}`,
        `--training.dataset_path=${process.env.HOME}/smolvla_episodes`,
    ], {
        env: { ...process.env, PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.0" },
    });

    trainingProcess.stdout?.on("data", (data) => {
        const line = data.toString();
        // Parse training output for progress
        const epochMatch = line.match(/epoch\s+(\d+)/i);
        const lossMatch = line.match(/loss[:\s]+([0-9.]+)/i);
        const stepMatch = line.match(/step\s+(\d+)/i);

        if (epochMatch) trainingState.epoch = parseInt(epochMatch[1]);
        if (lossMatch) {
            const loss = parseFloat(lossMatch[1]);
            trainingState.loss = loss;
            trainingState.lossHistory.push(loss);
            if (loss < trainingState.bestLoss) trainingState.bestLoss = loss;
        }
        if (stepMatch) trainingState.step = parseInt(stepMatch[1]);

        // Calculate ETA
        if (trainingState.epoch > 0) {
            const elapsed = (Date.now() - trainingState.startTime) / 1000;
            const perEpoch = elapsed / trainingState.epoch;
            const remaining = perEpoch * (trainingState.totalEpochs - trainingState.epoch);
            const mins = Math.round(remaining / 60);
            trainingState.eta = mins > 60 ? `${Math.round(mins / 60)}h ${mins % 60}m` : `${mins} min`;
        }
    });

    trainingProcess.stderr?.on("data", (data) => {
        console.error("[training]", data.toString().slice(0, 200));
    });

    trainingProcess.on("close", (code) => {
        trainingState.status = code === 0 ? "complete" : "error";
        if (code !== 0) trainingState.error = `Process exited with code ${code}`;
        trainingProcess = null;
    });

    return { success: true, message: `Training started: ${epochs} epochs, batch ${batchSize}, lr ${lr}` };
}

function stopTraining(): { success: boolean; message: string } {
    if (trainingProcess) {
        trainingProcess.kill("SIGTERM");
        trainingState.status = "idle";
        trainingProcess = null;
        return { success: true, message: "Training stopped" };
    }
    return { success: false, message: "No training running" };
}

async function deployModel(version: string): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
        const localModel = `${process.env.HOME}/smolvla_models/${version}`;
        const p = spawn("rsync", [
            "-avz", "--progress",
            localModel + "/",
            `danny@${JETSON_IP}:~/smolvla_models/${version}/`,
        ], { timeout: 300000 });

        p.on("close", async (code) => {
            if (code === 0) {
                // Tell Jetson to load the new model
                try {
                    await jetsonPost(INFERENCE_PORT, "/load", {
                        model: `/home/danny/smolvla_models/${version}`,
                    });
                    resolve({ success: true, message: `Model ${version} deployed and loaded` });
                } catch {
                    resolve({ success: true, message: `Model ${version} deployed (load manually)` });
                }
            } else {
                resolve({ success: false, message: `Deploy failed (exit ${code})` });
            }
        });
        p.on("error", (err) => resolve({ success: false, message: err.message }));
    });
}
