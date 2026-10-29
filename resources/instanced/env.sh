#!/bin/bash
# Reads this worktree's fixed instance number (see instance.sh) and exports all derived port and
# database variables for use by start/db scripts.

INSTANCED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTANCE=$(bash "$INSTANCED_DIR/instance.sh")

if [[ -z "$INSTANCE" ]]; then
  echo "error: could not determine instance number" >&2
  exit 1
fi

WORKTREE_DIR=$(git rev-parse --show-toplevel)

WORKDIR="$WORKTREE_DIR/.workdir"
LOG_DIR="$WORKDIR/logs"

export INSTANCE
export WORKTREE_DIR
export WORKDIR
export LOG_DIR

export TZ=UTC

export API_PORT=$((3000 + INSTANCE * 100))
export WEB_PORT=$((8080 + INSTANCE * 100))

DB_NAME=swarmfoundry
DB_USERNAME=swarmfoundry
DB_PASSWORD=swarmfoundry

# An incoming TYPEORM_HOST means an existing Postgres, and no script then calls Docker for the database. Scripts
# started from one that sourced this file inherit its TYPEORM_HOST, so DB_EXTERNAL carries the first decision down.
if [[ "$DB_EXTERNAL" != 0 && -n "$TYPEORM_HOST" ]]; then
  export DB_EXTERNAL=1
  export TYPEORM_PORT=${TYPEORM_PORT:-5432}
  export TYPEORM_DATABASE=${TYPEORM_DATABASE:-$DB_NAME}
  export TYPEORM_USERNAME=${TYPEORM_USERNAME:-$DB_USERNAME}
  export TYPEORM_PASSWORD=${TYPEORM_PASSWORD:-$DB_PASSWORD}
  export DB_PORT=$TYPEORM_PORT

  # The integration suite creates its database as TYPEORM_SUPERUSER, which otherwise means the container's postgres.
  if [[ -z "$TYPEORM_SUPERUSER" ]]; then
    export TYPEORM_SUPERUSER=$TYPEORM_USERNAME
    export TYPEORM_SUPERUSER_PASSWORD=${TYPEORM_SUPERUSER_PASSWORD:-$TYPEORM_PASSWORD}
  fi
else
  export DB_EXTERNAL=0
  export DB_PORT=$((15400 + INSTANCE))
  export TYPEORM_HOST=localhost
  export TYPEORM_PORT=$DB_PORT
  export TYPEORM_DATABASE=$DB_NAME
  export TYPEORM_USERNAME=$DB_USERNAME
  export TYPEORM_PASSWORD=$DB_PASSWORD
fi

export USE_TEST_MIGRATIONS=true

# Worktrees share the host's Docker daemon, so each instance names and labels only its own sandboxes.
export SANDBOX_NAMESPACE="swarmfoundry-dev${INSTANCE}"

# The e2e suite signs in from parallel workers, which the production rate limit would refuse.
export RATE_LIMIT_MAX_REQUESTS=100000
