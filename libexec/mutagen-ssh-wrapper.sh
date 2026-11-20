#!/bin/sh
# Point the mutagen daemon at obsync's ssh wrapper (or back at /usr/bin/ssh).
#
#   mutagen-ssh-wrapper.sh on | off | status
#
# mutagen reads MUTAGEN_SSH_PATH from the *daemon's* environment, and the
# daemon normally runs from the LaunchAgent that `mutagen daemon register`
# writes, so that is where the variable goes. Re-running `mutagen daemon
# register` rewrites the plist and silently drops it: run `on` again after.
#
# Restarting the daemon makes every session reconnect. To avoid a burst of
# simultaneous logins, running obsync sessions are paused first and resumed
# one by one afterwards.
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd -P)
BIN="$HOME/.obsync/ssh-bin"
PLIST="$HOME/Library/LaunchAgents/io.mutagen.mutagen.plist"
STAGGER=${STAGGER:-6}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

install_bin() {
  mkdir -p "$BIN"
  for n in ssh scp; do
    cp "$DIR/libexec/ssh-wrapper.sh" "$BIN/$n.tmp"
    chmod 755 "$BIN/$n.tmp"
    mv "$BIN/$n.tmp" "$BIN/$n"
  done
}

current() {
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:MUTAGEN_SSH_PATH' "$PLIST" 2>/dev/null || true
}

running_obsync() {
  mutagen sync list --label-selector obsync=true \
    --template '{{range .}}{{if not .Paused}}{{.Name}} {{end}}{{end}}' 2>/dev/null || true
}

restart_daemon() {
  names=$(running_obsync)
  if [ -n "$names" ]; then
    echo "· pausing obsync sessions: $names"
    # shellcheck disable=SC2086
    mutagen sync pause $names
  fi
  echo "· reloading the mutagen daemon"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  # Wait for launchd's daemon. (There is no `mutagen daemon status`; it prints
  # help and exits 0.) Autostart is disabled so the CLI cannot win the race and
  # spawn a daemon of its own that lacks the plist's environment.
  export MUTAGEN_DISABLE_AUTOSTART=1
  i=0; until mutagen sync list >/dev/null 2>&1 || [ $i -ge 40 ]; do i=$((i+1)); sleep 0.5; done
  for n in $names; do
    echo "· resuming $n"
    mutagen sync resume "$n" || echo "  (resume failed; obsync's breaker will take it from here)"
    sleep "$STAGGER"
  done
}

[ -f "$PLIST" ] || die "no mutagen LaunchAgent at $PLIST. Run: mutagen daemon register"

case "${1:-status}" in
  on)
    install_bin
    [ "$(current)" = "$BIN" ] && { echo "already on ($BIN)"; exit 0; }
    /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$PLIST" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:MUTAGEN_SSH_PATH" "$PLIST" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:MUTAGEN_SSH_PATH string $BIN" "$PLIST"
    restart_daemon
    echo "✓ mutagen now runs ssh via $BIN/ssh (ConnectTimeout 5→30, ServerAliveCountMax 1→4)"
    ;;
  off)
    [ -z "$(current)" ] && { echo "already off"; exit 0; }
    /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:MUTAGEN_SSH_PATH" "$PLIST"
    restart_daemon
    echo "✓ mutagen uses the system ssh again"
    ;;
  status)
    c=$(current)
    if [ "$c" = "$BIN" ]; then echo "on  (MUTAGEN_SSH_PATH=$BIN)"; else echo "off"; fi
    pid=$(pgrep -f 'mutagen daemon run' | head -1 || true)
    if [ -n "$pid" ] && launchctl print "gui/$(id -u)/io.mutagen.mutagen" 2>/dev/null | grep -q "MUTAGEN_SSH_PATH => $BIN"; then
      echo "running daemon (pid $pid): using the wrapper"
    elif [ -n "$pid" ]; then
      echo "running daemon (pid $pid): NOT using the wrapper"
    fi
    ;;
  *) die "usage: $0 on|off|status" ;;
esac
