#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
: "${HOME:?HOME is required}"
command -v node >/dev/null 2>&1 || { echo 'Node 24 or newer is required.' >&2; exit 78; }
dest=${KINGMAKER_ENGINE_HOME:-"$HOME/.local/share/kingmaker"}
exec node "$here/portable-verify.mjs" install-linux "$here" "$dest" "$HOME"
