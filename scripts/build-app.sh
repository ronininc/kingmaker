#!/bin/sh
# Build a self-contained Kingmaker.app. KINGMAKER_ENGINE_BINARY must name the reviewed native Node/Electron engine
# runtime; builds never borrow an engine from another installed app.
#   scripts/build-app.sh            → dist/Kingmaker.app
#   scripts/build-app.sh --install  → also copies it to ~/Applications (replacing an old Sol Ghost.app there)
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
app="${KINGMAKER_APP_OUT:-$here/dist/Kingmaker.app}"
payload_out="${KINGMAKER_PAYLOAD_OUT:-$here/dist/payload}"
# Task candidates must use a fresh bundle, never overwrite a running installation.
if [ -n "${KINGMAKER_APP_OUT:-}" ]; then
  case "$app" in /*/Kingmaker.app) ;; *) echo "candidate output must be an absolute Kingmaker.app path" >&2; exit 2;; esac
  [ ! -e "$app" ] && [ ! -L "$app" ] || { echo "candidate output already exists" >&2; exit 2; }
fi
if [ -n "${KINGMAKER_PAYLOAD_OUT:-}" ]; then
  case "$payload_out" in /*/payload) ;; *) echo "candidate payload output must be an absolute payload directory" >&2; exit 2;; esac
  [ ! -e "$payload_out" ] && [ ! -L "$payload_out" ] || { echo "candidate payload output already exists" >&2; exit 2; }
fi
if [ "${KINGMAKER_OFFLINE_BUILD:-0}" = 1 ]; then
  for tool in ffmpeg ffprobe uv; do
    [ -x "$here/app/Resources/bin/$tool" ] || { echo "offline build requires reviewed $tool" >&2; exit 2; }
  done
fi
version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$here/package.json" | head -1)"
: "${KINGMAKER_ENGINE_BINARY:?set KINGMAKER_ENGINE_BINARY to the reviewed engine runtime executable}"
: "${KINGMAKER_ENGINE_RESOURCES:?set KINGMAKER_ENGINE_RESOURCES to the reviewed packaged engine resource tree}"
[ -x "$KINGMAKER_ENGINE_BINARY" ] || { echo "KINGMAKER_ENGINE_BINARY is not executable: $KINGMAKER_ENGINE_BINARY" >&2; exit 2; }
node "$here/scripts/runtime-closure.mjs" "$KINGMAKER_ENGINE_RESOURCES"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/sol-ghost"
swiftc -O -o "$app/Contents/MacOS/Kingmaker" "$here/app/Kingmaker.swift" -framework AppKit -framework ApplicationServices -framework QuartzCore -framework ServiceManagement
cp "$KINGMAKER_ENGINE_BINARY" "$app/Contents/MacOS/KingmakerEngine"
chmod 755 "$app/Contents/MacOS/KingmakerEngine"
# Kingmaker's own ffmpeg (LGPL, VideoToolbox): "make an ad" needs it, and a stock Mac has none.
[ -x "$here/app/Resources/bin/ffmpeg" ] && [ -x "$here/app/Resources/bin/ffprobe" ] || "$here/scripts/build-ffmpeg.sh"
# Kingmaker's own uv: extensions that run on Python (Blender's MCP) need it, and a stock Mac has none.
[ -x "$here/app/Resources/bin/uv" ] || "$here/scripts/fetch-uv.sh"
clone_tree() {
  node -e 'const fs=require("node:fs");fs.cpSync(process.argv[1],process.argv[2],{recursive:true,verbatimSymlinks:true,preserveTimestamps:true,mode:fs.constants.COPYFILE_FICLONE})' "$1" "$2"
}
clone_tree "$here/app/Resources" "$app/Contents/Resources"
clone_tree "$KINGMAKER_ENGINE_RESOURCES" "$app/Contents/Resources"
# Kingmaker itself goes in as ONE file, never folder by folder (lib/payload.mjs): the payload holds the code, the CLI
# Hub, the catalogs, the built-in skills and the licences with the list of every file, checked before it is handed on.
# Never addons/: paid add-ons arrive signed, through Ronin Launcher.
node "$here/scripts/build-payload.mjs" --out "$payload_out"
rm -rf "$app/Contents/Resources/sol-ghost"
tar -xf "$payload_out/kingmaker-payload.tar" -C "$app/Contents/Resources"
got="$("$app/Contents/MacOS/KingmakerEngine" "$app/Contents/Resources/sol-ghost/lib/kingmaker.mjs" version)"
[ "$got" = "$version" ] || { echo "bundled engine handshake reported ${got:-nothing}, expected $version" >&2; exit 2; }
sed -e "s/@VERSION@/$version/g" -e "s/@SOLOMON_BUILD@/verified source runtime/g" "$here/app/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
[ -f "$here/scripts/kingmaker-mac-signing.mjs" ] || { echo "Signing Kingmaker.app needs Ronin's own signing tooling, which is not in the public repo: use the released app." >&2; exit 2; }
sign_identity="$(node "$here/scripts/kingmaker-mac-signing.mjs" --identity)"
codesign --force --options runtime --timestamp=none --sign "$sign_identity" "$app"
node "$here/scripts/kingmaker-mac-signing.mjs" --verify "$app"
echo "built $app"
if [ "${1:-}" = "--install" ]; then
  install_dir="${HOME:?}/Applications"
  mkdir -p "$install_dir"
  install_dir="$(cd "$install_dir" && pwd -P)"
  installed_app="$install_dir/Kingmaker.app"

  # Replacing a live bundle can strand the Node CLI and its engine backend after the
  # native wrapper disappears. Match the production installer: ask the signed app to
  # quit, allow its governed shutdown (CRM undock + backend stop) to finish, and refuse
  # the replacement if the wrapper is still alive. Never paper over it with kill -9.
  kingmaker_running() {
    pgrep -f 'Contents/MacOS/(Kingmaker|Sol Ghost)( |$)' >/dev/null 2>&1
  }
  if kingmaker_running; then
    echo "asking the running Kingmaker to stop cleanly"
    osascript -e 'tell application id "com.ronininc.solghost" to quit'
    for _ in $(seq 1 40); do kingmaker_running || break; sleep 1; done
    if kingmaker_running; then
      echo "Kingmaker is still running; use 'kingmaker stop', confirm it exited, and retry." >&2
      exit 1
    fi
  fi

  rm -rf "$installed_app"
  cp -R "$app" "$install_dir/"
  if [ -d "$HOME/Applications/Sol Ghost.app" ]; then mv "$HOME/Applications/Sol Ghost.app" "$HOME/.Trash/Sol Ghost.app.$(date +%s)" && echo "moved the old Sol Ghost.app to the Trash"; fi
  echo "installed ~/Applications/Kingmaker.app"
  if [ -d "/Applications/Kingmaker.app" ]; then
    echo "! A second /Applications/Kingmaker.app exists. Keep one installed copy so Launch Services and Headless Host Mode cannot select different bundles."
  fi
fi
