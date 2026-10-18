# Sample Upgrade Report

Example output from Claude Code Skillforge's **Upgrade Mode**.

---

## Diagnostic Audit

| # | Check | Status | Detail |
|---|---|---|---|
| 1 | Front matter < 1024 chars | Pass | 312 characters |
| 2 | Standard fields only | Fail | Non-standard field: `license` |
| 3 | Name constraints | Warn | Uses underscores instead of hyphens |
| 4 | No XML tags in description | Pass | — |
| 5 | Body < 500 lines | Pass | 87 lines |
| 6 | Description starts with verb | Fail | Starts with "A tool that..." |
| 7 | 3+ trigger phrases | Fail | Only 1 trigger phrase found |
| 8 | Invocation flags | Pass | — |
| 9 | Imperative step verbs | Warn | Step 3 starts with "The output should..." |
| 10 | Correct mkdir path | Pass | — |

**Result:** 5 Pass, 2 Warning, 3 Fail

---

## Change Summary

- Removed non-standard `license` field from front matter
- Renamed `seo_analyzer` to `analyzing-seo` (hyphens, gerund form)
- Rewrote description to start with "Analyzes..." and added 4 trigger phrases
- Restructured Step 3 to start with imperative verb "Generate..."

---

## Upgraded SKILL.md

*(Full upgraded skill code block appears here during actual usage)*
