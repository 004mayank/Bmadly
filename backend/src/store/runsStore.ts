export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export type RunMeta = {
  provider: string;
  model: string;
  useOwnKey: boolean;
  createdAt: number;
};

export type RunRecord = {
  runId: string;
  status: RunStatus;
  meta: RunMeta;
  logs: string[];
  runtime?: {
    // Host port mapped to the per-run container runtime server.
    hostPort: number;
    containerPort: number;
  };
  output?: unknown;
  finishedAt?: number;
};

const runs = new Map<string, RunRecord>();

const MAX_LOG_LINES = Number(process.env.MAX_LOG_LINES || 2000);
// Keep finished runs around long enough for the UI to open Agent Chat after execution.
// A short TTL causes "Run not found" / runtime 404s when the user switches tabs.
const FINISHED_TTL_MS = Number(process.env.FINISHED_TTL_MS || 60 * 60 * 1000);

function pruneLogs(r: RunRecord) {
  if (r.logs.length > MAX_LOG_LINES) {
    r.logs = r.logs.slice(r.logs.length - MAX_LOG_LINES);
  }
}

function gc() {
  const now = Date.now();
  for (const [id, r] of runs.entries()) {
    if ((r.status === "succeeded" || r.status === "failed") && r.finishedAt && now - r.finishedAt > FINISHED_TTL_MS) {
      runs.delete(id);
    }
  }
}

export const RunsStore = {
  create(runId: string, meta: RunMeta) {
    runs.set(runId, { runId, status: "queued", meta, logs: [] });
  },

  get(runId: string) {
    return runs.get(runId);
  },

  setStatus(runId: string, status: RunStatus) {
    const r = runs.get(runId);
    if (!r) return;
    r.status = status;
  },

  appendLog(runId: string, line: string) {
    const r = runs.get(runId);
    if (!r) return;
    r.logs.push(line);
    pruneLogs(r);
  },

  finish(runId: string, params: { status: Exclude<RunStatus, "queued" | "running">; output?: unknown }) {
    const r = runs.get(runId);
    if (!r) return;
    r.status = params.status;
    r.output = params.output;
    r.finishedAt = Date.now();
    gc();
  }
  ,

  setRuntime(runId: string, runtime: { hostPort: number; containerPort: number }) {
    const r = runs.get(runId);
    if (!r) return;
    r.runtime = runtime;
  }
};
