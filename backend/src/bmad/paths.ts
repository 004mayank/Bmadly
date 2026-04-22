import path from "node:path";

/**
 * Resolve paths to the vendored BMAD-METHOD submodule.
 *
 * Backend runs from Bmadly/backend, so we go up to repo root.
 */
export function getRepoRoot() {
  return path.resolve(process.cwd(), "..");
}

export function getBmadMethodRoot() {
  return path.join(getRepoRoot(), "bmad", "BMAD-METHOD");
}

export function getBmadSkillsRoot() {
  return path.join(getBmadMethodRoot(), "src");
}

