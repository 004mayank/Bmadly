import type { BuildArtifact, Plan, Task } from "../pipeline/types.js";
import type { LlmConfig } from "../llm/client.js";
import { llmJson } from "../llm/client.js";

export async function builderAgent(params: { plan: Plan; tasks: Task[]; llm?: LlmConfig }): Promise<BuildArtifact> {
  // Produce BMAD command + environment.
  // For now we drive the static Next.js generator runner in the container.
  // Swap to real BMAD by changing BMAD_COMMAND and the runner image.
  const command = process.env.BMAD_COMMAND || "node /app/runner/mock-bmad-static-nextjs.js";

  // Optional: let LLM rewrite/curate features into a tighter build plan.
  // Keep output JSON-only and small.
  let planForBuild = params.plan;
  if (params.llm) {
    try {
      const schemaHint = `{"features":["string"],"notes":["string"]}`;
      const refined = await llmJson<{ features: string[]; notes: string[] }>({
        config: params.llm,
        system: "You refine plans for implementation. Output ONLY JSON.",
        user: `Given this plan JSON:\n${JSON.stringify(params.plan)}\n\nAnd these tasks:\n${JSON.stringify(
          params.tasks
        )}\n\nReturn a refined features list (max 8) and implementation notes (max 6).`,
        schemaHint
      });
      planForBuild = {
        ...params.plan,
        features: Array.isArray(refined.features) ? refined.features.slice(0, 8) : params.plan.features,
        architecture: {
          notes: Array.isArray(refined.notes) ? refined.notes.slice(0, 6) : params.plan.architecture.notes
        }
      };
    } catch {
      // If LLM refinement fails, continue with original plan.
    }
  }

  return {
    bmad: {
      command,
      env: {
        BMAD_IDEA: planForBuild.idea,
        BMAD_PLAN_JSON: JSON.stringify(planForBuild)
      }
    }
  };
}
