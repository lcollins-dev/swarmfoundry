#!/bin/bash
set -e

# Runs the api integration suite against its own "swarmfoundry_int" database, recreated and
# migrated per run by the vitest global setup, in the same Postgres as the development
# database. The database has to already be running - see the dev-instance skill.
#
# CI can call vitest directly instead, exporting the same TYPEORM_* variables.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")"
INSTANCED_DIR="$API_DIR/../../resources/instanced"

source "$INSTANCED_DIR/env.sh"

# env.sh points at the development database, and process.env wins over test.env.
export NODE_ENV=test
export TYPEORM_DATABASE=swarmfoundry_int

# Restart recovery removes every sandbox of its namespace that its database does not know, so keep the suite's
# app off the development instance's sandboxes.
export SANDBOX_NAMESPACE="${SANDBOX_NAMESPACE}-int"

if ! timeout 2 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$TYPEORM_HOST" "$TYPEORM_PORT" 2>/dev/null; then
  echo "No Postgres reachable on ${TYPEORM_HOST}:${TYPEORM_PORT}." >&2

  if [[ "$DB_EXTERNAL" == 1 ]]; then
    echo "Check that the external database is running and TYPEORM_HOST and TYPEORM_PORT point at it." >&2
  else
    echo "Start the instance first: npm run instance:start" >&2
  fi

  exit 1
fi

cd "$API_DIR"

echo ""
echo "Running api integration suite against ${TYPEORM_DATABASE} on ${TYPEORM_HOST}:${TYPEORM_PORT}"
echo ""

INTEGRATION_SERIAL=0 npx vitest run --config vitest.integration.config.ts --passWithNoTests "$@"

# Serial specs own their app, so they get a second process-isolated pass.
INTEGRATION_SERIAL=1 npx vitest run --config vitest.integration.config.ts --passWithNoTests "$@"
