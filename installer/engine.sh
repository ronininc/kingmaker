#!/bin/bash
# Kingmaker install engine. Kingmaker Installer.app runs it when its one button (Download & Install) is pressed and
# shows its "@@km {json}" lines as one progress bar. Everything or nothing: there are no components to pick.
#
#   engine.sh --wake-word "Kingmaker"                  install on this Mac (what the installer runs)
#   engine.sh --inspect                                what is installed, as one JSON line (the installer's first call)
#   engine.sh --wake-word W --prefix DIR [--source D]  dry run: the app, its config and data go under DIR; the shared
#                                                      tools (Ollama, models, Homebrew, SearXNG, the knowledge library)
#                                                      are only checked, never installed
#
# What it does, in order (each download is resumable and sha256-verified; see the README "Installer" section):
#   1 preflight    macOS 14+ (15 for Hands of Horus), Apple silicon, the wake word (1–3 words, letters only), room on disk
#   2 download     the release parts (≤1.9 GB each) → each part's sha256 → the whole archive's sha256 → unpacked into a
#                  staging folder beside the target → the app's bundle id and code signature checked
#   3 prerequisites Apple's Command Line Tools and Homebrew when missing (official package, sha256-pinned; macOS asks
#                  for your password once, in its own dialog)
#   4 tools        Ollama (official build, sha256-pinned) → the abliterated models (each checked against its pinned
#                  registry digest) → Hands of Horus (Peekaboo), sox and Python via Homebrew → SearXNG
#   5 knowledge    the knowledge library (every confirmed corpus) into a staging folder (reused when already complete)
#   6 commit       Kingmaker.app, the cemented wake word (install.json + wake-word.txt, read-only) and the knowledge
#                  library are MOVED into place, journaled; any failure here moves everything back
#   7 launch       Kingmaker opens; the installer quits
#
# Kingmaker's own pieces (the app, its config, its library) are only ever moved into place at step 6, so a failure
# anywhere leaves none of them half-installed. Shared tools installed on the way (Ollama, the models, Homebrew formulas,
# SearXNG) are each installed whole by their own installer and kept, with the verified download cache, so pressing the
# button again picks up where it stopped. The bundle id stays com.ronininc.solghost (macOS permissions carry over) and
# the data folder stays ~/Library/Application Support/sol-ghost (vault, knowledge index).
#
# Test-only switches: --with-tools (with --prefix: run the tool steps for real inside the prefix), KINGMAKER_PATH (the
# whole PATH), KINGMAKER_OLLAMA_URL, KINGMAKER_GITHUB_API, KINGMAKER_FAIL_AT=<step> (fail on purpose at a step).

set -u
set -o pipefail
umask 022
export LC_ALL=C
export COPYFILE_DISABLE=1

HERE="$(cd "$(dirname "$0")" && pwd -P)"
if [ -n "${KINGMAKER_PATH:-}" ]; then export PATH="$KINGMAKER_PATH"; else export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"; fi

WAKE=""; TERMS=""; MANIFEST="$HERE/kingmaker-manifest.json"; SOURCE=""; BASE_URL=""; PREFIX=""; WITH_TOOLS=0; NO_LAUNCH=0; INSPECT=0; PACK=""
# The pinned release-signing public key (build-installer.sh ships it beside engine.sh) and whether an unsigned release
# is refused. The running app passes --require-signed for updates; first install may be transitional (see below).
RELEASE_PUBKEY="$HERE/kingmaker-release-public.pem"; REQUIRE_SIGNED="${KINGMAKER_REQUIRE_SIGNED:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --wake-word) WAKE="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --require-signed) REQUIRE_SIGNED=1; shift ;;
    --release-pubkey) RELEASE_PUBKEY="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --with-tools) WITH_TOOLS=1; shift ;;
    --no-launch) NO_LAUNCH=1; shift ;;
    --inspect) INSPECT=1; shift ;;
    --pack) PACK="${2:-}"; shift 2 ;; # the profile pack the owner picked (lib/mac-profiles.mjs PACKS; the manifest's packs)
    --terms-accepted) TERMS="${2:-}"; shift 2 ;; # sha256 of the TERMS.md the install screen showed (the terms hook)
    *) echo "engine.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

# ── output: one "@@km {json}" line per event (the installer reads these), plus a plain line for people ──────────────
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/ }"; s="${s//$'\n'/ }"; s="${s//$'\r'/ }"
  printf '"%s"' "$s"
}
say() { printf '%s\n' "$*"; }
event() { printf '@@km %s\n' "$1"; }
PHASE_BASE=0; PHASE_SPAN=0; PHASE_LABEL=""
phase() { # phase <base%> <span%> <label>
  PHASE_BASE="$1"; PHASE_SPAN="$2"; PHASE_LABEL="$3"
  say "▸ $3"
  event "{\"t\":\"progress\",\"pct\":$1,\"label\":$(json_str "$3"),\"detail\":\"\"}"
}
progress() { # progress <fraction 0..1> [detail]
  local pct
  pct="$(awk -v b="$PHASE_BASE" -v s="$PHASE_SPAN" -v f="$1" 'BEGIN { if (f < 0) f = 0; if (f > 1) f = 1; printf "%.1f", b + s * f }')"
  event "{\"t\":\"progress\",\"pct\":$pct,\"label\":$(json_str "$PHASE_LABEL"),\"detail\":$(json_str "${2:-}")}"
}
note() { say "  · $*"; event "{\"t\":\"note\",\"text\":$(json_str "$*")}"; }
gb() { awk -v b="$1" 'BEGIN { printf "%.1f GB", b / 1000000000 }'; }

# ── the manifest ─────────────────────────────────────────────────────────────────────────────────────────────────
mf() { plutil -extract "$1" raw -o - "$MANIFEST" 2>/dev/null; }
mfn() { local v; v="$(mf "$1")" || { echo 0; return; }; case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac; }

fsize() { stat -f %z "$1" 2>/dev/null || echo 0; }
sha256() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }

# ── where things go ──────────────────────────────────────────────────────────────────────────────────────────────
REAL_HOME="$HOME"
if [ -n "$PREFIX" ]; then
  mkdir -p "$PREFIX" || { echo "cannot create $PREFIX" >&2; exit 2; }
  PREFIX="$(cd "$PREFIX" && pwd -P)"
  H="$PREFIX/home"; APPS="$PREFIX/Applications"
  if [ "$WITH_TOOLS" = 1 ]; then TOOLS_LIVE=1; SYS_HOME="$H"; SYS_APPS="$APPS"; else TOOLS_LIVE=0; SYS_HOME="$REAL_HOME"; SYS_APPS="/Applications"; fi
else
  H="$HOME"
  if [ -w /Applications ]; then APPS="/Applications"; else APPS="$HOME/Applications"; fi
  TOOLS_LIVE=1; SYS_HOME="$HOME"; SYS_APPS="/Applications"
fi
APP_NAME="Kingmaker.app"
TARGET_APP="$APPS/$APP_NAME"
DATA="$H/Library/Application Support/sol-ghost"
STAGE="$APPS/.kingmaker-install"
DSTAGE="$DATA/.install-staging"
KNOW_TARGET="$DATA/runtime/data/knowledge/sources"
KNOW_STAGE="$DSTAGE/knowledge/sources"
OLLAMA_URL="${KINGMAKER_OLLAMA_URL:-http://127.0.0.1:11434}"
GITHUB_API="${KINGMAKER_GITHUB_API:-https://api.github.com}"

installed_apps() { # every Kingmaker.app copy, without repeating the same Applications folder
  local d seen=""
  for d in "$APPS" "$H/Applications"; do
    case "$seen" in *"|$d|"*) continue ;; esac; seen="$seen|$d|"
    [ -d "$d/$APP_NAME" ] && echo "$d/$APP_NAME"
  done
}
installed_app() { # the preferred installed Kingmaker.app, or nothing
  local first
  first="$(installed_apps | head -1)"
  [ -n "$first" ] || return 1
  echo "$first"
}
legacy_apps() { # older "Sol Ghost.app" copies (same product, same bundle id), one per line
  local d seen=""
  for d in "$APPS" "$H/Applications"; do
    case "$seen" in *"|$d|"*) continue ;; esac; seen="$seen|$d|"
    [ -d "$d/Sol Ghost.app" ] && echo "$d/Sol Ghost.app"
  done
}
cemented_word() { [ -f "$DATA/install.json" ] && plutil -extract wakeWord raw -o - "$DATA/install.json" 2>/dev/null; }

