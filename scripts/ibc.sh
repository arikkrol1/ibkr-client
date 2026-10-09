#!/usr/bin/env bash
# Control IB Gateway through IBC (see README → "IBC: auto-login & restart").
#
#   pnpm ibc            start Gateway under IBC, detached (approve the IB Key push)
#   pnpm ibc:restart    restart in place via IBC's command port (no 2FA, ~1 min);
#                       starts it instead if IBC isn't running
#   pnpm ibc:stop       tidy shutdown
#   pnpm ibc:status     is Gateway / IBC up?
#
# Env: IBC_PATH (default ~/ibc), IBC_COMMAND_PORT (default 7462),
#      IB_PORT (default 4001, the Gateway API port the app connects to).
set -euo pipefail

IBC_PATH="${IBC_PATH:-$HOME/ibc}"
CMD_PORT="${IBC_COMMAND_PORT:-7462}"
API_PORT="${IB_PORT:-4001}"
START="$IBC_PATH/gatewaystartmacos.sh"
LOG="$IBC_PATH/logs/start.out"

die() { echo "error: $*" >&2; exit 1; }
port_up() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
gateway_running() { pgrep -f "IB Gateway" >/dev/null 2>&1; }

# Send one command to IBC's command server and print its reply.
send() {
  port_up "$CMD_PORT" || return 1
  { echo "$1"; sleep 1; echo "EXIT"; } | nc 127.0.0.1 "$CMD_PORT"
}

status() {
  if port_up "$CMD_PORT"; then echo "IBC:     running (command port $CMD_PORT)"
  else echo "IBC:     not running"; fi
  if port_up "$API_PORT"; then echo "Gateway: API up on $API_PORT"
  elif gateway_running; then echo "Gateway: running, API not ready (logging in?)"
  else echo "Gateway: not running"; fi
}

# Wait until both the API and command ports are up (login done).
wait_ready() {
  echo "waiting for Gateway login (approve the IB Key push on your phone)…"
  for i in $(seq 1 180); do
    if port_up "$API_PORT" && port_up "$CMD_PORT"; then
      echo "ready after ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "not ready after 180s; check $IBC_PATH/logs/" >&2
  return 1
}

start() {
  [[ -x "$START" ]] || die "$START not found — install IBC first (see README)"
  if port_up "$CMD_PORT"; then
    echo "already running under IBC"
    status
    return 0
  fi
  if gateway_running; then
    die "IB Gateway is running but not under IBC — quit the Gateway app first, then rerun"
  fi
  mkdir -p "$(dirname "$LOG")"
  nohup "$START" -inline >"$LOG" 2>&1 &
  disown
  echo "started IBC (log: $LOG)"
  wait_ready
}

case "${1:-start}" in
  start) start ;;
  restart)
    if send RESTART; then
      echo "restart requested; Gateway drops and logs back in within ~1 min"
    else
      echo "IBC not running; starting it"
      start
    fi
    ;;
  stop) send STOP || die "IBC not running" ;;
  status) status ;;
  *) die "usage: $0 [start|restart|stop|status]" ;;
esac
