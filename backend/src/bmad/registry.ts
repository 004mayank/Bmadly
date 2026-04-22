import fs from "node:fs";
import path from "node:path";

export type BmadSkill = {
  id: string; // directory basename
  absDir: string;
  relDir: string;
  name?: string;
  description?: string;
  rawFrontmatter?: string;
};

function parseFrontmatter(md: string): { fm: Record<string, string>; raw: string } {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { fm: {}, raw: "" };
  let i = 1;
  const fmLines: string[] = [];
  while (i < lines.length && lines[i]?.trim() !== "---") {
    fmLines.push(lines[i]);
    i++;
  }
  const fm: Record<string, string> = {};
  for (const l of fmLines) {
    const m = l.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    fm[m[1]] = m[2];
  }
  return { fm, raw: fmLines.join("\n") };
}

function walkDirs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      out.push(p);
      stack.push(p);
    }
  }
  return out;
}

export function loadBmadSkills(params: { skillsRoot: string; repoRoot: string }): BmadSkill[] {
  const { skillsRoot, repoRoot } = params;
  const dirs = [skillsRoot, ...walkDirs(skillsRoot)];

  const skills: BmadSkill[] = [];
  for (const d of dirs) {
    const skillPath = path.join(d, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const md = fs.readFileSync(skillPath, "utf8");
    const { fm, raw } = parseFrontmatter(md);
    const id = path.basename(d);
    skills.push({
      id,
      absDir: d,
      relDir: path.relative(repoRoot, d),
      name: fm.name,
      description: fm.description,
      rawFrontmatter: raw
    });
  }

  // stable ordering
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

