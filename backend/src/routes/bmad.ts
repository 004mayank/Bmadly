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

export const bmadRouter = Router();

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
  apiKey: z.string().min(8)
});

// Start an agent session: greet + return menu.
bmadRouter.post("/bmad/sessions/start", async (req, res) => {
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { sessionId, agentSkillId, provider, model, apiKey } = parsed.data;
  const session = BmadSessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.agentSkillId = agentSkillId;
  BmadSessionStore.save(session);

  const greeting = await greetAgent({ agentSkillId, llm: { provider: provider as Provider, model, apiKey } });
  session.messages.push({ role: "assistant", text: greeting, ts: Date.now() });

  const menu = loadAgentMenu(agentSkillId);

  BmadSessionStore.save(session);
  res.json({
    ok: true,
    greeting,
    menu,
    session,
    // Canonical "current document" pointer for the UI (single source of truth).
    // Frontend should prefer this over any skillId→type mapping.
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
    artifact: null,
    session,
    primaryArtifactId: session.stepContext?.docArtifactId ?? null
  });
});
