# Agent rules for this repo (Codex, Claude, any coding agent)

Folder rules still apply: `solomon/AGENTS.md` covers everything under `solomon/`.

## Which version is current
Do not assume 4.4.4. Read `docs/CURRENT-VERSION.md` first: production is 4.4.4, this repository's `main` carries unreleased 4.4.5 work, and the owner's installed build reports 4.4.6.

## Driving Kingmaker from an agent: never click the menu bar
Screen-control tools time out on the macOS menu bar. Don't drive Kingmaker's panel by clicking or AX. Submit jobs from the shell instead. Full details: `docs/AUTOMATION-JOBS.md`.

- **Preferred (builds with PR #106, the job inbox):**
  `kingmaker job "<text>" --conversation <name> --json` waits and returns the job id, state, times, a hash of the text, the answer lines and the `bar.log` byte range (the per-job evidence a soak needs).
  `kingmaker job status <id>` checks a job. Add `--no-wait` to return right away.
- **Fallback (installed 0.2.7 / 0.3.0 without the inbox):**
  ```sh
  KEY="$(cat "$HOME/Library/Application Support/sol-ghost/bar-link.key")"
  open -g "kingmaker://bar?text=$(node -p 'encodeURIComponent(process.argv[1])' "<text>")&key=$KEY"
  tail -n 5 "$HOME/Library/Application Support/sol-ghost/logs/bar.log"
  ```
  `open "kingmaker://bar"` with no text just opens the panel.
- **Propose-only.** A job can never approve or cancel anything. The inbox refuses text that starts with yes/no/ok/approve/go ahead/cancel/send it, and `/…` or `:…` commands. Never use the fallback link to approve a waiting action. Approvals are Robbie's.

## Soaks
A soak proves Kingmaker works on real local inference with completed-job evidence (see `docs/SOAK-WORK.md`).
1. Smoke: `kingmaker job "write one sentence about a taco truck in Phoenix" --conversation soak-check --json`
2. Work soak: `node scripts/soak-work.mjs --config soak-config.json --run --baseline catalog/bench/m5-pro-24gb.json --json soak-work-report.json`
3. Bar soak: `node scripts/soak-bar.mjs --rounds 1 --work-config soak-config.json --baseline catalog/bench/m5-pro-24gb.json --json soak-bar-report.json`

`soak-config.json` is the example in `docs/SOAK-WORK.md`. `soak-bar.mjs` needs `"exclusive": true`, and the soaks refuse to start while a model is already loaded, so run them only in a quiet window on the local model server. The Mac has 8 GB of RAM, so keep runs lean.

## Proof and git
- Every "done" names the command that proved it, plus the report file.
- Merge commits only. Never squash, rebase or force-push. Don't publish releases or touch R2 / `latest.json`.
