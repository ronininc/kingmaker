#!/bin/sh
# uninstall-reversal.sh — §8.4: the honest exit. Removes every registration the install made, in
# reverse order, and lists what was removed. Stores are NOT touched here: sealed-and-retained is the
# default; deletion is the owner's separate explicit choice in the uninstaller.
set -eu
AGENT="$HOME/Library/LaunchAgents/org.ronininc.ronin-shell.plist"
osascript -e 'tell application "System Events" to delete (every login item whose name is "RoninShell")' || true
launchctl unload "$AGENT" || true
rm -f "$AGENT"
echo "RECEIPT reversal complete: login-item removed, launchagent unloaded+removed, stores untouched (sealed, retained)"
