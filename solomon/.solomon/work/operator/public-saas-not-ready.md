# Solomon work item — PUBLIC_SAAS_NOT_READY

- gap id: `public-saas-not-ready`
- class: **EXTERNAL** · classification: PUBLIC_RELEASE_HOLD · operator-gated: true
- assignee: operator
- backing proof (referee): `solomon:public-saas-readiness-proof`

## Why this is open
(read the backing proof output for the exact failing assertion)

## Next action
Depends on a signed release + a live public-ingress proof.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:public-saas-readiness-proof
```
