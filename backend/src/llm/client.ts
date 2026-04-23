import type { Provider } from "../pipeline/types.js";

export type LlmConfig = {
  provider: Provider;
  model: string;
  apiKey: string;
};

function must<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

export async function llmJson<T>(params: {
  config: LlmConfig;
  system: string;
  user: string;
  schemaHint?: string;
}): Promise<T> {
  const { config, system, user, schemaHint } = params;

  // In-container runtime: if config.apiKey is empty, fall back to runtime auth store.
  // This enables a one-time /runtime/auth handshake.
  if ((!config.apiKey || config.apiKey.trim().length < 8) && process.env.PORT === "8080") {
    try {
      const mod = await import("../runtime/runtimeAuth.js");
      const a = mod.RuntimeAuthStore.get();
      if (a && a.apiKey) {
        (config as any).apiKey = a.apiKey;
      }
    } catch {
      // ignore
    }
  }
  if (config.provider === "openai") {
    return openaiJson<T>({ apiKey: config.apiKey, model: config.model, system, user, schemaHint });
  }
  if (config.provider === "anthropic") {
    return anthropicJson<T>({ apiKey: config.apiKey, model: config.model, system, user, schemaHint });
  }
  if (config.provider === "gemini") {
    return geminiJson<T>({ apiKey: config.apiKey, model: config.model, system, user, schemaHint });
  }
  throw new Error(`Unsupported provider: ${config.provider}`);
}

async function geminiJson<T>(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaHint?: string;
}): Promise<T> {
  const { apiKey, model, system, user, schemaHint } = params;

  // Gemini API (v1beta) generateContent.
  // We instruct strict JSON output and parse the returned text.
  const prompt = schemaHint ? `${user}\n\nJSON schema hint:\n${schemaHint}` : user;

  const body: any = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${system}\n\n${prompt}` }]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini error ${resp.status}: ${t.slice(0, 500)}`);
  }

  const json: any = await resp.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned empty output");
  const parsed = JSON.parse(text);
  return parsed as T;
}

async function openaiJson<T>(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaHint?: string;
}): Promise<T> {
  const { apiKey, model, system, user, schemaHint } = params;

  const body: any = {
    model,
    // Use responses API for modern OpenAI; request strict JSON output.
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      {
        role: "user",
        content: [{ type: "input_text", text: schemaHint ? `${user}\n\nJSON schema hint:\n${schemaHint}` : user }]
      }
    ],
    text: { format: { type: "json_object" } }
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${t.slice(0, 500)}`);
  }

  const json: any = await resp.json();
  // Responses API: try common fields.
  const text =
    json?.output_text ??
    json?.output?.map((o: any) => o?.content?.map((c: any) => c?.text).join(" ")).join("\n") ??
    "";
  const parsed = JSON.parse(must(text, "OpenAI returned empty output"));
  return parsed as T;
}

async function anthropicJson<T>(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaHint?: string;
}): Promise<T> {
  const { apiKey, model, system, user, schemaHint } = params;

  const prompt = schemaHint ? `${user}\n\nJSON schema hint:\n${schemaHint}` : user;

  const body: any = {
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: prompt }]
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Anthropic error ${resp.status}: ${t.slice(0, 500)}`);
  }

  const json: any = await resp.json();
  const text = json?.content?.map((c: any) => c?.text ?? "").join("") ?? "";
  // Anthropic may include leading/trailing prose; try best-effort JSON extraction.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Anthropic did not return JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  return parsed as T;
}
