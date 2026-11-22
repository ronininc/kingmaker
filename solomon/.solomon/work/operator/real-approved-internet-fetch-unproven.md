# Solomon work item — REAL_APPROVED_INTERNET_FETCH_UNPROVEN

- gap id: `real-approved-internet-fetch-unproven`
- class: **OPERATOR** · classification: OPERATOR_APPROVAL_REQUIRED · operator-gated: true
- assignee: operator
- backing proof (referee): `solomon:internet-proof`

## Why this is open
INTERNET_UNPROVEN - Current packaged Solomon executable missing: /Users/robbiebrown/Projects/TSS/desktop/dist/mac-arm64/Solomon.app/Contents/MacOS/Solomon

## Next action
Operator-approve a real outbound fetch against the built app; record the source proof.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:internet-proof
```