# The Mac, for the profile packs: its memory (GiB as sold), chip, and the pack it should take (lib/mac-profiles.mjs
# classFor: the largest class at or under its memory).
MEM_GB="$(sysctl -n hw.memsize 2>/dev/null | awk '{ printf "%d", $1 / 1073741824 + 0.5 }')"; [ -n "$MEM_GB" ] || MEM_GB=8
CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
REC_PACK=8; for c in 64 48 32 24 16 8; do [ "$MEM_GB" -ge "$c" ] && { REC_PACK="$c"; break; }; done
pack_listed() { local n i=0; n="$(mfn packs)"; while [ "$i" -lt "$n" ]; do [ "$(mf "packs.$i.id")" = "$1" ] && return 0; i=$((i + 1)); done; return 1; }

if [ "$INSPECT" = 1 ]; then
  app="$(installed_app)"; word=""; [ -n "$app" ] && word="$(cemented_word)"
  legacy="$(legacy_apps | head -1)"
  packs="$(plutil -extract packs json -o - "$MANIFEST" 2>/dev/null || echo '[]')"
  free_gb="$(df -k "$HOME" 2>/dev/null | awk 'NR==2 { printf "%.1f", $4 / 1000000 * 1.024 }')"
  printf '{"installed":%s,"app":%s,"legacyApp":%s,"cemented":%s,"wakeWord":%s,"release":%s,"version":%s,"memGb":%s,"chip":%s,"freeGb":%s,"recommendedPack":%s,"packs":%s}\n' \
    "$([ -n "$app" ] && echo true || echo false)" "$(json_str "$app")" "$(json_str "$legacy")" \
    "$([ -n "$word" ] && echo true || echo false)" "$(json_str "$word")" "$(json_str "$(mf tag)")" "$(json_str "$(mf version)")" \
    "$MEM_GB" "$(json_str "$CHIP")" "${free_gb:-0}" "$(json_str "$REC_PACK")" "$packs"
  exit 0
fi

# ── failure, rollback, cleanup ───────────────────────────────────────────────────────────────────────────────────
COMMITTING=0; BG_PID=""; LOCKED=0; LOG=""; AUTH_HEADER=""
JOURNAL="$STAGE/journal"
jot() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$JOURNAL"; }
rollback() {
  [ -f "$JOURNAL" ] || return 0
  say "  ↺ putting everything back"
  local kind a b
  tail -r "$JOURNAL" | while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      moved) [ -e "$b" ] && { rm -rf "$a" 2>/dev/null; mv "$b" "$a"; } ;;
      created) rm -rf "$a" ;;
    esac
  done
  rm -f "$JOURNAL"
}
cleanup() {
  # The background step and its children (curl inside a pull, git/curl under the knowledge bootstrap).
  [ -n "$BG_PID" ] && { pkill -TERM -P "$BG_PID" 2>/dev/null; kill "$BG_PID" 2>/dev/null; }
  [ -n "$AUTH_HEADER" ] && rm -f "$AUTH_HEADER"
  rm -rf "$STAGE/unpack" "$STAGE/ollama" "$STAGE/launcher" "$STAGE/old" "$STAGE/whole.fifo" "$DSTAGE/config"
  [ "$LOCKED" = 1 ] && rm -rf "$STAGE/lock"
  rmdir "$STAGE" 2>/dev/null
  true
}
fail() {
  local msg="$1"
  say "✗ $msg"
  if [ "$COMMITTING" = 1 ]; then rollback; COMMITTING=0; fi
  cleanup
  event "{\"t\":\"failed\",\"message\":$(json_str "$msg"),\"log\":$(json_str "$LOG"),\"nothingInstalled\":true}"
  exit 1
}
fail_at() { [ "${KINGMAKER_FAIL_AT:-}" = "$1" ] && fail "stopped on purpose at $1 (KINGMAKER_FAIL_AT)"; true; }
trap 'fail "Cancelled."' INT TERM HUP

run_logged() { "$@" >> "$LOG" 2>&1; }

# ── 1 preflight ──────────────────────────────────────────────────────────────────────────────────────────────────
phase 0 1 "Checking this Mac"
[ -f "$MANIFEST" ] || fail "This installer carries no release manifest ($MANIFEST)."
SCHEMA="$(mf schema)"; [ "$SCHEMA" = "kingmaker.release/1" ] || fail "The release manifest is not one this installer understands ($SCHEMA)."
TAG="$(mf tag)"; VERSION="$(mf version)"; REPO="$(mf repo)"
case "$TAG" in ''|*[!A-Za-z0-9._-]*) fail "The release manifest has no usable tag." ;; esac
CACHE="$H/Library/Caches/Kingmaker Installer/$TAG"
mkdir -p "$CACHE/parts" || fail "Cannot write the download cache ($CACHE)."
LOG="$CACHE/install.log"
printf '\n=== %s Kingmaker %s install (prefix %s) ===\n' "$(date -u +%FT%TZ)" "$TAG" "${PREFIX:-none}" >> "$LOG"

# Release signature: prove this manifest is the operator's before trusting any sha256 in it. The manifest's sha256
# values are only as trustworthy as the manifest itself; a compromised update host (or a rebuilt installer) could swap
# the payload AND its hashes together. The detached signature ($MANIFEST.sig), verified against the pinned public key
# with stock macOS openssl, is what a thief cannot forge without the OFFLINE private key. See lib/release-signing.mjs.
#   - signature present + verifies  → trusted, proceed.
#   - signature present + fails     → refuse, always (tampering, or wrong key).
#   - signature absent              → refuse if --require-signed / KINGMAKER_REQUIRE_SIGNED=1 (updates do), else warn
#                                      and proceed (a transitional unsigned release; real builds are always signed).
verify_release_signature() {
  local sig="$MANIFEST.sig" bin="$CACHE/.manifest.sig.bin"
  if [ ! -s "$RELEASE_PUBKEY" ]; then
    note "No pinned release key in this installer; cannot verify the release signature."
    [ "$REQUIRE_SIGNED" = 1 ] && fail "A signed release was required, but this installer carries no release key to check it against."
    return 0
  fi
  if [ ! -s "$sig" ]; then
    [ "$REQUIRE_SIGNED" = 1 ] && fail "This release is not signed, and a signed release was required. Refusing it."
    note "This release is not signed. Install it only if you got it straight from Ronin Inc."
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || fail "Cannot verify the release signature: openssl is not available on this Mac."
  base64 -D -i "$sig" -o "$bin" 2>>"$LOG" || base64 -d -i "$sig" -o "$bin" 2>>"$LOG" || fail "The release signature is not valid base64."
  if openssl dgst -sha256 -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:-1 -verify "$RELEASE_PUBKEY" -signature "$bin" "$MANIFEST" >>"$LOG" 2>&1; then
    rm -f "$bin"
    note "Release signature verified: this is Ronin Inc.'s own $TAG."
  else
    rm -f "$bin"
    fail "The release signature does NOT match Ronin Inc.'s key. This copy has been altered or did not come from Ronin Inc. Refusing to install it."
  fi
}
verify_release_signature

