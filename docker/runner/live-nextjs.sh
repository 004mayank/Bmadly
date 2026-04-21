#!/usr/bin/env bash
set -euo pipefail

# Runs a Next.js dev server for live preview.
# Assumptions:
# - /work/app contains a Next.js project
# - We bind to 0.0.0.0 so Docker port mapping works
# - We force port 3000

cd /work/app

echo "[live] installing deps…"
npm install

echo "[live] starting next dev on 0.0.0.0:3000…"
# next dev supports --hostname and --port
npx next dev --hostname 0.0.0.0 --port 3000
