import type { LlmConfig } from "../llm/client.js";

export async function analystAgent(params: { idea: string; llm: LlmConfig }) {
  const { llm, idea } = params;

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
                {
                  role: "system",
                  content: [
                    {
                      type: "text",
                      text:
                        "You are an expert analyst. Produce a concise analysis document in Markdown. No code fences. Include: Problem, Target users, Key constraints, Risks, Success metrics, Open questions."
                    }
                  ]
                },
                {
                  role: "user",
                  content: [{ type: "text", text: `Product idea:\n${idea}` }]
                }
              ]
            })
          : JSON.stringify({
              model: llm.model,
              max_tokens: 1600,
              system:
                "You are an expert analyst. Produce a concise analysis document in Markdown. No code fences. Include: Problem, Target users, Key constraints, Risks, Success metrics, Open questions.",
              messages: [{ role: "user", content: `Product idea:\n${idea}` }]
            })
    }
  );

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Analyst agent failed (${llm.provider}) ${resp.status}: ${t.slice(0, 300)}`);
  }

  const json: any = await resp.json();
  const text =
    llm.provider === "openai"
      ? (json?.output_text ?? "")
      : (json?.content?.map((c: any) => c?.text ?? "").join("") ?? "");

  return text.trim();
}
