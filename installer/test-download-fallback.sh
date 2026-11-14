#!/bin/bash
# test-download-fallback.sh — regression test for the installer's download-source ladder.
#
# The 4.5.0 customer install failed because a stale update.json routed every part to an
# update host that 404'd them, and the engine blamed the sha256. This test drives the real
# engine.sh (the one beside this file) in a sandbox HOME against two local HTTP fixtures —
# a fake update host holding a stale key's worth of nothing, and a fake GitHub API — with
# macOS-only tools (plutil, stat, sw_vers, uname, xattr, codesign, ditto) shimmed.
#
#   A  update host 404s the part, GitHub serves it  → the part lands, sha256-verified,
#      the failover is noted with the real HTTP cause, and update.json is untouched.
#   B  both hosts fail                              → the failure message names BOTH causes
#      (HTTP 404 from the update host; the GitHub fallback's own failure), never the sha256.
#
# Exits 0 when both scenarios pass. Fixture-grade: the network is two localhost servers
# and the payload is a 422-byte tar.gz; what is exercised is the engine's real code path.
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ENGINE="$HERE/engine.sh"
[ -f "$ENGINE" ] || { echo "FAIL: no engine.sh beside this test" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required" >&2; exit 0; }

SB="$(mktemp -d "${TMPDIR:-/tmp}/km-fallback-test.XXXXXX")"
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/shims" "$SB/payload" "$SB/updroot"

# ── payload: a tiny Kingmaker.app tar.gz (the part) with a real sha256 ───────────────────
python3 - "$SB" <<'PY'
import hashlib, io, json, os, sys, tarfile
SB = sys.argv[1]
PART = "Kingmaker-v9.9.9-test.tar.gz.part01"
PLIST = (b'<?xml version="1.0" encoding="UTF-8"?>\n'
         b'<plist version="1.0">\n<dict>\n<key>CFBundleIdentifier</key>\n'
         b'<string>com.ronininc.solghost</string>\n</dict>\n</plist>\n')
arc = os.path.join(SB, "payload", PART)
with tarfile.open(arc, "w:gz") as tf:
    for name, data in (("Kingmaker.app/Contents/Info.plist", PLIST),
                       ("Kingmaker.app/Contents/MacOS/KingmakerEngine", b"fixture\n")):
        info = tarfile.TarInfo(name); info.size = len(data); info.mtime = 0
        tf.addfile(info, io.BytesIO(data))
sha = hashlib.sha256(open(arc, "rb").read()).hexdigest()
size = os.path.getsize(arc)
json.dump({"schema": "kingmaker.release/1", "tag": "v9.9.9-test", "version": "9.9.9-test",
           "repo": "ronininc/kingmaker",
           "parts": [{"name": PART, "sha256": sha, "size": size}],
           "app": {"size": size, "sha256": sha, "bundleId": "com.ronininc.solghost",
                   "unpackedBytes": 4096}},
          open(os.path.join(SB, "manifest.json"), "w"))
json.dump({"tag_name": "v9.9.9-test", "assets": [{"name": PART, "id": 111}]},
          open(os.path.join(SB, "release.json"), "w"))
print(sha)
PY
PART_SHA="$(python3 -c "import json;print(json.load(open('$SB/manifest.json'))['parts'][0]['sha256'])")"
PART_NAME="Kingmaker-v9.9.9-test.tar.gz.part01"

# ── fixture servers: upd (404 unless the file is in its root) and gh (API + payload) ─────
cat > "$SB/server.py" <<'PY'
import os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
MODE, PORT, ROOT, EXTRA = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body=b"", extra=None):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers()
        if body: self.wfile.write(body)
    def do_GET(self):
        p = self.path.split("?")[0]
        if MODE == "upd":
            fp = os.path.join(ROOT, os.path.basename(p))
            self._send(200, open(fp, "rb").read()) if os.path.isfile(fp) else self._send(404, b"nf")
            return
        if "/releases/tags/" in p:
            self._send(200, open(EXTRA, "rb").read()); return
        if "/releases/assets/" in p:
            self._send(302, b"", {"Location": "/payload/" + "Kingmaker-v9.9.9-test.tar.gz.part01"}); return
        if p.startswith("/payload/"):
            fp = os.path.join(ROOT, os.path.basename(p))
            self._send(200, open(fp, "rb").read()) if os.path.isfile(fp) else self._send(404, b"nf")
            return
        self._send(404, b"{}")
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY

# ── shims for the macOS-only tools the engine calls before the download phase ───────────
cat > "$SB/shims/plutil" <<'PY'
#!/usr/bin/python3
import json, plistlib, sys
args = sys.argv[1:]
if "-extract" not in args: sys.exit(1)
i = args.index("-extract"); key, mode = args[i + 1], args[i + 2]
try:
    raw = open(args[-1], "rb").read()
    data = json.loads(raw.decode()) if raw.lstrip()[:1] in (b"{", b"[") else plistlib.loads(raw)
except Exception: sys.exit(1)
cur = data
for part in key.split("."):
    try: cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    except Exception: sys.exit(1)
