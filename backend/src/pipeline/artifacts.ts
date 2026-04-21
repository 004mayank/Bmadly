export type Artifact = {
  name: string;
  contentType: "text/markdown" | "application/json" | "text/plain";
  content: string;
};

export type ArtifactsBundle = {
  analysis?: Artifact;
  prd?: Artifact;
  plan?: Artifact;
  tasks?: Artifact;
  dev?: Artifact;
  review?: Artifact;
};
