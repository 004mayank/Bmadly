import type { LlmConfig } from "../llm/client.js";

export async function productManagerAgent(params: { analysisMd: string; llm: LlmConfig }) {
  const { llm, analysisMd } = params;

  const system =
    "You are a product manager. Write a crisp PRD in Markdown (no code fences). Include: Overview, Goals/Non-goals, User stories, Requirements, UX notes, Milestones, Out of scope.";

  const user = `Analysis doc:\n\n${analysisMd}`;

  const resp = await fetch(
    llm.provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers:
        llm.provider === "openai"
          ? { Authorization: `Bearer ${llm.apiKey}`, "Content-Type": "application/json" }
          : {
              "x-api-key": llm.apiKey,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            },
      body:
        llm.provider === "openai"
          ? JSON.stringify({
              model: llm.model,
              input: [
                { role: "system", content: [{ type: "text", text: system }] },
                { role: "user", content: [{ type: "text", text: user }] }
              ]
            })
          : JSON.stringify({
              model: llm.model,
              max_tokens: 1800,
              system,
              messages: [{ role: "user", content: user }]
            })
    }
  );

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`PM agent failed (${llm.provider}) ${resp.status}: ${t.slice(0, 300)}`);
  }

  const json: any = await resp.json();
  const text =
    llm.provider === "openai"
      ? (json?.output_text ?? "")
      : (json?.content?.map((c: any) => c?.text ?? "").join("") ?? "");

  return text.trim();
}
