import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "./paths.js";

export type BmadChatMessage = { role: "user" | "assistant"; text: string; ts: number };

export type BmadSessionState = {
  id: string;
  runId: string;
  createdAt: number;
  updatedAt: number;
  agentSkillId?: string;
  activeSkillId?: string;
  step?: { kind: string; index: number; total?: number };
  answers: Record<string, string>;
  stepContext?: Record<string, any>;
  messages: BmadChatMessage[];
  artifacts: Array<{ id: string; type: string; title?: string; content: string; createdAt: number }>;
  // Persisted runtime session ID so all proxy calls reuse the same container session.
  runtimeSessionId?: string;
};

const SESSIONS = new Map<string, BmadSessionState>();

function sessionsDirForRun(runId: string) {
  // Store sessions inside the per-run work directory so the runtime container
  // can see the same files via the run volume mount.
  // New location:
  //   .bmadly/runs/<runId>/bmad-sessions/
  return path.join(getRepoRoot(), ".bmadly", "runs", runId, "bmad-sessions");
}

// Back-compat location (older builds stored sessions globally):
function legacySessionsDirForRun(runId: string) {
  return path.join(getRepoRoot(), ".bmadly", "bmad-sessions", runId);
}

function sessionPath(runId: string, sessionId: string) {
  return path.join(sessionsDirForRun(runId), `${sessionId}.json`);
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function loadFromDisk(runId: string, sessionId: string): BmadSessionState | null {
  const p = sessionPath(runId, sessionId);
  // If missing in new path, try legacy location.
  const legacy = path.join(legacySessionsDirForRun(runId), `${sessionId}.json`);
  const target = fs.existsSync(p) ? p : fs.existsSync(legacy) ? legacy : null;
  if (!target) return null;
  try {
    const raw = fs.readFileSync(target, "utf8");
    return JSON.parse(raw) as BmadSessionState;
  } catch {
    return null;
  }
}

function saveToDisk(s: BmadSessionState) {
  ensureDir(sessionsDirForRun(s.runId));
  fs.writeFileSync(sessionPath(s.runId, s.id), JSON.stringify(s, null, 2));
}

export const BmadSessionStore = {
  create(runId: string) {
    const id = nanoid();
    const now = Date.now();
    const s: BmadSessionState = {
      id,
      runId,
      createdAt: now,
      updatedAt: now,
      answers: {},
      messages: [],
      artifacts: []
    };
    SESSIONS.set(id, s);
    saveToDisk(s);
    return s;
  },

  get(id: string) {
    const inMem = SESSIONS.get(id);
    if (inMem) return inMem;
    // If not in memory, try to find on disk by scanning runs. (Cheap for MVP)
    // New base:
    //   .bmadly/runs/<runId>/bmad-sessions/
    const runsBase = path.join(getRepoRoot(), ".bmadly", "runs");
    if (fs.existsSync(runsBase)) {
      for (const runId of fs.readdirSync(runsBase)) {
        const s = loadFromDisk(runId, id);
        if (s) {
          SESSIONS.set(id, s);
          return s;
        }
      }
    }

    // Legacy base fallback:
    const legacyBase = path.join(getRepoRoot(), ".bmadly", "bmad-sessions");
    if (fs.existsSync(legacyBase)) {
      for (const runId of fs.readdirSync(legacyBase)) {
        const s = loadFromDisk(runId, id);
        if (s) {
          SESSIONS.set(id, s);
          return s;
        }
      }
    }
    return undefined;
  },

  listByRun(runId: string) {
    const out = Array.from(SESSIONS.values()).filter((s) => s.runId === runId);
    // merge in disk sessions
    const dir = sessionsDirForRun(runId);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.replace(/\.json$/, "");
        if (out.some((s) => s.id === id)) continue;
        const s = loadFromDisk(runId, id);
        if (s) {
          SESSIONS.set(id, s);
          out.push(s);
        }
      }
    }

    // Legacy merge
    const legacyDir = legacySessionsDirForRun(runId);
    if (fs.existsSync(legacyDir)) {
      for (const f of fs.readdirSync(legacyDir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.replace(/\.json$/, "");
        if (out.some((s) => s.id === id)) continue;
        const s = loadFromDisk(runId, id);
        if (s) {
          SESSIONS.set(id, s);
          out.push(s);
        }
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  },

  save(s: BmadSessionState) {
    s.updatedAt = Date.now();
    SESSIONS.set(s.id, s);
    saveToDisk(s);
  }
};
