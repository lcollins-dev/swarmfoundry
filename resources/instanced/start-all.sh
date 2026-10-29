#!/bin/bash
set -e

source "$(dirname "$0")/env.sh"

mkdir -p "$LOG_DIR"

start_app() {
  local name=$1
  local pid_file="$LOG_DIR/${name}.pid"
  local log_file="$LOG_DIR/${name}.log"

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "${name}: already running (PID $(cat "$pid_file"))"
    return
  fi

  : > "$log_file"
  if [[ "$name" == "api" ]]; then
    PORT=$API_PORT setsid bash -c "npm run start --workspace=apps/${name}" > "$log_file" 2>&1 &
  else
    setsid bash -c "npm run start --workspace=apps/${name}" > "$log_file" 2>&1 &
  fi

  echo $! > "$pid_file"
  echo "${name}: started (PID $!, log: .workdir/logs/${name}.log)"
}

echo ""
echo "Starting all apps for instance ${INSTANCE}"

# development.env is gitignored, so a fresh worktree starts from the template.
DEV_ENV="$WORKTREE_DIR/apps/api/development.env"

if [[ ! -f "$DEV_ENV" ]]; then
  cp "$DEV_ENV.tpl" "$DEV_ENV"
  echo "Created apps/api/development.env from development.env.tpl"
  sed -i "s/^USER_TOKEN_SECRET=$/USER_TOKEN_SECRET=$(openssl rand -hex 32)/" "$DEV_ENV"
fi

bash "$(dirname "$0")/db-up.sh"

start_app api
start_app web

echo ""
echo "Instance ${INSTANCE} running"
echo "  Web: http://localhost:${WEB_PORT}"
echo ""
echo "  Ports - api:${API_PORT} web:${WEB_PORT} db:${DB_PORT}"
echo ""
