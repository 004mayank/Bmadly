import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { RunsStore } from "../store/runsStore.js";
import { dockerRunBmad } from "../services/dockerRunner.js";
import { maskKey } from "../utils/maskKey.js";

export const runsRouter = Router();

const ProviderEnum = z.enum(["openai", "anthropic", "gemini"]);

const StartRunSchema = z.object({
  provider: ProviderEnum,
  model: z.string().min(1),
  useOwnKey: z.boolean().default(false),
  apiKey: z.string().optional(),
  input: z.record(z.any()).optional()
});

runsRouter.post("/run", async (req, res) => {
  const parsed = StartRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { provider, model, useOwnKey, apiKey, input } = parsed.data;

  if (useOwnKey && (!apiKey || apiKey.trim().length < 8)) {
    return res.status(400).json({ error: "BYOK enabled but apiKey is missing/too short" });
  }

  const runId = nanoid();
  RunsStore.create(runId, { provider, model, useOwnKey, createdAt: Date.now() });

  // Fire-and-forget execution. Streaming happens via SSE endpoint.
  dockerRunBmad({
    runId,
    provider,
    model,
    useOwnKey,
    apiKey: useOwnKey ? apiKey : undefined,
    input
  }).catch((err) => {
    RunsStore.appendLog(runId, `[runner] fatal: ${String(err?.message || err)}`);
    RunsStore.finish(runId, { status: "failed", output: { error: "Runner failed" } });
  });

  // eslint-disable-next-line no-console
  console.log(
    `[bmadly] run started ${runId} provider=${provider} model=${model} byok=${useOwnKey}` +
      (useOwnKey ? ` apiKey=${maskKey(apiKey!)}` : "")
  );

  res.json({ runId, status: "started" });
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
    return res.json({ runId, status: run.status });
  }
  return res.json({ runId, status: run.status, output: run.output ?? null });
});