validate_wake() {
  local w word n=0 lower
  w="$(printf '%s' "$1" | tr -s ' \t\n' '   ' | sed -e 's/^ *//' -e 's/ *$//')"
  [ -n "$w" ] && [ ${#w} -le 32 ] || return 1
  set -f
  for word in $w; do
    n=$((n + 1))
    case "$word" in *[!A-Za-z]*) set +f; return 1 ;; esac
    if [ ${#word} -lt 2 ] || [ ${#word} -gt 20 ]; then set +f; return 1; fi
  done
  set +f
  [ "$n" -ge 1 ] && [ "$n" -le 3 ] || return 1
  lower="$(printf '%s' "$w" | tr 'A-Z' 'a-z')"
  case "$lower" in yes|no|cancel|stop|quit|exit|ok|okay|hey|hi|sleep|wake|"wake up"|mute|go|"go ahead"|confirm) return 1 ;; esac
  WAKE="$w"
}
validate_wake "$WAKE" || fail "The wake word must be 1 to 3 words, letters only, and not a command word (got \"$WAKE\")."
case "$TERMS" in "") ;; *[!0-9a-f]*) fail "The accepted terms must be named by their sha256." ;; *) [ ${#TERMS} -eq 64 ] || fail "The accepted terms must be named by their sha256." ;; esac

# macOS 14 is the floor: Ollama dropped 13 (0.12.4), and the voice runs on 14's Neural Engine API. Hands of Horus
# (Peekaboo) needs 15; on 14 it is left out, said plainly, and the rest installs (the brew step below).
MACOS="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if [ -z "$PREFIX" ] || [ "$WITH_TOOLS" = 1 ]; then
  [ "${MACOS%%.*}" -ge 14 ] 2>/dev/null || fail "Kingmaker needs macOS 14 (Sonoma) or newer; this Mac has macOS $MACOS. Update it in System Settings → General → Software Update, then run this installer again."
  [ "$(uname -m)" = "arm64" ] || fail "Kingmaker needs an Apple silicon Mac (this one is $(uname -m))."
fi

# A second installer on the same target would fight this one.
mkdir -p "$STAGE" || fail "Cannot write to $APPS."
if mkdir "$STAGE/lock" 2>/dev/null; then LOCKED=1; echo $$ > "$STAGE/lock/pid"; else
  other="$(cat "$STAGE/lock/pid" 2>/dev/null)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then fail "Another Kingmaker install is running (pid $other)."; fi
  rm -rf "$STAGE/lock"; mkdir "$STAGE/lock" && LOCKED=1 && echo $$ > "$STAGE/lock/pid"
fi
rm -rf "$STAGE/unpack" "$STAGE/old" "$JOURNAL"

# Cemented: an installed Kingmaker keeps its wake word. Changing it means deleting Kingmaker and installing again.
KEEP_CONFIG=0
if existing_app="$(installed_app)"; then
  existing="$(cemented_word)"
  if [ -n "$existing" ]; then
    if [ "$(printf '%s' "$existing" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$WAKE" | tr 'A-Z' 'a-z')" ]; then
      fail "Kingmaker is installed with the wake word \"$existing\", cemented at install. To change it, delete Kingmaker (move $existing_app to the Trash) and run this installer again."
    fi
    KEEP_CONFIG=1; WAKE="$existing"
    note "Updating Kingmaker; the wake word stays \"$existing\" (cemented)."
  fi
fi

PART_COUNT="$(mfn parts)"; [ "$PART_COUNT" -ge 1 ] || fail "The release manifest lists no parts."
ARCHIVE_SIZE="$(mfn app.size)"; ARCHIVE_SHA="$(mf app.sha256)"; BUNDLE_ID="$(mf app.bundleId)"
UNPACKED="$(mfn app.unpackedBytes)"; [ "$UNPACKED" -gt 0 ] || UNPACKED=$((ARCHIVE_SIZE * 3 / 2))
# The pack: the owner's pick, else this Mac's own (a release without packs installs as before).
if [ "$(mfn packs)" -gt 0 ]; then
  [ -n "$PACK" ] || PACK="$REC_PACK"
  pack_listed "$PACK" || fail "This release has no \"$PACK\" pack."
  note "Pack: $PACK GB$([ "$PACK" = "$REC_PACK" ] && echo " (recommended for this Mac)" || echo " (your choice; this Mac's own is $REC_PACK GB)")."
else PACK=""; fi
note "Release $TAG (Kingmaker $VERSION): $PART_COUNT part(s), $(gb "$ARCHIVE_SIZE") to download, $(gb "$UNPACKED") installed; this Mac has ${MEM_GB} GB of memory."

# Tool lookups (Ollama, brew, python, a formula's binary): PATH, then the usual app folders.
find_ollama() {
  local p
  p="$(command -v ollama 2>/dev/null)" && { echo "$p"; return 0; }
  for p in "$SYS_APPS/Ollama.app/Contents/Resources/ollama" "$SYS_HOME/Applications/Ollama.app/Contents/Resources/ollama"; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  return 1
}
python_ok() {
  local p
  for p in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$p" >/dev/null 2>&1 || continue
    [ "$(command -v "$p")" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1 && continue # the stub would pop a dialog
    "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1 && return 0
  done
  return 1
}
ollama_up() { curl -fsS --max-time 5 "$OLLAMA_URL/api/tags" -o "$1" 2>/dev/null; }
installed_digest() { # installed_digest <tags.json> <model name> → its digest, or nothing
  local n i name
  n="$(plutil -extract models raw -o - "$1" 2>/dev/null)" || return 1
  i=0
  while [ "$i" -lt "${n:-0}" ]; do
    name="$(plutil -extract "models.$i.name" raw -o - "$1" 2>/dev/null)"
    [ "$name" = "$2" ] && { plutil -extract "models.$i.digest" raw -o - "$1" 2>/dev/null | sed 's/^sha256://'; return 0; }
    i=$((i + 1))
  done
  return 1
}
model_wanted() { # model_wanted <index>: a pack's own model only for that pack; the rest sized to the pack (or this Mac)
  local min max packs mem="${PACK:-$MEM_GB}"
  packs="$(mf "models.$1.packs" || true)"
  if [ -n "$packs" ]; then case ",$packs," in *",${PACK:-$REC_PACK},"*) return 0 ;; *) return 1 ;; esac; fi
  min="$(mfn "models.$1.minMemGb")"; max="$(mfn "models.$1.maxMemGb")"
  [ "$min" -gt 0 ] && [ "$mem" -lt "$min" ] && return 1
  [ "$max" -gt 0 ] && [ "$mem" -ge "$max" ] && return 1
  return 0
}
receipts_complete() { # receipts_complete <sources dir>: every confirmed corpus has its receipt and its files
  local n i id field
  n="$(mfn knowledge.corpora)"; [ "$n" -ge 1 ] || return 1
  i=0
  while [ "$i" -lt "$n" ]; do
    id="$(mf "knowledge.corpora.$i.id")"; field="$(mf "knowledge.corpora.$i.field")"
    [ -f "$1/.receipts/$id.json" ] || return 1
    [ -n "$(ls -A "$1/$field/$id" 2>/dev/null)" ] || return 1
    i=$((i + 1))
  done
  return 0
}

# Room: what is still to download and unpack, plus 2 GB.
CACHED=0; i=0
while [ "$i" -lt "$PART_COUNT" ]; do
  name="$(mf "parts.$i.name")"; sha="$(mf "parts.$i.sha256")"
  [ "$(cat "$CACHE/parts/$name.ok" 2>/dev/null)" = "$sha" ] && CACHED=$((CACHED + $(fsize "$CACHE/parts/$name")))
  i=$((i + 1))
done
NEED=$((ARCHIVE_SIZE - CACHED + UNPACKED + 2000000000))
KNOW_REUSE=""
# Kingmaker's library is its own (operator 2026-10-13): a windowed desktop app's ~/.solomon library is never counted as Kingmaker's.
if receipts_complete "$KNOW_TARGET"; then KNOW_REUSE="$KNOW_TARGET"; fi
if [ -z "$KNOW_REUSE" ] && receipts_complete "$SYS_HOME/.solomon/knowledge/sources"; then note "A desktop app on the same engine keeps a knowledge library on this Mac (~/.solomon/knowledge). Kingmaker does not read it; Kingmaker keeps its own library under its data folder."; fi
if [ -z "$KNOW_REUSE" ] && [ "$TOOLS_LIVE" = 1 ]; then NEED=$((NEED + $(mfn knowledge.totalMB) * 1048576)); fi
if [ "$TOOLS_LIVE" = 1 ] && ! find_ollama >/dev/null; then NEED=$((NEED + 2 * $(mfn ollama.size))); fi
FREE=$(( $(df -k "$APPS" | awk 'NR==2 {print $4}') * 1024 ))
if [ "$FREE" -lt "$NEED" ]; then
  if [ "$TOOLS_LIVE" = 1 ]; then fail "Kingmaker needs about $(gb "$NEED") free; this Mac has $(gb "$FREE"). Free some space and press Download & Install again."; fi
  note "A real install would need about $(gb "$NEED") free; $(gb "$FREE") is free here."
fi
fail_at preflight

# Self-enrollment (operator 2026-10-08: "anyone who downloads it auto gets a Mac key … as easy as possible"): an
# installer that carries enroll.json ({"url", "code"}) asks the update host for THIS Mac's own key, so nobody pastes
# anything. The Mac is named only by a sha256 of its hardware UUID (never the UUID itself, never its computer name:
# that is often a person's name, the owner 2026-10-17); the key comes back once and is kept only in update.json (0600).
# A Mac that already has update.json keeps its key.
ENROLL_FILE="$HERE/enroll.json"
# A Mac that already has update.json (a reinstall) downloads with its own key; otherwise it enrolls first. Either
# way, with no --source/--base-url the release comes from the update host, not GitHub (no sign-in needed).
if [ -z "${KINGMAKER_UPDATE_KEY:-}" ] && [ -s "$DATA/update.json" ] && [ -z "$PREFIX" ]; then
  KINGMAKER_UPDATE_URL="$(plutil -extract url raw -o - "$DATA/update.json" 2>/dev/null || true)"; KINGMAKER_UPDATE_KEY="$(plutil -extract key raw -o - "$DATA/update.json" 2>/dev/null || true)"
fi
if [ -z "${KINGMAKER_UPDATE_KEY:-}" ] && [ -s "$ENROLL_FILE" ] && [ -z "$PREFIX" ]; then
  E_URL="$(plutil -extract url raw -o - "$ENROLL_FILE" 2>/dev/null || true)"; E_CODE="$(plutil -extract code raw -o - "$ENROLL_FILE" 2>/dev/null || true)"
  DEV="$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}' | shasum -a 256 | cut -c1-64)"
  if [ -n "$E_URL" ] && [ -n "$E_CODE" ]; then
    EH="$CACHE/.enroll-header"; ( umask 077; printf 'Authorization: Bearer %s\n' "$E_CODE" > "$EH" )
    if curl -fsS --max-time 30 -H @"$EH" -H 'content-type: application/json' -X POST "${E_URL%/}/enroll" \
         -d "{\"device\":\"$DEV\",\"installId\":\"$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')\"}" -o "$CACHE/.enroll.json" 2>>"$LOG"; then
      KINGMAKER_UPDATE_URL="$(plutil -extract url raw -o - "$CACHE/.enroll.json")"; KINGMAKER_UPDATE_KEY="$(plutil -extract key raw -o - "$CACHE/.enroll.json")"
      note "This Mac is enrolled for Kingmaker updates."
      # Hand the signed install certificate to the Ronin Launcher by storing it where the launcher reads it: a login
      # Keychain generic password (service com.ronininc.ronin-launcher, account kingmaker-install-cert — see the
      # launcher's cert.rs keychain_get). Without this the launcher never receives the cert and the genuine-copy cert
      # check stays inactive. Best-effort: a failure here never fails the install.
      if plutil -extract cert.payload raw -o - "$CACHE/.enroll.json" >/dev/null 2>&1; then
        plutil -extract cert json -o "$CACHE/.cert.json" -- "$CACHE/.enroll.json" >/dev/null 2>&1 \
          && security add-generic-password -U -s "com.ronininc.ronin-launcher" -a "kingmaker-install-cert" \
               -w "$(cat "$CACHE/.cert.json")" >/dev/null 2>>"$LOG" \
          && note "Stored this Mac's Ronin install certificate."
        rm -f "$CACHE/.cert.json"
      fi
    else note "Couldn't enroll this Mac for updates (it still works; run the installer again to retry)."; fi
    rm -f "$EH" "$CACHE/.enroll.json"
  fi
fi
if [ -z "$SOURCE" ] && [ -z "$BASE_URL" ] && [ -n "${KINGMAKER_UPDATE_URL:-}" ] && [ -n "${KINGMAKER_UPDATE_KEY:-}" ]; then
  BASE_URL="${KINGMAKER_UPDATE_URL%/}/$TAG"
fi

# ── 2 download + verify + unpack ─────────────────────────────────────────────────────────────────────────────────
TOKEN=""
if [ -z "$SOURCE" ] && [ -z "$BASE_URL" ]; then
  TOKEN="${KINGMAKER_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
  [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1 && TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -n "$TOKEN" ]; then
  # A private release (a fork's, or a pre-release): assets come through the API with a token, which goes in a
  # 0600 header file (never on a command line, never in a URL) and is removed on exit.
  AUTH_HEADER="$CACHE/.auth-header"
  ( umask 077; printf 'Authorization: Bearer %s\n' "$TOKEN" > "$AUTH_HEADER" )
  curl -fsSL --max-time 60 -H @"$AUTH_HEADER" -H "Accept: application/vnd.github+json" "$GITHUB_API/repos/$REPO/releases/tags/$TAG" -o "$CACHE/release.json" 2>>"$LOG" \
    || fail "Could not read release $TAG of $REPO with the GitHub sign-in on this Mac (gh auth login, or KINGMAKER_GITHUB_TOKEN)."
fi
# The update host (kingmaker update): a release folder behind the update key, which comes in the environment and goes
# in the same 0600 header file, never on a command line or in a URL.
if [ -n "$BASE_URL" ] && [ -n "${KINGMAKER_UPDATE_KEY:-}" ]; then
  AUTH_HEADER="$CACHE/.auth-header"
  ( umask 077; printf 'Authorization: Bearer %s\n' "$KINGMAKER_UPDATE_KEY" > "$AUTH_HEADER" )
fi
asset_id() { # asset_id <name> → the release asset's API id
  local n i
  n="$(plutil -extract assets raw -o - "$CACHE/release.json" 2>/dev/null)" || return 1
  i=0
  while [ "$i" -lt "${n:-0}" ]; do
    [ "$(plutil -extract "assets.$i.name" raw -o - "$CACHE/release.json" 2>/dev/null)" = "$1" ] && { plutil -extract "assets.$i.id" raw -o - "$CACHE/release.json"; return 0; }
    i=$((i + 1))
  done
  return 1
}

# fetch <dest> <sha256> <size> <url|file> <auth 0|1> <bytes already counted> <bytes in this phase>
# Resumable and verified: a cut-off transfer is resumed from where it stopped (curl -C -, a Range request), up to 4
# times; a complete file whose sha256 is wrong is thrown away and fetched again once. The file lands at <dest> only
# when its size and sha256 match; a half-done <dest>.partial is kept for the next press of the button.
fetch() {
  local dest="$1" sha="$2" size="$3" src="$4" auth="$5" before="$6" total="$7" part rc have bad=0 short=0
  if [ -f "$dest" ] && [ "$(cat "$dest.ok" 2>/dev/null)" = "$sha" ] && [ "$(fsize "$dest")" = "$size" ]; then return 0; fi
  rm -f "$dest" "$dest.ok"
  part="$dest.partial"
  while [ "$bad" -lt 2 ] && [ "$short" -lt 4 ]; do
    have="$(fsize "$part")"; [ "$have" -gt "$size" ] && { rm -f "$part"; have=0; }
    if [ "$have" -lt "$size" ]; then
      case "$src" in
        /*) { cp -c "$src" "$part" 2>/dev/null || cp "$src" "$part"; } 2>>"$LOG" & ;; # a local folder: an APFS clone when it can (no extra disk)
        *) if [ "$auth" = 1 ]; then curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -C - -H @"$AUTH_HEADER" -H "Accept: application/octet-stream" -o "$part" "$src" 2>>"$LOG" &
           else curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -C - -o "$part" "$src" 2>>"$LOG" & fi ;;
      esac
      BG_PID=$!
      while kill -0 "$BG_PID" 2>/dev/null; do
        have="$(fsize "$part")"
        progress "$(awk -v a="$before" -v h="$have" -v t="$total" 'BEGIN { print (t > 0) ? (a + h) / t : 0 }')" "$(gb $((before + have))) of $(gb "$total")"
        sleep 0.25
      done
      wait "$BG_PID"; rc=$?; BG_PID=""
      if [ "$rc" = 33 ] || [ "$rc" = 36 ]; then rm -f "$part"; short=$((short + 1)); continue; fi # that server cannot resume: start over
    fi
    have="$(fsize "$part")"
    if [ "$have" = "$size" ]; then
      [ "$(sha256 "$part")" = "$sha" ] && { mv "$part" "$dest" && echo "$sha" > "$dest.ok" && return 0; }
      echo "sha256 mismatch for $(basename "$dest"); fetching it again" >> "$LOG"
      rm -f "$part"; bad=$((bad + 1))
    else
      echo "transfer of $(basename "$dest") stopped at $have of $size bytes; resuming" >> "$LOG"
      short=$((short + 1))
    fi
  done
  return 1
}

phase 1 46 "Downloading Kingmaker"
DONE_BYTES=0; i=0
while [ "$i" -lt "$PART_COUNT" ]; do
  name="$(mf "parts.$i.name")"; sha="$(mf "parts.$i.sha256")"; size="$(mfn "parts.$i.size")"
  case "$name" in ''|*/*|.*) fail "The release manifest has a bad part name." ;; esac
  auth=0
  if [ -n "$SOURCE" ]; then src="$(cd "$SOURCE" && pwd -P)/$name"
  elif [ -n "$BASE_URL" ]; then src="${BASE_URL%/}/$name"; [ -n "$AUTH_HEADER" ] && auth=1
  elif [ -n "$TOKEN" ]; then id="$(asset_id "$name")" || fail "Release $TAG has no asset $name."; src="$GITHUB_API/repos/$REPO/releases/assets/$id"; auth=1
  else src="https://github.com/$REPO/releases/download/$TAG/$name"; fi
  PHASE_LABEL="Downloading Kingmaker (part $((i + 1)) of $PART_COUNT)"
  if ! fetch "$CACHE/parts/$name" "$sha" "$size" "$src" "$auth" "$DONE_BYTES" "$ARCHIVE_SIZE"; then
    if [ -z "$SOURCE" ] && [ -z "$BASE_URL" ] && [ -z "$TOKEN" ] && grep -q 'error: 404\|returned error: 404' "$LOG"; then
      fail "Could not download $name (404): the release is not public, or it is private and this Mac needs a GitHub sign-in (gh auth login)."
    fi
    fail "Part $name did not download or did not match its sha256, twice. The verified parts are kept: press Download & Install again to resume."
  fi
  DONE_BYTES=$((DONE_BYTES + size))
  i=$((i + 1))
done
progress 1 "$(gb "$ARCHIVE_SIZE") downloaded, every part verified"
fail_at download

phase 47 8 "Verifying and unpacking"
mkdir -p "$STAGE/unpack" || fail "Cannot write the staging folder."
rm -f "$STAGE/whole.fifo"; mkfifo "$STAGE/whole.fifo" || fail "Cannot create a pipe in the staging folder."
shasum -a 256 < "$STAGE/whole.fifo" | awk '{print $1}' > "$STAGE/whole.sha" &
SUM_PID=$!
# One pass: the parts, in order, go both to sha256 (the whole archive's pin) and to tar. tar's side drains whatever it
# does not read, so the hash always sees every byte. It runs in the background so the bar moves (by what has landed
# in staging) and Cancel stops it at once.
( ( i=0; while [ "$i" -lt "$PART_COUNT" ]; do cat "$CACHE/parts/$(mf "parts.$i.name")" || exit 1; i=$((i + 1)); done ) \
  | tee "$STAGE/whole.fifo" | { tar -x -z --xattrs -f - -C "$STAGE/unpack" 2>>"$LOG"; rc=$?; cat > /dev/null; exit "$rc"; } ) &
BG_PID=$!
while kill -0 "$BG_PID" 2>/dev/null; do
  landed=$(( $(du -sk "$STAGE/unpack" 2>/dev/null | awk '{print $1}') * 1024 ))
  progress "$(awk -v l="$landed" -v u="$UNPACKED" 'BEGIN { f = (u > 0) ? 0.55 * l / u : 0; print (f > 0.55) ? 0.55 : f }')" "$(gb "$landed") of $(gb "$UNPACKED") unpacked"
  sleep 2
done
wait "$BG_PID"; TAR_RC=$?; BG_PID=""
wait "$SUM_PID"
rm -f "$STAGE/whole.fifo"
GOT_SHA="$(cat "$STAGE/whole.sha" 2>/dev/null)"; rm -f "$STAGE/whole.sha"
[ "$TAR_RC" = 0 ] || fail "Unpacking Kingmaker failed (exit $TAR_RC; is the disk full?). The verified parts are kept; see $LOG."
if [ "$GOT_SHA" != "$ARCHIVE_SHA" ]; then
  rm -rf "$CACHE/parts"
  fail "The reassembled archive does not match the release's sha256 (got ${GOT_SHA:0:12}…). The download cache was cleared; press Download & Install again."
fi
progress 0.6 "archive sha256 verified"
STAGED_APP="$STAGE/unpack/$APP_NAME"
[ -d "$STAGED_APP" ] || fail "The archive does not contain $APP_NAME."
# The bytes are the release's own (every part and the whole matched the manifest this installer carries); a quarantine
# flag that rode along from the build machine is not part of the code seal and would only make macOS ask again.
xattr -dr com.apple.quarantine "$STAGED_APP" 2>/dev/null
GOT_ID="$(plutil -extract CFBundleIdentifier raw -o - "$STAGED_APP/Contents/Info.plist" 2>/dev/null)"
[ "$GOT_ID" = "$BUNDLE_ID" ] || fail "The unpacked app's bundle id is $GOT_ID, not $BUNDLE_ID."
codesign --verify --deep --strict "$STAGED_APP" >>"$LOG" 2>&1 || fail "The unpacked Kingmaker.app fails its code signature check (codesign --verify --deep --strict)."
# The pinned Kingmaker Release certificate (lib/release-identity.mjs): only an app signed by exactly it is installed.
# An update brings the pin from the Kingmaker already on this Mac (KINGMAKER_EXPECT_LEAF), never from the download; a
# first install from the one this installer carries. A copy signed by anyone else never lands, and never inherits the
# owner's permissions.
PIN="${KINGMAKER_EXPECT_LEAF:-}"
[ -n "$PIN" ] || PIN="$(plutil -extract sha1 raw -o - "$HERE/release-identity.json" 2>/dev/null || true)"
case "$PIN" in *[!0-9A-Fa-f]*|"") PIN="" ;; *) [ ${#PIN} -eq 40 ] || PIN="" ;; esac
if [ -n "$PIN" ]; then
  codesign --verify --deep --strict -R="identifier \"com.ronininc.solghost\" and certificate leaf = H\"$PIN\"" "$STAGED_APP" >>"$LOG" 2>&1 \
    || fail "This Kingmaker.app is not signed by Ronin Inc.'s Kingmaker Release certificate, so it was not installed. Download Kingmaker again from ronininc.org."
  note "Kingmaker.app is signed by the Kingmaker Release certificate."
fi
NODE_BIN="$STAGED_APP/Contents/MacOS/KingmakerEngine"; [ -x "$NODE_BIN" ] || NODE_BIN="$STAGED_APP/Contents/MacOS/Solomon"   # before 0.3.0
progress 1 "code signature valid"
note "Kingmaker.app unpacked into staging and verified (bundle id $GOT_ID, signature valid)."
fail_at unpack

# The Ronin Launcher: required with every release that pins it (an older release without a pin installs without it).
# Same source as the parts, sha256 and size checked, its signature checked, staged beside Kingmaker.app. Never opened.
LAUNCHER_STAGED=""
L_ARCHIVE="$(mf launcher.archive)"
if [ -n "$L_ARCHIVE" ]; then
  case "$L_ARCHIVE" in *.zip) ;; *) fail "The release's Ronin Launcher pin is not a zip." ;; esac
  case "$L_ARCHIVE" in */*|.*) fail "The release manifest has a bad Ronin Launcher name." ;; esac
  L_SHA="$(mf launcher.sha256)"; L_SIZE="$(mfn launcher.size)"; L_URL="$(mf launcher.url)"; auth=0
  if [ -n "$SOURCE" ]; then src="$(cd "$SOURCE" && pwd -P)/$L_ARCHIVE"
  elif [ -n "$L_URL" ] && [ "$L_URL" != "null" ]; then src="$L_URL"
  elif [ -n "$BASE_URL" ]; then src="${BASE_URL%/}/$L_ARCHIVE"; [ -n "$AUTH_HEADER" ] && auth=1
  elif [ -n "$TOKEN" ]; then id="$(asset_id "$L_ARCHIVE")" || fail "Release $TAG has no asset $L_ARCHIVE."; src="$GITHUB_API/repos/$REPO/releases/assets/$id"; auth=1
  else src="https://github.com/$REPO/releases/download/$TAG/$L_ARCHIVE"; fi
  phase 55 0 "Getting the Ronin Launcher"   # a small zip: the bar holds where it is
  fetch "$CACHE/Ronin-Launcher.zip" "$L_SHA" "$L_SIZE" "$src" "$auth" 0 "$L_SIZE" || fail "The Ronin Launcher did not download or did not match its sha256. It's a required part of Kingmaker; press Download & Install again."
  rm -rf "$STAGE/launcher"; mkdir -p "$STAGE/launcher"
  ditto -x -k "$CACHE/Ronin-Launcher.zip" "$STAGE/launcher" 2>>"$LOG" || fail "Unpacking the Ronin Launcher failed."
  LAUNCHER_STAGED="$STAGE/launcher/Ronin Launcher.app"
  [ -d "$LAUNCHER_STAGED" ] || fail "The Ronin Launcher zip does not contain Ronin Launcher.app."
  L_ID="$(plutil -extract CFBundleIdentifier raw -o - "$LAUNCHER_STAGED/Contents/Info.plist" 2>/dev/null)"
  [ "$L_ID" = "$(mf launcher.bundleId)" ] || fail "The Ronin Launcher's bundle id is $L_ID, not $(mf launcher.bundleId)."
  xattr -dr com.apple.quarantine "$LAUNCHER_STAGED" 2>/dev/null
  codesign --verify --deep --strict "$LAUNCHER_STAGED" >>"$LOG" 2>&1 || fail "Ronin Launcher.app fails its code signature check."
  note "Ronin Launcher $(mf launcher.version) verified and staged."
else
  note "This release predates the Ronin Launcher; installing Kingmaker without it."
fi
fail_at launcher

# ── 3 prerequisites: Command Line Tools + Homebrew ───────────────────────────────────────────────────────────────
phase 55 5 "Checking Apple's Command Line Tools and Homebrew"
NEED_CLT=0; NEED_BREW=0
xcode-select -p >/dev/null 2>&1 || NEED_CLT=1
command -v brew >/dev/null 2>&1 || NEED_BREW=1
if [ "$NEED_CLT" = 0 ] && [ "$NEED_BREW" = 0 ]; then note "Command Line Tools and Homebrew are already here."
elif [ "$TOOLS_LIVE" = 0 ]; then note "Would install:$([ "$NEED_CLT" = 1 ] && echo " Apple's Command Line Tools")$([ "$NEED_BREW" = 1 ] && echo " Homebrew") (macOS asks for the password once)."
else
  admin="$CACHE/prerequisites.sh"
  : > "$admin"
  if [ "$NEED_CLT" = 1 ]; then
    cat >> "$admin" <<'CLT'
touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
label="$(softwareupdate -l 2>/dev/null | grep -B 1 -E 'Command Line Tools' | awk -F'*' '/^ *\*/ {print $2}' | sed -e 's/^ *Label: //' -e 's/^ *//' | sort -V | tail -n 1)"
[ -n "$label" ] && softwareupdate -i "$label"
rc=$?
rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
[ "$rc" = 0 ] || exit "$rc"
CLT
  fi
  if [ "$NEED_BREW" = 1 ]; then
    BREW_URL="$(mf homebrew.url)"; BREW_SHA="$(mf homebrew.sha256)"; BREW_SIZE="$(mfn homebrew.size)"
    [ -n "$BREW_URL" ] && [ -n "$BREW_SHA" ] || fail "Homebrew is missing and this release carries no pinned Homebrew package."
    fetch "$CACHE/Homebrew.pkg" "$BREW_SHA" "$BREW_SIZE" "$BREW_URL" 0 0 "$BREW_SIZE" || fail "The Homebrew package did not download or did not match its sha256."
    printf 'installer -pkg %q -target /\n' "$CACHE/Homebrew.pkg" >> "$admin"
  fi
  note "macOS will ask for your password once, to install$([ "$NEED_CLT" = 1 ] && echo " Apple's Command Line Tools")$([ "$NEED_BREW" = 1 ] && echo " Homebrew")."
  osascript -e 'on run argv' -e 'do shell script "/bin/sh " & quoted form of (item 1 of argv) with prompt "Kingmaker needs to install Apple’s Command Line Tools and Homebrew." with administrator privileges' -e 'end run' "$admin" >>"$LOG" 2>&1 \
    || fail "Installing the Command Line Tools / Homebrew did not finish (the password was declined, or the install failed)."
  command -v brew >/dev/null 2>&1 || [ "$NEED_BREW" = 0 ] || fail "Homebrew still is not on this Mac after its installer ran."
