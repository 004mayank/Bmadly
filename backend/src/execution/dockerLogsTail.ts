import { spawn } from "node:child_process";
import { RunsStore } from "../store/runsStore.js";

export function tailContainerLogs(params: { runId: string; containerName: string }) {
  const { runId, containerName } = params;
  const child = spawn("docker", ["logs", "-f", "--since", "0s", containerName], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });

  const onData = (buf: Buffer) => {
    const lines = buf
      .toString("utf8")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean);
    for (const line of lines) {
      RunsStore.appendLog(runId, `[runtime] ${line}`);
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("close", (code) => {
    RunsStore.appendLog(runId, `[runtime] log tail ended (code=${code ?? "?"})`);
  });

  child.on("error", (err) => {
    RunsStore.appendLog(runId, `[runtime] log tail error: ${String(err?.message || err)}`);
  });

  return child;
}

