import type { Plan } from "../pipeline/types.js";
import type { LlmConfig } from "../llm/client.js";
import { llmJson } from "../llm/client.js";

export async function plannerAgent(params: { idea: string; llm?: LlmConfig }): Promise<Plan> {
  const cleaned = params.idea.trim();

  if (!params.llm) {
    // Fallback deterministic plan if LLM isn't configured.
    return {
      idea: cleaned,
      features: [
        "Landing page that explains the product",
        "Primary call-to-action",
        "Simple form to collect user input",
        "Result view with clear next steps"
      ],
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

  const schemaHint = `{
  "idea": "string",
  "features": ["string"],
  "techStack": { "frontend": "string", "backend": "string", "execution": "string" },
  "architecture": { "notes": ["string"] }
}`;

  return llmJson<Plan>({
    config: params.llm,
    system:
      "You are a product planner. Output ONLY valid JSON. No markdown, no prose. Keep it concise and implementable.",
    user: `Product idea:\n${cleaned}\n\nCreate a structured product plan for an MVP.`,
    schemaHint
  });
}
