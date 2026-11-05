#!/bin/bash
# Scripture Armor — Mac breach scan (READ-ONLY).
#
# Runs a fixed battery of stock-macOS checks and writes a plain-text
# report to ~/scripture-scan/report.txt. It changes nothing on the
# machine: no installs, no deletions, no settings touched, no sudo.
# Purpose: answer one question before the armor goes on — does this
# machine show signs of being breached already? (Persistence items,
# platform protections off, network listeners, account/access changes,
# shell hooks, hostile hosts entries.) Every check that cannot run is
# reported as SKIPPED, never silently passed.
set +e
OUT_DIR="$HOME/scripture-scan"
mkdir -p "$OUT_DIR"
R="$OUT_DIR/report.txt"
: > "$R"
say() { echo "$@" >> "$R"; }
run() { # label, command...
  local label="$1"; shift
  say ""
  say "== $label =="
  local out
  out="$("$@" 2>&1)"
  if [ $? -ne 0 ] && [ -z "$out" ]; then say "(SKIPPED: command unavailable or needs privileges)";
  else echo "$out" >> "$R"; fi
}

say "SCRIPTURE ARMOR — MAC BREACH SCAN"
say "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
run "host" sw_vers
say "host name: $(hostname)   user: $(whoami)   arch: $(uname -m)"

run "SIP (want: enabled)" csrutil status
run "Gatekeeper (want: enabled)" spctl --status
run "FileVault (want: On)" fdesetup status
run "Application firewall" /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
run "XProtect version" defaults read /Library/Apple/System/Library/Extensions/XProtect.bundle/Contents/Info.plist CFBundleShortVersionString
run "Automatic update schedule" softwareupdate --schedule

say ""
say "== Persistence: LaunchAgents / LaunchDaemons (non-Apple highlighted in summary) =="
for d in "$HOME/Library/LaunchAgents" /Library/LaunchAgents /Library/LaunchDaemons /System/Library/LaunchAgents /System/Library/LaunchDaemons; do
  [ -d "$d" ] || continue
  say "-- $d"
  for p in "$d"/*.plist; do
    [ -e "$p" ] || continue
    label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$p" 2>/dev/null)"
    prog="$(/usr/libexec/PlistBuddy -c 'Print :Program' "$p" 2>/dev/null)"
    [ -z "$prog" ] && prog="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$p" 2>/dev/null)"
    say "$(basename "$p")  label=${label:-?}  program=${prog:-?}"
  done
done

run "Login items" osascript -e 'tell application "System Events" to get the name of every login item'
run "User crontab" crontab -l
run "System cron directories" ls -la /usr/lib/cron/tabs /etc/cron.d
run "Profiles / MDM enrollment" profiles status -type enrollment
run "Configuration profiles" profiles list

say ""
say "== Network =="
run "Listening TCP ports" lsof -nP -iTCP -sTCP:LISTEN
run "Established connections (first 60)" bash -c "lsof -nP -iTCP -sTCP:ESTABLISHED | head -60"
run "DNS configuration (resolvers)" bash -c "scutil --dns | grep -E 'nameserver\[[0-9]+\]' | sort -u"
run "System proxies" scutil --proxy
say "-- /etc/hosts entries (non-comment)"
grep -vE '^\s*(#|$)' /etc/hosts >> "$R" 2>/dev/null

say ""
say "== Accounts & access =="
run "Local users (uid >= 500)" bash -c "dscl . -list /Users UniqueID | awk '\$2 >= 500'"
run "Remote login (SSH) status" systemsetup -getremotelogin
say "-- authorized_keys files present (contents NOT read)"
find /Users -maxdepth 3 -name authorized_keys 2>/dev/null >> "$R"
ls -la "$HOME/.ssh" >> "$R" 2>&1

say ""
say "== Shell / config hooks (suspicious patterns) =="
for f in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  [ -f "$f" ] || continue
  hits="$(grep -nE 'curl[^|]*\||wget[^|]*\||base64 +-d|base64 +--decode|eval +\$|nc +-e|/dev/tcp/' "$f" 2>/dev/null)"
  if [ -n "$hits" ]; then say "REVIEW $f:"; echo "$hits" >> "$R"; else say "clean: $f"; fi
done

say ""
say "== Software recency =="
say "-- /Applications modified in the last 30 days"
find /Applications -maxdepth 1 -mtime -30 2>/dev/null >> "$R"
say "-- Latest install receipts"
ls -lt /Library/Receipts 2>/dev/null | head -15 >> "$R"
run "System extensions" systemextensionsctl list
run "Homebrew top-level packages (if brew exists)" bash -c "command -v brew >/dev/null && brew list --formula -1 | head -80 || echo '(no brew)'"

say ""
say "== Browser extension directories (names only) =="
ls "$HOME/Library/Application Support/Google/Chrome/Default/Extensions" >> "$R" 2>&1
ls "$HOME/Library/Safari/Extensions" >> "$R" 2>&1

say ""
say "== SUMMARY FLAGS =="
NONAPPLE="$(grep -hE 'label=' "$R" | grep -vE 'com\.apple|label=\?' | wc -l | tr -d ' ')"
say "non-Apple launch items listed above: review each one by name"
say "hosts entries, authorized_keys, shell-hook hits, listeners: review in the sections above"
say "END OF REPORT"
echo "Report written to $R"
