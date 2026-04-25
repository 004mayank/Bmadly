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
  previewUrl?: string;
  previewReady?: boolean;
  containerId?: string;
  history: Array<{ version: number; result: PipelineResult; finishedAt: number }>;
};

const runs = new Map<string, PipelineRecord>();

const MAX_LOG_LINES = Number(process.env.MAX_LOG_LINES || 4000);
// Keep finished pipeline runs around long enough for users to inspect artifacts after completion.
const FINISHED_TTL_MS = Number(process.env.FINISHED_TTL_MS || 60 * 60 * 1000);

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

  setLivePreview(runId: string, params: { previewUrl: string; previewReady: boolean; containerId?: string }) {
    const r = runs.get(runId);
    if (!r) return;
    r.previewUrl = params.previewUrl;
    r.previewReady = params.previewReady;
    r.containerId = params.containerId;
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
  },

  upsertBmadArtifact(runId: string, artifact: { id: string; type: string; title?: string; content: string; createdAt: number }) {
    const r = runs.get(runId);
    if (!r) return;
    if (!r.result) {
      // Create a minimal result container if pipeline hasn't finished yet.
      r.result = {
        status: r.status === "failed" ? "failed" : "running",
        version: r.version,
        plan: {
          idea: "",
          features: [],
          techStack: { frontend: "", backend: "", execution: "" },
          architecture: { notes: [] }
        },
        tasks: [],
        build: { bmad: { command: "", env: {} } },
        artifacts: {}
      };
    }
    if (!r.result.artifacts) r.result.artifacts = {};
    if (!r.result.artifacts.bmad) r.result.artifacts.bmad = [];

    const arr = r.result.artifacts.bmad;
    const idx = arr.findIndex((a) => a.id === artifact.id);
    const rec = {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      contentType: "text/markdown",
      content: artifact.content,
      createdAt: artifact.createdAt
    };
    if (idx >= 0) arr[idx] = rec;
    else arr.push(rec);
  }
};
