#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash, set in the managed settings by the runner and run with an empty environment:
#   command-limit.sh <default ms> <max ms> <background ms> <grace ms>
# Starts command-watchdog.sh, then marks the command with a call id that every process it starts inherits, and has the
# command's shell tell the watchdog its pid. The watchdog kills the shell, and every marked process, once the call runs
# the grace past its limit. Needs jq and setsid.

set -euo pipefail

default_ms=$1
max_ms=$2
background_ms=$3
grace_ms=$4

id=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
# Stands in for the watchdog's pid, which is known only once the watchdog has started, after the limit.
watchdog_pid="@watchdog-$id@"

# The call's limit and its background limit, 0 in the foreground, on the first line, then the hook's answer. Nothing
# for a call without a command.
answer=$(
  jq -r --arg id "$id" --arg watchdog "$watchdog_pid" --argjson default "$default_ms" --argjson max "$max_ms" \
    --argjson background "$background_ms" --argjson grace "$grace_ms" '
    .tool_input as $in
    | select($in.command | type == "string")
    | ($in.timeout | if type == "number" and . >= 1 then floor else null end) as $timeout
    | ($in.run_in_background == true) as $bg
    | (if $bg and $timeout == null then $background else [$timeout // $default, $max] | min end) as $limit
    | "\($limit) \(if $bg then $limit else 0 end)", ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: ($in + {
            # On the first line of the command, so its error line numbers stay as they were. `builtin` passes over
            # any function the shell snapshot defines, and the braces keep the redirect to the announcement, which
            # fails quietly once the watchdog is gone.
            command: (
              "\\builtin export SWARMFOUNDRY_CALL=\($id); { \\builtin echo $$ >> /proc/\($watchdog)/fd/9; } 2> /dev/null; "
              + $in.command
            ),
            # Claude shows the command, marker included, in place of a missing description.
            description: (
              if ($in.description | type) == "string" and $in.description != "" then $in.description
              else $in.command | split("\n")[0] | .[0:80] end
            )
          }
          # Past the kill, so Claude keeps the call in the foreground and the agent reads the reason in its result. A
          # background call gets its limit, so Claude stops it where the watchdog takes it to be stopped.
          + {timeout: (if $bg then $limit else $limit + $grace + 10000 end)})
        }
      } | tojson)'
)

[[ -n "$answer" ]] || exit 0

limits=${answer%%$'\n'*}
limit_ms=${limits% *}
background_limit_ms=${limits#* }
deadline_ms=$((limit_ms + grace_ms))
reason="Swarmfoundry stopped this command, and every process it started, after $((deadline_ms / 1000))s: its limit of $((limit_ms / 1000))s plus $((grace_ms / 1000))s grace."

# Claude starts a hook as a session leader, or its shell, so Claude is the parent of this session's leader.
read -r _ _ _ _ _ session _ < "/proc/$$/stat"
read -r _ _ _ claude_pid _ < "/proc/$session/stat"
# A session that a container's pid 1 leads has no parent, so the watchdog waits on the leader instead.
((claude_pid > 0)) || claude_pid=$session

# The watchdog prints its own pid first, as `$!` names setsid's where setsid forks. Within the hook's timeout, which
# would otherwise let the call run unhooked.
read -r -t 5 pid < <(
  SWARMFOUNDRY_REASON=$reason setsid bash --norc --noprofile "$(dirname "$0")/command-watchdog.sh" \
    "$id" "$deadline_ms" "$claude_pid" "$background_limit_ms" < /dev/null 2> /dev/null
)
[[ "$pid" =~ ^[0-9]+$ ]] || exit 1

json=${answer#*$'\n'}
printf '%s\n' "${json//"$watchdog_pid"/"$pid"}"
