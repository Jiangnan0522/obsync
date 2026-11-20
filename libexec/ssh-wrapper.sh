#!/bin/bash
# obsync's ssh/scp shim for the mutagen daemon.
#
# mutagen 0.18 resolves `ssh` and `scp` inside $MUTAGEN_SSH_PATH (a directory)
# when that variable is set in the *daemon's* environment. obsync installs this
# file there twice, as `ssh` and as `scp`, and does two things with it:
#
#  1. Relaxes the timeouts mutagen hard-codes on the command line
#     (-oConnectTimeout=5 -oServerAliveInterval=10 -oServerAliveCountMax=1).
#     Command-line -o beats ~/.ssh/config, so this cannot be done in the config.
#     A 5 s connect timeout against a slow sshd means every reconnect gives up
#     *before authenticating*, which OpenSSH >= 9.8 PerSourcePenalties counts
#     against our IP until it bans it ("Not allowed at this time").
#
#  2. Records each invocation and its stderr in ~/.obsync/ssh-wrapper.log.
#     mutagen discards the error of every failed *re*connect, so without this
#     obsync's circuit breaker could never see "banner exchange" or
#     "Not allowed at this time".
#
# Everything else is forwarded verbatim. `exec` keeps the PID, so when mutagen
# kills "ssh" it kills the real ssh, and stdin/stdout (the agent protocol) are
# never touched.

self=${0##*/}
case "$self" in
  scp) real=/usr/bin/scp ;;
  *)   real=/usr/bin/ssh ;;
esac

CT=${OBSYNC_SSH_CONNECT_TIMEOUT:-30}
SAI=${OBSYNC_SSH_ALIVE_INTERVAL:-15}
SAC=${OBSYNC_SSH_ALIVE_COUNT:-4}
LOG=${OBSYNC_SSH_LOG:-$HOME/.obsync/ssh-wrapper.log}

args=()
# -v (ssh only): sshd's pre-banner refusal "Not allowed at this time" and the
# "Offering public key" stall of an MFA-gated login are printed only at debug
# level. The debug lines are filtered below: mutagen never sees them, and only
# the few that matter are logged.
[ "$self" = ssh ] && args+=(-v)
for a in "$@"; do
  case "$a" in
    -oConnectTimeout=*)      a="-oConnectTimeout=$CT" ;;
    -oServerAliveInterval=*) a="-oServerAliveInterval=$SAI" ;;
    -oServerAliveCountMax=*) a="-oServerAliveCountMax=$SAC" ;;
  esac
  args+=("$a")
done

now() { date '+%Y-%m-%dT%H:%M:%S%z'; }

# Logging must never break the connection: every write is best-effort.
printf '%s\t%s\tstart\t%s\t%s\n' "$(now)" "$$" "$self" "${args[*]}" >>"$LOG" 2>/dev/null

# The process substitution is forked before the redirection applies, so its own
# fd 2 is still mutagen's stderr pipe: every line goes back to mutagen unchanged
# and a copy goes to the log. ($$ in it is still this PID, i.e. the real ssh's.)
log() { printf '%s\t%s\t%s\t%s\t%s\n' "$(now)" "$$" "$1" "$self" "$2" >>"$LOG" 2>/dev/null; }

# A function, not inline: bash 3.2 (macOS /bin/bash) mis-parses `case` patterns
# inside >( ... ) and takes their ")" for the end of the substitution.
filter() {
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      debug*)
        case "$line" in
          *"banner line"*|*"Offering public key"*|*"Authenticated to"*|*"Authentications that can continue"*) log err "$line" ;;
        esac ;;
      OpenSSH_*) ;;  # the version line -v prints first
      *) printf '%s\n' "$line" >&2; log err "$line" ;;
    esac
  done
  # stderr hits EOF when ssh exits: lets obsync tell a live connection from a dead one.
  log end ""
}

exec "$real" "${args[@]}" 2> >(filter)
