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
    label: "Gemini",
    // Use Gemini API model ids (v1beta models/<id>)
    models: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-flash", "gemini-1.5-pro"]
  }
] as const;

export const DEFAULT_PIPELINE_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet",
  gemini: "gemini-2.0-flash"
};
