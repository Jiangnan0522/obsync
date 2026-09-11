#!/bin/sh
# obsync installer — creates the config, the `obsync` command, and optionally a
# LaunchAgent. Safe to re-run: nothing already customised is overwritten.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd -P)
BIN="$HOME/.local/bin"
CONF_DIR="$HOME/.obsync"
CONF="$CONF_DIR/config.json"
PLIST="$HOME/Library/LaunchAgents/com.obsync.server.plist"
PORT=7777

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- dependencies
[ "$(uname -s)" = "Darwin" ] || die "obsync currently supports macOS only (it uses ~/.Trash and launchd)."
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 18+ from https://nodejs.org"
command -v mutagen >/dev/null 2>&1 || die "mutagen not found. See https://mutagen.io/documentation/introduction/installation"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $(node -v))."

say "✓ node $(node -v), mutagen $(mutagen version)"

# The mutagen daemon must be running for obsync to see or create anything.
if ! mutagen daemon status >/dev/null 2>&1; then
  say "· starting the mutagen daemon"
  mutagen daemon start >/dev/null 2>&1 || true
fi
if ! mutagen sync list >/dev/null 2>&1; then
  die "the mutagen daemon is not reachable. Try: mutagen daemon start"
fi

# --------------------------------------------------------------------- config
mkdir -p "$CONF_DIR"
if [ -f "$CONF" ]; then
  PORT=$(node -p "JSON.parse(require('fs').readFileSync('$CONF','utf8')).port || 7777")
  say "✓ keeping existing config ($CONF)"
else
  cat > "$CONF" <<JSON
{
  "port": $PORT,
  "localRoots": [
    "$HOME/Documents"
  ],
  "hosts": [],
  "syncMode": "two-way-safe",
  "remotePollSeconds": 5,
  "destPrefix": "[from:{name}] ",
  "localLabel": "$(scutil --get ComputerName 2>/dev/null || echo Mac)",
  "warnSizeMB": 5,
  "warnFileCount": 2000,
  "ignore": [
    ".DS_Store",
    ".git",
    ".obsidian",
    ".trash",
    "*.swp",
    "*.tmp",
    "~\$*"
  ]
}
JSON
  say "✓ wrote starter config to $CONF"
  say "  (localRoots defaults to ~/Documents — change it there, or use \"Open…\" in the UI)"
fi

# -------------------------------------------------------------------- command
mkdir -p "$BIN"
cat > "$BIN/obsync" <<SH
#!/bin/sh
# obsync — start the sync GUI (idempotent) and open it.
OBSYNC_DIR="$DIR"
PLIST="\$HOME/Library/LaunchAgents/com.obsync.server.plist"
PORT=\$(node -p "JSON.parse(require('fs').readFileSync('\$HOME/.obsync/config.json','utf8')).port")
up() { curl -sf "http://127.0.0.1:\$PORT/api/state" >/dev/null 2>&1; }
# The LaunchAgent has KeepAlive=true, so pkill alone just gets it restarted.
managed() { [ -f "\$PLIST" ] && launchctl list 2>/dev/null | grep -q com.obsync.server; }

start() {
  if managed; then launchctl kickstart gui/"\$(id -u)"/com.obsync.server 2>/dev/null
  elif [ -f "\$PLIST" ]; then launchctl load "\$PLIST" 2>/dev/null
  else nohup node "\$OBSYNC_DIR/server.js" >"\$HOME/.obsync/server.log" 2>&1 & fi
  i=0; while [ \$i -lt 20 ]; do up && return 0; i=\$((i+1)); sleep 0.3; done
  return 1
}

case "\${1:-}" in
  stop)
    [ -f "\$PLIST" ] && launchctl unload "\$PLIST" 2>/dev/null
    pkill -f "\$OBSYNC_DIR/server.js" 2>/dev/null
    up && echo "still running" || echo stopped
    ;;
  restart)
    if managed; then launchctl kickstart -k gui/"\$(id -u)"/com.obsync.server && echo restarted
    else pkill -f "\$OBSYNC_DIR/server.js" 2>/dev/null; start && echo restarted || echo "failed — see: obsync log"; fi
    ;;
  log)    tail -f "\$HOME/.obsync/server.log" ;;
  status)
    up && echo "running on http://127.0.0.1:\$PORT" || echo "not running"
    managed && echo "launchd: managed" || echo "launchd: not managed"
    ;;
  path)   echo "\$OBSYNC_DIR" ;;
  *)
    up || start || { echo "failed to start — see: obsync log"; exit 1; }
    open "http://127.0.0.1:\$PORT"
    ;;
esac
SH
chmod +x "$BIN/obsync"
say "✓ installed $BIN/obsync"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "  ⚠ $BIN is not on your PATH — add it to ~/.zshrc:"
     say "      export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# ----------------------------------------------------------------- LaunchAgent
if [ -t 0 ]; then
  printf 'Start obsync automatically at login? [y/N] '
  read -r reply || reply=n
else
  reply=n
fi

case "$reply" in
  [yY]*)
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.obsync.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$DIR/server.js</string>
  </array>
  <!-- launchd does not inherit your shell PATH; without this, mutagen and ssh
       are not found even though they work fine in a terminal. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$CONF_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$CONF_DIR/server.log</string>
</dict>
</plist>
PLISTEOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    say "✓ LaunchAgent installed (remove with: launchctl unload $PLIST && rm $PLIST)"
    ;;
  *)
    say "· skipped the LaunchAgent; \`obsync\` starts the server on demand"
    ;;
esac

say ""
say "Done. Run:  obsync"
