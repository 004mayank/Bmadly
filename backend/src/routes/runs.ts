import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { RunsStore } from "../store/runsStore.js";
import { maskKey } from "../utils/maskKey.js";
import path from "node:path";
import fs from "node:fs";
import { pickFreePortInRange, startRunContainer, waitForContainerReady } from "../execution/runContainerManager.js";
import { tailContainerLogs } from "../execution/dockerLogsTail.js";

export const runsRouter = Router();

const ProviderEnum = z.enum(["openai", "anthropic", "gemini"]);

const StartRunSchema = z.object({
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  useOwnKey: z.boolean().default(false),
  apiKey: z.string().optional(),
  input: z.record(z.any()).optional()
});

function normalizeApiKey(key: string) {
  return key.trim();
}

function validateApiKeyFormat(provider: z.infer<typeof ProviderEnum>, key: string) {
  // Keep this intentionally loose for MVP (providers change prefixes).
  // We only prevent obvious bad inputs.
  if (key.length < 8) return "too short";
  if (/\s/.test(key)) return "contains whitespace";
  if (provider === "openai" && !/^sk-/.test(key)) return null; // allow other OpenAI key formats
  return null;
}

runsRouter.post("/run", async (req, res) => {
  const parsed = StartRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { provider, model, useOwnKey, apiKey, input } = parsed.data;

  let normalizedKey: string | undefined;
  if (useOwnKey) {
    if (!apiKey) return res.status(400).json({ error: "BYOK enabled but apiKey is missing" });
    normalizedKey = normalizeApiKey(apiKey);
    const bad = validateApiKeyFormat(provider, normalizedKey);
    if (bad) return res.status(400).json({ error: `Invalid apiKey (${bad})` });
  }

  const runId = nanoid();
  RunsStore.create(runId, { provider, model, useOwnKey, createdAt: Date.now() });
  RunsStore.setStatus(runId, "running");

  // eslint-disable-next-line no-console
  console.log(`[bmadly] run started ${runId} provider=${provider} model=${model} byok=${useOwnKey}` + (useOwnKey ? ` apiKey=${maskKey(normalizedKey!)}` : ""));

  // Respond immediately — container boots in the background.
  // The bmad proxy will wait for runtime.hostPort to be registered before proxying.
  res.json({ runId, status: "started" });

  // Boot the runtime container asynchronously.
  (async () => {
    try {
      const repoRoot = process.cwd();
      const workDirHost = path.join(repoRoot, ".bmadly", "runs", runId);
      fs.mkdirSync(workDirHost, { recursive: true });
      const image = "bmadly-runtime:local";
      const runtimePort = 8080;
      const maxAttempts = 12;

      let started = false;
      let hostPort: number | null = null;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        hostPort = await pickFreePortInRange({ start: 18080, end: 18999 });
        try {
          RunsStore.appendLog(runId, `[runner] starting runtime container (attempt ${attempt}/${maxAttempts}) on port ${hostPort}…`);
          await startRunContainer({ runId, image, hostPort, runtimePort, workDirHost });
          started = true;
          break;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || e);
          const isPortBindIssue = msg.includes("port is already allocated") || msg.includes("EADDRINUSE") || msg.includes("address already in use");
          RunsStore.appendLog(runId, `[runner] runtime start failed on port ${hostPort}: ${msg}`);
          if (!isPortBindIssue) break;
        }
      }

      if (!started || !hostPort) throw lastErr || new Error("runtime container failed to start");

      // Stream container logs to SSE immediately.
      tailContainerLogs({ runId, containerName: `bmadly-run-${runId}` });
      RunsStore.appendLog(runId, `[runner] container up on port ${hostPort} — waiting for HTTP…`);

      // Wait until the container's Express server is accepting requests,
      // THEN register the runtime so the proxy knows it is safe to use.
      await waitForContainerReady({ hostPort, timeoutMs: 60_000 });
      RunsStore.setRuntime(runId, { hostPort, containerPort: runtimePort });
      RunsStore.appendLog(runId, `[runner] runtime ready ✓ http://localhost:${hostPort}`);
    } catch (e: any) {
      RunsStore.appendLog(runId, `[runner] runtime container failed: ${String(e?.message || e)}`);
    }
  })();
});

runsRouter.get("/run/:runId/stream", (req, res) => {
  const runId = req.params.runId;
  const run = RunsStore.get(runId);
  if (!run) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  // Nudge proxies to flush immediately.
  res.write(`:ok\n\n`);

  // initial event
  res.write(`event: meta\ndata: ${JSON.stringify({ runId, status: run.status })}\n\n`);

  let cursor = 0;

  const tick = () => {
    const current = RunsStore.get(runId);
    if (!current) {
      res.write(`event: done\ndata: ${JSON.stringify({ status: "unknown" })}\n\n`);
      return;
    }

    const logs = current.logs;
    while (cursor < logs.length) {
      res.write(`event: log\ndata: ${JSON.stringify({ line: logs[cursor] })}\n\n`);
      cursor++;
    }

    if (current.status === "succeeded" || current.status === "failed") {
      res.write(`event: done\ndata: ${JSON.stringify({ status: current.status })}\n\n`);
      res.end();
      return;
    }

    setTimeout(tick, 250);
  };

  const onClose = () => {
    // client disconnected
  };
  req.on("close", onClose);

  tick();
});

runsRouter.get("/run/:runId/result", (req, res) => {
  const runId = req.params.runId;
  const run = RunsStore.get(runId);
  if (!run) return res.status(404).json({ error: "Not found" });
  if (run.status === "running" || run.status === "queued") {
    return res.json({ runId, status: run.status, runtime: run.runtime ?? null });
  }
  return res.json({ runId, status: run.status, runtime: run.runtime ?? null, output: run.output ?? null });
});
