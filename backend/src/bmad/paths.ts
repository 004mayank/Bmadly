import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

export function getRepoRoot() {
  return path.resolve(process.cwd(), "..");
}

export function getBmadMethodRoot() {
  // First try the git submodule (local dev)
  const submodulePath = path.join(getRepoRoot(), "bmad", "BMAD-METHOD");
  if (fs.existsSync(path.join(submodulePath, "src"))) return submodulePath;

  // Fall back to the bmad-method npm package (container / no submodule)
  try {
    const pkgMain = _require.resolve("bmad-method/package.json");
    return path.dirname(pkgMain);
  } catch {
    return submodulePath; // let the caller fail with a clear path
  }
}

export function getBmadSkillsRoot() {
  return path.join(getBmadMethodRoot(), "src");
}
