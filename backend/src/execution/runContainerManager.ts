import { spawn } from "node:child_process";

export type RunContainerConfig = {
  runId: string;
  image: string;
  hostPort: number;
  runtimePort: number;
  workDirHost: string;
};

export function containerNameForRun(runId: string) {
  return `bmadly-run-${runId}`;
}

export async function startRunContainer(cfg: RunContainerConfig): Promise<void> {
  const name = containerNameForRun(cfg.runId);

  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `${cfg.hostPort}:${cfg.runtimePort}`,
    "-v",
    `${cfg.workDirHost}:/work`,
    "-e",
    `BMADLY_RUNTIME_PORT=${cfg.runtimePort}`,
    cfg.image
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(err.trim() || `docker run failed (${code})`));
    });
    child.on("error", (e) => reject(e));
  });
}

export async function stopRunContainer(runId: string): Promise<void> {
  const name = containerNameForRun(runId);
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["stop", name], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

