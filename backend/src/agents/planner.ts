import type { Plan } from "../pipeline/types.js";

export async function plannerAgent(idea: string): Promise<Plan> {
  // MVP: deterministic structured plan (swap with real LLM later).
  // Keep output stable and machine-usable.
  const cleaned = idea.trim();
  const features = [
    "Landing page that explains the product",
    "Primary call-to-action",
    "Simple form to collect user input",
    "Result view with clear next steps"
  ];

  return {
    idea: cleaned,
    features,
    techStack: {
      frontend: "Next.js (static export)",
      backend: "Node.js API (Bmadly backend)",
      execution: "Docker (BMAD command)"
    },
    architecture: {
      notes: [
        "Generate a static Next.js export for preview to avoid port mapping in MVP",
        "Stream logs via SSE",
        "Keep iteration patch-scoped to UI/content changes"
      ]
    }
  };
}
