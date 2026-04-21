import type { PipelineConfig, PipelineResult, Plan } from "./types.js";
import { PipelineStore } from "./store.js";
import { plannerAgent } from "../agents/planner.js";
import { decomposerAgent } from "../agents/decomposer.js";
import { builderAgent } from "../agents/builder.js";
import { reviewerAgent } from "../agents/reviewer.js";
import { iterationAgent, type IterationIntent } from "../agents/iteration.js";
import { runDockerStaticBuild } from "../execution/dockerStaticRunner.js";
import { previewPathForRun, rmPreview } from "../execution/staticPreviewManager.js";
import fs from "node:fs";
import { runDockerLivePreview, stopContainer } from "../execution/dockerLivePreviewRunner.js";

export async function runFullPipeline(params: {
  runId: string;
  idea: string;
  config: PipelineConfig;
  onLog: (line: string) => void;
}): Promise<void> {
  const { runId, idea, config, onLog } = params;

  PipelineStore.setStatus(runId, "running");

  const llm = {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey!
  };

  onLog(`[agent:planner] planning…`);
  const plan = await plannerAgent({ idea, llm });
  onLog(`[agent:planner] done`);

  onLog(`[agent:decomposer] decomposing…`);
  const tasks = await decomposerAgent(plan);
  onLog(`[agent:decomposer] done (${tasks.length} tasks)`);

  onLog(`[agent:builder] preparing BMAD input…`);
  const build = await builderAgent({ plan, tasks, llm });
  onLog(`[agent:builder] done`);

  onLog(`[exec] starting docker build…`);

  const version = PipelineStore.get(runId)?.version ?? 1;

  // Live preview mode (Next.js dev server in container)
  const liveRes = await runDockerLivePreview({
    runId,
    version,
    provider: config.provider,
    model: config.model,
    useOwnKey: config.useOwnKey,
    apiKey: config.apiKey,
    bmadEnv: build.bmad.env,
    bmadCommand: build.bmad.command,
    onLog
  });

  if (!liveRes.ok) {
    const result: PipelineResult = {
      status: "failed",
      version,
      plan,
      tasks,
      build,
      previewReady: false,
      error: liveRes.error
    };
    PipelineStore.finish(runId, result);
    return;
  }

  PipelineStore.setLivePreview(runId, {
    previewUrl: liveRes.previewUrl,
    previewReady: true,
    containerId: liveRes.containerId
  });

  // Auto cleanup after 10 minutes
  setTimeout(() => {
    stopContainer(liveRes.containerId).catch(() => {});
  }, 10 * 60 * 1000);

  const previewUrl = liveRes.previewUrl;

  const resultBase: PipelineResult = {
    status: "succeeded",
    version,
    plan,
    tasks,
    build,
    previewUrl,
    previewReady: true
  };

  onLog(`[agent:reviewer] reviewing…`);
  const review = await reviewerAgent({ result: resultBase, logs: PipelineStore.get(runId)?.logs ?? [], llm });
  onLog(`[agent:reviewer] done`);

  PipelineStore.finish(runId, { ...resultBase, review });
}

export async function runIteration(params: {
  runId: string;
  intent: IterationIntent;
  note?: string;
  config: PipelineConfig;
  onLog: (line: string) => void;
}): Promise<void> {
  const { runId, intent, note, config, onLog } = params;

  const llm = {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey!
  };

  const current = PipelineStore.get(runId);
  if (!current?.result) {
    onLog(`[iter] no existing result to iterate on`);
    PipelineStore.finish(runId, {
      status: "failed",
      version: current?.version ?? 1,
      plan: { idea: "", features: [], techStack: { frontend: "", backend: "", execution: "" }, architecture: { notes: [] } },
      tasks: [],
      build: { bmad: { command: "", env: {} } },
      error: "No prior run state"
    });
    return;
  }

  PipelineStore.bumpVersion(runId);
  const version = PipelineStore.get(runId)?.version ?? 1;

  const prior = current.result;
  const newPlan: Plan = await iterationAgent({ intent, plan: prior.plan, note });

  onLog(`[iter] version=${version} intent=${intent}`);

  const tasks = await decomposerAgent(newPlan);
  const build = await builderAgent({ plan: newPlan, tasks, llm });

  const liveRes = await runDockerLivePreview({
    runId,
    version,
    provider: config.provider,
    model: config.model,
    useOwnKey: config.useOwnKey,
    apiKey: config.apiKey,
    bmadEnv: build.bmad.env,
    bmadCommand: build.bmad.command,
    onLog
  });

  if (!liveRes.ok) {
    PipelineStore.finish(runId, {
      status: "failed",
      version,
      plan: newPlan,
      tasks,
      build,
      previewReady: false,
      error: liveRes.error
    });
    return;
  }

  PipelineStore.setLivePreview(runId, {
    previewUrl: liveRes.previewUrl,
    previewReady: true,
    containerId: liveRes.containerId
  });

  setTimeout(() => {
    stopContainer(liveRes.containerId).catch(() => {});
  }, 10 * 60 * 1000);

  const previewUrl = liveRes.previewUrl;

  const base: PipelineResult = {
    status: "succeeded",
    version,
    plan: newPlan,
    tasks,
    build,
    previewUrl,
    previewReady: true
  };

  const review = await reviewerAgent({ result: base, logs: PipelineStore.get(runId)?.logs ?? [], llm });
  PipelineStore.finish(runId, { ...base, review });

  // (MVP) previews accumulate; GC for finished runs will eventually drop store entries.
  // If you want aggressive cleanup, call rmPreview(runId) elsewhere.
}
