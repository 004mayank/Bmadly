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
  output?: unknown;
};

const runs = new Map<string, RunRecord>();

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
  },

  finish(runId: string, params: { status: Exclude<RunStatus, "queued" | "running">; output?: unknown }) {
    const r = runs.get(runId);
    if (!r) return;
    r.status = params.status;
    r.output = params.output;
  }
};
