# Bmadly multi-target image
#
# Targets:
# - runtime: runs the BMADly backend (Express) inside the container on :8080
# - runner: one-shot runner image (kept for now)

############################
# runtime: backend-in-container
############################
FROM node:20-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    # Playwright/Chromium deps (minimal set for Debian slim)
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libgtk-3-0 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# Copy only backend + root package manifests needed for build.
COPY backend /app/backend

WORKDIR /app/backend
RUN npm install
RUN npm run build

# Install Playwright browsers in the image (so /api/export/pdf works in-container).
RUN npx -y playwright install --with-deps chromium

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]

############################
# runner: one-shot runner (legacy)
############################
FROM node:20-slim AS runner

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

RUN chmod +x /app/runner/*.sh || true

ENV BMAD_COMMAND="node /app/runner/real-bmad-quick-dev.js"

CMD ["bash", "-lc", "$BMAD_COMMAND"]
