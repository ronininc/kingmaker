#!/usr/bin/env bash
# Build a clean ./dist and deploy to Cloudflare Pages. Strips the local demo password and
# REFUSES to deploy if it survives.  ./deploy-cloudflare.sh [--deploy]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DIST="$SRC/dist"
PROJECT="${CF_PAGES_PROJECT:-my-site}"
DEMO_PW="${DEMO_PW:-CHANGE_ME_LOCAL_ONLY}"   # the placeholder your config.js uses

echo "→ Building $DIST"; rm -rf "$DIST"; mkdir -p "$DIST"
( cd "$SRC" && find . -type f ! -path './dist/*' ! -name '*.md' ! -name 'deploy-cloudflare.sh' \
   ! -name '.DS_Store' ! -path './.git/*' \
   -exec sh -c 'mkdir -p "'"$DIST"'/$(dirname "$1")" && cp "$1" "'"$DIST"'/$1"' _ {} \; )

echo "→ Stripping demo credential from config.js"
python3 - "$DIST/assets/js/config.js" <<'PY'
import re,sys; p=sys.argv[1]; s=open(p,encoding='utf-8').read()
s=re.sub(r"password:\s*'[^']*'","password: ''",s)
s=re.sub(r"enabled:\s*\(function[\s\S]*?\}\)\(\),","enabled: false,",s)
open(p,'w',encoding='utf-8').write(s)
PY
if grep -rq "$DEMO_PW" "$DIST"; then echo "✗ ABORT: demo credential still in dist/"; exit 1; fi
grep -q "enabled: false" "$DIST/assets/js/config.js" || { echo "✗ ABORT: demoAccess not disabled"; exit 1; }
echo "✓ credential stripped, demoAccess disabled"

[ "${1:-}" = "--deploy" ] && npx wrangler pages deploy "$DIST" --project-name "$PROJECT" \
  || echo "dist/ ready — deploy with --deploy, or drag dist/ into Cloudflare Pages → Upload assets."
