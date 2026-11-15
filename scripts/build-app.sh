#!/bin/sh
# Build the THIN "Kingmaker.app": a normal-window app by default (Dock icon + menu-bar logo; set km.windowMode=bar for the
# old no-window, menu-bar-only agent) that runs its engine headless on the
# runtime of an INSTALLED Kingmaker.app (KINGMAKER_RUNTIME_APP). The standalone app (the engine runtime inside) is
# built by the engine build (it reads this checkout's app/bundle.json, app/ and lib/). People install it with
# Kingmaker Installer (scripts/build-installer.sh), never with this.
#   scripts/build-app.sh            → dist/Kingmaker.app
#   scripts/build-app.sh --install  → also copies it to ~/Applications (replacing an old Sol Ghost.app there)
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
app="${KINGMAKER_APP_OUT:-$here/dist/Kingmaker.app}"
payload="${KINGMAKER_PAYLOAD_OUT:-$here/dist/payload}"
# Candidate outputs are exclusive destinations, never replacement targets.
if [ -n "${KINGMAKER_APP_OUT:-}${KINGMAKER_PAYLOAD_OUT:-}" ]; then
  node --input-type=module - "$app" "$payload" <<'CHECK'
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, basename } from 'node:path';
const [app, payload] = process.argv.slice(2);
const bad = resolve(app) === resolve(payload) || !isAbsolute(app) || !isAbsolute(payload) || basename(app) !== 'Kingmaker.app' || [app,payload].some(p => resolve(p) === '/' || existsSync(p) || (() => { try { lstatSync(p); return true; } catch { return false; } })()) || resolve(app).startsWith(resolve(payload) + '/') || resolve(payload).startsWith(resolve(app) + '/');
if (bad) { console.error('candidate app/payload output must be new, absolute, separate destinations'); process.exit(2); }
CHECK
fi
version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$here/package.json" | head -1)"
if [ -z "${KINGMAKER_APP_OUT:-}${KINGMAKER_PAYLOAD_OUT:-}" ]; then rm -rf "$app"; fi
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/sol-ghost"
swiftc -O -o "$app/Contents/MacOS/Kingmaker" "$here/app/Kingmaker.swift" -framework AppKit -framework ApplicationServices -framework QuartzCore -framework ServiceManagement
# Kingmaker's own ffmpeg (LGPL, VideoToolbox): "make an ad" needs it, and a stock Mac has none.
[ -x "$here/app/Resources/bin/ffmpeg" ] && [ -x "$here/app/Resources/bin/ffprobe" ] || "$here/scripts/build-ffmpeg.sh"
# Kingmaker's own uv: extensions that run on Python (Blender's MCP) need it, and a stock Mac has none.
[ -x "$here/app/Resources/bin/uv" ] || "$here/scripts/fetch-uv.sh"
cp -R "$here/app/Resources/." "$app/Contents/Resources/"
# Kingmaker itself goes in as ONE file, never folder by folder (lib/payload.mjs): the payload holds the code, the CLI
# Hub, the catalogs, the built-in skills and the licences with the list of every file, checked before it is handed on.
# Never addons/: paid add-ons arrive signed, through Ronin Launcher.
node "$here/scripts/build-payload.mjs" --out "$payload"
rm -rf "$app/Contents/Resources/sol-ghost"
tar -xf "$payload/kingmaker-payload.tar" -C "$app/Contents/Resources"
sed -e "s/@VERSION@/$version/g" -e "s/@SOLOMON_BUILD@/borrowed (installed Kingmaker.app)/g" "$here/app/Info.plist" > "$app/Contents/Info.plist"
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
