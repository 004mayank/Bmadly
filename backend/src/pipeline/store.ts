import type { PipelineResult, PipelineStatus } from "./types.js";

export type PipelineRecord = {
  runId: string;
  status: PipelineStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  version: number;
  logs: string[];
  result?: PipelineResult;
  previewPath?: string; // local filesystem path to preview root
  history: Array<{ version: number; result: PipelineResult; finishedAt: number }>;
};

const runs = new Map<string, PipelineRecord>();

const MAX_LOG_LINES = Number(process.env.MAX_LOG_LINES || 4000);
const FINISHED_TTL_MS = Number(process.env.FINISHED_TTL_MS || 20 * 60 * 1000);

function pruneLogs(r: PipelineRecord) {
  if (r.logs.length > MAX_LOG_LINES) r.logs = r.logs.slice(r.logs.length - MAX_LOG_LINES);
}

function gc() {
  const now = Date.now();
  for (const [id, r] of runs.entries()) {
    if ((r.status === "succeeded" || r.status === "failed") && r.finishedAt && now - r.finishedAt > FINISHED_TTL_MS) {
      runs.delete(id);
    }
  }
}

export const PipelineStore = {
  create(runId: string) {
    const rec: PipelineRecord = {
      runId,
      status: "queued",
      createdAt: Date.now(),
      version: 1,
      logs: [],
      history: []
    };
    runs.set(runId, rec);
    return rec;
  },

  get(runId: string) {
    return runs.get(runId);
  },

  appendLog(runId: string, line: string) {
    const r = runs.get(runId);
    if (!r) return;
    r.logs.push(line);
    pruneLogs(r);
  },

  setStatus(runId: string, status: PipelineStatus) {
    const r = runs.get(runId);
    if (!r) return;
    r.status = status;
    if (status === "running") r.startedAt = Date.now();
  },

  setPreview(runId: string, previewPath: string) {
    const r = runs.get(runId);
    if (!r) return;
    r.previewPath = previewPath;
  },

  finish(runId: string, result: PipelineResult) {
    const r = runs.get(runId);
    if (!r) return;
    r.status = result.status;
    r.result = result;
    r.finishedAt = Date.now();
    r.history.push({ version: result.version, result, finishedAt: r.finishedAt });
    gc();
  },

  bumpVersion(runId: string) {
    const r = runs.get(runId);
    if (!r) return;
    r.version += 1;
  }
};
