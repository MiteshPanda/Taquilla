# check=error=true
# The API's image (NFR-10). Build it from the repo root: docker build -f api/Dockerfile .
# The sweeper, the migrations and the seed run from this image too, each with its own command.
# It also carries the payment mock's compiled code, for a host that runs the mock inside the API's
# process (PAYMENTS_IN_PROCESS, WP 8.4).
#
# Any warning from Docker's build checks fails the build (the check line above). Each FROM names
# its base image in full, so Dependabot can keep them up to date.

# Compiles the TypeScript. Every workspace's package.json is copied so npm ci sees the whole
# lockfile, but only the API's and the mock's dependencies and the root's tools are installed.
FROM node:26.13.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/api --workspace=@taquilla/payments-mock --include-workspace-root         --ignore-scripts --no-audit --no-fund
COPY api/tsconfig.json api/tsconfig.build.json api/
COPY api/src api/src
COPY payments-mock/tsconfig.json payments-mock/tsconfig.build.json payments-mock/
COPY payments-mock/src payments-mock/src
RUN npm run build --workspace=@taquilla/api --workspace=@taquilla/payments-mock

# The production dependencies only: no TypeScript, test tools or type packages.
FROM node:26.13.0-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/api --workspace=@taquilla/payments-mock --omit=dev         --ignore-scripts --no-audit --no-fund

FROM node:26.13.0-alpine3.24
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# node_modules sits at the root and in api/, where npm put a version another package doesn't share.
COPY --from=deps /app /app
COPY api/migrations api/migrations
COPY --from=build /app/api/dist api/dist
COPY payments-mock/migrations payments-mock/migrations
COPY --from=build /app/payments-mock/dist payments-mock/dist
WORKDIR /app/api
# The node image's own unprivileged user. The files stay root's, so the process can't change them.
USER node
EXPOSE 3000
# Ready means the API can reach the database, which is what the services that wait for it need.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/ready`, { signal: AbortSignal.timeout(2500) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
