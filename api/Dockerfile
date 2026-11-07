# The API's image (NFR-10). Build it from the repo root: docker build -f api/Dockerfile .
# The sweeper, the migrations and the seed run from this image too, each with its own command.

ARG NODE_IMAGE=node:26.13.0-alpine3.24

# Compiles the TypeScript. Every workspace's package.json is copied so npm ci sees the whole
# lockfile, but only the API's dependencies and the root's tools are installed.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/api --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY api/tsconfig.json api/tsconfig.build.json api/
COPY api/src api/src
RUN npm run build --workspace=@taquilla/api

# The production dependencies only: no TypeScript, test tools or type packages.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/api --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# node_modules sits at the root and in api/, where npm put a version another package doesn't share.
COPY --from=deps /app /app
COPY api/migrations api/migrations
COPY --from=build /app/api/dist api/dist
WORKDIR /app/api
# The node image's own unprivileged user. The files stay root's, so the process can't change them.
USER node
EXPOSE 3000
# Ready means the API can reach the database, which is what the services that wait for it need.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/ready`, { signal: AbortSignal.timeout(2500) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
