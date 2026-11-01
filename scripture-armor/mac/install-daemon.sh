#!/bin/bash
# Scripture Armor — vault daemon service installer (macOS).
#
# DEFAULT POSTURE (Robbie's order, 2026-10-26): vaultd is always on.
# The standard install (mac/install-armor.sh) calls this helper in
# --mode daemon: vaultd is installed as a SYSTEM LaunchDaemon —
# RunAtLoad + KeepAlive, started by launchd at boot, before any login,
# running as the owner user so it can read the owner's identity store.
# Logout does not stop it. On a DESIGNATED HOST, --designated-host
# also sets the system sleep policy (pmset -a disablesleep 1) so sleep
# and lid-close cannot take the daemon down.
#
# The per-user LaunchAgent path (--mode agent) is an explicit fallback
# only: it starts at login and is NOT the default posture.
#
# This helper PRINTS every system change it makes. Nothing is silent.
# It never touches identity key material beyond ensuring the identity
# directory exists with private permissions.
set -e

LABEL="org.ronininc.scripture-vaultd"
MODE="daemon"
DESIGNATED_HOST=0
RENDER_ONLY=0
OWNER_USER=""
OWNER_HOME=""
NODE_BIN=""
REPO_DIR=""
IDENTITY_DIR=""

usage() {
  echo "usage: install-daemon.sh [--mode daemon|agent] [--designated-host]"
  echo "         [--owner-user <user>] [--owner-home <dir>] [--node-bin <path>]"
  echo "         [--repo-dir <dir>] [--identity-dir <dir>] [--render-only]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --designated-host) DESIGNATED_HOST=1; shift ;;
    --owner-user) OWNER_USER="$2"; shift 2 ;;
    --owner-home) OWNER_HOME="$2"; shift 2 ;;
    --node-bin) NODE_BIN="$2"; shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --identity-dir) IDENTITY_DIR="$2"; shift 2 ;;
    --render-only) RENDER_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$MODE" != "daemon" ] && [ "$MODE" != "agent" ]; then
  echo "error: --mode must be 'daemon' or 'agent'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/org.ronininc.scripture-vaultd.plist"
if [ ! -f "$TEMPLATE" ]; then
  echo "error: plist template not found: $TEMPLATE" >&2
  exit 1
