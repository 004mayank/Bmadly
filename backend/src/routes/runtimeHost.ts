import { Router } from "express";
import { z } from "zod";
import { RunsStore } from "../store/runsStore.js";
import { runtimeFetch } from "../execution/runtimeProxy.js";

export const runtimeHostRouter = Router();

const ProviderEnum = z.enum(["openai", "anthropic", "gemini"]);

const AuthSchema = z.object({
  runId: z.string().min(6),
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  apiKey: z.string().min(8)
});

runtimeHostRouter.post("/runtime/auth", async (req, res) => {
  const parsed = AuthSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { runId, provider, model, apiKey } = parsed.data;

  const run = RunsStore.get(runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (!run.runtime?.hostPort) return res.status(409).json({ error: "Runtime not started for this run" });

  try {
    const j = await runtimeFetch({
      hostPort: run.runtime.hostPort,
      path: "/api/runtime/auth",
      method: "POST",
      body: { provider, model, apiKey }
    });
    return res.json({ ok: true, runId, runtimeHostPort: run.runtime.hostPort, runtime: j });
  } catch (e: any) {
    return res.status(502).json({ error: `Runtime auth proxy failed: ${String(e?.message || e)}` });
  }
});

runtimeHostRouter.get("/runtime/status", async (req, res) => {
  const runId = String(req.query.runId || "");
  if (!runId || runId.length < 6) return res.status(400).json({ error: "Missing runId" });
  const run = RunsStore.get(runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (!run.runtime?.hostPort) return res.status(409).json({ error: "Runtime not started for this run" });
  try {
    const j = await runtimeFetch({ hostPort: run.runtime.hostPort, path: "/api/runtime/status" });
    return res.json({ ok: true, runId, runtimeHostPort: run.runtime.hostPort, runtime: j });
  } catch (e: any) {
    return res.status(502).json({ error: `Runtime status proxy failed: ${String(e?.message || e)}` });
  }
});

