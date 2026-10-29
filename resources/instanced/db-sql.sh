#!/bin/bash
set -e

source "$(dirname "$0")/env.sh"

if [[ "$DB_EXTERNAL" == 1 ]]; then
  export PGHOST=$TYPEORM_HOST
  export PGPORT=$TYPEORM_PORT
  export PGUSER=$TYPEORM_USERNAME
  export PGPASSWORD=$TYPEORM_PASSWORD
  export PGDATABASE=$TYPEORM_DATABASE

  if [[ $# -eq 0 ]]; then
    echo "Opening psql shell for instance ${INSTANCE} (${TYPEORM_DATABASE} on ${TYPEORM_HOST}:${TYPEORM_PORT})..."
  fi

  exec psql "$@"
fi

CONTAINER="swarmfoundry-${INSTANCE}-db"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "error: database container ${CONTAINER} is not running" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Opening psql shell for instance ${INSTANCE} (${TYPEORM_DATABASE} on localhost:${TYPEORM_PORT})..."
  exec docker exec -it "$CONTAINER" psql -U "$TYPEORM_USERNAME" -d "$TYPEORM_DATABASE"
else
  exec docker exec -i "$CONTAINER" psql -U "$TYPEORM_USERNAME" -d "$TYPEORM_DATABASE" "$@"
fi
