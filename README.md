# Bmadly (MVP)

Run BMAD workflows in your browser — no CLI, no IDE.

Bmadly is a local-first MVP that proves the core value proposition:

> **Run BMAD from a web UI with optional bring-your-own-LLM-key (BYOK) support.**

This repo contains:
- **Frontend**: Next.js + React + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Execution**: Docker runner image (isolated per run)
- **Realtime logs**: Server-Sent Events (SSE)

## MVP Features
- Single-page UI
  - Provider + model selection
  - BYOK toggle + API key input
  - Run button
  - Real-time log streaming
  - Final output viewer
- Backend API
  - `POST /api/run` start a run
  - `GET /api/run/:runId/stream` stream logs/events (SSE)
  - `GET /api/run/:runId/result` fetch final output
- Docker-isolated execution per run
- Safe key handling basics
  - Managed keys stay on backend (env vars)
  - BYOK key used in-memory for that run only
  - API keys are masked in backend logs

## Agent pipeline (MVP)

This repo also includes a **local-first agent pipeline** that runs a multi-step flow:

Idea → planner/decomposer/builder → Docker execution → static preview → reviewer → iterate

The pipeline uses the same managed/BYOK key rules and streams logs via SSE.

### Pipeline API
- `POST /api/pipeline/run`
- `GET /api/pipeline/run/:runId/stream` (SSE)
- `GET /api/pipeline/run/:runId/result`
- `POST /api/pipeline/iterate`

### Preview (live)
Pipeline runs start a **live Next.js dev server inside Docker** and expose it via dynamic port mapping.

- The backend allocates a free host port (default range: **4000–9000**)
- The container binds to **0.0.0.0:3000** and is published as `http://localhost:<hostPort>`
- The UI renders this URL in an iframe

The backend waits up to ~30s for the preview to become reachable before marking it ready.

Preview containers are automatically cleaned up after ~10 minutes.

## Managed mode vs BYOK mode

### Managed mode
- User leaves **“Use my own API key”** OFF.
- Backend uses environment variables:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`

### BYOK mode
- User turns **“Use my own API key”** ON.
- User selects provider + model and enters an API key.
- Backend uses the provided key **only for that run** (not persisted).

## Local setup

### Prereqs
- Node.js 20+
- Docker Desktop (or docker daemon)

### 1) Configure env
Copy:
```bash
cp .env.example .env
```

Set at least one managed key (optional if you only test BYOK):
- `OPENAI_API_KEY=...`
- `ANTHROPIC_API_KEY=...`

### 2) Install deps
```bash
npm install
npm --prefix backend install
npm --prefix frontend install
```

### 3) Build the runner image
```bash
docker build -t bmadly-runner:local .
```

### 4) Start dev servers
```bash
npm run dev
```

Open:
- Frontend: http://localhost:3000
- Backend health: http://localhost:4000/health

## How Docker execution works (MVP)
- Backend starts a run and launches an ephemeral container:
  - `docker run --rm ... bmadly-runner:local`
- Provider/model/key are passed as environment variables.
- Container prints logs to stdout/stderr.
- Backend captures logs and streams them to the browser via SSE.
- Container prints the final output as a JSON line prefixed with:
  - `[output] {...}`

### Runner notes
The runner image is `bmadly-runner:local` (built from `./Dockerfile`).

This repo contains mock runners to keep the platform runnable even before real BMAD wiring:

- `docker/runner/mock-bmad.js` — basic mock (logs + JSON output)
- `docker/runner/mock-bmad-static-nextjs.js` — generates a real static Next.js export (useful for early preview experiments)
- `docker/runner/live-nextjs.sh` — starts a Next.js dev server for **live preview**

Swap to real BMAD later by changing `.env`:
```bash
BMAD_COMMAND=npx bmad run
```
…and updating the Dockerfile to install BMAD dependencies.

## Live preview execution flow

For each pipeline run:

1) **Generation container** (one-shot)
   - mounts `./.bmadly-live/<runId>/<version>/app` → `/work/app`
   - runs `BMAD_COMMAND` and expects it to write a runnable Next.js app into `/work/app`

2) **Preview container** (long-running)
   - mounts the same `/work/app`
   - runs `npx next dev --hostname 0.0.0.0 --port 3000`
   - published to a dynamic host port (e.g. `http://localhost:4123`)

If your real BMAD writes output elsewhere, update the generator step to emit into `/work/app`.

## Known limitations (MVP)
- In-memory run storage (lost on backend restart)
- No auth / no multi-user
- Not hardened for untrusted code execution
- Mock BMAD runner by default

## Future roadmap (not in MVP)
- Real BMAD runtime baked into runner image
- Persistent run history
- Auth + multi-user
- More workflows + input forms
- Kubernetes execution backend
- Cost controls and quotas

---

MIT
