#!/usr/bin/env bash
# Started by command-limit.sh, detached, before Claude runs the command:
#   command-watchdog.sh <call id> <deadline ms> <Claude's pid> <background limit ms, 0 in the foreground>,
#   with the reason in SWARMFOUNDRY_REASON
# Prints its pid, then waits for the command's shell to write the shell's pid to its fd 9. Exits once that shell is
# gone, leaving what the command put in the background running. If the shell is still running at the deadline, counted
# from that write, it freezes the shell and every process carrying the call's marker, writes the reason to the shell's
# output and kills them.

set -u
trap '' PIPE HUP INT TERM

id=$1
deadline_ms=$2
claude=$3
background_limit_ms=$4

# Read for the shell's pid, and for naps without forking, so the watchdog stays out of the agent's `pgrep sleep`.
exec 9<> <(:)
printf '%s\n' "$$"
exec > /dev/null

now() {
  local micros=${EPOCHREALTIME/./}
  now_ms=$((micros / 1000))
}

# The start time, which tells the shell from a later process given its pid. Fails for a zombie, whose call is over.
start_of() {
  local stat
  read -r stat 2> /dev/null < "/proc/$1/stat" || return 1

  # Past the name, which can hold spaces: the state, then the start time as the stat's 22nd field.
  local -a fields=(${stat##*) })
  [[ "${fields[0]}" != Z && "${fields[0]}" != X ]] || return 1
  started=${fields[19]}
}

shell_alive() {
  start_of "$shell" && [[ "$started" == "$shell_started" ]]
}

# A process carrying the marker in its environment, or a subshell, which keeps the shell's arguments.
is_marked() {
  local arg args variable

  args=
  while IFS= read -r -d '' arg; do args+="$arg "; done 2> /dev/null < "$1/cmdline"
  [[ "$args" == *"export SWARMFOUNDRY_CALL=$id; "* ]] && return 0

  while IFS= read -r -d '' variable; do
    [[ "$variable" == "SWARMFOUNDRY_CALL=$id" ]] && return 0
  done 2> /dev/null < "$1/environ"

  return 1
}

# Stops each marked process as it finds it, so none can start a child between the scan and the signal.
stop_marked() {
  local entry pid

  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [[ "$pid" != "$$" ]] && is_marked "$entry" || continue

    kill -STOP "$pid" 2> /dev/null
    if [[ -z "${stopped[$pid]-}" ]]; then
      stopped[$pid]=1
      found=true
    fi
  done
}

# Only to a regular file, since a pipe can block the write or raise SIGPIPE.
write_reason() {
  local fd

  for fd in 2 1; do
    if [[ -f "/proc/$shell/fd/$fd" ]]; then
      printf '\n%s\n' "${SWARMFOUNDRY_REASON:-Swarmfoundry stopped this command at its limit.}" \
        >> "/proc/$shell/fd/$fd" 2> /dev/null
      return
    fi
  done
}

# The shell writes its pid before running the command. Claude starts it only once every PreToolUse hook has finished,
# and never if the call is denied, so the wait lasts while Claude does.
shell=

while [[ -z "$shell" ]]; do
  [[ -d "/proc/$claude" ]] || exit 0

  if read -r -t 1 -u 9 line && [[ "$line" =~ ^[0-9]+$ ]]; then
    # A shell already gone ran a call that is over.
    start_of "$line" || exit 0
    shell=$line
    shell_started=$started
  fi
done

now
start_ms=$now_ms
end_ms=$((start_ms + deadline_ms))

while shell_alive; do
  now
  ((now_ms < end_ms)) || break
  read -r -t 0.2 -u 9 _ || true
done

# Claude stops a background call's shell at its limit, so a shell gone from then on ran a call that hung.
stopped_by_claude() {
  now
  ((background_limit_ms > 0 && now_ms >= start_ms + background_limit_ms - 1000))
}

if shell_alive; then
  # The shell frozen first, so it neither runs a later line nor finishes while the marked processes are found.
  kill -STOP "$shell" 2> /dev/null

  if ! shell_alive; then
    kill -CONT "$shell" 2> /dev/null
    stopped_by_claude || exit 0
  fi
elif ! stopped_by_claude; then
  exit 0
fi

# Again until a scan finds no process it had not stopped, as a process can start a child before it is stopped.
declare -A stopped=()
for _ in {1..40}; do
  found=false
  stop_marked
  $found || break
done

if shell_alive; then
  write_reason
  kill -KILL "$shell" 2> /dev/null
fi

for pid in "${!stopped[@]}"; do
  kill -KILL "$pid" 2> /dev/null
done

exit 0
