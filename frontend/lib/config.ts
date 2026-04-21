export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o-mini", "gpt-4o"]
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-sonnet", "claude-3-5-haiku"]
  },
  {
    id: "gemini",
    label: "Gemini (optional)",
    models: ["gemini-1.5-flash", "gemini-1.5-pro"]
  }
] as const;
