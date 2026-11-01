#!/bin/bash
# Scripture Armor — Mac install (run AFTER the breach scan verdict).
#
# DEFAULT POSTURE (Robbie's order, 2026-10-26): the vault daemon is
# ALWAYS ON. This standard install creates/loads the identity and then
# installs vaultd as a system LaunchDaemon (boot-level, before login,
# kept alive by launchd) via mac/install-daemon.sh. That helper prints
# every system change it makes.
#
# Run as the OWNER user, not with sudo — this script asks sudo only
# for the LaunchDaemon step.
#
# Options:
#   --designated-host   also set the system sleep policy
#                       (pmset -a disablesleep 1) so sleep / lid-close
#                       cannot take vaultd down on this host.
#                       (or: SCRIPTURE_ARMOR_DESIGNATED_HOST=1)
#   --user-agent        explicit fallback: per-user LaunchAgent
#                       (starts at login; NOT the default posture).
#   --no-daemon         opt out of service installation entirely;
#                       vaultd then runs only when started manually.
#                       (or: SCRIPTURE_ARMOR_DAEMON=off|agent|daemon)
set -e

DAEMON_MODE="${SCRIPTURE_ARMOR_DAEMON:-daemon}"
DESIGNATED_HOST="${SCRIPTURE_ARMOR_DESIGNATED_HOST:-0}"
for arg in "$@"; do
  case "$arg" in
    --designated-host) DESIGNATED_HOST=1 ;;
    --user-agent) DAEMON_MODE="agent" ;;
    --no-daemon) DAEMON_MODE="off" ;;
    --help|-h)
      echo "usage: install-armor.sh [--designated-host] [--user-agent] [--no-daemon]"
      exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done
case "$DAEMON_MODE" in
  daemon|default) DAEMON_MODE="daemon" ;;
  agent|off) ;;
  *) echo "error: SCRIPTURE_ARMOR_DAEMON must be daemon, agent, or off" >&2; exit 2 ;;
esac

if [ "$(id -u)" = "0" ] && [ "${SCRIPTURE_ARMOR_ALLOW_ROOT:-0}" != "1" ]; then
  echo "error: run this installer as the owner user, not with sudo." >&2
  echo "It will ask sudo only for the LaunchDaemon step." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../armor.mjs" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$HOME/scripture-armor/armor.mjs" ]; then
  REPO_DIR="$HOME/scripture-armor"
else
  echo "error: could not locate the scripture-armor tree (armor.mjs not found)." >&2
  exit 1
fi
cd "$REPO_DIR"

NODE_BIN="$(command -v node 2>/dev/null || true)"
NODE_OK="no"
if [ -n "$NODE_BIN" ]; then
  NODE_OK="$("$NODE_BIN" -e 'const [a]=process.versions.node.split(".").map(Number); console.log(a>=24?"yes":"no")' 2>/dev/null || echo no)"
fi
if [ "$NODE_OK" != "yes" ]; then
  echo "Scripture Armor v4 needs Node >= 24 (ML-KEM-768 / ML-DSA-65 in the standard library)."
  echo "This Mac reports: $($NODE_BIN -v 2>/dev/null || node -v 2>/dev/null || echo 'no node on PATH')"
  echo "Install Node 24 (e.g. from nodejs.org or: brew install node@24) and re-run this script."
  exit 1
fi
echo "node: $($NODE_BIN -v) — OK"
echo "repo: $REPO_DIR"
if [ -f "$HOME/.scripture-armor/identity.json" ]; then
  echo "identity already exists at ~/.scripture-armor — loading it (PQ migration is automatic if it predates v4):"
else
  echo "creating identity at ~/.scripture-armor:"
fi
"$NODE_BIN" armor.mjs identity
echo ""
echo "Your public identity block is printed above by the identity command."
echo ""

DAEMON_HELPER="$REPO_DIR/mac/install-daemon.sh"
case "$DAEMON_MODE" in
  daemon)
    echo "Installing the vault daemon — DEFAULT always-on posture (system LaunchDaemon, boot-level)."
    echo "sudo is required for /Library/LaunchDaemons; the helper prints every change it makes."
    run_daemon_install() {
      if [ "$DESIGNATED_HOST" = "1" ]; then
        sudo /bin/bash "$DAEMON_HELPER" --mode daemon --repo-dir "$REPO_DIR" --owner-user "$(id -un)" --owner-home "$HOME" --node-bin "$NODE_BIN" --designated-host
      else
        sudo /bin/bash "$DAEMON_HELPER" --mode daemon --repo-dir "$REPO_DIR" --owner-user "$(id -un)" --owner-home "$HOME" --node-bin "$NODE_BIN"
      fi
    }
    if ! run_daemon_install; then
      echo "error: LaunchDaemon installation failed — vaultd is NOT installed as a service." >&2
      echo "Fallbacks: re-run with --user-agent (login-level), or run the daemon manually:" >&2
      echo "  node $REPO_DIR/vaultd.mjs serve" >&2
      exit 1
    fi
    ;;
  agent)
    echo "Installing the vault daemon — FALLBACK posture (per-user LaunchAgent, login-level), per explicit request."
    /bin/bash "$DAEMON_HELPER" --mode agent --repo-dir "$REPO_DIR" --owner-user "$(id -un)" --owner-home "$HOME" --node-bin "$NODE_BIN"
    ;;
  off)
    echo "Vault daemon service installation SKIPPED (--no-daemon / SCRIPTURE_ARMOR_DAEMON=off)."
    echo "This is an explicit opt-out of the default always-on posture. To install later:"
    echo "  bash $DAEMON_HELPER --mode daemon   (via sudo; see the helper)"
    echo "Or run the daemon manually in the foreground:"
    echo "  node $REPO_DIR/vaultd.mjs serve"
    ;;
esac

echo ""
echo "Install complete."
