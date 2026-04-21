import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../pipeline/types.js";
import { maskKey } from "../utils/maskKey.js";

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

export async function runDockerStaticBuild(params: {
  runId: string;
  version: number;
  provider: Provider;
  model: string;
  useOwnKey: boolean;
  apiKey?: string;
  bmadEnv: Record<string, string>;
  bmadCommand: string;
  onLog: (line: string) => void;
}): Promise<{ outDirOnHost: string; output: any } | { error: string }> {
  const { runId, version, provider, model, useOwnKey, apiKey, bmadEnv, bmadCommand, onLog } = params;

  const providerKey = useOwnKey ? apiKey : process.env[envKeyName(provider)];
  if (!providerKey || providerKey.trim().length < 8) {
    return { error: "Missing API key. Set env var or enable BYOK." };
  }

  const hostOutDir = path.join(process.cwd(), ".bmadly-runs", runId, String(version));
  fs.mkdirSync(hostOutDir, { recursive: true });

  onLog(`[exec] using key=${maskKey(providerKey)} (${useOwnKey ? "byok" : "managed"}) provider=${provider}`);
  onLog(`[exec] output dir: ${hostOutDir}`);

  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    `bmadly-pipeline-${runId}-${version}`,
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
    `${hostOutDir}:/work/out`,
    "bmadly-runner:local"
  ];

  onLog(`[exec] docker run …`);

  const secretsToRedact = [providerKey];
  let collectedOutput: any = null;

  const result = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });

    const handle = (buf: Buffer) => {
      const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const raw of lines) {
        const line = redactSecrets(raw, secretsToRedact);
        onLog(line);
        if (line.startsWith("[output]")) {
          const payload = line.replace(/^\[output\]\s*/, "");
          try {
            collectedOutput = JSON.parse(payload);
          } catch {
            collectedOutput = payload;
          }
        }
      }
    };

    child.stdout.on("data", handle);
    child.stderr.on("data", handle);

    child.on("error", (err) => {
      resolve({ code: null, error: String(err?.message || err) });
    });

    child.on("close", (code) => resolve({ code }));
  });

  if (result.error) {
    return { error: `Docker failed to start: ${result.error}` };
  }

  if (result.code !== 0) {
    return { error: `Container exited with code ${result.code}` };
  }

  return { outDirOnHost: hostOutDir, output: collectedOutput };
}
