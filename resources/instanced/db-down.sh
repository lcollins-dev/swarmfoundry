#!/bin/bash
set -e

source "$(dirname "$0")/env.sh"

if [[ "$DB_EXTERNAL" == 1 ]]; then
  echo "Leaving external database on ${TYPEORM_HOST}:${TYPEORM_PORT} running."
  exit 0
fi

COMPOSE_FILE="$(dirname "$0")/db/docker-compose.yml"

echo "Stopping database for instance ${INSTANCE}..."

INSTANCE=$INSTANCE DB_PORT=$DB_PORT docker compose \
  -f "$COMPOSE_FILE" \
  -p "swarmfoundry-${INSTANCE}-db" \
  down

echo "Done."
