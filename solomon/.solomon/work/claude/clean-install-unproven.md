# Solomon work item — CLEAN_INSTALL_UNPROVEN

- gap id: `clean-install-unproven`
- class: **BUILD** · classification: CONTROLLED_VALIDATION_BLOCKER · operator-gated: true
- assignee: claude
- backing proof (referee): `solomon:readiness:controlled-validation`

## Why this is open
CLEAN_INSTALL_UNPROVEN - Installed runtime health did not become ok:true (fetch failed).; nativeInternetQuestion=UNPROVEN

## Next action
Build + package the desktop .app, then rerun clean-install health until runtime health returns ok:true.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:readiness:controlled-validation
```
