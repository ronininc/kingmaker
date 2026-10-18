---
name: research
description: "Use when the user requests research, a deep dive, a compare X vs Y, trend analysis, or any answer that needs multiple web sources with citations. Triggers: research, deep research, deep dive, comprehensive analysis, compare, analyze trends, investigate, find sources on, what's the state of. Not for 1-2-search lookups; use web search directly for those."
license: MIT
metadata:
  source: https://scalably.io/skills/research
  derived_from:
    path: container/skills/research/SKILL.md
    commit: ef174fc3
    date: "2026-09-07"
  triggers: [research, deep research, deep dive, comprehensive analysis, compare X vs Y, analyze trends]
  not_for: [Simple lookups or quick questions answerable with 1-2 searches]
---

# Research: Multi-Source Synthesis

## What it does

Runs parallel research across several angles of a topic, each in its own subagent, then triangulates the findings and writes a cited report. Two modes: Quick (3 directions, executes immediately) for narrow questions, and Deep (up to 5 directions, posts a plan and waits for approval) for broad or comparative topics.

## Requirements

- Web search and fetch tools in the agent runtime. Free option: Claude Code's built-in WebSearch and WebFetch.
- Subagents for parallel directions. Free option: Claude Code's Agent tool; without it, run directions sequentially.

## Inputs and outputs

| | |
|---|---|
| Input | A topic (free text) and a mode (`quick` or `deep`, inferred from phrasing if not stated) |
| Output | Deep mode: `./research/<topic-slug-YYYYMMDD>/report.md`, with one `raw/direction-N.md` per direction under the same folder. Quick mode: the report is delivered inline in chat, no file written. |

## Worked example

Paste into Claude Code with this skill installed:

```text
/agent-ops:research deep research: state of MCP server hosting options in 2026, compare managed vs self-hosted, freshness 6mo
```

Expected: a plan with 4-5 directions is posted and waits for "go"; after approval the report lands at `./research/mcp-server-hosting-20260907/report.md` with one `raw/direction-N.md` per direction and inline citations.

## Procedure

<modes>
| Mode | When | Agents | Approval |
|------|------|--------|----------|
| **Quick** | Narrow topic, single question | 3 | Execute immediately |
| **Deep** | "deep research", broad topic, comparison, trends | Up to 5 | Post plan, wait for "go" |

Deep triggers: user says "deep research", "deep dive", "comprehensive", or topic is broad/multi-faceted.
Everything else defaults to Quick.
</modes>

### 1. Scope

Determine mode, domain (`tech`/`business`/`academic`/`general`), freshness (`7d`/`6mo`/`12mo`/`2-3yr`/`none`), and restate the core question.

Read `modules/{domain}.md` and `references/source-tiers.md`.

If the plan depends on Reddit or forum evidence, also read
`references/reddit.md` before retrieval. It defines the supported access path,
sampling rules, and how to qualify community evidence.

### 2. Plan

Design broad, multi-angle directions. Each subagent has its own context window; make directions meaty so each covers 2-3 related subtopics.

Good: "Customer perception & brand positioning: reviews from multiple sites, website messaging, pricing structure, CRO changes via Wayback Machine."
Bad: "Reviews analysis" (wastes an agent slot on a narrow angle)

Quick: 3 directions. Deep: up to 5 directions. If the user specifies a number, use that instead.

<plan_delivery>
**Deep mode:** Reply to the user in chat with the plan below, then stop and wait for approval. The user will reply "go" or suggest changes. You have session context; the plan is remembered across messages.

Plan format:
```
Research Plan: {topic}
Mode: Deep | Domain: {domain} | Freshness: {freshness}

Directions:
1. {direction 1: with scope description}
2. {direction 2}
...

Reply "go" to start, or suggest changes.
```

After sending the plan, you are done for this turn. Make no further tool calls.
The user's next message will arrive as a new turn. Only proceed to step 3 when that message approves the plan.
</plan_delivery>

Quick mode: skip approval, go directly to step 3.

### 3. Retrieve

Run `date +%Y-%m-%d` for today's date.

<resume_check>
Deep mode only: check if a research folder exists for today:
```bash
ls ./research/{slug}/raw/direction-*.md 2>/dev/null && wc -c ./research/{slug}/raw/direction-*.md
```
If files exist with >500 bytes, resume only missing directions. Tell the user how many are already done.
</resume_check>

