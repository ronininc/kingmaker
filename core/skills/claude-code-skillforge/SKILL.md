---
name: claude-code-skillforge
description: Generates highly optimized Agent Skills for both native Claude Code and the Antigravity system, according to official best practices and the "Progressive Disclosure" strategy. Use when the user wants to build a new skill, turn a workflow into a skill, upgrade an existing skill to latest best practices, audit a skill for compliance, or structure agent instructions for either ecosystem.
argument-hint: [skill-idea or workflow]
---

# Claude Code Skillforge SOP

## Execution Rules
- Fetch all URLs and search all marketplaces **in parallel** using concurrent tool calls.
- `read_url_content`, `search_web`, `view_content_chunk` are non-destructive — execute without user approval.
- Only pause at steps marked **(CHECKPOINT)**.

## Step 0: Update Check
Fetch `https://raw.githubusercontent.com/lijinnair/claude-code-skillforge/main/VERSION` silently. Compare the remote version with the local version (`5.11.0`). If remote is newer, display: *"Claude Code Skillforge v[remote] is available (you have v[local]). Run `git -C [skill-path] pull` to update."* where `[skill-path]` is the detected install location. Then proceed normally — do not block execution.

## Step 1: Sync Live Best Practices (CHECKPOINT)
Fetch live documentation before any user interaction.

1. **Fetch ALL 5 URLs in parallel:**
   - `https://code.claude.com/docs/en/`
   - `https://code.claude.com/docs/en/skills`
   - `https://code.claude.com/docs/en/hooks`
   - `https://antigravity.google/docs/home`
   - `https://antigravity.google/docs/skills`
2. **All succeed:** Synthesize best practices, present summary. Say: *"Here are the latest best practices. Proceed?"* Wait for confirmation.
3. **Any fail:** State which URLs failed. Display cached knowledge version and date. Say: *"I can proceed using built-in knowledge (Version: [X], Last Updated: [Date]). Continue or retry?"* Do not proceed until the user chooses.

## Step 1.5: Mode Detection
Determine the user's intent:
- **Build Mode** — User provides a new skill idea, workflow, or says "build", "create", "new". → Proceed to Step 2.
- **Upgrade Mode** — User provides an existing SKILL.md, pastes skill content, or says "upgrade", "audit", "fix", "optimize", "review". → Proceed to Step U1.
- **Scan Mode** — User says "scan", "check my skills", "health check", "audit my skills". → Proceed to Step S1.

If ambiguous, ask: *"Are you building a new skill, upgrading an existing one, or scanning your installed skills?"*

## Step 2: Intake & Scoping
Collect from the user:
- **Name:** kebab-case, preferring gerund form (e.g., `analyzing-seo-pages`, `formatting-commits`). Noun form acceptable if gerund is awkward. **Constraints:** max 64 characters, lowercase letters/numbers/hyphens only. If omitted, Claude uses the directory name.
- **Category:** `dev` | `marketing` | `seo` | `document` | `data` | `ops`
- **Scope:** Personal (`~/.claude/skills/`) for all projects, or Project (`.claude/skills/`) for this repo only — project skills can be committed to version control for team sharing. Antigravity: `~/.gemini/antigravity/skills/`.
- **Triggers:** Activation words or phrases
- **Inputs:** Context, files, or arguments needed at runtime
- **Output:** Expected deliverable
- **Tools:** Bash, URL fetch, file read, MCP servers (use `ServerName:tool_name` format), or `context: fork` + `agent:`?

## Step 2.5: Discovery Check
Search **ALL 10 sources in parallel** before building from scratch:

1. Smithery — `https://smithery.ai/skills?q=[skill-name]`
2. SkillsMP — `https://skillsmp.com/search?q=[skill-name]`
3. SkillsLLM — `https://skillsllm.com/search?q=[skill-name]`
4. SkillHub — `https://skill-marketplace.com/search?q=[skill-name]`
5. Antigravity Skill Vault — `https://github.com/search?q=[skill-name]+topic:antigravity-skill`
6. Awesome Skills — `https://github.com/sickn33/antigravity-awesome-skills` CATALOG.md
7. GitHub Topics — `https://github.com/search?q=[skill-name]+topic:claude-code-skill`
8. Composio — `https://composio.dev/search?q=[skill-name]`
9. AI Templates — `https://www.aitmpl.com/skills?q=[skill-name]`
10. Awesome Claude Skills — `https://github.com/ComposioHQ/awesome-claude-skills/search?q=[skill-name]`

**Results:**
- **No match:** Proceed to Step 3.
- **Match found (CHECKPOINT):** Present Discovery Report (name, source, stars, description). Ask: *(A) Customise existing, or (B) Build new?* Wait for choice.
- **Sources failed:** Note unreachable sources in the report. Use whatever succeeded. If ALL 10 fail, proceed to Step 3.

