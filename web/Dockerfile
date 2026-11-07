# check=skip=SecretsUsedInArgOrEnv;error=true
# The web page's image (NFR-10): the static build, served by nginx as an unprivileged user.
# Build it from the repo root: docker build -f web/Dockerfile .
#
# Vite bakes VITE_API_URL and VITE_DEMO_PASSWORD into the page, so they're build arguments and a
# change needs a rebuild. The demo password isn't a secret: it ends up in the page for anyone to
# read, by design. That's why the check that flags build arguments named like passwords is off.
#
# Any warning from Docker's build checks fails the build (the check line above). Each FROM names
# its base image in full, so Dependabot can keep them up to date.

FROM node:26.13.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY api/package.json api/
COPY payments-mock/package.json payments-mock/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@taquilla/web --include-workspace-root --ignore-scripts --no-audit --no-fund
# The page's forms share the API's sign-up and login rules (WP 7.2).
COPY api/src/auth/rules.ts api/src/auth/
COPY web web
ARG VITE_API_URL=http://localhost:3000
ARG VITE_DEMO_PASSWORD=taquilla-dev
# The build checks VITE_API_URL and stops on any warning, as on the host.
RUN npm run build --workspace=@taquilla/web
# The page may only call its own origin and the API's, so the policy names the API's origin.
RUN api_origin="$(node -p 'new URL(process.env.VITE_API_URL).origin')" \
    && sed "s|__API_ORIGIN__|${api_origin}|" web/nginx.conf > /tmp/default.conf

FROM nginxinc/nginx-unprivileged:1.31.7-alpine
COPY --from=build /tmp/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
