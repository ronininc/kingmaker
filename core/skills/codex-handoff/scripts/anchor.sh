#!/usr/bin/env bash
# anchor.sh — ground yourself in the correct tree before acting on a Codex handoff.
#
# Failure mode this prevents: editing the wrong worktree. A handoff quotes absolute
# paths that usually point at the MAIN repo; the same file exists in your worktree.
# Edit the path the doc printed and your change lands in the wrong tree, invisibly.
#
# Usage: .claude/skills/codex-handoff/scripts/anchor.sh [path/to/HANDOFF.md]
set -euo pipefail

TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$TOP" ]; then
  echo "NOT INSIDE A GIT REPO — cd into the worktree the handoff refers to first." >&2
  exit 1
fi

echo "=== Working-tree anchor ==="
echo "toplevel : $TOP"
echo "branch   : $(git branch --show-current 2>/dev/null || echo '(detached HEAD)')"
echo "HEAD     : $(git log -1 --oneline 2>/dev/null || echo '(no commits)')"
echo
echo "=== Worktrees (which directory maps to which branch) ==="
git worktree list
echo

HANDOFF="${1:-}"
if [ -n "$HANDOFF" ] && [ -f "$HANDOFF" ]; then
  echo "=== Absolute paths quoted in the handoff ==="
  echo "Rule: edit the file at the SAME relative path UNDER '$TOP',"
  echo "      never the raw absolute path the doc prints."
  echo
  paths="$(grep -oE '(/Users|/home)/[A-Za-z0-9._/-]+' "$HANDOFF" | sort -u || true)"
  if [ -z "$paths" ]; then
    echo "  (no absolute paths found in the doc)"
  else
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      case "$p" in
        "$TOP"/*|"$TOP")
          echo "  OK       $p" ;;
        *)
          echo "  OUTSIDE  $p" ;;
      esac
    done <<< "$paths"
    echo
    echo "OUTSIDE = points at another tree (usually the main repo). Do NOT edit there;"
    echo "translate it to the matching path under $TOP."
  fi
else
  echo "(no handoff file passed — re-run with the HANDOFF.md path to scan its quoted paths)"
fi
