import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { PipelineStore } from "../pipeline/store.js";
import { sseInit, sseEvent } from "../pipeline/sse.js";
import { runFullPipeline, runIteration } from "../pipeline/orchestrator.js";
import type { Provider } from "../pipeline/types.js";
import { maskKey } from "../utils/maskKey.js";
import { RunsStore } from "../store/runsStore.js";
import { runtimeFetch } from "../execution/runtimeProxy.js";

export const pipelineRouter = Router();

function isRuntimeContainerBackend() {
  return String(process.env.PORT || "") === "8080";
}

async function proxyIfRuntime(params: { runId: string; path: string; method: string; body?: any }) {
  if (isRuntimeContainerBackend()) return null;
  const run = RunsStore.get(params.runId);
  const hostPort = run?.runtime?.hostPort;
  if (!hostPort) return null;
  return runtimeFetch({ hostPort, path: `/api${params.path}`, method: params.method as any, body: params.body });
}

const ProviderEnum = z.enum(["openai", "anthropic", "gemini"]);

// Create a runId without starting the pipeline (used for BMAD chat sessions).
pipelineRouter.post("/pipeline/create", (_req, res) => {
  const runId = nanoid();
  PipelineStore.create(runId);
  res.json({ runId, status: "created" });
});
const StartSchema = z.object({
  idea: z.string().min(3).max(4000),
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  useOwnKey: z.boolean().default(false),
  apiKey: z.string().optional()
});

const IterateSchema = z.object({
  runId: z.string().min(6),
  intent: z.enum(["improve_ui", "fix_bugs", "add_feature"]),
  note: z.string().max(2000).optional(),
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  useOwnKey: z.boolean().default(false),
  apiKey: z.string().optional()
});

function normalizeKey(k: string) {
  return k.trim();
}

function validateKey(k: string) {
  if (k.length < 8) return "too short";
  if (/\s/.test(k)) return "contains whitespace";
  return null;
}

function envKeyFor(provider: string) {
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "gemini") return process.env.GEMINI_API_KEY;
  return undefined;
}

pipelineRouter.post("/pipeline/run", async (req, res) => {
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  const { idea, provider, model, useOwnKey, apiKey } = parsed.data;

  let normalizedKey: string | undefined;
  if (useOwnKey) {
    if (!apiKey) return res.status(400).json({ error: "BYOK enabled but apiKey is missing" });
    normalizedKey = normalizeKey(apiKey);
    const bad = validateKey(normalizedKey);
    if (bad) return res.status(400).json({ error: `Invalid apiKey (${bad})` });
  }

  if (!useOwnKey) {
    const managed = envKeyFor(provider);
    if (!managed || managed.trim().length < 8) {
      return res.status(400).json({ error: `Managed key missing for provider=${provider}. Set env var or enable BYOK.` });
    }
    normalizedKey = managed.trim();
  }

  const runId = nanoid();
  PipelineStore.create(runId);

  // fire-and-forget pipeline
  runFullPipeline({
    runId,
    idea,
    config: { provider: provider as Provider, model, useOwnKey, apiKey: normalizedKey },
    onLog: (line) => PipelineStore.appendLog(runId, line)
  }).catch((err) => {
    PipelineStore.appendLog(runId, `[pipeline] fatal: ${String(err?.message || err)}`);
    const rec = PipelineStore.get(runId);
    PipelineStore.finish(runId, {
      status: "failed",
      version: rec?.version ?? 1,
      plan: { idea, features: [], techStack: { frontend: "", backend: "", execution: "" }, architecture: { notes: [] } },
      tasks: [],
      build: { bmad: { command: "", env: {} } },
      error: "Pipeline failed"
    });
  });

  // eslint-disable-next-line no-console
  console.log(
    `[bmadly] pipeline started ${runId} provider=${provider} model=${model} byok=${useOwnKey}` +
      (useOwnKey ? ` apiKey=${maskKey(normalizedKey!)}` : "")
  );

  res.json({ runId, status: "started" });
});

pipelineRouter.post("/pipeline/iterate", async (req, res) => {
  const parsed = IterateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  const { runId, intent, note, provider, model, useOwnKey, apiKey } = parsed.data;

  // Host mode: proxy iteration into the runtime container backend for this runId.
  const proxied = await proxyIfRuntime({ runId, path: "/pipeline/iterate", method: "POST", body: req.body });
  if (proxied) return res.json(proxied);

  let normalizedKey: string | undefined;
  if (useOwnKey) {
    if (!apiKey) return res.status(400).json({ error: "BYOK enabled but apiKey is missing" });
    normalizedKey = normalizeKey(apiKey);
    const bad = validateKey(normalizedKey);
    if (bad) return res.status(400).json({ error: `Invalid apiKey (${bad})` });
  }

  if (!useOwnKey) {
    const managed = envKeyFor(provider);
    if (!managed || managed.trim().length < 8) {
      return res.status(400).json({ error: `Managed key missing for provider=${provider}. Set env var or enable BYOK.` });
    }
    normalizedKey = managed.trim();
  }

  const rec = PipelineStore.get(runId);
  if (!rec) return res.status(404).json({ error: "Run not found" });

  runIteration({
    runId,
    intent,
    note,
    config: { provider: provider as Provider, model, useOwnKey, apiKey: normalizedKey },
    onLog: (line) => PipelineStore.appendLog(runId, line)
  }).catch((err) => {
    PipelineStore.appendLog(runId, `[iter] fatal: ${String(err?.message || err)}`);
  });

  res.json({ runId, status: "started" });
});

pipelineRouter.get("/pipeline/run/:runId/stream", (req, res) => {
  const runId = req.params.runId;
  const run = PipelineStore.get(runId);
  if (!run) return res.status(404).end();

  sseInit(res);
  sseEvent(res, "meta", { runId, status: run.status, version: run.version });

  let cursor = 0;
  const tick = () => {
    const current = PipelineStore.get(runId);
    if (!current) {
      sseEvent(res, "done", { status: "unknown" });
      return;
    }

    while (cursor < current.logs.length) {
      sseEvent(res, "log", { line: current.logs[cursor] });
      cursor++;
    }

    if (current.status === "succeeded" || current.status === "failed") {
      sseEvent(res, "done", { status: current.status, version: current.version });
      res.end();
      return;
    }

    setTimeout(tick, 250);
  };

  tick();
});

pipelineRouter.get("/pipeline/run/:runId/result", (req, res) => {
  const runId = req.params.runId;
  const run = PipelineStore.get(runId);
  if (!run) return res.status(404).json({ error: "Not found" });

  if (run.status === "running" || run.status === "queued") {
    return res.json({ runId, status: run.status, version: run.version });
  }

  return res.json({
    runId,
    status: run.status,
    version: run.version,
    previewUrl: run.previewUrl,
    previewReady: run.previewReady,
    result: run.result ?? null
  });
});
