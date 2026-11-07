# The payment mock's image (NFR-10). Build it from the repo root:
# docker build -f payments-mock/Dockerfile .
# Its migrations run from this image too: node dist/migrate-cli.js

ARG NODE_IMAGE=node:26.13.0-alpine3.24

# Compiles the TypeScript. Every workspace's package.json is copied so npm ci sees the whole
# lockfile, but only the mock's dependencies and the root's tools are installed.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/payments-mock --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY payments-mock/tsconfig.json payments-mock/tsconfig.build.json payments-mock/
COPY payments-mock/src payments-mock/src
RUN npm run build --workspace=@taquilla/payments-mock

# The production dependencies only.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/payments-mock --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PAYMENTS_PORT=4000
WORKDIR /app
COPY --from=deps /app /app
COPY payments-mock/migrations payments-mock/migrations
COPY --from=build /app/payments-mock/dist payments-mock/dist
WORKDIR /app/payments-mock
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PAYMENTS_PORT}/health`, { signal: AbortSignal.timeout(2500) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