fi
if [ -z "$REPO_DIR" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
if [ ! -f "$REPO_DIR/vaultd.mjs" ]; then
  echo "error: vaultd.mjs not found in repo dir: $REPO_DIR" >&2
  exit 1
fi

if [ -z "$OWNER_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    OWNER_USER="$SUDO_USER"
  else
    OWNER_USER="$(id -un)"
  fi
fi
if [ -z "$OWNER_HOME" ]; then
  OWNER_HOME="$(dscl . -read "/Users/$OWNER_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  if [ -z "$OWNER_HOME" ]; then
    OWNER_HOME="$(eval echo "~$OWNER_USER")"
  fi
  if [ -z "$OWNER_HOME" ] || [ "$OWNER_HOME" = "~$OWNER_USER" ]; then
    OWNER_HOME="$HOME"
  fi
fi
OWNER_UID="$(id -u "$OWNER_USER" 2>/dev/null || echo "")"
if [ -z "$IDENTITY_DIR" ]; then
  IDENTITY_DIR="$OWNER_HOME/.scripture-armor"
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for cand in /opt/homebrew/bin/node /usr/local/bin/node "$OWNER_HOME/.local/bin/node"; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: could not find a node binary (pass --node-bin <path>)" >&2
  exit 1
fi

LOG_PATH="$OWNER_HOME/Library/Logs/scripture-vaultd.launchd.log"
PATH_VALUE="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
sed_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/&/\\&/g' -e 's/|/\\|/g'
}
esc() {
  sed_escape "$(xml_escape "$1")"
}

if [ "$MODE" = "daemon" ]; then
  USERNAME_ENTRY_RAW="<key>UserName</key><string>$(xml_escape "$OWNER_USER")</string>"
else
  USERNAME_ENTRY_RAW=""
fi

TMP_PLIST="$(mktemp /tmp/scripture-vaultd-plist.XXXXXX)"
trap 'rm -f "$TMP_PLIST"' EXIT
sed \
  -e "s|__USERNAME_ENTRY__|$(sed_escape "$USERNAME_ENTRY_RAW")|g" \
  -e "s|__NODE_BIN__|$(esc "$NODE_BIN")|g" \
  -e "s|__REPO_DIR__|$(esc "$REPO_DIR")|g" \
  -e "s|__IDENTITY_DIR__|$(esc "$IDENTITY_DIR")|g" \
  -e "s|__OWNER_HOME__|$(esc "$OWNER_HOME")|g" \
  -e "s|__PATH_VALUE__|$(esc "$PATH_VALUE")|g" \
  -e "s|__LOG_PATH__|$(esc "$LOG_PATH")|g" \
  "$TEMPLATE" > "$TMP_PLIST"

if [ "$RENDER_ONLY" = "1" ]; then
  cat "$TMP_PLIST"
  exit 0
fi

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TMP_PLIST"
fi

if [ "$MODE" = "daemon" ]; then
  if [ "$(id -u)" != "0" ]; then
    echo "error: --mode daemon installs into /Library/LaunchDaemons and must run as root." >&2
    echo "The standard installer (mac/install-armor.sh) calls it with sudo. Direct run:" >&2
    echo "  sudo bash \"$SCRIPT_DIR/install-daemon.sh\" --mode daemon" >&2
    exit 1
  fi
  DAEMON_PLIST="/Library/LaunchDaemons/$LABEL.plist"
  AGENT_PLIST="$OWNER_HOME/Library/LaunchAgents/$LABEL.plist"

  echo "Scripture Armor daemon install — DEFAULT posture (system LaunchDaemon)"
  echo "  owner user:        $OWNER_USER (uid ${OWNER_UID:-unknown})"
  echo "  node:              $NODE_BIN"
  echo "  repo:              $REPO_DIR"
  echo "  identity dir:      $IDENTITY_DIR"
  echo "  log:               $LOG_PATH"

  mkdir -p "$IDENTITY_DIR" "$(dirname "$LOG_PATH")"
  chmod 700 "$IDENTITY_DIR"
  touch "$LOG_PATH"
  if [ -n "$OWNER_USER" ]; then
    chown "$OWNER_USER" "$IDENTITY_DIR" "$LOG_PATH" || true
  fi
  echo "  [done] identity dir ensured (0700), log file ensured: $LOG_PATH"

  if [ -f "$AGENT_PLIST" ]; then
    if [ -n "$OWNER_UID" ]; then
      launchctl bootout "gui/$OWNER_UID" "$AGENT_PLIST" 2>/dev/null || true
    fi
    BACKUP="$AGENT_PLIST.agent-backup"
    if [ -e "$BACKUP" ]; then
      BACKUP="$AGENT_PLIST.agent-backup.$(date +%Y%m%d%H%M%S)"
    fi
    mv "$AGENT_PLIST" "$BACKUP"
    echo "  [done] existing per-user LaunchAgent booted out and its plist moved (not deleted) to: $BACKUP"
  fi

  if [ -f "$DAEMON_PLIST" ]; then
    launchctl bootout system "$DAEMON_PLIST" 2>/dev/null || true
  fi
  install -m 0644 -o root -g wheel "$TMP_PLIST" "$DAEMON_PLIST"
  echo "  [done] LaunchDaemon plist installed: $DAEMON_PLIST (root:wheel, 0644)"
  launchctl bootstrap system "$DAEMON_PLIST"
  launchctl enable "system/$LABEL"
  launchctl kickstart -k "system/$LABEL"
  echo "  [done] launchd: bootstrapped + enabled + kickstarted system/$LABEL"
  echo "         -> vaultd now starts at boot, before login, and is kept alive by launchd."

  if [ "$DESIGNATED_HOST" = "1" ]; then
    /usr/bin/pmset -a disablesleep 1
    echo "  [done] SLEEP POLICY CHANGED (designated host): pmset -a disablesleep 1"
    echo "         this host will not sleep (lid-close included) while this policy stands."
    echo "         revert with: sudo pmset -a disablesleep 0"
    /usr/bin/pmset -g | grep -i "sleepdisabled" || true
  else
    echo "  [unchanged] sleep policy: this install did NOT change system sleep."
    echo "         on a designated always-on host, re-run the standard installer with"
    echo "         --designated-host (or SCRIPTURE_ARMOR_DESIGNATED_HOST=1) to set"
    echo "         pmset -a disablesleep 1 so sleep/lid-close cannot take vaultd down."
  fi
  echo "Daemon install complete: $LABEL is the default, always-on posture."
  exit 0
fi

# ---- fallback: per-user LaunchAgent (explicit opt-down, NOT the default) ----
if [ "$(id -un)" != "$OWNER_USER" ]; then
  echo "error: --mode agent must run as the owner user ($OWNER_USER)." >&2
  exit 1
fi
AGENT_PLIST="$OWNER_HOME/Library/LaunchAgents/$LABEL.plist"
echo "Scripture Armor daemon install — FALLBACK posture (per-user LaunchAgent)"
echo "  WARNING: this is not the default. vaultd will start at LOGIN, not at"
echo "  boot, and logout / sleep can take it down. Prefer --mode daemon."
mkdir -p "$(dirname "$AGENT_PLIST")" "$(dirname "$LOG_PATH")" "$IDENTITY_DIR"
chmod 700 "$IDENTITY_DIR"
touch "$LOG_PATH"
if [ -f "$AGENT_PLIST" ]; then
  launchctl bootout "gui/$OWNER_UID" "$AGENT_PLIST" 2>/dev/null || true
fi
cp "$TMP_PLIST" "$AGENT_PLIST"
chmod 644 "$AGENT_PLIST"
echo "  [done] LaunchAgent plist installed: $AGENT_PLIST"
launchctl bootstrap "gui/$OWNER_UID" "$AGENT_PLIST"
launchctl enable "gui/$OWNER_UID/$LABEL"
launchctl kickstart -k "gui/$OWNER_UID/$LABEL"
echo "  [done] launchd: bootstrapped + enabled + kickstarted gui/$OWNER_UID/$LABEL"
echo "  [unchanged] sleep policy: agent mode cannot change system sleep."
echo "Agent install complete (fallback posture)."