fi
fail_at prerequisites

# ── 4 tools: Ollama, the models, Homebrew formulas, SearXNG ─────────────────────────────────────────────────────
phase 60 4 "Checking Ollama"
TAGS="$CACHE/ollama-tags.json"
if OLLAMA="$(find_ollama)"; then note "Ollama is here ($OLLAMA)."
elif [ "$TOOLS_LIVE" = 0 ]; then note "Would install Ollama $(mf ollama.version) (official build, sha256 $(mf ollama.sha256 | cut -c1-12)…)."; OLLAMA=""
else
  O_URL="$(mf ollama.url)"; O_SHA="$(mf ollama.sha256)"; O_SIZE="$(mfn ollama.size)"
  [ -n "$O_URL" ] && [ -n "$O_SHA" ] || fail "Ollama is missing and this release carries no pinned Ollama build."
  fetch "$CACHE/Ollama-darwin.zip" "$O_SHA" "$O_SIZE" "$O_URL" 0 0 "$O_SIZE" || fail "Ollama did not download or did not match its sha256."
  rm -rf "$STAGE/ollama"; mkdir -p "$STAGE/ollama"
  ditto -x -k "$CACHE/Ollama-darwin.zip" "$STAGE/ollama" 2>>"$LOG" || fail "Unpacking Ollama failed."
  codesign --verify --deep --strict "$STAGE/ollama/Ollama.app" >>"$LOG" 2>&1 || fail "Ollama.app fails its code signature check."
  if [ -w "$SYS_APPS" ]; then O_DIR="$SYS_APPS"; else O_DIR="$SYS_HOME/Applications"; fi
  mkdir -p "$O_DIR" && mv "$STAGE/ollama/Ollama.app" "$O_DIR/Ollama.app" || fail "Could not put Ollama.app in $O_DIR."
  OLLAMA="$O_DIR/Ollama.app/Contents/Resources/ollama"
  note "Installed Ollama $(mf ollama.version) in $O_DIR."
