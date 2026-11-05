#!/bin/bash
# Scripture Armor — vault daemon service installer (Linux / systemd).
#
# DEFAULT POSTURE (Robbie's order, 2026-10-26): vaultd is always on.
# The standard install (linux/install-armor.sh) calls this helper in
# --mode service: vaultd is installed as a SYSTEM systemd service —
# enabled at boot (multi-user.target), started before any login,
# Restart=always, running as the owner user so it can read the
# owner's identity store. Logout does not stop it. On a DESIGNATED
# HOST, --designated-host also masks the systemd sleep targets so
# sleep / suspend / hibernate cannot take the daemon down.
#
# The per-user unit path (--mode user) is an explicit fallback only:
# it starts in the owner's systemd user session (at login, or at boot
# only if the owner enables linger) and is NOT the default posture.
# System and user units are first-class twins (scripture-vaultd.
# service / scripture-vaultd-user.service), corrected 2026-10-26
# against the ecosystem's original solomon.service pattern: both
# health-gate their start on vaultd's own status answer, and both
# refuse to restart-loop configuration-class exits (78).
#
# This is the Linux translation of mac/install-daemon.sh — same
# flags, same printed-changes discipline, same backup-never-delete
# migration. This helper PRINTS every system change it makes.
# Nothing is silent.
set -e

UNIT_NAME="scripture-vaultd.service"
MODE="service"
DESIGNATED_HOST=0
RENDER_ONLY=0
OWNER_USER=""
OWNER_HOME=""
NODE_BIN=""
REPO_DIR=""
IDENTITY_DIR=""

usage() {
  echo "usage: install-daemon.sh [--mode service|user] [--designated-host]"
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

if [ "$MODE" != "service" ] && [ "$MODE" != "user" ]; then
  echo "error: --mode must be 'service' or 'user'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$MODE" = "service" ]; then
  TEMPLATE="$SCRIPT_DIR/scripture-vaultd.service"
else
  TEMPLATE="$SCRIPT_DIR/scripture-vaultd-user.service"
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "error: systemd unit template not found: $TEMPLATE" >&2
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
  OWNER_HOME="$(getent passwd "$OWNER_USER" 2>/dev/null | cut -d: -f6 || true)"
  if [ -z "$OWNER_HOME" ]; then
    OWNER_HOME="$(eval echo "~$OWNER_USER")"
  fi
  if [ -z "$OWNER_HOME" ] || [ "$OWNER_HOME" = "~$OWNER_USER" ]; then
    OWNER_HOME="$HOME"
  fi
fi
OWNER_UID="$(id -u "$OWNER_USER" 2>/dev/null || echo "")"

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for cand in /usr/local/bin/node /usr/bin/node "$OWNER_HOME/.local/bin/node" "$OWNER_HOME/.nvm/current/bin/node"; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: could not find a node binary (pass --node-bin <path>)" >&2
  exit 1
fi

IDENTITY_DEFAULT="$("$NODE_BIN" "$REPO_DIR/product-paths.mjs" --home "$OWNER_HOME" --field identityDir)"
IDENTITY_DIR="$("$NODE_BIN" "$REPO_DIR/product-paths.mjs" --home "$OWNER_HOME" --check "${IDENTITY_DIR:-$IDENTITY_DEFAULT}")"
SERVICE_NAME="$("$NODE_BIN" "$REPO_DIR/product-paths.mjs" --home "$OWNER_HOME" --field serviceName)"
UNIT_NAME="$SERVICE_NAME.service"
LOG_PATH="$OWNER_HOME/.local/state/$SERVICE_NAME/vaultd.log"
PATH_VALUE="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

sed_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/&/\\&/g' -e 's/|/\\|/g'
}
esc() {
  sed_escape "$1"
}

TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT
sed \
  -e "s|__OWNER_USER__|$(esc "$OWNER_USER")|g" \
  -e "s|__NODE_BIN__|$(esc "$NODE_BIN")|g" \
  -e "s|__REPO_DIR__|$(esc "$REPO_DIR")|g" \
  -e "s|__IDENTITY_DIR__|$(esc "$IDENTITY_DIR")|g" \
  -e "s|__OWNER_HOME__|$(esc "$OWNER_HOME")|g" \
  -e "s|__PATH_VALUE__|$(esc "$PATH_VALUE")|g" \
  -e "s|__LOG_PATH__|$(esc "$LOG_PATH")|g" \
  "$TEMPLATE" > "$TMP_UNIT"

if [ "$RENDER_ONLY" = "1" ]; then
  cat "$TMP_UNIT"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl not found — this host does not run systemd." >&2
  echo "No service was installed. Run the daemon under your own supervisor:" >&2
  echo "  $NODE_BIN $REPO_DIR/vaultd.mjs serve --identity-dir $IDENTITY_DIR" >&2
  exit 1
fi

user_systemctl() {
  # Best-effort systemctl --user against the owner's session (used only
  # to migrate away a pre-existing user unit during a service install).
  if [ -n "$OWNER_UID" ] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$OWNER_USER" -- env "XDG_RUNTIME_DIR=/run/user/$OWNER_UID" systemctl --user "$@" 2>/dev/null
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$OWNER_USER" env "XDG_RUNTIME_DIR=/run/user/$OWNER_UID" systemctl --user "$@" 2>/dev/null
  else
    return 1
  fi
}

status_probe() {
  # vaultd's own status answer over the owner channel — the
  # "started" proof, mirroring Solomon's --wait-healthy. Runs as
  # the owner (the owner token is owner-readable only).
  if [ "$MODE" = "service" ]; then
    if [ -n "$OWNER_UID" ] && command -v runuser >/dev/null 2>&1; then
      runuser -u "$OWNER_USER" -- env "HOME=$OWNER_HOME" "$NODE_BIN" "$REPO_DIR/vaultd.mjs" status --identity-dir "$IDENTITY_DIR" 2>/dev/null
    elif command -v sudo >/dev/null 2>&1; then
      sudo -u "$OWNER_USER" env "HOME=$OWNER_HOME" "$NODE_BIN" "$REPO_DIR/vaultd.mjs" status --identity-dir "$IDENTITY_DIR" 2>/dev/null
    else
      return 127
    fi
  else
    "$NODE_BIN" "$REPO_DIR/vaultd.mjs" status --identity-dir "$IDENTITY_DIR" 2>/dev/null
  fi
}

verify_started() {
  # Confirm the unit is active AND (where a runner exists) that the
  # daemon's own status answers. "active" alone is not the proof.
  local active=0 attempt out
  if [ "$MODE" = "service" ]; then
    systemctl is-active --quiet "$UNIT_NAME" && active=1
  else
    systemctl --user is-active --quiet "$UNIT_NAME" && active=1
  fi
  if [ "$active" != "1" ]; then
    echo "error: $UNIT_NAME did not become active; see: journalctl -u $UNIT_NAME -n 100${MODE/user/ --user}" >&2
    return 1
  fi
  for attempt in 1 2 3 4 5; do
    out="$(status_probe)" && {
      echo "  [done] verified started: vaultd status answered: $out"
      return 0
    }
    if [ $? -eq 127 ]; then
      echo "  [done] $UNIT_NAME is active (status probe unavailable here: no runuser/sudo — verify as the owner with: node $REPO_DIR/vaultd.mjs status --identity-dir $IDENTITY_DIR)"
      return 0
    fi
    sleep 1
  done
  echo "error: $UNIT_NAME is active but vaultd's status did not answer; see: journalctl -u $UNIT_NAME -n 100" >&2
  return 1
}

