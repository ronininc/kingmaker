#!/bin/sh
set -eu

unit="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
dest="${KINGMAKER_ENGINE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/kingmaker}"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
stage="${dest}.new.$$"
backup="${dest}.backup.$$"

case "$dest" in
  /*) ;;
  *) echo "Kingmaker's install directory must be an absolute path." >&2; exit 2 ;;
esac
case "$dest" in
  /|"$HOME") echo "Refusing an unsafe Kingmaker install directory: $dest" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || { echo "Kingmaker requires Node.js 22 or newer." >&2; exit 2; }
major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$major" -ge 22 ] || { echo "Kingmaker requires Node.js 22 or newer (found $(node --version))." >&2; exit 2; }
[ -f "$unit/UNIT.json" ] && [ -f "$unit/engine/payload.json" ] && [ -f "$unit/engine/lib/kingmaker.mjs" ] || {
  echo "This Kingmaker unit is incomplete; nothing was installed." >&2; exit 3;
}
node - "$unit" <<'NODE'
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const unit = JSON.parse(fs.readFileSync(path.join(root, 'UNIT.json')));
const payload = JSON.parse(fs.readFileSync(path.join(root, 'engine', 'payload.json')));
if (unit.schema !== 'kingmaker.unit/1' || unit.unit !== 'kingmaker' || unit.platform !== 'linux' || unit.arch !== 'x64') throw new Error('invalid Linux unit identity');
if (unit.version !== payload.version) throw new Error('unit and payload versions differ');
NODE

rm -rf "$stage" "$backup"
mkdir -p "$(dirname -- "$dest")" "$stage"
cp -R "$unit/engine" "$stage/engine"
cp "$unit/UNIT.json" "$unit/kingmaker" "$unit/PORTABLE-NOTES.txt" "$stage/"
chmod 755 "$stage/kingmaker"

rollback() {
  rm -rf "$stage"
  if [ -d "$backup" ] && [ ! -e "$dest" ]; then mv "$backup" "$dest"; fi
}
trap rollback HUP INT TERM EXIT
if [ -e "$dest" ]; then mv "$dest" "$backup"; fi
mv "$stage" "$dest"
mkdir -p "$bin_dir"
ln -sfn "$dest/kingmaker" "$bin_dir/kingmaker"
rm -rf "$backup"
trap - HUP INT TERM EXIT
echo "Installed Kingmaker $(node -p "require('$dest/engine/package.json').version") in $dest"
echo "Launcher: $bin_dir/kingmaker"
