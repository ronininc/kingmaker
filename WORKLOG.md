# WORKLOG

Channel between the Claude seat (text, catalog, inventory) and the Codex seat (lib/, harnesses, installer, engine plumbing). Append only. Never rewrite another seat's entry.

## 2026-11-24 — Claude seat — K1 README cascade draft (DRAFT, awaiting owner approval)

- Branch `kingmaker-joint`, cut from `main` at b44cea4. This seat is running in a cloud container (Linux), not on the Mac; there was no WORKLOG.md, so this file starts here.
- Changed: `README.md`, section "The system, in its own terms", four passages: **Kingmaker**, **The Core Loop**, **The Fleet**, **Pipelines and Daemons**.
- Removed: "not an autonomous agent… no skill is acquired and no skill is used unless a person requested it."
- Now says: harness for local brains with extra abilities; each program works by itself, united by the launcher they work together; one owner command is the activation and the cascade follows; fleet-level autonomy traced to that activation; skills absorbed during each task a daemon handles without the owner; learning at every level; autonomy stops at installation, the human's act.
- Left alone on purpose, for the owner to rule: the Seeker passage ("money, outbound messages, connector writes and every proposal wait for the owner's word") and the approval wording lower in the README. The doctrine as issued did not revoke those gates.
- Public face: no launcher or union marketing added; the launcher is named once, as a fact.
- Proof: `grep -c "not an autonomous agent" README.md` returns 0; `git diff main -- README.md` shows 4 lines changed.
