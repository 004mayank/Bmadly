# Bmadly runner image
# This image is responsible for executing BMAD inside an isolated container.
# It includes (a) mock runners for development and (b) a real BMAD installer + a
# minimal workflow driver (starting with quick-dev).

FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ca-certificates \
    git \
    curl \
  && rm -rf /var/lib/apt/lists/*

# BMAD Method docs recommend uv. On Debian (PEP 668), install it in a venv.
RUN python3 -m venv /opt/uv \
  && /opt/uv/bin/pip install --no-cache-dir -U pip \
  && /opt/uv/bin/pip install --no-cache-dir uv

ENV PATH="/opt/uv/bin:${PATH}"

# Install BMAD Method CLI (installer) so we can materialize _bmad/ inside /work.
RUN npm install -g bmad-method@6.3.0

COPY docker/runner /app/runner

# For live preview mode we run a Next.js dev server. Cache npm where possible.
RUN chmod +x /app/runner/*.sh || true

ENV BMAD_COMMAND="node /app/runner/real-bmad-quick-dev.js"

# Default: run long-lived runtime server for per-run containers.
# The host backend can override BMAD_COMMAND to run one-shot jobs.
ENV BMADLY_RUNTIME_PORT=8080

CMD ["bash", "-lc", "node /app/runner/bmadly-runtime-server.js"]