<launch_workers>
Step 1: Create folder:
```bash
mkdir -p ./research/{topic-slug-YYYYMMDD}/raw
```

Step 2: Launch all directions as parallel subagents in a SINGLE message. Each call runs concurrently with its own context window.

For each direction, use the Agent tool (Claude Code) or equivalent Task/subagent primitive, with a general-purpose worker profile:

```
Agent({
  description: "Research direction N",
  prompt: `You are a research agent.

Direction: {direction text}
Topic: {overall topic}
Today: {YYYY-MM-DD}
Freshness: {constraint}
Output file: ./research/{slug}/raw/direction-N.md

- Use WebSearch extensively (10-20+ searches). Go deep.
- Use WebFetch to read full articles from quality sources. Try alternatives if a site blocks you.
- Write incrementally: after every 3-4 searches, update the output file with accumulated findings.
  First write creates the file. Subsequent writes replace it with the full report so far.
- Structure as markdown: key findings with source URLs, confidence levels (high/medium/low), contradictions.
- Keep under 5000 words. Summarize rather than dump raw data.
- When done, confirm the file was written and its approximate word count.`,
  model: "sonnet"
})
```

**CRITICAL:** Launch ALL directions in a single message; do NOT wait for one to finish before launching the next. Parallel subagents run concurrently.

Step 3: Verify:
```bash
wc -c ./research/{slug}/raw/direction-*.md 2>/dev/null
```

If any file is missing or under 500 bytes, retry those directions once with a single new Agent call. If still missing, note the gap and proceed with available data.
</launch_workers>

### 4. Synthesize

Read all `raw/direction-N.md` files. Cross-reference findings:

- Same claim from 2+ sources → state as fact with citations
- Single-source claim → qualify: "According to [Source], ..."
- Contradictions → present both sides with their sources
- Deduplicate URLs across directions

Write the report with [N] numbered inline citations. Include a bibliography at the end:
```
[1] Title - URL (Tier, accessed YYYY-MM-DD)
```

Include a Limitations section noting gaps, failed directions, and unverifiable claims.

Deep mode: save as `report.md` in the research folder.
Quick mode: draft inline (no file needed).

### 5. Deliver

Read back the report. Verify: claims have citations, no unsourced facts, contradictions handled, limitations noted. Fix issues before delivering.

<delivery>
Reply to the user in chat with the final report.

**Quick mode:** Send the full report (under 4000 chars). Split into two messages if longer.

**Deep mode:** Send a summary with:
- Key findings (5-8 bullets with source links)
- Note that the full report is saved in the research folder
- Under 4000 chars
</delivery>

<source_rules>
Every factual claim needs a source URL. Qualify single-source claims ("According to..."). Present contradictions fairly. No Tier Never sources (Wikipedia as primary, content farms, Quora); use Wikipedia to find the real source, then cite that.

Read `references/source-tiers.md` for the full tier system.
</source_rules>

<technical_rules>
- Use parallel subagents for research directions. Launch ALL directions in a single message for true parallelism.
- Each subagent gets its own context window and runs concurrently.
- Subagents return results to the parent; deliver the final report to the user in chat.
- Max 5 directions (Quick: 3, Deep: up to 5).
- All research output goes to `./research/` (no temp prompt files needed).
- Deep mode waits for user approval before launching agents. Quick mode executes immediately.
</technical_rules>

<deprecated_fallback>
**Sequential CLI fallback (DEPRECATED)**: use only if parallel subagents stall or fail repeatedly.

```bash
for i in 1 2 3 4 5; do
  [ -f /tmp/research_prompt_$i.txt ] || continue
  env -u CLAUDECODE timeout 600 claude -p "$(cat /tmp/research_prompt_$i.txt)" \
    --tools "WebSearch,WebFetch,Read,Write,Bash" \
    --strict-mcp-config \
    --disable-slash-commands \
    --effort low \
    --dangerously-skip-permissions \
    --no-session-persistence \
    --fallback-model haiku \
    --verbose \
    --model sonnet \
    --max-turns 40 > /tmp/research_log_$i.txt 2>&1 &
  echo "Launched direction $i (PID $!)"
  sleep 5
done
wait
```

Write prompts to `/tmp/research_prompt_N.txt` first (same format as the Agent prompt above). Set the Bash timeout to 600000ms.
</deprecated_fallback>