fi
if ! ollama_up "$TAGS"; then
  if [ "$TOOLS_LIVE" = 1 ] && [ -n "$OLLAMA" ]; then
    nohup "$OLLAMA" serve >> "$CACHE/ollama-serve.log" 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do ollama_up "$TAGS" && break; sleep 1; done
    ollama_up "$TAGS" || fail "Ollama did not start (see $CACHE/ollama-serve.log)."
  else
    : > "$TAGS"; note "Ollama is not answering, so the models can only be listed."
  fi
fi
fail_at ollama

phase 64 16 "Getting the models"
MODEL_COUNT="$(mfn models)"; i=0
while [ "$i" -lt "$MODEL_COUNT" ]; do
  model="$(mf "models.$i.name")"; pin="$(mf "models.$i.digest")"; msize="$(mfn "models.$i.size")"
  if ! model_wanted "$i"; then i=$((i + 1)); continue; fi
  PHASE_LABEL="Getting the models"
  have="$(installed_digest "$TAGS" "$model")"
  if [ -n "$have" ] && { [ -z "$pin" ] || [ "$have" = "$pin" ]; }; then
    note "$model is here$([ -n "$pin" ] && echo ", digest matches the release's pin")."
  elif [ "$TOOLS_LIVE" = 0 ]; then
    note "Would pull $model$([ "$msize" -gt 0 ] && echo " ($(gb "$msize"))")$([ -n "$have" ] && echo "; this Mac has another revision")."
  else
    : > "$CACHE/pull.err"; rm -f "$CACHE/pull.ok"
    # In the background, so Cancel (SIGTERM) stops a multi-GB pull at once instead of after it.
    ( curl -sN --max-time 7200 "$OLLAMA_URL/api/pull" -d "{\"model\":\"$model\",\"stream\":true}" 2>>"$LOG" | while IFS= read -r line; do
      case "$line" in *'"error"'*) printf '%s\n' "$line" >> "$CACHE/pull.err" ;; esac
      case "$line" in *'"status":"success"'*) touch "$CACHE/pull.ok" ;; esac
      t="$(printf '%s' "$line" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"; c="$(printf '%s' "$line" | sed -n 's/.*"completed":\([0-9]*\).*/\1/p')"
      [ -n "$t" ] && [ -n "$c" ] && [ "$t" -gt 0 ] && progress "$(awk -v i="$i" -v n="$MODEL_COUNT" -v c="$c" -v t="$t" 'BEGIN { print (i + c / t) / n }')" "$model: $(gb "$c") of $(gb "$t")"
    done ) &
    BG_PID=$!; wait "$BG_PID"; BG_PID=""
    [ -f "$CACHE/pull.ok" ] || fail "Pulling $model failed: $(head -c 300 "$CACHE/pull.err")"
    ollama_up "$TAGS" || fail "Ollama stopped answering after pulling $model."
    have="$(installed_digest "$TAGS" "$model")"
    if [ -n "$pin" ] && [ "$have" != "$pin" ]; then
      fail "$model came down as ${have:0:12}…, not the ${pin:0:12}… this release was built and tested with (it changed upstream). A newer release pins the new one."
    fi
    note "Pulled $model ($([ -n "$pin" ] && echo "digest matches the pin" || echo "digest ${have:0:12}…, unpinned"))."
  fi
  progress "$(awk -v i="$i" -v n="$MODEL_COUNT" 'BEGIN { print (i + 1) / n }')"
  i=$((i + 1))
