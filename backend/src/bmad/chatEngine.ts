import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../pipeline/types.js";
import type { LlmConfig } from "../llm/client.js";
import { llmJson } from "../llm/client.js";
import { getRepoRoot, getBmadSkillsRoot } from "./paths.js";
import { loadBmadSkills, type BmadSkill } from "./registry.js";
import type { BmadSessionState } from "./sessionStore.js";

export type AgentMenuItem = { code: string; description: string; skill?: string; prompt?: string };

function findSkill(skills: BmadSkill[], id: string) {
  return skills.find((s) => s.id === id);
}

// Extremely small TOML-ish parser for just [[agent.menu]] blocks.
// We only need code/description/skill/prompt for v1.
export function parseAgentMenu(customizeToml: string): AgentMenuItem[] {
  const lines = customizeToml.split(/\r?\n/);
  const out: AgentMenuItem[] = [];
  let cur: Partial<AgentMenuItem> | null = null;

  const flush = () => {
    if (cur?.code && cur.description && (cur.skill || cur.prompt)) out.push(cur as AgentMenuItem);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[agent.menu]]") {
      flush();
      cur = {};
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "code") cur.code = val;
    if (key === "description") cur.description = val;
    if (key === "skill") cur.skill = val;
    if (key === "prompt") cur.prompt = val;
  }
  flush();
  return out;
}

function readIfExists(p: string) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function upsertSessionArtifact(
  session: BmadSessionState,
  artifact: { type: string; title?: string; content: string }
): { id: string; createdAt: number } {
  const existingIdx = session.artifacts.findIndex((a) => a.type === artifact.type && (artifact.title ? a.title === artifact.title : true));
  const createdAt = Date.now();
  const rec = {
    id: existingIdx >= 0 ? session.artifacts[existingIdx].id : `${createdAt}`,
    type: artifact.type,
    title: artifact.title,
    content: artifact.content,
    createdAt
  };
  if (existingIdx >= 0) session.artifacts[existingIdx] = rec;
  else session.artifacts.push(rec);
  return { id: rec.id, createdAt };
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function ensureFrontmatter(content: string, meta: Record<string, any>) {
  const has = content.trimStart().startsWith("---\n");
  const lines = content.split(/\r?\n/);

  const fmLines: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) fmLines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    else fmLines.push(`${k}: ${JSON.stringify(v)}`);
  }

  const fm = `---\n${fmLines.join("\n")}\n---\n`;
  if (!has) return fm + content;

  // Replace existing frontmatter block (best-effort).
  const endIdx = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
  if (endIdx === -1) return fm + content; // malformed
  const rest = lines.slice(endIdx + 1).join("\n");
  return fm + rest;
}

export function loadAgentMenu(agentSkillId: string) {
  const repoRoot = getRepoRoot();
  const skillsRoot = getBmadSkillsRoot();
  const skills = loadBmadSkills({ skillsRoot, repoRoot });
  const skill = findSkill(skills, agentSkillId);
  if (!skill) throw new Error(`Agent skill not found: ${agentSkillId}`);
  const customizeToml = readIfExists(path.join(skill.absDir, "customize.toml"));
  if (!customizeToml) return [];
  return parseAgentMenu(customizeToml);
}

export async function greetAgent(params: {
  agentSkillId: string;
  llm: LlmConfig;
  userName?: string;
}) {
  const { agentSkillId, llm, userName } = params;
  const greeting = `You are the BMAD agent skill ${agentSkillId}. Greet the user warmly${userName ? ` as ${userName}` : ""}. Keep it concise. Then ask what they want to do.`;
  const r = await llmJson<{ text: string }>({
    config: llm,
    system: greeting,
    user: "Start the session.",
    schemaHint: `{ "text": "string" }`
  });
  return String(r?.text ?? "").trim();
}

