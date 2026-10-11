#!/bin/sh
# Applies pending database migrations, then starts the API.
# Migrations are idempotent and safe to run on every start (single instance).
set -e

echo "Applying database migrations..."
node node_modules/prisma/build/index.js migrate deploy

echo "Starting API..."
exec "$@"