done
fail_at models

phase 80 5 "Getting Hands of Horus, sox and Python"
BREW_COUNT="$(mfn brew)"; i=0
while [ "$i" -lt "$BREW_COUNT" ]; do
  formula="$(mf "brew.$i.formula")"; bin="$(mf "brew.$i.bin")"; check="$(mf "brew.$i.check")"; label="$(mf "brew.$i.label")"
  present=1; minm="$(mf "brew.$i.minMacos")"
  if [ -n "$minm" ] && [ "${MACOS%%.*}" -lt "${minm%%.*}" ] 2>/dev/null; then
    note "$label needs macOS $minm; this Mac has $MACOS, so it's left out. Kingmaker works without it (it can't click and type in other apps). Update macOS and run this installer again to add it."
    progress "$(awk -v i="$i" -v n="$BREW_COUNT" 'BEGIN { print (i + 1) / n }')"; i=$((i + 1)); continue
  fi
  if [ "$check" = "python3.10+" ]; then python_ok || present=0
  elif [ -n "$bin" ]; then command -v "$bin" >/dev/null 2>&1 || present=0; fi
  if [ "$present" = 1 ]; then note "$label is here."
  elif [ "$TOOLS_LIVE" = 0 ]; then note "Would install $label (brew install $formula)."
  else
    run_logged brew install "$formula" || fail "brew install $formula failed; see $LOG."
    note "Installed $label."
  fi
  progress "$(awk -v i="$i" -v n="$BREW_COUNT" 'BEGIN { print (i + 1) / n }')"
  i=$((i + 1))
