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

### Preview
Pipeline runs produce a **static Next.js export** that is served locally from:

- `GET /preview/:runId/:version/`

In the UI, this shows up as an iframe preview.

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

### Mock BMAD runner
Right now, the runner is a realistic mock at:
- `docker/runner/mock-bmad.js`

For the pipeline static preview, the runner is:
- `docker/runner/mock-bmad-static-nextjs.js`

Swap to real BMAD later by changing `.env`:
```bash
BMAD_COMMAND=npx bmad run
```
…and updating the Dockerfile to install BMAD dependencies.

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
