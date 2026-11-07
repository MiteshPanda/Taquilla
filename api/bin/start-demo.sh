#!/bin/sh
# The hosted demo's start (WP 8.4), as render.yaml runs it: sh bin/start-demo.sh
# Render passes its start command on without a shell, splitting it on spaces, so a quoted
# `sh -c "… && …"` arrives in pieces. A script keeps the steps in one place instead.
set -eu

# Cheap once done: both only act on a new or empty database.
node dist/migrate-cli.js
node dist/seed-cli.js

# exec makes Node the container's main process, so Render's SIGTERM reaches it.
exec node --enable-source-maps dist/server.js