## Step 3: Front Matter Engineering
Use ONLY officially recognized fields: `name`, `description`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `context`, `agent`, `argument-hint`, `hooks`. Do NOT add custom fields like `license`, `metadata`, `category`, `version`, or `generated-by`. All fields are optional; only `description` is recommended.
- **Name** *(optional — defaults to directory name):* ≤64 chars, lowercase letters/numbers/hyphens only.
- **Description** *(recommended — defaults to first paragraph if omitted):* Start with 3rd-person verb ("Analyzes...", "Generates..."). Include what the skill does AND when to use it with 3–5 trigger phrases. Keep concise.
- **Invocation:** `disable-model-invocation: true` for workflows with side effects you control (deploy, commit, send). `user-invocable: false` for background knowledge users shouldn't invoke directly. Omit both for auto-discover.
- **Argument hint:** Add `argument-hint: [hint]` if the skill accepts arguments (e.g., `argument-hint: [url]`).
- **Subagent execution:** Add `context: fork` to run in an isolated subagent. Add `agent: [type]` to specify which subagent runs (`Explore`, `Plan`, `general-purpose`, or any custom agent from `.claude/agents/`). Omit `agent:` to default to `general-purpose`.
- **Tool restriction:** Add `allowed-tools` to limit which tools Claude can use without per-use approval when the skill is active.

## Step 4: SOP Translation
Convert the workflow into numbered imperative steps.
- Each step starts with a command verb ("Extract...", "Analyze...", "Compile...").
- **Runtime substitutions** available in skill content:
  - `$ARGUMENTS` — all arguments passed when invoking the skill
  - `$ARGUMENTS[N]` or `$N` — access argument by 0-based index (e.g., `$0`, `$1`)
  - `${CLAUDE_SKILL_DIR}` — absolute path to the skill's directory; use this to reference bundled scripts portably regardless of cwd (e.g., `python ${CLAUDE_SKILL_DIR}/scripts/run.py`)
  - `${CLAUDE_SESSION_ID}` — current session ID; useful for session-specific logs or files
  - `` !`command` `` — shell command whose output is injected into the skill before Claude sees it (e.g., `` !`gh pr diff` ``)

**Authoring patterns** — apply where appropriate:
- **Degrees of freedom:** Match specificity to task fragility. High freedom → text instructions. Medium → pseudocode. Low → exact scripts.
- **Feedback loops:** Add validation steps (e.g., "Run validator → fix errors → repeat").
- **Template pattern:** Define output format explicitly. Strict templates for data/API outputs; flexible templates when adaptation is useful.
- **Examples pattern:** Provide input/output pairs where output quality depends on demonstrated style or format.
- **Conditional workflow:** For decision points, branch explicitly: "Creating new? → Creation workflow. Editing existing? → Editing workflow."
- **Checklist pattern:** For complex multi-step workflows, provide a copyable checklist Claude can track progress against.
- **Verifiable intermediates:** For batch/destructive operations, use plan-validate-execute: create plan file → validate with script → execute after validation passes.
- **Defaults over options:** Provide one recommended approach with an escape hatch, not multiple equivalent choices.
- **MCP tools:** Reference with fully qualified names: `ServerName:tool_name`.
- **Progressive Disclosure:** Do not embed data only needed for one path — link to it or load it conditionally.
- **No time-sensitive info:** Do not include information that will become outdated.

## Step 5: Scaffold Generation
Output the `mkdir` command for the chosen scope:
- Personal (Claude): `mkdir -p ~/.claude/skills/[skill-name]`
- Project (Claude): `mkdir -p .claude/skills/[skill-name]` *(commit to git for team sharing)*
- Antigravity: `mkdir -p ~/.gemini/antigravity/skills/[skill-name]`

**Priority when names conflict:** enterprise > personal > project. Plugin skills use `plugin-name:skill-name` namespace and cannot conflict with other scopes.

**Scripts** (if applicable):
- Offload deterministic logic to `scripts/`. Scripts must handle errors explicitly — do not punt errors to Claude. Document all configuration constants with justification (no "voodoo constants").
- List required packages with install commands (e.g., `pip install pypdf`). Do not assume packages are pre-installed.

**References:**
- Keep references one level deep from SKILL.md — avoid chains like SKILL.md → advanced.md → details.md.
- Add a table of contents to reference files longer than 100 lines.
- Use forward slashes only in all file paths (`reference/guide.md`, not `reference\guide.md`).

Follow with the complete `SKILL.md` code block.

