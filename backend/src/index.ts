import express from "express";
import cors from "cors";
import { runsRouter } from "./routes/runs.js";

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
