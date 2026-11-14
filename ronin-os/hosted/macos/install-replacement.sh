#!/bin/sh
# install-replacement.sh — §8.2 registration, performed by the installer as its LAST step.
# Registers (account layer only — nothing below it is ever touched):
#   1. the shell's LaunchAgent (KeepAlive supervision; the fleet watchdog pattern)
#   2. the shell as a login item for the owner's account
# Every act is echoed to the install receipt. uninstall-reversal.sh removes exactly this list.
set -eu
AGENT="$HOME/Library/LaunchAgents/org.ronininc.ronin-shell.plist"
cp "/Applications/Kingmaker.app/Contents/Resources/org.ronininc.ronin-shell.plist" "$AGENT"
launchctl load "$AGENT"
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Kingmaker.app/Contents/MacOS/RoninShell", hidden:false}'
echo "RECEIPT replacement registered: launchagent=$AGENT login-item=RoninShell"
