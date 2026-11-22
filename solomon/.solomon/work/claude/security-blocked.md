# Solomon work item — SECURITY_BLOCKED

- gap id: `security-blocked`
- class: **CODE** · classification: TRUE_FAILURE · operator-gated: false
- assignee: claude
- backing proof (referee): `npm audit --omit=dev`

## Why this is open
server/app/root npm audit totals high=6, critical=0, moderate=0; dependency risk register present

## Next action
Resolve the HIGH-severity npm advisories (audit fix / pinned upgrades) across root, server, app.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm audit --omit=dev
```
