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
  previewReady?: boolean;
  artifacts?: {
    analysis?: { contentType: string; content: string };
    prd?: { contentType: string; content: string };
    plan?: { contentType: string; content: string };
    tasks?: { contentType: string; content: string };
    dev?: { contentType: string; content: string };
    review?: { contentType: string; content: string };

    // BMAD interactive chat artifacts (product brief, research, PRFAQ, etc.)
    bmad?: Array<{ id: string; type: string; title?: string; contentType: string; content: string; createdAt: number }>;
  };
  review?: {
    summary: string;
    suggestions: string[];
  };
  error?: string;
};
