#!/bin/sh
# Ship uv (Astral, MIT/Apache-2.0) INSIDE Kingmaker.app (app/Resources/bin → Contents/Resources/bin), so extensions that
# run on Python (MCP Bundles of type "uv"/"python", like Blender's) work on a stock Mac: uv fetches its own managed Python.
# The release's own .sha256 is checked before anything is kept.   scripts/fetch-uv.sh [version]
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
v="${1:-${UV_VERSION:-0.13.1}}"
out="$here/app/Resources/bin"
work="$(mktemp -d)"
base="https://github.com/astral-sh/uv/releases/download/$v/uv-aarch64-apple-darwin.tar.gz"
curl -fsSL "$base" -o "$work/uv.tgz"
curl -fsSL "$base.sha256" -o "$work/uv.tgz.sha256"
want="$(cut -d' ' -f1 < "$work/uv.tgz.sha256")"; got="$(shasum -a 256 "$work/uv.tgz" | cut -d' ' -f1)"
[ "$want" = "$got" ] || { echo "uv $v: checksum mismatch ($got != $want): not kept" >&2; exit 1; }
tar -xzf "$work/uv.tgz" -C "$work"
mkdir -p "$out"
cp "$work/uv-aarch64-apple-darwin/uv" "$work/uv-aarch64-apple-darwin/uvx" "$out/"
# uv is MIT OR Apache-2.0: both licence texts ship beside the binaries.
for f in LICENSE-MIT LICENSE-APACHE; do curl -fsSL "https://raw.githubusercontent.com/astral-sh/uv/$v/$f" -o "$out/uv-$f"; done
printf 'uv %s (Astral, MIT OR Apache-2.0), from %s, sha256 %s\n' "$v" "$base" "$got" > "$out/README.uv"
rm -rf "$work"
"$out/uv" --version
