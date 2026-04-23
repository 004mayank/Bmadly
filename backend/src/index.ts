import cors from "cors";
import { runsRouter } from "./routes/runs.js";
import { pipelineRouter } from "./routes/pipeline.js";
import { bmadRouter } from "./routes/bmad.js";
import { runtimeRouter } from "./routes/runtime.js";
import { runtimeHostRouter } from "./routes/runtimeHost.js";
import express from "express";

const PORT = Number(process.env.PORT || 4000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Basic error boundary for malformed JSON bodies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  return next(err);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "bmadly-backend" });
});

app.use("/api", runsRouter);
app.use("/api", pipelineRouter);
app.use("/api", bmadRouter);
app.use("/api", runtimeRouter);
app.use("/api", runtimeHostRouter);

// Serve static previews (local-only MVP)
app.use("/preview", express.static(".bmadly-previews"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("[bmadly] unhandled error", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[bmadly] backend listening on http://localhost:${PORT}`);
});
