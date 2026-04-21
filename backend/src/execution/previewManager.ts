import { spawn } from "node:child_process";
import { allocatePort } from "./portAllocator.js";

export type PreviewHandle = {
  containerId?: string;
  hostPort: number;
  url: string;
  stop: () => Promise<void>;
};

export async function startPreviewContainer(params: {
  runId: string;
  version: number;
  image: string;
  onLog: (line: string) => void;
}): Promise<PreviewHandle> {
  const { runId, version, image, onLog } = params;

  const hostPort = await allocatePort();
  const name = `bmadly-preview-${runId}-${version}`;

  // NOTE: This is a "real" live preview container start. However, in this repo
  // the generation step currently produces static artifacts, not a runnable dev server.
  // We wire the preview manager so it can be enabled once the container image
  // actually contains a runnable app + command.
  const dockerArgs = [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `${hostPort}:3000`,
    image
  ];

  onLog(`[preview] starting container: docker ${dockerArgs.slice(0, 5).join(" ")} …`);

  const id = await new Promise<string>((resolve, reject) => {
    const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) return resolve(out.trim());
      return reject(new Error(err.trim() || `docker run exited with code ${code}`));
    });
    child.on("error", reject);
  });

  const url = `http://localhost:${hostPort}`;

  async function stop() {
    await new Promise<void>((resolve) => {
      const child = spawn("docker", ["stop", id], { stdio: "ignore" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  }

  return { containerId: id, hostPort, url, stop };
}

export async function waitForApp(params: {
  url: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const intervalMs = params.intervalMs ?? 1000;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(params.url, { method: "GET" });
      if (resp.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("Preview did not become ready before timeout");
}
