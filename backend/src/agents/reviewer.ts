import type { PipelineResult } from "../pipeline/types.js";
import type { LlmConfig } from "../llm/client.js";
import { llmJson } from "../llm/client.js";

export async function reviewerAgent(params: { result: PipelineResult; logs: string[]; llm?: LlmConfig }) {
  if (!params.llm) {
    const suggestions: string[] = [];

    if (params.result.previewUrl) {
      suggestions.push("Add clearer typography and spacing to the generated landing page");
      suggestions.push("Include a short FAQ section to explain what the product does");
    }

    const hasErrors = params.logs.some((l) => /\b(error|failed|fatal)\b/i.test(l));
    if (hasErrors) suggestions.unshift("Fix the errors shown in logs before iterating further");

    return {
      summary: "MVP review (heuristic).",
      suggestions
    };
  }

  const schemaHint = `{"summary":"string","suggestions":["string"]}`;
  return llmJson<{ summary: string; suggestions: string[] }>({
    config: params.llm,
    system:
      "You are a senior engineer reviewing an agent-generated product build. Output ONLY JSON. Keep it short and actionable.",
    user: `Result JSON:\n${JSON.stringify(params.result)}\n\nRecent logs (last 120 lines):\n${params.logs
      .slice(-120)
      .join("\n")}\n\nProvide a brief review and next improvements.`,
    schemaHint
  });
}
