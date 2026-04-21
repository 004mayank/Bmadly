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

  const execRes = await runDockerStaticBuild({
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

  if ("error" in execRes) {
    const result: PipelineResult = {
      status: "failed",
      version,
      plan,
      tasks,
      build,
      error: execRes.error
    };
    PipelineStore.finish(runId, result);
    return;
  }

  const previewPath = previewPathForRun(runId, version);
  fs.mkdirSync(previewPath, { recursive: true });
  // Copy from hostOutDir to previewPath
  fs.cpSync(execRes.outDirOnHost, previewPath, { recursive: true });

  PipelineStore.setPreview(runId, previewPath);

  const previewUrl = `/preview/${runId}/${version}/`;

  const resultBase: PipelineResult = {
    status: "succeeded",
    version,
    plan,
    tasks,
    build,
    previewUrl
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

  const execRes = await runDockerStaticBuild({
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

  if ("error" in execRes) {
    PipelineStore.finish(runId, {
      status: "failed",
      version,
      plan: newPlan,
      tasks,
      build,
      error: execRes.error
    });
    return;
  }

  const previewPath = previewPathForRun(runId, version);
  fs.mkdirSync(previewPath, { recursive: true });
  fs.cpSync(execRes.outDirOnHost, previewPath, { recursive: true });

  PipelineStore.setPreview(runId, previewPath);

  const previewUrl = `/preview/${runId}/${version}/`;

  const base: PipelineResult = {
    status: "succeeded",
    version,
    plan: newPlan,
    tasks,
    build,
    previewUrl
  };

  const review = await reviewerAgent({ result: base, logs: PipelineStore.get(runId)?.logs ?? [], llm });
  PipelineStore.finish(runId, { ...base, review });

  // (MVP) previews accumulate; GC for finished runs will eventually drop store entries.
  // If you want aggressive cleanup, call rmPreview(runId) elsewhere.
}
