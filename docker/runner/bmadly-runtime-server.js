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
const fs = require("node:fs");
const path = require("node:path");

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

    // ---- BMAD chat endpoints (container-local) ----
    // MVP contract: persist a single session.json for the run under /work.
    const workDir = process.env.BMADLY_WORKDIR || "/work";
    const sessionPath = path.join(workDir, "bmad-session.json");

    const loadSession = () => {
      if (!fs.existsSync(sessionPath)) {
        return {
          id: "session",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          agentSkillId: null,
          activeSkillId: null,
          step: null,
          artifacts: [],
          messages: []
        };
      }
      try {
        return JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      } catch {
        return {
          id: "session",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          agentSkillId: null,
          activeSkillId: null,
          step: null,
          artifacts: [],
          messages: []
        };
      }
    };

    const saveSession = (s) => {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      s.updatedAt = Date.now();
      fs.writeFileSync(sessionPath, JSON.stringify(s, null, 2));
    };

    if (req.method === "POST" && req.url === "/bmad/sessions/start") {
      const j = await readJson(req);
      const s = loadSession();
      s.agentSkillId = j.agentSkillId || s.agentSkillId;
      s.messages.push({ role: "assistant", text: `Started agent ${s.agentSkillId || "(unknown)"} (container runtime MVP).`, ts: Date.now() });
      saveSession(s);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, session: s, menu: [] }));
      return;
    }

    if (req.method === "POST" && req.url === "/bmad/sessions/select-skill") {
      const j = await readJson(req);
      const s = loadSession();
      s.activeSkillId = j.skillId || null;
      s.step = { kind: "chat", index: 0 };
      s.messages.push({ role: "assistant", text: `Selected skill ${s.activeSkillId}. (container runtime MVP)`, ts: Date.now() });
      saveSession(s);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, session: s }));
      return;
    }

    if (req.method === "POST" && req.url === "/bmad/sessions/message") {
      const j = await readJson(req);
      const s = loadSession();
      const msg = String(j.message || "");
      s.messages.push({ role: "user", text: msg, ts: Date.now() });
      // MVP: echo back. Next: run real BMAD method inside container.
      s.messages.push({ role: "assistant", text: `Echo (container runtime): ${msg}`, ts: Date.now() });
      saveSession(s);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, text: `Echo (container runtime): ${msg}`, session: s }));
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
