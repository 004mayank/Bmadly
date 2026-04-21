import net from "node:net";

export async function allocatePort(range: { start: number; end: number } = { start: 4000, end: 9000 }) {
  for (let port = range.start; port <= range.end; port++) {
    const ok = await isFree(port);
    if (ok) return port;
  }
  throw new Error(`No free ports in range ${range.start}-${range.end}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}
