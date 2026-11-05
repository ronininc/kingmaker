#!/bin/bash
# Scripture Armor — Linux install.
#
# DEFAULT POSTURE (Robbie's order, 2026-10-26): the vault daemon is
# ALWAYS ON. This standard install creates/loads the identity and then
# installs vaultd as a system systemd service (boot-level, before
# login, kept alive by systemd) via linux/install-daemon.sh. That
# helper prints every system change it makes.
#
# Run as the OWNER user, not with sudo — this script asks sudo only
# for the systemd service step.
#
# Options:
#   --designated-host   also mask the systemd sleep targets so
#                       sleep / suspend / hibernate cannot take
#                       vaultd down on this host.
#                       (or: SCRIPTURE_ARMOR_DESIGNATED_HOST=1)
#   --user-service      explicit fallback: the per-user twin unit
#                       (linux/scripture-vaultd-user.service;
#                       starts with your user session, or at boot
#                       with linger enabled; NOT the default
#                       posture). Alias: --user-agent.
#   --no-daemon         opt out of service installation entirely;
#                       vaultd then runs only when started manually.
#                       (or: SCRIPTURE_ARMOR_DAEMON=off|user|service;
#                        the macOS values daemon|agent map to
#                        service|user so the env var means the same
#                        three postures on every platform)
set -e

DAEMON_MODE="${SCRIPTURE_ARMOR_DAEMON:-service}"
DESIGNATED_HOST="${SCRIPTURE_ARMOR_DESIGNATED_HOST:-0}"
for arg in "$@"; do
  case "$arg" in
    --designated-host) DESIGNATED_HOST=1 ;;
    --user-service|--user-agent) DAEMON_MODE="user" ;;
    --no-daemon) DAEMON_MODE="off" ;;
    --help|-h)
      echo "usage: install-armor.sh [--designated-host] [--user-service] [--no-daemon]"
      exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done
case "$DAEMON_MODE" in
  service|daemon|default) DAEMON_MODE="service" ;;
  user|agent) DAEMON_MODE="user" ;;
  off) ;;
  *) echo "error: SCRIPTURE_ARMOR_DAEMON must be service, user, or off" >&2; exit 2 ;;
esac

if [ "$(id -u)" = "0" ] && [ "${SCRIPTURE_ARMOR_ALLOW_ROOT:-0}" != "1" ]; then
  echo "error: run this installer as the owner user, not with sudo." >&2
  echo "It will ask sudo only for the systemd service step." >&2
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
  echo "This machine reports: $($NODE_BIN -v 2>/dev/null || node -v 2>/dev/null || echo 'no node on PATH')"
  echo "Install Node 24 (e.g. from nodejs.org or your distro's nodesource setup) and re-run this script."
  exit 1
fi
echo "node: $($NODE_BIN -v) — OK"
echo "repo: $REPO_DIR"
IDENTITY_DIR="$("$NODE_BIN" "$REPO_DIR/product-paths.mjs" --home "$HOME" --field identityDir)"
if [ -f "$IDENTITY_DIR/identity.json" ]; then
  echo "identity already exists at $IDENTITY_DIR — loading it (PQ migration is automatic if it predates v4):"
else
  echo "creating identity at $IDENTITY_DIR:"
fi
"$NODE_BIN" armor.mjs identity --identity-dir "$IDENTITY_DIR"
echo ""
echo "Your public identity block is printed above by the identity command."
echo ""

DAEMON_HELPER="$REPO_DIR/linux/install-daemon.sh"
case "$DAEMON_MODE" in
  service)
    echo "Installing the vault daemon — DEFAULT always-on posture (system systemd service, boot-level)."
    echo "sudo is required for /etc/systemd/system; the helper prints every change it makes."
    run_daemon_install() {
      if [ "$DESIGNATED_HOST" = "1" ]; then
        sudo /bin/bash "$DAEMON_HELPER" --mode service --repo-dir "$REPO_DIR" --owner-user "$(id -un)" --owner-home "$HOME" --node-bin "$NODE_BIN" --identity-dir "$IDENTITY_DIR" --designated-host
      else
        sudo /bin/bash "$DAEMON_HELPER" --mode service --repo-dir "$REPO_DIR" --owner-user "$(id -un)" --owner-home "$HOME" --node-bin "$NODE_BIN" --identity-dir "$IDENTITY_DIR"
      fi
    }
    if ! run_daemon_install; then
      echo "error: systemd service installation failed — vaultd is NOT installed as a service." >&2
      echo "Fallbacks: re-run with --user-service (session-level), or run the daemon manually:" >&2
      echo "  node $REPO_DIR/vaultd.mjs serve" >&2
      exit 1
    fi
    ;;
  user)
    echo "Installing the vault daemon — FALLBACK posture (per-user systemd unit, session-level), per explicit request."
    /bin/bash "$DAEMON_HELPER" --mode user --repo-dir "$REPO_DIR" --owner-user "$(id -un)" --owner-home "$HOME" --node-bin "$NODE_BIN" --identity-dir "$IDENTITY_DIR"
    ;;
  off)
    echo "Vault daemon service installation SKIPPED (--no-daemon / SCRIPTURE_ARMOR_DAEMON=off)."
    echo "This is an explicit opt-out of the default always-on posture. To install later:"
    echo "  bash $DAEMON_HELPER --mode service   (via sudo; see the helper)"
    echo "Or run the daemon manually in the foreground:"
    echo "  node $REPO_DIR/vaultd.mjs serve"
    ;;
esac

echo ""
echo "Install complete."
