#!/bin/sh
# Applies pending migrations before the backend starts (RUN_MIGRATIONS=true,
# the default). Migrations are additive and idempotent, so every replica may
# run this: the second one finds nothing to do. Set RUN_MIGRATIONS=false when
# a separate release step runs `node packages/backend/dist/migrate.js`.
set -e
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node packages/backend/dist/migrate.js
fi
exec "$@"
