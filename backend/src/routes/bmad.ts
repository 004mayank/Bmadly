import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getBmadMethodRoot, getBmadSkillsRoot, getRepoRoot } from "../bmad/paths.js";
import { loadBmadSkills } from "../bmad/registry.js";
import { BmadSessionStore } from "../bmad/sessionStore.js";
import { greetAgent, loadAgentMenu, advanceSession } from "../bmad/chatEngine.js";
import type { Provider } from "../pipeline/types.js";
import { PipelineStore } from "../pipeline/store.js";
import { RunsStore } from "../store/runsStore.js";
import { runtimeFetch } from "../execution/runtimeProxy.js";
import { RuntimeAuthStore } from "../runtime/runtimeAuth.js";

function isRuntimeContainerBackend() {
  return String(process.env.PORT || "") === "8080";
}

async function waitForRuntime(runId: string, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hostPort = RunsStore.get(runId)?.runtime?.hostPort;
    if (hostPort) return hostPort;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Runtime container for run ${runId} did not become ready within ${timeoutMs}ms`);
}

// Sync messages/artifacts from a runtime proxy response back to the host session so
// they survive container restarts and page refreshes.
function syncRuntimeSession(
  hostSession: import("../bmad/sessionStore.js").BmadSessionState,
  runtimeSession: any
) {
  if (!runtimeSession) return;
  if (Array.isArray(runtimeSession.messages)) hostSession.messages = runtimeSession.messages;
  if (Array.isArray(runtimeSession.artifacts)) hostSession.artifacts = runtimeSession.artifacts;
  if (runtimeSession.agentSkillId) hostSession.agentSkillId = runtimeSession.agentSkillId;
  if (runtimeSession.activeSkillId) hostSession.activeSkillId = runtimeSession.activeSkillId;
  if (runtimeSession.step) hostSession.step = runtimeSession.step;
  if (runtimeSession.stepContext) hostSession.stepContext = runtimeSession.stepContext;
  BmadSessionStore.save(hostSession);
}

// Get the existing runtime session ID for a host session, or create one if missing.
// Persisted on the host session so all proxy calls reuse the same container session.
async function getOrCreateRuntimeSession(session: import("../bmad/sessionStore.js").BmadSessionState, hostPort: number): Promise<string> {
  if (session.runtimeSessionId) return session.runtimeSessionId;
  const j = await runtimeFetch({
    hostPort,
    path: "/api/bmad/sessions",
    method: "POST",
    body: { runId: session.runId }
  });
  const runtimeSessionId = String(j?.session?.id || "");
  if (!runtimeSessionId) throw new Error("Runtime did not return a session id");
  session.runtimeSessionId = runtimeSessionId;
  BmadSessionStore.save(session);
  return runtimeSessionId;
}

export const bmadRouter = Router();

async function ensureRuntimeAuthed(params: {
  hostPort: number;
  provider: string;
  model: string;
  apiKey: string;
}) {
  const status = await runtimeFetch({ hostPort: params.hostPort, path: "/api/runtime/status", method: "GET" });
  if (status?.authed) return;
  await runtimeFetch({
    hostPort: params.hostPort,
    path: "/api/runtime/auth",
    method: "POST",
    body: { provider: params.provider, model: params.model, apiKey: params.apiKey }
  });
}

// Simple read-only endpoints first: status + list skills.

bmadRouter.get("/bmad/status", (_req, res) => {
  const repoRoot = getRepoRoot();
  const methodRoot = getBmadMethodRoot();
  const skillsRoot = getBmadSkillsRoot();

  const exists = {
    repoRoot,
    methodRoot,
    skillsRoot,
    methodRootExists: fs.existsSync(methodRoot),
    skillsRootExists: fs.existsSync(skillsRoot)
  };

  res.json({ ok: true, ...exists });
});

const ListSchema = z
  .object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200)
  })
  .default({});

bmadRouter.get("/bmad/skills", (req, res) => {
  const parsed = ListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });

  const { q, limit } = parsed.data;
  const repoRoot = getRepoRoot();
  const skillsRoot = getBmadSkillsRoot();
  if (!fs.existsSync(skillsRoot)) {
    return res.status(500).json({ error: "BMAD skills root not found", skillsRoot });
  }

  let skills = loadBmadSkills({ skillsRoot, repoRoot });
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    skills = skills.filter((s) =>
      [s.id, s.name, s.description, s.relDir].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
    );
  }

  res.json({ ok: true, count: skills.length, skills: skills.slice(0, limit) });
});

const ReadSkillSchema = z.object({ id: z.string().min(1).max(200) });

bmadRouter.get("/bmad/skills/:id", (req, res) => {
  const parsed = ReadSkillSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });
  const { id } = parsed.data;

  const repoRoot = getRepoRoot();
  const skillsRoot = getBmadSkillsRoot();
  const all = loadBmadSkills({ skillsRoot, repoRoot });
  const skill = all.find((s) => s.id === id);
  if (!skill) return res.status(404).json({ error: "Skill not found", id });

  const skillMd = fs.readFileSync(path.join(skill.absDir, "SKILL.md"), "utf8");
  const customizePath = path.join(skill.absDir, "customize.toml");
  const customizeToml = fs.existsSync(customizePath) ? fs.readFileSync(customizePath, "utf8") : null;

  res.json({ ok: true, skill, files: { skillMd, customizeToml } });
});

const DebugParamsSchema = z.object({ sessionId: z.string().min(6) });

// Debug endpoint: expose current BMAD session execution state (no secrets).
bmadRouter.get("/bmad/sessions/:sessionId/debug", (req, res) => {
  const parsed = DebugParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid params" });
  const { sessionId } = parsed.data;
  const session = BmadSessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  let stepFile: string | null = null;
  let skillAbsDir: string | null = null;
  try {
    if (session.activeSkillId) {
      const repoRoot = getRepoRoot();
      const skillsRoot = getBmadSkillsRoot();
      const all = loadBmadSkills({ skillsRoot, repoRoot });
      const skill = all.find((s) => s.id === session.activeSkillId);
      if (skill) {
        skillAbsDir = skill.absDir;
        const stepDirCandidates = [
          "steps",
          "domain-steps",
          "technical-steps",
          "steps-c",
          "steps-v",
          "steps-e"
        ].map((d) => path.join(skill.absDir, d));
        const stepsDir = stepDirCandidates.find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory()) || null;
        if (session.step?.kind === "bmad_steps" && stepsDir) {
          const stepFiles = fs
            .readdirSync(stepsDir)
            .filter((f) => /^step-\d+-.+\.md$/.test(f))
            .sort();
          const idx = Math.max(0, Math.min(stepFiles.length - 1, (session.step.index ?? 1) - 1));
          stepFile = stepFiles[idx] ?? null;
        }
      }
    }
  } catch {
    // ignore debug resolution errors
  }

  res.json({
    ok: true,
    sessionId: session.id,
    runId: session.runId,
    agentSkillId: session.agentSkillId ?? null,
    activeSkillId: session.activeSkillId ?? null,
    step: session.step ?? null,
    stepsCompleted: session.stepContext?.stepsCompleted ?? null,
    stepFile,
    skillAbsDir,
    docArtifact:
      session.stepContext && session.stepContext.docArtifactId
        ? {
            id: String(session.stepContext.docArtifactId),
            type: session.artifacts.find((a) => a.id === session.stepContext!.docArtifactId)?.type ?? null,
            title: session.artifacts.find((a) => a.id === session.stepContext!.docArtifactId)?.title ?? null
          }
        : null
  });
});

const ProviderEnum = z.enum(["openai", "anthropic", "gemini"]);

const CreateSessionSchema = z.object({
  runId: z.string().min(6).max(80)
});

// Create a BMAD chat session attached to a pipeline runId.
bmadRouter.post("/bmad/sessions", (req, res) => {
  const parsed = CreateSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { runId } = parsed.data;
  const session = BmadSessionStore.create(runId);
  res.json({ ok: true, session });
});

const ListSessionsSchema = z.object({ runId: z.string().min(6).max(80) });

// List/resume sessions for a run.
bmadRouter.get("/bmad/sessions", (req, res) => {
  const parsed = ListSessionsSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  const { runId } = parsed.data;
  const sessions = BmadSessionStore.listByRun(runId);
  // Include canonical current-document pointers per session so the frontend can
  // immediately render the right "Current Document" on resume.
  const sessionsWithPrimary = sessions.map((s) => ({
    ...s,
    primaryArtifactId: s.stepContext?.docArtifactId ?? null
  }));
  res.json({ ok: true, runId, sessions: sessionsWithPrimary });
});

const StartSchema = z.object({
  sessionId: z.string().min(6),
  agentSkillId: z.string().min(1).max(200),
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  apiKey: z.string().min(8),
  // Optional UX helper: seed the agent with the user's project idea.
  idea: z.string().min(1).max(2000).optional()
});

// Start an agent session: greet + return menu.
bmadRouter.post("/bmad/sessions/start", async (req, res) => {
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { sessionId, agentSkillId, provider, model, apiKey, idea } = parsed.data;
  const session = BmadSessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // In-container runtime mode: expect a runtime auth handshake and do not require apiKey per request.
  if (isRuntimeContainerBackend()) {
    const a = RuntimeAuthStore.get();
    if (!a) return res.status(401).json({ error: "Runtime not authenticated. Call POST /api/runtime/auth first." });
  }

  // Host mode: proxy to the per-run runtime container backend.
  // IMPORTANT: in host mode the runtime container has its own in-memory session store,
  // so the host sessionId is meaningless there. We must translate host sessionId -> runId.
  if (!isRuntimeContainerBackend()) {
    try {
      // Wait for runtime container to become ready (it boots asynchronously after POST /api/run).
      const hostPort = await waitForRuntime(session.runId, 60_000);
      // Ensure runtime is authenticated (the runtime container enforces this before BMAD endpoints).
      await ensureRuntimeAuthed({
        hostPort,
        provider,
        model,
        apiKey
      });

      const runtimeSessionId = await getOrCreateRuntimeSession(session, hostPort);
      const proxied = await runtimeFetch({
        hostPort,
        path: "/api/bmad/sessions/start",
        method: "POST",
        body: { ...req.body, sessionId: runtimeSessionId }
      });
      // Replace the runtime session id with the host session id so the frontend
      // sends the host id on subsequent calls (which the host can look up).
      if (proxied?.session) {
        syncRuntimeSession(session, proxied.session);
        proxied.session = { ...proxied.session, id: session.id, runId: session.runId };
      }
      return res.json(proxied);
    } catch (e: any) {
      return res.status(502).json({ error: `Runtime proxy failed: ${String(e?.message || e)}` });
    }
  }

  session.agentSkillId = agentSkillId;
  BmadSessionStore.save(session);

  // Seed project context so the agent doesn't ask the user to restate it.
  if (idea && idea.trim()) {
    const seeded = session.messages?.some((m) => m.role === "user" && String(m.text || "").startsWith("Project:"));
    if (!seeded) {
      session.messages.push({ role: "user", text: `Project: ${idea.trim()}`, ts: Date.now() });
    }
  }

  let greeting: string;
  try {
    greeting = await greetAgent({ agentSkillId, llm: { provider: provider as Provider, model, apiKey } });
  } catch (e: any) {
    return res.status(502).json({ error: `Agent greeting failed: ${String(e?.message || e)}` });
  }
  session.messages.push({ role: "assistant", text: greeting, ts: Date.now() });

  const menu = loadAgentMenu(agentSkillId);

  BmadSessionStore.save(session);
  res.json({
    ok: true,
    greeting,
    menu,
    session,
    primaryArtifactId: session.stepContext?.docArtifactId ?? null
  });
});

const SelectSkillSchema = z.object({
  sessionId: z.string().min(6),
  skillId: z.string().min(1).max(200)
});

// Select active BMAD skill (from menu) to drive the next chat turns.
bmadRouter.post("/bmad/sessions/select-skill", (req, res) => {
  const parsed = SelectSkillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { sessionId, skillId } = parsed.data;
  const session = BmadSessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  if (!isRuntimeContainerBackend()) {
    // Translate host sessionId -> runtime sessionId (runtime has its own in-memory session store).
    waitForRuntime(session.runId, 60_000)
      .then((hostPort) =>
        getOrCreateRuntimeSession(session, hostPort).then((runtimeSessionId) =>
          runtimeFetch({
            hostPort,
            path: "/api/bmad/sessions/select-skill",
            method: "POST",
            body: { ...req.body, sessionId: runtimeSessionId }
          })
        )
      )
      .then((j) => {
        if (j?.session) {
          syncRuntimeSession(session, j.session);
          j.session = { ...j.session, id: session.id, runId: session.runId };
        }
        return res.json(j);
      })
      .catch((e: any) => res.status(502).json({ error: `Runtime proxy failed: ${String(e?.message || e)}` }));
    return;
  }

  if (isRuntimeContainerBackend()) {
    const a = RuntimeAuthStore.get();
    if (!a) return res.status(401).json({ error: "Runtime not authenticated. Call POST /api/runtime/auth first." });
  }
  session.activeSkillId = skillId;
  // Reset step state for the selected skill; step runner will take over if skill has steps/.
  session.step = { kind: "chat", index: 0 };
  BmadSessionStore.save(session);
  res.json({
    ok: true,
    session,
    primaryArtifactId: session.stepContext?.docArtifactId ?? null
  });
});

const MessageSchema = z.object({
  sessionId: z.string().min(6),
  message: z.string().min(1).max(8000),
  provider: ProviderEnum,
  model: z.string().min(1).max(80),
  apiKey: z.string().min(8)
});

// Main chat turn: user message -> assistant response. If skill emits artifact, store it.
bmadRouter.post("/bmad/sessions/message", async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { sessionId, message, provider, model, apiKey } = parsed.data;
  const session = BmadSessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  if (isRuntimeContainerBackend()) {
    const a = RuntimeAuthStore.get();
    if (!a) return res.status(401).json({ error: "Runtime not authenticated. Call POST /api/runtime/auth first." });
  }

  if (!isRuntimeContainerBackend()) {
    try {
      const hostPort = await waitForRuntime(session.runId, 60_000);
      // Ensure runtime is authenticated (the runtime container enforces this before BMAD endpoints).
      await ensureRuntimeAuthed({
        hostPort,
        provider,
        model,
        apiKey
      });

      const runtimeSessionId = await getOrCreateRuntimeSession(session, hostPort);
      const j = await runtimeFetch({
        hostPort,
        path: "/api/bmad/sessions/message",
        method: "POST",
        body: { ...req.body, sessionId: runtimeSessionId }
      });
      if (j?.session) {
        syncRuntimeSession(session, j.session);
        j.session = { ...j.session, id: session.id, runId: session.runId };
      }
      return res.json(j);
    } catch (e: any) {
      return res.status(502).json({ error: `Runtime proxy failed: ${String(e?.message || e)}` });
    }
  }

  session.messages.push({ role: "user", text: message, ts: Date.now() });

  const r = await advanceSession({
    session,
    userMessage: message,
    provider: provider as Provider,
    model,
    apiKey
  });

  const text = String(r?.text ?? "").trim();
  session.messages.push({ role: "assistant", text, ts: Date.now() });

  // Sync any new/updated session artifacts to the pipeline run record.
  // (The step-runner upserts artifacts into the session directly.)
  for (const a of session.artifacts) {
    PipelineStore.upsertBmadArtifact(session.runId, {
      id: a.id,
      type: a.type,
      title: a.title,
      content: a.content,
      createdAt: a.createdAt
    });
  }

  BmadSessionStore.save(session);
  res.json({
    ok: true,
    text,
    artifact: (r as any)?.artifact ?? null,
    session,
    primaryArtifactId: session.stepContext?.docArtifactId ?? session.artifacts.slice(-1)[0]?.id ?? null
  });
});
