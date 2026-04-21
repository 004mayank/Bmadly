import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../pipeline/types.js";
import { maskKey } from "../utils/maskKey.js";
import { allocatePort } from "./portAllocator.js";

function envKeyName(provider: Provider) {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return "GEMINI_API_KEY";
}

function redactSecrets(line: string, secrets: string[]) {
  let out = line;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("***REDACTED***");
  }
  return out;
}

async function waitForApp(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Preview not ready after ${timeoutMs}ms`);
}

export type LivePreviewResult =
  | { ok: true; containerId: string; hostPort: number; previewUrl: string }
  | { ok: false; error: string };

export async function runDockerLivePreview(params: {
  runId: string;
  version: number;
  provider: Provider;
  model: string;
  useOwnKey: boolean;
  apiKey?: string;
  bmadEnv: Record<string, string>;
  bmadCommand: string;
  onLog: (line: string) => void;
}): Promise<LivePreviewResult> {
  const { runId, version, provider, model, useOwnKey, apiKey, bmadEnv, bmadCommand, onLog } = params;

  const providerKey = useOwnKey ? apiKey : process.env[envKeyName(provider)];
  if (!providerKey || providerKey.trim().length < 8) {
    return { ok: false, error: "Missing API key. Set env var or enable BYOK." };
  }

  const hostPort = await allocatePort();
  const name = `bmadly-live-${runId}-${version}`;

  const hostWorkDir = path.join(process.cwd(), ".bmadly-live", runId, String(version));
  const hostAppDir = path.join(hostWorkDir, "app");
  fs.mkdirSync(hostAppDir, { recursive: true });

  onLog(`[live] using key=${maskKey(providerKey)} (${useOwnKey ? "byok" : "managed"}) provider=${provider}`);
  onLog(`[live] workspace: ${hostWorkDir}`);

  // Phase 1: run BMAD command once to generate code. We mount /work/app.
  // BMAD command should write into /work/app.
  const genArgs = [
    "run",
    "--rm",
    "--name",
    `${name}-gen`,
    "-e",
    `BMAD_PROVIDER=${provider}`,
    "-e",
    `BMAD_MODEL=${model}`,
    "-e",
    `BMAD_API_KEY=${providerKey}`,
    "-e",
    `BMAD_COMMAND=${bmadCommand}`,
    ...Object.entries(bmadEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-v",
    `${hostAppDir}:/work/app`,
    "bmadly-runner:local"
  ];

  onLog(`[live] generating app with docker…`);

  const secretsToRedact = [providerKey];

  const genExit = await new Promise<number>((resolve) => {
    const child = spawn("docker", genArgs, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });

    const handle = (buf: Buffer) => {
      const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const raw of lines) onLog(redactSecrets(raw, secretsToRedact));
    };

    child.stdout.on("data", handle);
    child.stderr.on("data", handle);

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      onLog(`[live] docker error: ${String(err?.message || err)}`);
      resolve(1);
    });
  });

  if (genExit !== 0) {
    return { ok: false, error: `Generation container failed (exit ${genExit})` };
  }

  // Phase 2: start long-running Next.js dev server container.
  // We run the live-nextjs.sh script shipped in the runner image.
  const runArgs = [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `${hostPort}:3000`,
    "-v",
    `${hostAppDir}:/work/app`,
    "-e",
    `PORT=3000`,
    "-e",
    `HOSTNAME=0.0.0.0`,
    "bmadly-runner:local",
    "bash",
    "-lc",
    "/app/runner/live-nextjs.sh"
  ];

  onLog(`[live] starting preview container (port ${hostPort} -> 3000)…`);

  const containerId = await new Promise<string>((resolve, reject) => {
    const child = spawn("docker", runArgs, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) return resolve(out.trim());
      return reject(new Error(err.trim() || `docker run exited with code ${code}`));
    });
    child.on("error", reject);
  });

  const previewUrl = `http://localhost:${hostPort}`;

  try {
    onLog(`[live] waiting for app ready…`);
    await waitForApp(previewUrl, 30_000);
    onLog(`[live] preview ready: ${previewUrl}`);
  } catch (e: any) {
    onLog(`[live] preview not ready: ${String(e?.message || e)}`);
    return { ok: false, error: "Preview failed to become ready" };
  }

  return { ok: true, containerId, hostPort, previewUrl };
}

export async function stopContainer(containerIdOrName: string) {
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["stop", containerIdOrName], { stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
