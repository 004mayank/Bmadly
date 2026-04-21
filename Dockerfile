# Bmadly runner image
# This image is responsible for executing BMAD inside an isolated container.
# For MVP, it ships a mock runner that simulates realistic BMAD logs + output.

FROM node:20-slim

WORKDIR /app

# (Future) Install BMAD dependencies here. For now, we only need a runner script.
COPY docker/runner /app/runner

ENV BMAD_COMMAND="node /app/runner/mock-bmad.js"

CMD ["bash", "-lc", "$BMAD_COMMAND"]
