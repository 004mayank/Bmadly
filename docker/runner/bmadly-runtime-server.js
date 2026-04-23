#!/usr/bin/env node

// Bmadly runtime server (MVP)
//
// This runs INSIDE the long-lived per-run container.
// It exposes a tiny HTTP API so the host backend can proxy:
// - chat start/select-skill/message
// - run/pipeline commands (future)
//
// For MVP we implement /health and a very small /chat/echo endpoint.
// We'll extend this to run BMAD skills in-container.

const http = require("node:http");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

const port = Number(process.env.BMADLY_RUNTIME_PORT || "8080");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "bmadly-runtime", pid: process.pid }));
      return;
    }

    if (req.method === "POST" && req.url === "/chat/echo") {
      const j = await readJson(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, received: j }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
});

server.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[runtime] listening on http://0.0.0.0:${port}`);
});

