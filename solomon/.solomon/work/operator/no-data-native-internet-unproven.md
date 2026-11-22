# Solomon work item — NO_DATA_NATIVE_INTERNET_UNPROVEN

- gap id: `no-data-native-internet-unproven`
- class: **OPERATOR** · classification: OPERATOR_APPROVAL_REQUIRED · operator-gated: true
- assignee: operator
- backing proof (referee): `solomon:internet-proof`

## Why this is open
(read the backing proof output for the exact failing assertion)

## Next action
Operator-approve the native no-data source-backed answer against the built app.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:internet-proof
```
