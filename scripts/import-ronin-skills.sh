#!/bin/zsh
# Import Ronin's own skills into Kingmaker's core pack. Run it yourself, by hand: it copies Ronin's skills out of your
# Claude account's synced skills folder into this source-available repo (core/skills/, public) and your private
# install (private-skills/, never in the repo). Nothing is committed: read `git diff --stat` and commit if it's right.
#   zsh scripts/import-ronin-skills.sh
set -euo pipefail
here=${0:A:h:h}
src=$(ls -d ~/.claude/skills/synced/*/ | head -1)
state=${SOL_GHOST_HOME:-$HOME/Library/Application Support/sol-ghost}
public=(website-build-standard service-business-website big-box-store business-profile-recon site-media-fetch
  spanish-regional-localization wholesale-real-estate immersive-evidence-workspace cloudflare-ordering-worker clover-operations-command)
private=(custom-lead-generator profiler)

for n in $public; do
  [[ -f "$src/$n/SKILL.md" ]] || { echo "skip $n (not in $src)"; continue; }
  rsync -a --delete --exclude __pycache__ --exclude .DS_Store --exclude tests "$src/$n/" "$here/core/skills/$n/"
  printf 'Copyright (c) 2026 Ronin Inc.\nPart of Kingmaker, under Kingmaker'"'"'s LICENSE (see the repository root).\n' > "$here/core/skills/$n/LICENSE"
  echo "+ core/skills/$n"
done

# Remove the owner's own clients and CRM from the public copies; say Kingmaker where they say Claude.
cd "$here/core/skills"
sed -i '' 's/The last-mile media piece of the Orosolu build pipeline\./The last-mile media piece of a website build pipeline./' site-media-fetch/SKILL.md
sed -i '' 's#\[\[client-sites\]\] / \[\[orosolu\]\] notes#your notes on the client#g' spanish-regional-localization/SKILL.md spanish-regional-localization/references/regional-glossary.md
sed -i '' 's#Already validated with this client base — see your notes on the client for La Tiendita Colombiana\.#Already validated on real client sites.#' spanish-regional-localization/references/regional-glossary.md
sed -i '' -e 's/how Claude reasons and acts/how Kingmaker reasons and acts/' -e 's/^Claude may call/Kingmaker may call/' clover-operations-command/SKILL.md
echo; echo "Left to read by eye (names of clients, people, or Claude):"
grep -rnoiE "orosolu|tiendita|lupita|hector|yordi|robbie|ericka|claude" $public 2>/dev/null | sort | uniq -c | sort -rn | head -30 || true

for n in $private; do
  [[ -f "$src/$n/SKILL.md" ]] || { echo "skip $n"; continue; }
  mkdir -p "$state/private-skills"
  rsync -a --delete --exclude __pycache__ --exclude .DS_Store "$src/$n/" "$state/private-skills/$n/"
  echo "+ private: $state/private-skills/$n (your Mac only)"
done
echo; echo "Next: cd $here && node --test test/core-pack.test.mjs && git status --short core/"
