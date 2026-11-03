# syntax=docker/dockerfile:1
# Official Node 24 LTS images support linux/arm64 and linux/amd64.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Optional managed-cloud CA mount; TLS and package integrity checks remain enabled.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca GIT_SSL_CAINFO=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ARG OCC_UID=1000
ARG OCC_GID=1000
ENV NODE_ENV=production OCC_HOST=0.0.0.0 OCC_PORT=3000 OCC_DB_PATH=/app/data/occ.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dashboard/dist ./dashboard/dist
COPY --from=build --chown=node:node /app/docs ./docs
COPY --chown=node:node package.json ./
RUN test "$OCC_UID" -gt 0 && test "$OCC_GID" -gt 0 && mkdir -p /app/data /app/sessions/whatsapp && chmod 700 /app/data /app/sessions/whatsapp && chown -R "$OCC_UID:$OCC_GID" /app/data /app/sessions
USER ${OCC_UID}:${OCC_GID}
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000'+(process.env.OCC_BASE_PATH||'/sys')+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
