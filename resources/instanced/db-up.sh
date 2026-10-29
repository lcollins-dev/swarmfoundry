#!/bin/bash
set -e

source "$(dirname "$0")/env.sh"

MAX_WAIT=60
ELAPSED=0

# A database the environment provides as a service may still be starting.
if [[ "$DB_EXTERNAL" == 1 ]]; then
  echo "Waiting for external database on ${TYPEORM_HOST}:${TYPEORM_PORT}..."

  until timeout 2 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$TYPEORM_HOST" "$TYPEORM_PORT" 2>/dev/null; do
    if [[ $ELAPSED -ge $MAX_WAIT ]]; then
      echo "Timed out waiting for Postgres on ${TYPEORM_HOST}:${TYPEORM_PORT} after ${MAX_WAIT}s" >&2
      exit 1
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
  done

  echo "Database ready on ${TYPEORM_HOST}:${TYPEORM_PORT}"
  exit 0
fi

COMPOSE_FILE="$(dirname "$0")/db/docker-compose.yml"

echo "Starting database for instance ${INSTANCE} on port ${DB_PORT}..."

INSTANCE=$INSTANCE DB_PORT=$DB_PORT docker compose \
  -f "$COMPOSE_FILE" \
  -p "swarmfoundry-${INSTANCE}-db" \
  up -d

echo "Waiting for Postgres to be ready..."
until docker exec "swarmfoundry-${INSTANCE}-db" pg_isready -U postgres > /dev/null 2>&1; do
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "Timed out waiting for Postgres after ${MAX_WAIT}s" >&2
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

echo "Database ready on localhost:${DB_PORT}"
