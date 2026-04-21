import type { BuildArtifact, Plan, Task } from "../pipeline/types.js";

export async function builderAgent(params: { plan: Plan; tasks: Task[] }): Promise<BuildArtifact> {
  // MVP: produce BMAD command/env. For now we drive the mock static generator.
  // Swap to real BMAD by changing BMAD_COMMAND in environment or here.
  const command = process.env.BMAD_COMMAND || "node /app/runner/mock-bmad-static-nextjs.js";

  return {
    bmad: {
      command,
      env: {
        BMAD_IDEA: params.plan.idea,
        BMAD_PLAN_JSON: JSON.stringify(params.plan)
      }
    }
  };
}