## Step 6: Validate & Deliver
Run this checklist internally — fix any failures before delivering output.

### Core quality
- [ ] Only standard front matter fields used (no `license`, `metadata`, `category`, `version`, `generated-by`)
- [ ] Name ≤64 chars, lowercase+hyphens only (if provided)
- [ ] Body < 500 lines
- [ ] Description starts with 3rd-person verb (if provided)
- [ ] Description has 3+ trigger phrases and includes "Use when..." (if provided)
- [ ] Invocation flags set correctly (`disable-model-invocation` / `user-invocable`)
- [ ] `agent:` field set when `context: fork` is used (if needed)
- [ ] All steps begin with imperative verb
- [ ] Correct `mkdir` path for chosen scope (personal / project / Antigravity)
- [ ] `${CLAUDE_SKILL_DIR}` used for any bundled script references
- [ ] No time-sensitive information
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract
- [ ] Progressive disclosure used appropriately
- [ ] Workflows have clear steps
- [ ] References are one level deep from SKILL.md

### Code & scripts (if applicable)
- [ ] Scripts handle errors explicitly (no punting to Claude)
- [ ] No voodoo constants (all values justified)
- [ ] Required packages listed with install commands
- [ ] Scripts have clear documentation
- [ ] No Windows-style paths (forward slashes only)
- [ ] Validation/verification steps for critical operations
- [ ] Feedback loops for quality-critical tasks
- [ ] MCP tools use fully qualified `ServerName:tool_name` format

### Post-delivery recommendations
After delivering the skill, recommend the user:
- [ ] Test with Haiku, Sonnet, and Opus
- [ ] Create 3+ evaluation scenarios with expected behaviors
- [ ] Test with real usage scenarios before sharing

**Deliver:** Sync status → checklist results → `mkdir` command → full `SKILL.md` code block → post-delivery testing recommendations.

Then say: *"Tip: Have other skills? Say 'Upgrade this skill' with any SKILL.md, or 'Scan my skills' for a full health check."*

Consult `examples/` for reference outputs and `evaluations/` for test prompt templates.

## Upgrade Path

### Step U1: Ingest Existing Skill
Read the provided SKILL.md. Parse front matter fields and body sections. Identify the target ecosystem (Claude Code or Antigravity) from the file path or content.

### Step U2: Diagnostic Audit (CHECKPOINT)
Run the full 27-item validation checklist (from Step 6) against the existing skill. For each item, report:
- Pass — Meets current best practices
- Warning — Works but could be improved
- Fail — Violates current best practices

Present the diagnostic report. Say: *"Here's the audit. Shall I upgrade this skill?"* Wait for confirmation.

### Step U3: Upgrade & Fix
Apply all fixes:
- Rewrite non-standard front matter to use only recognized fields.
- Remove fabricated constraints (e.g., "no reserved words", "no XML tags" in names/descriptions — these are not in the spec).
- Restructure body into imperative steps if needed.
- Apply relevant authoring patterns from Step 4.
- Enforce progressive disclosure (move embedded data to references).
- Fix naming conventions, description format, and invocation flags.
- Replace hardcoded script paths with `${CLAUDE_SKILL_DIR}/scripts/...`.

Preserve the skill's original intent and domain logic — only change structure and compliance.

### Step U4: Deliver Upgraded Skill
Output:
1. **Change summary** — Bulleted list of what was fixed and why.
2. **Upgraded `SKILL.md`** — Full code block ready to replace the original.
3. **Post-upgrade recommendations** — Same as Step 6 post-delivery.

Then say: *"Tip: Want to check your other skills? Say 'Scan my skills' for a full health report."*

## Scan Path

### Step S1: Discover Skills
Scan the user's skill directories:
- Claude Code personal: `~/.claude/skills/*/SKILL.md`
- Claude Code project: `.claude/skills/*/SKILL.md` *(current working directory)*
- Antigravity: `~/.gemini/antigravity/skills/*/SKILL.md`

If both directories exist, scan both. List all discovered skills. If no skills found, say: *"No skills found in the default directories. Provide a path to scan."*

### Step S2: Quick Audit
For each discovered skill, run these key checks:
- Only standard front matter fields used
- Name ≤64 chars, lowercase+hyphens only (if provided)
- Description starts with 3rd-person verb (if provided)
- Body < 500 lines
- Steps begin with imperative verbs
- `${CLAUDE_SKILL_DIR}` used for any bundled script references (not hardcoded paths)

### Step S3: Health Report
Output a summary table:

| Skill | Ecosystem | Checks Passed | Issues | Top Issue |
|---|---|---|---|---|

Sort by most issues first. Then say: *"Run 'Upgrade [skill-name]' on any skill to fix its issues."*
