export type Provider = "openai" | "anthropic" | "gemini";

export type PipelineStatus = "queued" | "running" | "succeeded" | "failed";

export type PipelineConfig = {
  provider: Provider;
  model: string;
  useOwnKey: boolean;
  apiKey?: string;
};

export type Plan = {
  idea: string;
  features: string[];
  techStack: {
    frontend: string;
    backend: string;
    execution: string;
  };
  architecture: {
    notes: string[];
  };
};

export type Task = { id: string; area: "frontend" | "backend" | "infra"; title: string };

export type BuildArtifact = {
  bmad: {
    command: string;
    env: Record<string, string>;
  };
};

export type PipelineResult = {
  status: PipelineStatus;
  version: number;
  plan: Plan;
  tasks: Task[];
  build: BuildArtifact;
  previewUrl?: string;
  review?: {
    summary: string;
    suggestions: string[];
  };
  error?: string;
};
