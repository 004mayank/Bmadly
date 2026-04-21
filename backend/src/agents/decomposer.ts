import type { Plan, Task } from "../pipeline/types.js";

export async function decomposerAgent(plan: Plan): Promise<Task[]> {
  const base: Task[] = [
    { id: "fe-1", area: "frontend", title: "Generate static Next.js app shell" },
    { id: "fe-2", area: "frontend", title: "Render idea + feature list" },
    { id: "infra-1", area: "infra", title: "Export static site to /work/out" }
  ];

  // Tiny customization so plans feel responsive to input.
  if (plan.idea.toLowerCase().includes("dashboard")) {
    base.push({ id: "fe-3", area: "frontend", title: "Add simple dashboard-like sections" });
  }

  return base;
}
