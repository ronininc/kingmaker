# Solomon work item — UI_VISUAL_QA_UNPROVEN

- gap id: `ui-visual-qa-unproven`
- class: **CODE** · classification: SCRIPT_OR_ARTIFACT_MISSING · operator-gated: false
- assignee: claude
- backing proof (referee): `solomon:readme-scope-flagship-completion-proof`

## Why this is open
UI_VISUAL_QA_BLOCKED - Current packaged Solomon executable missing: /Users/robbiebrown/Projects/TSS/desktop/dist/mac-arm64/Solomon.app/Contents/MacOS/Solomon

## Next action
Build the .app, then run the packaged UI visual QA capture.

## Constraints
- Work ONLY on this gap. Do not touch files owned by another gap — that is how parallel agents avoid collisions.
- Work on an isolated git branch/worktree named `gap/<id>`; commit referencing the gap id.
- PROPOSE, never execute: no money, no sends, no deploy, nothing irreversible without explicit operator approval.
- A gap is CLOSED only when its backing proof PASSES from real command output. Never loosen a proof to make it pass. Never self-certify.

## Verify (close only on green)
```bash
npm run solomon:readme-scope-flagship-completion-proof
```