if mode == "json": sys.stdout.write(json.dumps(cur))
elif isinstance(cur, (list, dict)): sys.stdout.write(str(len(cur)))
elif isinstance(cur, bool): sys.stdout.write("true" if cur else "false")
elif cur is None: sys.exit(1)
else: sys.stdout.write(str(cur))
PY
printf '#!/bin/bash\nif [ "${1:-}" = "-f" ] && [ "${2:-}" = "%%z" ]; then exec /usr/bin/stat -c %%s "$3"; fi\nexec /usr/bin/stat "$@"\n' > "$SB/shims/stat"
printf '#!/bin/bash\n[ "${1:-}" = "-productVersion" ] && echo 15.0 || echo "ProductVersion: 15.0"\n' > "$SB/shims/sw_vers"
printf '#!/bin/bash\nif [ "${1:-}" = "-m" ]; then echo arm64; exit 0; fi\nexec /bin/uname "$@"\n' > "$SB/shims/uname"
printf '#!/bin/bash\nexit 0\n' > "$SB/shims/xattr"
printf '#!/bin/bash\nexit 0\n' > "$SB/shims/codesign"
cat > "$SB/shims/df" <<'EOF'
#!/bin/bash
# df shim: the fixture Mac has half a terabyte free (the engine asks df -k <apps dir>;
# a small tmpfs would fail its 2 GB room check for reasons unrelated to this test).
printf 'Filesystem   1024-blocks      Used  Available Capacity Mounted on\n'
printf '/dev/disk0s1 1000000000 1000000 500000000 1%% %s\n' "${2:-/}"
EOF
chmod +x "$SB/shims/"*

run_engine() { # run_engine <label> — fresh sandbox home with the stale update.json
  local label="$1"
  local home="$SB/$label/home"
  mkdir -p "$home/Library/Application Support/sol-ghost"
  printf '{\n  "schema": "kingmaker.update/1",\n  "url": "http://127.0.0.1:8791",\n  "key": "stale-fixture-key"\n}\n' \
    > "$home/Library/Application Support/sol-ghost/update.json"
  shasum -a 256 "$home/Library/Application Support/sol-ghost/update.json" > "$SB/$label/update.sha"
  /usr/bin/env -i \
    HOME="$home" \
    PATH="/usr/bin:/bin" \
    KINGMAKER_PATH="$SB/shims:/usr/bin:/bin" \
    KINGMAKER_GITHUB_API="http://127.0.0.1:8792" \
    KINGMAKER_GITHUB_TOKEN="fixture-token" \
    KINGMAKER_FAIL_AT="download" \
    /bin/bash "$ENGINE" --wake-word Seeker --manifest "$SB/manifest.json" --no-launch \
    > "$SB/$label/stdout.txt" 2>/dev/null
}
wait_port() { local n=0; while [ "$n" -lt 50 ]; do curl -s -o /dev/null "http://127.0.0.1:$1/" && return 0; n=$((n + 1)); sleep 0.1; done; return 1; }

FAILURES=0
check() { if [ "$2" = 0 ]; then echo "ok - $1"; else echo "FAIL - $1"; FAILURES=$((FAILURES + 1)); fi; }

# ── scenario A: update host 404s, GitHub serves ─────────────────────────────────────────
python3 "$SB/server.py" upd 8791 "$SB/updroot" - & UPD_PID=$!
python3 "$SB/server.py" gh 8792 "$SB/payload" "$SB/release.json" & GH_PID=$!
wait_port 8791; wait_port 8792
run_engine scenA
kill "$UPD_PID" "$GH_PID" 2>/dev/null; wait "$UPD_PID" "$GH_PID" 2>/dev/null
A_HOME="$SB/scenA/home"
A_CACHE="$A_HOME/Library/Caches/Kingmaker Installer/v9.9.9-test"
grep -q "The update host could not serve $PART_NAME (HTTP 404 from 127.0.0.1:8791)" "$SB/scenA/stdout.txt"; check "A: failover note names the real HTTP cause" $?
grep -q "GitHub served $PART_NAME after the update host failed" "$SB/scenA/stdout.txt"; check "A: failover success is noted, not silent" $?
[ "$(cat "$A_CACHE/parts/$PART_NAME.ok" 2>/dev/null)" = "$PART_SHA" ]; check "A: part landed via GitHub, sha256 verified (.ok pin)" $?
grep -q "falling back to GitHub" "$A_CACHE/install.log"; check "A: failover written to the install log" $?
[ "$(shasum -a 256 "$A_HOME/Library/Application Support/sol-ghost/update.json" | awk '{print $1}')" = "$(awk '{print $1}' "$SB/scenA/update.sha")" ]
check "A: the stale update.json was not rewritten" $?

# ── scenario B: both hosts fail → one honest message naming both causes ─────────────────
mkdir -p "$SB/emptygh"
python3 "$SB/server.py" upd 8791 "$SB/updroot" - & UPD_PID=$!
python3 "$SB/server.py" gh 8792 "$SB/emptygh" "$SB/release.json" & GH_PID=$!
wait_port 8791; wait_port 8792
run_engine scenB
kill "$UPD_PID" "$GH_PID" 2>/dev/null; wait "$UPD_PID" "$GH_PID" 2>/dev/null
B_OUT="$SB/scenB/stdout.txt"
grep -q "Part $PART_NAME failed to download (HTTP 404 from 127.0.0.1:8791); the GitHub fallback also failed" "$B_OUT"
check "B: failure message names the update host's HTTP 404 and the failed fallback" $?
grep -q "did not download or did not match its sha256" "$B_OUT" && B_LEGACY=1 || B_LEGACY=0
[ "$B_LEGACY" = 0 ]; check "B: the old sha256-blaming message is gone" $?

if [ "$FAILURES" = 0 ]; then echo "PASS: download fallback + honest errors"; exit 0; fi
echo "FAIL: $FAILURES check(s) failed" >&2; exit 1
