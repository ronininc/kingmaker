# Solomon work item — DEPLOYMENT_RUNTIME_PROOF_UNPROVEN

- gap id: `deployment-runtime-proof-unproven`
- class: **BUILD** · classification: CONTROLLED_VALIDATION_BLOCKER · operator-gated: true
- assignee: claude
- backing proof (referee): `solomon:tomorrow-deployment-gate`

## Why this is open
DEPLOYMENT_RUNTIME_PROOF_FAILED

## Next action
Rerun the deployment runtime proof against the built app.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:tomorrow-deployment-gate
```
