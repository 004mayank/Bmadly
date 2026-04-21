import type { Plan } from "../pipeline/types.js";

export type IterationIntent = "improve_ui" | "fix_bugs" | "add_feature";

export async function iterationAgent(params: { intent: IterationIntent; plan: Plan; note?: string }) {
  // MVP: iteration returns a new plan with small scoped adjustments.
  // Real implementation would produce file patches.
  const plan = { ...params.plan };

  if (params.intent === "add_feature") {
    plan.features = [...plan.features, params.note?.trim() || "New feature (requested)"].filter(Boolean);
  }

  if (params.intent === "improve_ui") {
    plan.architecture = {
      ...plan.architecture,
      notes: [...(plan.architecture?.notes || []), "Improve UI polish and section hierarchy"]
    };
  }

  if (params.intent === "fix_bugs") {
    plan.architecture = {
      ...plan.architecture,
      notes: [...(plan.architecture?.notes || []), "Address errors found during build"]
    };
  }

  return plan;
}