if [ "$MODE" = "service" ]; then
  if [ "$(id -u)" != "0" ]; then
    echo "error: --mode service installs into /etc/systemd/system and must run as root." >&2
    echo "The standard installer (linux/install-armor.sh) calls it with sudo. Direct run:" >&2
    echo "  sudo bash \"$SCRIPT_DIR/install-daemon.sh\" --mode service" >&2
    exit 1
  fi
  UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
  USER_UNIT_PATH="$OWNER_HOME/.config/systemd/user/$UNIT_NAME"

  echo "Scripture Armor daemon install — DEFAULT posture (system systemd service)"
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

  if [ -f "$USER_UNIT_PATH" ]; then
    user_systemctl disable --now "$UNIT_NAME" || true
    BACKUP="$USER_UNIT_PATH.user-unit-backup"
    if [ -e "$BACKUP" ]; then
      BACKUP="$USER_UNIT_PATH.user-unit-backup.$(date +%Y%m%d%H%M%S)"
    fi
    mv "$USER_UNIT_PATH" "$BACKUP"
    echo "  [done] existing per-user unit disabled and its file moved (not deleted) to: $BACKUP"
  fi

  if [ -f "$UNIT_PATH" ]; then
    systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
  fi
  install -m 0644 -o root -g root "$TMP_UNIT" "$UNIT_PATH"
  echo "  [done] systemd unit installed: $UNIT_PATH (root:root, 0644)"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME"
  if ! systemctl restart "$UNIT_NAME" 2>/dev/null && ! systemctl start "$UNIT_NAME"; then
    echo "error: $UNIT_NAME failed to start; see: journalctl -u $UNIT_NAME -n 100" >&2
    exit 1
  fi
  if ! verify_started; then
    exit 1
  fi
  echo "  [done] systemd: daemon-reload + enabled + started $UNIT_NAME"
  echo "         -> vaultd now starts at boot, before login, and is kept alive by systemd (Restart=always)."

  if [ "$DESIGNATED_HOST" = "1" ]; then
    systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
    echo "  [done] SLEEP POLICY CHANGED (designated host): systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
    echo "         this host cannot sleep / suspend / hibernate while these targets are masked."
    echo "         revert with: sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target"
  else
    echo "  [unchanged] sleep policy: this install did NOT change system sleep."
    echo "         on a designated always-on host, re-run the standard installer with"
    echo "         --designated-host (or SCRIPTURE_ARMOR_DESIGNATED_HOST=1) to mask the"
    echo "         systemd sleep targets so sleep/suspend cannot take vaultd down."
  fi
  echo "Daemon install complete: $UNIT_NAME is the default, always-on posture."
  exit 0
fi

# ---- fallback: per-user unit (explicit opt-down, NOT the default) ----
if [ "$(id -un)" != "$OWNER_USER" ]; then
  echo "error: --mode user must run as the owner user ($OWNER_USER)." >&2
  exit 1
fi
USER_UNIT_PATH="$OWNER_HOME/.config/systemd/user/$UNIT_NAME"
echo "Scripture Armor daemon install — FALLBACK posture (per-user systemd unit)"
echo "  WARNING: this is not the default. vaultd starts with your systemd"
echo "  user session (at login — or at boot only if you enable linger as"
echo "  root: loginctl enable-linger $OWNER_USER), and logout can take it"
echo "  down unless linger is on. Prefer --mode service."
mkdir -p "$(dirname "$USER_UNIT_PATH")" "$(dirname "$LOG_PATH")" "$IDENTITY_DIR"
chmod 700 "$IDENTITY_DIR"
touch "$LOG_PATH"
if [ -f "$USER_UNIT_PATH" ]; then
  systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
fi
cp "$TMP_UNIT" "$USER_UNIT_PATH"
chmod 644 "$USER_UNIT_PATH"
echo "  [done] user unit installed: $USER_UNIT_PATH"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"
if ! systemctl --user restart "$UNIT_NAME" 2>/dev/null && ! systemctl --user start "$UNIT_NAME"; then
  echo "error: $UNIT_NAME failed to start; see: journalctl --user -u $UNIT_NAME -n 100" >&2
  exit 1
fi
if ! verify_started; then
  exit 1
fi
echo "  [done] systemd --user: daemon-reload + enabled + started $UNIT_NAME"
echo "  [unchanged] sleep policy: user mode cannot change system sleep."
echo "User-unit install complete (fallback posture)."
