#!/usr/bin/env bash
# The runner copies this into every agent container and runs it with bash, in the image's working directory.
# Contract with the runner:
#   env    GITLAB_HOST (https web host), GITLAB_TOKEN, REPO_URL (https, on GITLAB_HOST), MODEL,
#          GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL
#   files  /foundry/prompt.md, optional /foundry/system.md, optional /etc/claude-code/managed-settings.json

set -euo pipefail

fail() {
  echo "foundry-entrypoint: $*" >&2
  exit 1
}

for name in GITLAB_HOST GITLAB_TOKEN REPO_URL MODEL \
  GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; do
  [[ -n "${!name:-}" ]] || fail "$name is not set"
done

[[ "$REPO_URL" == "https://$GITLAB_HOST/"* ]] || fail "REPO_URL must be an https URL on $GITLAB_HOST"
[[ -r /foundry/prompt.md ]] || fail "/foundry/prompt.md is missing"
[[ ! -e /foundry/system.md || -r /foundry/system.md ]] || fail "/foundry/system.md is not readable"
[[ "$(id -u)" != 0 ]] || fail "refusing to run as root"

# The helper reads the token from the environment, so it never lands on disk, and only GITLAB_HOST receives it.
git config --global "credential.https://$GITLAB_HOST.helper" \
  '!f() { test "$1" = get && echo username=oauth2 && echo "password=$GITLAB_TOKEN"; }; f'

# A new folder named after the project. The image must let its user write the working directory.
repo_dir="${REPO_URL##*/}"
repo_dir="${repo_dir%.git}"

git clone --quiet "$REPO_URL" "$repo_dir"

cd "$repo_dir"

claude_args=(
  -p
  --output-format stream-json
  --verbose
  --dangerously-skip-permissions
  --disallowedTools ScheduleWakeup CronCreate CronDelete CronList
  --model "$MODEL"
)

if [[ -e /foundry/system.md ]]; then
  claude_args+=(--append-system-prompt-file /foundry/system.md)
fi

exec claude "${claude_args[@]}" < /foundry/prompt.md
