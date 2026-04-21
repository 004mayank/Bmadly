import fs from "node:fs";
import path from "node:path";

export function ensurePreviewRoot() {
  const root = path.join(process.cwd(), ".bmadly-previews");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function previewPathForRun(runId: string, version: number) {
  const root = ensurePreviewRoot();
  return path.join(root, runId, String(version));
}

export function rmPreview(runId: string) {
  const root = ensurePreviewRoot();
  const p = path.join(root, runId);
  fs.rmSync(p, { recursive: true, force: true });
}
