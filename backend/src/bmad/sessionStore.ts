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
  messages: BmadChatMessage[];
  artifacts: Array<{ id: string; type: string; title?: string; content: string; createdAt: number }>;
};

const SESSIONS = new Map<string, BmadSessionState>();

function sessionsDirForRun(runId: string) {
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
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
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
    const base = path.join(getRepoRoot(), ".bmadly", "bmad-sessions");
    if (!fs.existsSync(base)) return undefined;
    for (const runId of fs.readdirSync(base)) {
      const s = loadFromDisk(runId, id);
      if (s) {
        SESSIONS.set(id, s);
        return s;
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
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  },

  save(s: BmadSessionState) {
    s.updatedAt = Date.now();
    SESSIONS.set(s.id, s);
    saveToDisk(s);
  }
};
