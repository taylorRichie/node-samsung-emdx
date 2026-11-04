# syntax=docker/dockerfile:1

# ─── Frontend build ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS frontend

# onnxruntime-node would otherwise try to download CUDA binaries on linux/x64
ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    ONNXRUNTIME_NODE_INSTALL=skip \
    PORT=3001

# tzdata for the time zone set in the web UI — the display's wake timer is set
# from server-local time
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Root package backs lib/ and the CLI; web/providers.mjs also resolves
# fast-xml-parser from here
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY web/package.json web/package-lock.json web/
# onnxruntime-node ships binaries for every OS/arch; keep only this one (~180MB)
RUN cd web && npm ci --omit=dev && npm cache clean --force \
 && cd node_modules/onnxruntime-node/bin/napi-v6 \
 && find . -mindepth 2 -maxdepth 2 -type d ! -path "./linux/$(node -p process.arch)" -exec rm -rf {} +

COPY lib/ lib/
COPY bin/ bin/
COPY web/server.mjs web/providers.mjs web/depth.mjs web/eink.mjs web/
COPY --from=frontend /app/web/dist web/dist

# Writable state, owned by the unprivileged user so named volumes inherit it:
#   .displays        per-display config, queues, history, scenes
#   .gallery         artwork library (mounted read-only from the host)
#   .gallery-thumbs  thumbnail cache
#   transformers/.cache  Depth Anything model download
RUN mkdir -p web/.displays web/.gallery web/.gallery-thumbs \
             web/node_modules/@huggingface/transformers/.cache \
 && chown -R node:node web/.displays web/.gallery-thumbs \
             web/node_modules/@huggingface/transformers/.cache

USER node
WORKDIR /app/web
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/displays').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.mjs"]
