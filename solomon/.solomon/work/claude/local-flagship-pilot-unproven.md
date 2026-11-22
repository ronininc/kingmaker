# Solomon work item — LOCAL_FLAGSHIP_PILOT_UNPROVEN

- gap id: `local-flagship-pilot-unproven`
- class: **BUILD** · classification: CONTROLLED_VALIDATION_BLOCKER · operator-gated: true
- assignee: claude
- backing proof (referee): `solomon:readiness:controlled-validation`

## Why this is open
LOCAL_FLAGSHIP_PILOT_PROOF_FAILED; fresh clean-install validation failed with exit 1

## Next action
Fresh clean-install validation must pass exit 0 (depends on the packaged app).

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:readiness:controlled-validation
```
