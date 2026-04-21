import type { PipelineResult } from "../pipeline/types.js";

export async function reviewerAgent(params: { result: PipelineResult; logs: string[] }) {
  const suggestions: string[] = [];

  if (params.result.previewUrl) {
    suggestions.push("Add clearer typography and spacing to the generated landing page");
    suggestions.push("Include a short FAQ section to explain what the product does");
  }

  const hasErrors = params.logs.some((l) => /\b(error|failed|fatal)\b/i.test(l));
  if (hasErrors) suggestions.unshift("Fix the errors shown in logs before iterating further");

  return {
    summary: "MVP review (heuristic). Swap to LLM-backed review later.",
    suggestions
  };
}