export async function advanceSession(params: {
  session: BmadSessionState;
  userMessage: string;
  provider: Provider;
  model: string;
  apiKey: string;
}) {
  const { session, userMessage, provider, model, apiKey } = params;

  const llm: LlmConfig = { provider, model, apiKey };

  // v2 (partial): if active skill has steps/step-*.md, run deterministic step runner.
  // v1: otherwise, if prompts/guided-elicitation.md exists, run guided Q/A.
  // Otherwise, generic chat response.
  const repoRoot = getRepoRoot();
  const skillsRoot = getBmadSkillsRoot();
  const skills = loadBmadSkills({ skillsRoot, repoRoot });

  const active = session.activeSkillId ? findSkill(skills, session.activeSkillId) : null;

  // Step-runner (supports bmad-market-research and similar).
  if (active) {
    // Step dirs vary by skill: steps/, domain-steps/, technical-steps/
    const stepDirCandidates = ["steps", "domain-steps", "technical-steps"].map((d) => path.join(active.absDir, d));
    const stepsDir = stepDirCandidates.find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory()) || null;
    if (stepsDir) {
      const stepFiles = fs
        .readdirSync(stepsDir)
        .filter((f) => /^step-\d+-.+\.md$/.test(f))
        .sort();

      const total = stepFiles.length;
      const currentIndex = session.step?.kind === "bmad_steps" ? session.step.index : 1;

      // Gate: only advance when user explicitly says C (or Modify stays on step).
      const trimmed = userMessage.trim();
      const wantsContinue = /^c$/i.test(trimmed);
      const wantsModify = /^modify$/i.test(trimmed);

      const nextIndex = wantsContinue && currentIndex < total ? currentIndex + 1 : currentIndex;
      session.step = { kind: "bmad_steps", index: nextIndex, total };

      // Respond using the effective step file.
      const effectiveIndex = nextIndex;
      const effectiveFile = stepFiles[Math.max(0, Math.min(total - 1, effectiveIndex - 1))];
      const effectiveMd = fs.readFileSync(path.join(stepsDir, effectiveFile), "utf8");

      const history = session.messages
        .slice(-20)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
        .join("\n");

      // Step-based doc handling (first implementation: market research).
      const artifactType =
        active.id.includes("market-research") ? "market-research" :
        active.id.includes("domain-research") ? "domain-research" :
        active.id.includes("technical-research") ? "technical-research" :
        `${active.id}-doc`;
      const existingDoc = session.stepContext?.docContent || "";
      const system =
        (session.agentSkillId ? `You are running BMAD agent ${session.agentSkillId}. ` : "") +
        `You are executing BMAD skill ${active.id} as a step-by-step workflow inside a chat UI. ` +
        `You MUST follow the step file instructions EXACTLY. Ask one question at a time. ` +
        `If the step says HALT, you must stop after presenting choices and wait for the user's next message. ` +
        `You are NOT allowed to skip steps. The backend controls step transitions (C/Modify). ` +
        `\n\nCURRENT DOCUMENT (if any):\n\n${existingDoc || "(none yet)"}` +
        `\n\nCURRENT STEP FILE (authoritative):\n\n${effectiveMd}`;

      const user = `Conversation so far:\n${history}\n\nLatest user message:\n${userMessage}`;

      const r = await llmJson<{
        text: string;
        doc: null | { title?: string | null; content: string };
      }>({
        config: llm,
        system,
        user,
        schemaHint:
          `{ "text": "string", "doc": null | { "title": "string?", "content": "string" } }`
      });

      // Update stepsCompleted only when user confirms with C (complete the previous step).
      const prev = (session.stepContext?.stepsCompleted as number[] | undefined) ?? [];
      const completedStep = wantsContinue ? currentIndex : null;
      const stepsCompleted = completedStep ? Array.from(new Set([...prev, completedStep])).sort((a, b) => a - b) : prev;

      // Persist/update document for this step-based skill.
      // If LLM doesn't return a doc, keep the last doc content.
      const nextDocRaw = r?.doc?.content && typeof r.doc.content === "string" ? r.doc.content : (session.stepContext?.docContent as string | undefined);
      if (nextDocRaw && typeof nextDocRaw === "string") {
        const title = r?.doc?.title ? String(r.doc.title) : active.id;
        const withFm = ensureFrontmatter(nextDocRaw, {
          skill: active.id,
          stepsCompleted,
          updatedAt: isoDate()
        });

        const { id, createdAt } = upsertSessionArtifact(session, { type: artifactType, title, content: withFm });
        session.stepContext = { ...(session.stepContext || {}), docContent: nextDocRaw, docArtifactId: id, docCreatedAt: createdAt, stepsCompleted };
      } else {
        session.stepContext = { ...(session.stepContext || {}), stepsCompleted };
      }

      // If user requested Modify, don't advance; (already enforced). We don't need special handling here.
      // If user sent C, backend advanced; LLM should now be responding for the next step.

      // Adapt return shape to the outer handler (artifact optional).
      return {
        text: String(r?.text ?? "").trim(),
        artifact: null
      };
    }
  }

  const guidedPath = active ? path.join(active.absDir, "prompts", "guided-elicitation.md") : null;
  const guided = guidedPath && fs.existsSync(guidedPath) ? fs.readFileSync(guidedPath, "utf8") : null;

  const history = session.messages
    .slice(-16)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");

  const system =
    (session.agentSkillId ? `You are running BMAD agent ${session.agentSkillId}. ` : "") +
    (session.activeSkillId ? `Current BMAD skill: ${session.activeSkillId}. ` : "") +
    `You are operating inside a chat UI. Ask one question at a time. If you need more info, ask a focused question. ` +
    (guided
      ? `You MUST follow this BMAD guided elicitation prompt as closely as possible (treat it as authoritative instructions):\n\n${guided}\n\n`
      : "");

  const user = `Conversation so far:\n${history}\n\nLatest user message:\n${userMessage}`;

  const r = await llmJson<{
    text: string;
    artifact: null | { type: string; title?: string | null; content: string };
  }>({
    config: llm,
    system,
    user,
    schemaHint:
      `{ "text": "string", "artifact": null | { "type": "string", "title": "string?", "content": "string" } }`
  });
  return r;
}
