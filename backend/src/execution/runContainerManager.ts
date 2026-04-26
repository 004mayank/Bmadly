import { spawn } from "node:child_process";
import net from "node:net";

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

export async function pickFreePortInRange(params: { start: number; end: number }): Promise<number> {
  const { start, end } = params;
  for (let port = start; port <= end; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", () => resolve(false));
      // Listen on all interfaces so the check matches Docker's bind behavior.
      // Using 127.0.0.1 can yield false positives when a port is bound on 0.0.0.0.
      srv.listen(port, "0.0.0.0", () => {
        srv.close(() => resolve(true));
      });
    });
    if (ok) return port;
  }
  throw new Error(`No free ports in range ${start}-${end}`);
}

/** Poll the container's /api/runtime/status until it returns 200 or timeout. */
export async function waitForContainerReady(params: {
  hostPort: number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const { hostPort, timeoutMs = 30_000, intervalMs = 500 } = params;
  const url = `http://127.0.0.1:${hostPort}/api/runtime/status`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), intervalMs);
      const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Runtime container on port ${hostPort} did not become ready within ${timeoutMs}ms`);
}

export async function stopRunContainer(runId: string): Promise<void> {
  const name = containerNameForRun(runId);
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["stop", name], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