done
fail_at brew

phase 85 3 "Setting up SearXNG (private web search)"
SX_SCRIPT="$STAGED_APP/$(mf searxng.script)"
SX_ROOT="$SYS_HOME/Library/Application Support/solomon-desktop/services/searxng-native"
if [ -z "$(mf searxng.script)" ] || [ ! -f "$SX_SCRIPT" ]; then fail "This Kingmaker.app carries no SearXNG installer."; fi
if [ "$TOOLS_LIVE" = 0 ]; then
  out="$(SOLOMON_SEARXNG_NATIVE_ROOT="$SX_ROOT" ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$SX_SCRIPT" --dry-run 2>&1)" || fail "SearXNG's installer did not run under Kingmaker's own runtime: $(printf '%s' "$out" | tail -c 300)"
  note "SearXNG: $(printf '%s' "$out" | head -1) (dry run, under Kingmaker's own runtime)"
else
  SOLOMON_SEARXNG_NATIVE_ROOT="$SX_ROOT" ELECTRON_RUN_AS_NODE=1 run_logged "$NODE_BIN" "$SX_SCRIPT" || fail "SearXNG's installer failed; see $LOG."
  note "SearXNG is set up in $SX_ROOT."
fi
fail_at searxng

# Kingmaker Phone away from home (Tailscale): default-on, optional. Tailscale's own official Mac package, pinned by
# sha256 in the release manifest (never redistributed — fetched from Tailscale, the way Ollama is). It gives the Mac a
# stable name + 100.x address so the phone reaches it on cellular. Skipped when already present, unpinned, or opted out
# (KINGMAKER_NO_TAILSCALE). The iPhone side is the App Store Tailscale app (the launcher shows a QR). Kingmaker Phone is
# free and still works on the home Wi-Fi without this.
phase 87 1 "Kingmaker Phone away from home (Tailscale)"
TS_URL="$(mf tailscale.url)"; TS_SHA="$(mf tailscale.sha256)"; TS_SIZE="$(mfn tailscale.size)"
if [ -n "${KINGMAKER_NO_TAILSCALE:-}" ]; then
  note "Skipping Tailscale (KINGMAKER_NO_TAILSCALE set); Kingmaker Phone will work on your home Wi-Fi only."
elif [ -d "$SYS_APPS/Tailscale.app" ] || [ -d "$SYS_HOME/Applications/Tailscale.app" ] || command -v tailscale >/dev/null 2>&1; then
  note "Tailscale is already here; Kingmaker Phone can work away from home."
elif [ -z "$TS_URL" ] || [ "$TS_URL" = "null" ] || [ -z "$TS_SHA" ] || [ "$TS_SHA" = "null" ]; then
  note "This release carries no pinned Tailscale build, so Kingmaker Phone stays home-Wi-Fi only (add Tailscale from tailscale.com to use it away from home)."
elif [ "$TOOLS_LIVE" = 0 ]; then
  note "Would install Tailscale $(mf tailscale.version) (official build from Tailscale, sha256 $(printf '%s' "$TS_SHA" | cut -c1-12)…), so Kingmaker Phone works on cellular."
else
  fetch "$CACHE/Tailscale.pkg" "$TS_SHA" "$TS_SIZE" "$TS_URL" 0 0 "$TS_SIZE" || fail "Tailscale did not download or did not match its sha256."
  ts_admin="$STAGE/tailscale-admin.sh"; printf '#!/bin/sh\nset -e\n' > "$ts_admin"
  printf 'installer -pkg %q -target /\n' "$CACHE/Tailscale.pkg" >> "$ts_admin"
  if osascript -e 'on run argv' -e 'do shell script "/bin/sh " & quoted form of (item 1 of argv) with prompt "Kingmaker is installing Tailscale so Kingmaker Phone works away from home." with administrator privileges' -e 'end run' "$ts_admin" >>"$LOG" 2>&1; then
    note "Installed Tailscale $(mf tailscale.version). Open Tailscale once and sign in to use Kingmaker Phone away from home."
  else
    note "Tailscale didn't install (you can add it later from tailscale.com); Kingmaker Phone will work on your home Wi-Fi for now."
  fi
fi
fail_at tailscale

# ── 5 the knowledge library ──────────────────────────────────────────────────────────────────────────────────────
phase 88 9 "Getting the knowledge library"
KNOW_SCRIPT="$STAGED_APP/$(mf knowledge.script)"
KNOW_STAGED=0
[ -n "$(mf knowledge.script)" ] && [ -f "$KNOW_SCRIPT" ] || fail "This Kingmaker.app carries no knowledge library installer."
if [ -n "$KNOW_REUSE" ]; then note "The knowledge library is already complete ($KNOW_REUSE): every confirmed corpus has its receipt."
elif [ "$TOOLS_LIVE" = 0 ]; then
  out="$(SOLOMON_CORPUS_DIR="$KNOW_STAGE" HOME="$SYS_HOME" ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$KNOW_SCRIPT" --dry-run 2>&1)" || fail "The knowledge library installer did not run under Kingmaker's own runtime."
  note "Would fetch $(mfn knowledge.corpora) confirmed corpora ($(mfn knowledge.totalMB) MB): $(printf '%s' "$out" | grep -c '▸') planned by the bundled bootstrap (dry run)."
  rm -rf "$DSTAGE/knowledge"
else
  mkdir -p "$KNOW_STAGE"
  SOLOMON_CORPUS_DIR="$KNOW_STAGE" HOME="$SYS_HOME" ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$KNOW_SCRIPT" >> "$LOG" 2>&1 &
  BG_PID=$!
  total="$(mfn knowledge.corpora)"
  while kill -0 "$BG_PID" 2>/dev/null; do
    done_n="$(ls "$KNOW_STAGE/.receipts" 2>/dev/null | grep -c '\.json$')"
    progress "$(awk -v d="$done_n" -v t="$total" 'BEGIN { print (t > 0) ? d / t : 0 }')" "$done_n of $total corpora"
    sleep 1
  done
  wait "$BG_PID"; BG_PID=""
  receipts_complete "$KNOW_STAGE" || fail "The knowledge library is not complete (a corpus failed to download). What came down is kept: press Download & Install again to resume."
  KNOW_STAGED=1
  note "The knowledge library is complete in staging ($total corpora)."
fi
fail_at knowledge

# ── 6 commit: everything Kingmaker owns moves into place, journaled ──────────────────────────────────────────────
phase 97 2 "Installing"
mkdir -p "$DSTAGE/config"
if [ "$KEEP_CONFIG" = 0 ]; then
  # The terms hook: which TERMS.md text was accepted on the install screen (its sha256), when the installer passed it.
  TERMS_JSON=""
  [ -n "$TERMS" ] && TERMS_JSON="$(printf '\n  "termsAccepted": { "sha256": "%s", "at": "%s" },' "$TERMS" "$(date -u +%FT%TZ)")"
  printf '{\n  "schema": "kingmaker.install/1",\n  "product": "Kingmaker",\n  "wakeWord": %s,\n  "cementedAt": "%s",\n  "release": %s,\n  "installer": "engine.sh",%s\n  "note": "Cemented at install. To change the wake word, delete Kingmaker and install it again."\n}\n' \
    "$(json_str "$WAKE")" "$(date -u +%FT%TZ)" "$(json_str "$TAG")" "$TERMS_JSON" > "$DSTAGE/config/install.json"
  printf 'Hey %s\n' "$WAKE" > "$DSTAGE/config/wake-word.txt"
  chmod 0444 "$DSTAGE/config/install.json" "$DSTAGE/config/wake-word.txt"
  [ "$(plutil -extract wakeWord raw -o - "$DSTAGE/config/install.json")" = "$WAKE" ] || fail "The install config did not read back."
