#!/bin/zsh
# Rebuild vendor/webrtc/webrtc-libs.mjs: the Node WebRTC stack Mia uses to sit in a room call and hear it — werift (a
# pure-JS WebRTC implementation: ICE, DTLS-SRTP, RTP) plus opusscript (the Opus codec, used in its pure asm.js mode so no
# .wasm companion ships) — bundled into ONE file that runs on Kingmaker's own Node, so a stock Mac needs nothing
# installed. Developer-time only (npm + esbuild); the app never runs it. Mirrors scripts/build-office-vendor.sh.
# Versions are pinned; bump only to a release at least two weeks old. Both are MIT (opusscript wraps libopus, BSD).
set -euo pipefail
here=${0:A:h:h}; work=$(mktemp -d); trap 'rm -rf $work' EXIT
cd $work
echo '{"name":"km-webrtc-build","private":true}' > package.json
npm install --ignore-scripts --no-audit --no-fund --save-exact werift@0.25.0 opusscript@0.0.8 esbuild@0.25.12 >/dev/null
printf "export { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift';\nexport { default as OpusScript } from 'opusscript';\n" > entry.mjs
mkdir -p $here/vendor/webrtc
# __dirname/__filename/require are provided so werift's node builtins and opusscript's loader resolve inside the ESM bundle.
./node_modules/.bin/esbuild entry.mjs --bundle --platform=node --format=esm --target=node22 --legal-comments=none --metafile=meta.json \
  --outfile=$here/vendor/webrtc/webrtc-libs.mjs \
  --banner:js="import { createRequire as __kmReq } from 'node:module'; import { fileURLToPath as __kmF } from 'node:url'; import { dirname as __kmD } from 'node:path'; const require = __kmReq(import.meta.url); const __filename = __kmF(import.meta.url); const __dirname = __kmD(__filename);"
node -e "
const fs=require('fs'),path=require('path'),meta=JSON.parse(fs.readFileSync('meta.json'));
const pk=new Set(); for (const f of Object.keys(meta.inputs)) { const m=/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(f); if(m) pk.add(m[1]); }
const out=['Third-party code bundled in vendor/webrtc/webrtc-libs.mjs (Kingmaker meeting-audio stack: werift + opusscript; opusscript runs in asm.js mode, no .wasm shipped).'];
const seen=new Set();
for (const d of [...pk].sort()) { let j; try { j=JSON.parse(fs.readFileSync(path.join(d,'package.json'))); } catch { continue; } // skip nested/non-package paths in the metafile
  if (!j.name || seen.has(j.name)) continue; seen.add(j.name);
  const lic=typeof j.license==='string'?j.license:(j.license?.type||'?');
  if (lic==='?') { console.error('NO LICENCE: '+j.name); process.exit(1); }
  out.push('  '+j.name+'@'+j.version+'  '+lic); }
fs.writeFileSync('$here/vendor/webrtc/THIRD_PARTY_LICENSES.txt', out.join('\n')+'\n');
console.log('Bundled '+pk.size+' packages into vendor/webrtc/webrtc-libs.mjs ('+(fs.statSync('$here/vendor/webrtc/webrtc-libs.mjs').size/1e6).toFixed(1)+' MB).');
"
