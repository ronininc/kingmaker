#!/bin/sh
# Kingmaker from a git checkout (developers). Everyone else uses Kingmaker Installer.app: one button, everything.
# This links the kingmaker CLI (and its old name, sol-ghost) and checks the system software the engine uses (Ollama,
# the hands, a mic tool). Nothing is installed without --yes; without it, the missing pieces are printed with the
# command. When Kingmaker.app (or an older Sol Ghost.app) is in ~/Applications or /Applications, the CLI is linked
# from inside it. Otherwise this checkout borrows the engine runtime of the Kingmaker.app at KINGMAKER_RUNTIME_APP.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
app="${KINGMAKER_RUNTIME_APP:-/Applications/Kingmaker.app}"
fork="$here/solomon" # an operator checkout's engine source (lib/fork.mjs reads the same folder)
yes=0; [ "${1:-}" = "--yes" ] && yes=1
missing=0
cli="$here/bin/kingmaker"
for g in "$HOME/Applications/Kingmaker.app" "/Applications/Kingmaker.app" "$HOME/Applications/Sol Ghost.app" "/Applications/Sol Ghost.app"; do
  if { [ -x "$g/Contents/MacOS/KingmakerEngine" ] || [ -x "$g/Contents/MacOS/Solomon" ]; } && { [ -d "$g/Contents/Resources/kingmaker-runtime" ] || [ -d "$g/Contents/Resources/solomon-runtime" ]; }; then
    cli="$g/Contents/Resources/sol-ghost/bin/kingmaker"
    [ -e "$cli" ] || cli="$g/Contents/Resources/sol-ghost/bin/sol-ghost"
    break
  fi
done

need() { # need <label> <check-cmd> <install-cmd>
  if sh -c "$2" >/dev/null 2>&1; then echo "✓ $1"; return; fi
  missing=1
  if [ "$yes" = 1 ]; then echo "… installing $1"; sh -c "$3"; else echo "✗ $1 → $3"; fi
}

case "$cli" in
  "$here"/*)
    if [ -f "$fork/server/src/index.ts" ]; then
      echo "✓ the engine's source in this checkout (UI stripped)"
      need "server dependencies" "test -f '$fork/server/node_modules/tsx/dist/cli.mjs'" "npm ci --prefix '$fork/server'"
      { [ -x "$app/Contents/MacOS/KingmakerEngine" ] || [ -x "$app/Contents/MacOS/Solomon" ]; } && echo "✓ native runtimes from $app" || echo "· native runtimes (voice, guardrails): install Kingmaker.app once or set SOL_GHOST_RESOURCES"
    elif [ -x "$app/Contents/MacOS/KingmakerEngine" ] || [ -x "$app/Contents/MacOS/Solomon" ]; then echo "✓ engine runtime borrowed from $app"; else
      echo "✗ No engine runtime. Install Kingmaker with Kingmaker Installer, or build Kingmaker.app (the engine build), or set KINGMAKER_RUNTIME_APP to one."; exit 78
    fi ;;
  *) echo "✓ engine runtime inside $(dirname "$(dirname "$(dirname "$(dirname "$(dirname "$cli")")")")")" ;;
esac
need "Ollama"         "command -v ollama"   "brew install ollama && brew services start ollama"
need "Hands of Horus" "command -v peekaboo" "brew install openclaw/tap/peekaboo"
need "sox"            "command -v sox"      "brew install sox"

if [ "$yes" = 1 ]; then "$cli" chrome; else echo "· Chrome connector: run kingmaker chrome (or ./install.sh --yes) to set it up"; fi
mkdir -p "$HOME/.local/bin"
ln -sf "$cli" "$HOME/.local/bin/kingmaker"
ln -sf "$cli" "$HOME/.local/bin/sol-ghost"
echo "✓ linked ~/.local/bin/kingmaker (and the old name sol-ghost) → $cli"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  add ~/.local/bin to your PATH" ;; esac
[ "$missing" = 1 ] && [ "$yes" = 0 ] && echo "Run ./install.sh --yes to install the missing pieces."
"$cli" doctor