fi

# A running Kingmaker (or Sol Ghost) is asked to quit first: never in a dry run.
if [ -z "$PREFIX" ] && pgrep -f 'Contents/MacOS/(Kingmaker|Sol Ghost)$' >/dev/null 2>&1; then
  note "Asking the running Kingmaker to quit."
  osascript -e 'tell application id "com.ronininc.solghost" to quit' >>"$LOG" 2>&1
  for _ in $(seq 1 40); do pgrep -f 'Contents/MacOS/(Kingmaker|Sol Ghost)$' >/dev/null 2>&1 || break; sleep 1; done
  pgrep -f 'Contents/MacOS/(Kingmaker|Sol Ghost)$' >/dev/null 2>&1 && fail "Kingmaker is still running. Quit it (or run: kingmaker stop) and press Download & Install again."
fi

COMMITTING=1
: > "$JOURNAL"
mkdir -p "$STAGE/old"
if [ -e "$TARGET_APP" ]; then mv "$TARGET_APP" "$STAGE/old/$APP_NAME" || fail "Could not move the old Kingmaker.app aside."; jot moved "$TARGET_APP" "$STAGE/old/$APP_NAME"; fi
n=0
installed_apps | while IFS= read -r old; do
  [ -n "$old" ] && [ "$old" != "$TARGET_APP" ] || continue
  n=$((n + 1)); mv "$old" "$STAGE/old/Kingmaker.app.duplicate.$n" || fail "Could not move the duplicate $old aside."; jot moved "$old" "$STAGE/old/Kingmaker.app.duplicate.$n"
done
n=0
legacy_apps | while IFS= read -r old; do echo "$old"; done > "$STAGE/legacy.list"
while IFS= read -r old; do
  [ -n "$old" ] || continue
  n=$((n + 1)); mv "$old" "$STAGE/old/Sol Ghost.app.$n" || fail "Could not move the old $old aside."; jot moved "$old" "$STAGE/old/Sol Ghost.app.$n"
done < "$STAGE/legacy.list"
rm -f "$STAGE/legacy.list"
fail_at commit-aside
mv "$STAGED_APP" "$TARGET_APP" || fail "Could not move Kingmaker.app into $APPS."; jot moved "$STAGED_APP" "$TARGET_APP"
fail_at commit-app
if [ -n "$LAUNCHER_STAGED" ]; then
  L_TARGET="$APPS/Ronin Launcher.app"
  if [ -e "$L_TARGET" ]; then mv "$L_TARGET" "$STAGE/old/Ronin Launcher.app" || fail "Could not move the old Ronin Launcher.app aside."; jot moved "$L_TARGET" "$STAGE/old/Ronin Launcher.app"; fi
  mv "$LAUNCHER_STAGED" "$L_TARGET" || fail "Could not move Ronin Launcher.app into $APPS."; jot moved "$LAUNCHER_STAGED" "$L_TARGET"
fi
fail_at commit-launcher
if [ "$KNOW_STAGED" = 1 ]; then
  if [ -d "$KNOW_TARGET" ]; then mv "$KNOW_TARGET" "$STAGE/old/knowledge-sources" || fail "Could not move the old knowledge folder aside."; jot moved "$KNOW_TARGET" "$STAGE/old/knowledge-sources"; fi
  if [ ! -d "$(dirname "$KNOW_TARGET")" ]; then mkdir -p "$(dirname "$KNOW_TARGET")" && jot created "$(dirname "$KNOW_TARGET")"; fi
  mv "$KNOW_STAGE" "$KNOW_TARGET" || fail "Could not move the knowledge library into place."; jot moved "$KNOW_STAGE" "$KNOW_TARGET"
fi
fail_at commit-knowledge
if [ "$KEEP_CONFIG" = 0 ]; then
  if [ ! -d "$DATA" ]; then mkdir -p "$DATA" && jot created "$DATA"; fi
  for f in install.json wake-word.txt; do
    if [ -e "$DATA/$f" ]; then mv "$DATA/$f" "$STAGE/old/$f" || fail "Could not move the old $f aside."; jot moved "$DATA/$f" "$STAGE/old/$f"; fi
    mv "$DSTAGE/config/$f" "$DATA/$f" || fail "Could not write $f."; jot moved "$DSTAGE/config/$f" "$DATA/$f"
  done
fi
fail_at commit-config
ALIAS="$H/Library/Application Support/Kingmaker"
if [ ! -e "$ALIAS" ] && [ ! -L "$ALIAS" ]; then ln -s sol-ghost "$ALIAS" && jot created "$ALIAS"; fi
fail_at commit-done
COMMITTING=0

# Done: the old copies go (an old Sol Ghost.app to the Trash, not deleted), the download cache is cleared.
mkdir -p "$H/.Trash"
for old in "$STAGE/old/Sol Ghost.app."*; do [ -e "$old" ] && mv "$old" "$H/.Trash/Sol Ghost $(date +%Y%m%d-%H%M%S)-$RANDOM.app"; done
[ -e "$STAGE/old/knowledge-sources" ] && mv "$STAGE/old/knowledge-sources" "$H/.Trash/Kingmaker knowledge (replaced $(date +%Y%m%d-%H%M%S))"
rm -f "$JOURNAL"
cleanup
rm -rf "$CACHE/parts" "$DSTAGE"
progress 1 "installed"
# The pack becomes the Mac profile (calibration.json macProfile.profile, Customize → Mac profile): "auto" when it is this
# Mac's own, else the class the owner picked. Other calibration is kept.
if [ -n "$PACK" ]; then
  want="$([ "$PACK" = "$REC_PACK" ] && echo auto || echo "$PACK")"; cal="$DATA/calibration.json"
  if [ -s "$cal" ] && plutil -lint "$cal" >/dev/null 2>&1; then
    plutil -extract macProfile json -o /dev/null "$cal" 2>/dev/null || plutil -insert macProfile -dictionary "$cal" 2>>"$LOG"
    plutil -replace macProfile.profile -string "$want" "$cal" 2>>"$LOG" || note "Could not record the pack in $cal."
  else ( umask 077; printf '{\n  "schema": 1,\n  "macProfile": { "profile": "%s" }\n}\n' "$want" > "$cal" ); fi
  note "Mac profile: $want."
fi
note "Kingmaker.app is in $APPS; the wake word \"$WAKE\" is cemented in $DATA/install.json."
# Where updates come from (kingmaker update reads it): written when the installer was given an update host and key.
if [ -n "${KINGMAKER_UPDATE_URL:-}" ] && [ -n "${KINGMAKER_UPDATE_KEY:-}" ]; then
  ( umask 077; printf '{\n  "schema": "kingmaker.update/1",\n  "url": %s,\n  "key": %s\n}\n' "$(json_str "$KINGMAKER_UPDATE_URL")" "$(json_str "$KINGMAKER_UPDATE_KEY")" > "$DATA/update.json" )
  note "Updates come from $KINGMAKER_UPDATE_URL."
fi
# Ronin pairing intent (lib/ronin-pairing.mjs): an installer that carries pair.json ({"crm": "ronininc"}) marks this Mac
# as a Ronin Mac, so Kingmaker's first start shows a pairing code and opens Connections; the owner approves it on the
# site and the Mac saves its keys in the Keychain. pair.json carries no key and no code. An existing pairing is kept.
if [ -z "$PREFIX" ] && [ -s "$HERE/pair.json" ] && [ "$(plutil -extract crm raw -o - "$HERE/pair.json" 2>/dev/null || true)" = "ronininc" ] && [ ! -s "$DATA/ronin-pairing.json" ]; then
  ( umask 077; printf '{\n  "schema": 1,\n  "crm": "ronininc",\n  "want": true\n}\n' > "$DATA/ronin-pairing.json" )
  note "When Kingmaker starts it shows a code to pair this Mac with Ronin CRM (Connections, Pair a Mac)."
fi

# ── 7 launch ─────────────────────────────────────────────────────────────────────────────────────────────────────
LAUNCHED=false
if [ -z "$PREFIX" ] && [ "$NO_LAUNCH" = 0 ]; then
  open "$TARGET_APP" >>"$LOG" 2>&1 && LAUNCHED=true
fi
phase 100 0 "Kingmaker is installed"
event "{\"t\":\"done\",\"app\":$(json_str "$TARGET_APP"),\"wakeWord\":$(json_str "$WAKE"),\"release\":$(json_str "$TAG"),\"launched\":$LAUNCHED,\"dryRun\":$([ -n "$PREFIX" ] && echo true || echo false)}"
exit 0
