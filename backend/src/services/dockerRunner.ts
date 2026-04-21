import { spawn } from "node:child_process";
import { RunsStore } from "../store/runsStore.js";
import { maskKey } from "../utils/maskKey.js";

type Provider = "openai" | "anthropic" | "gemini";

type RunParams = {
  runId: string;
  provider: Provider;
  model: string;
  useOwnKey: boolean;
  apiKey?: string;
  input?: Record<string, unknown>;
};

function envKeyName(provider: Provider) {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return "GEMINI_API_KEY";
}

function redactSecrets(line: string, secrets: string[]) {
  let out = line;
  for (const s of secrets) {
    if (!s) continue;
    // replace all occurrences; keep it simple for MVP
    out = out.split(s).join("***REDACTED***");
  }
  return out;
}

export async function dockerRunBmad(params: RunParams): Promise<void> {
  const { runId, provider, model, useOwnKey, apiKey, input } = params;

  RunsStore.setStatus(runId, "running");
  RunsStore.appendLog(runId, `[runner] preparing container…`);

  const BMAD_COMMAND = process.env.BMAD_COMMAND || "node /app/runner/mock-bmad.js";

  const providerKey = useOwnKey ? apiKey : process.env[envKeyName(provider)];
  if (!providerKey || providerKey.trim().length < 8) {
    RunsStore.appendLog(runId, `[runner] missing API key for provider=${provider} (BYOK=${useOwnKey})`);
    RunsStore.finish(runId, {
      status: "failed",
      output: { error: "Missing API key. Set env var or enable BYOK." }
    });
    return;
  }

  RunsStore.appendLog(
    runId,
    `[runner] using key=${maskKey(providerKey)} (${useOwnKey ? "byok" : "managed"}) provider=${provider}`
  );

  // Never log the raw key.
  const inputJson = JSON.stringify(input ?? {});

  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    `bmadly-${runId}`,
    "-e",
    `BMAD_PROVIDER=${provider}`,
    "-e",
    `BMAD_MODEL=${model}`,
    "-e",
    `BMAD_API_KEY=${providerKey}`,
    "-e",
    `BMAD_INPUT=${inputJson}`,
    "-e",
    `BMAD_COMMAND=${BMAD_COMMAND}`,
    "bmadly-runner:local"
  ];

  RunsStore.appendLog(runId, `[runner] docker ${dockerArgs.slice(0, 2).join(" ")} …`);

  await new Promise<void>((resolve) => {
    const child = spawn("docker", dockerArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });

    const secretsToRedact = [providerKey];

    child.stdout.on("data", (buf) => {
      const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) RunsStore.appendLog(runId, redactSecrets(line, secretsToRedact));
    });

    child.stderr.on("data", (buf) => {
      const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) RunsStore.appendLog(runId, redactSecrets(line, secretsToRedact));
    });

    child.on("close", (code) => {
      if (code === 0) {
        const out = RunsStore.get(runId)?.logs
          .filter((l) => l.startsWith("[output]"))
          .map((l) => l.replace(/^\[output\]\s*/, ""))
          .join("\n");

        let parsed: unknown = out;
        try {
          parsed = out ? JSON.parse(out) : null;
        } catch {
          // keep as text
        }

        RunsStore.finish(runId, { status: "succeeded", output: parsed });
      } else {
        RunsStore.appendLog(runId, `[runner] container exited code=${code}`);
        RunsStore.finish(runId, { status: "failed", output: { error: `Container exited with code ${code}` } });
      }
      resolve();
    });

    child.on("error", (err) => {
      RunsStore.appendLog(runId, `[runner] docker spawn error: ${String(err?.message || err)}`);
      RunsStore.finish(runId, { status: "failed", output: { error: "Docker failed to start. Is Docker running?" } });
      resolve();
    });
  });
}
