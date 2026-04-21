import express from "express";
import cors from "cors";
import { runsRouter } from "./routes/runs.js";

const PORT = Number(process.env.PORT || 4000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "bmadly-backend" });
});

app.use("/api", runsRouter);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[bmadly] backend listening on http://localhost:${PORT}`);
});
