# Sample Scan Report

Example output from Claude Code Skillforge's **Scan Mode**.

---

## Skills Discovered

Found **5 skills** across 2 ecosystems:
- Claude Code (`~/.claude/skills/`): 3 skills
- Antigravity (`~/.gemini/antigravity/skills/`): 2 skills

## Health Report

| Skill | Ecosystem | Checks Passed | Issues | Top Issue |
|---|---|---|---|---|
| seo_analyzer | Claude Code | 2/6 | 4 | Non-standard front matter fields |
| email-writer | Claude Code | 3/6 | 3 | Description missing trigger phrases |
| data-pipeline | Claude Code | 4/6 | 2 | Steps don't start with imperative verbs |
| formatting-commits | Antigravity | 5/6 | 1 | Body exceeds 500 lines |
| analyzing-seo | Antigravity | 6/6 | 0 | — |

**Summary:** 5 skills scanned. 1 healthy, 2 need minor fixes, 2 need significant upgrades.

---

*Run `Upgrade seo_analyzer` to fix the most critical skill first.*
