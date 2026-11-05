#!/bin/zsh
# Rebuild vendor/office/office-libs.mjs: Kingmaker's office stack (Word, Excel, PowerPoint, PDF) as ONE file that runs on
# Kingmaker's own Node, so a stock Mac needs nothing installed. Developer-time only (npm + esbuild); the app never runs it.
# Versions are pinned; each must be at least two weeks old when bumped. unzipper is stubbed out: it pulls in `buffers`,
# which carries no licence, and only exceljs's streaming reader used it.
set -euo pipefail
here=${0:A:h:h}; work=$(mktemp -d); trap 'rm -rf $work' EXIT
cd $work
echo '{"name":"km-office-build","private":true}' > package.json
npm install --ignore-scripts --no-audit --no-fund --save-exact docx@9.8.1 exceljs@4.4.0 pptxgenjs@4.0.1 pdf-lib@1.17.1 esbuild@0.25.12 >/dev/null
printf "export * as docx from 'docx';\nexport { default as ExcelJS } from 'exceljs';\nexport { default as PptxGenJS } from 'pptxgenjs';\nexport * as pdfLib from 'pdf-lib';\n" > entry.mjs
./node_modules/.bin/esbuild entry.mjs --bundle --platform=node --format=esm --target=node22 --minify --legal-comments=none --metafile=meta.json \
  --alias:unzipper=$here/scripts/office-unzipper-stub.cjs --outfile=$here/vendor/office/office-libs.mjs \
  --banner:js="import { createRequire as __kmReq } from 'node:module'; const require = __kmReq(import.meta.url);"
node -e "
const fs=require('fs'),path=require('path'),meta=JSON.parse(fs.readFileSync('meta.json'));
const pk=new Set(); for (const f of Object.keys(meta.inputs)) { const m=/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(f); if(m) pk.add(m[1]); }
const out=['Third-party code bundled in vendor/office/office-libs.mjs (Kingmaker office stack). jszip is used under its MIT option.'];
for (const d of [...pk].sort()) { const j=JSON.parse(fs.readFileSync(path.join(d,'package.json'))); const lic=typeof j.license==='string'?j.license:(j.license?.type||'?');
  if (lic==='?') { console.error('NO LICENCE: '+j.name); process.exit(1); }
  const lf=fs.readdirSync(d).find(n=>/^(licen[cs]e|copying)/i.test(n));
  out.push('==== '+j.name+'@'+j.version+' ('+lic+')\n'+(lf?fs.readFileSync(path.join(d,lf),'utf8'):'(no licence file in the package; its package.json declares '+lic+')')); }
fs.writeFileSync('$here/vendor/office/THIRD_PARTY_LICENSES.txt', out.join('\n\n'));"
echo "✓ vendor/office rebuilt"
