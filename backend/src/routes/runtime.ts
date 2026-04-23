import { Router } from "express";
import { z } from "zod";
import { RuntimeAuthStore } from "../runtime/runtimeAuth.js";

export const runtimeRouter = Router();

const ProviderEnum = z.enum(["openai", "anthropic", "gemini"]);

const AuthSchema = z.object({
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  apiKey: z.string().min(8)
});

runtimeRouter.post("/runtime/auth", (req, res) => {
  const parsed = AuthSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { provider, model, apiKey } = parsed.data;
  RuntimeAuthStore.set({ provider, model, apiKey });
  res.json({ ok: true, provider, model });
});

runtimeRouter.post("/runtime/clear", (_req, res) => {
  RuntimeAuthStore.clear();
  res.json({ ok: true });
});

runtimeRouter.get("/runtime/status", (_req, res) => {
  const a = RuntimeAuthStore.get();
  res.json({ ok: true, authed: Boolean(a), provider: a?.provider ?? null, model: a?.model ?? null });
});

