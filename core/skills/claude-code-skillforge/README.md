<div align="center">

# Claude Code Skillforge

### The skill that builds, upgrades, and scans skills.

Generate and upgrade Claude Code &amp; Antigravity `SKILL.md` files — with live best practices sync, 10-marketplace discovery, built-in skill upgrader, and self-validation — in minutes.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.11.0-green.svg)](CHANGELOG.md)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-blueviolet.svg)](https://code.claude.com)
[![Antigravity](https://img.shields.io/badge/Antigravity-compatible-orange.svg)](https://antigravity.google)

**Built by [Lijin Nair](https://lijinnair.com)** · [@lijinnair](https://github.com/lijinnair)

</div>

---

## Quick Start

```bash
# Clone into your Antigravity skills directory
git clone https://github.com/lijinnair/claude-code-skillforge ~/.gemini/antigravity/skills/claude-code-skillforge

# Or into native Claude Code
git clone https://github.com/lijinnair/claude-code-skillforge ~/.claude/skills/claude-code-skillforge
```

Then say: **"Build a new skill"**, **"Upgrade this skill"**, or **"Scan my skills"** — or run **`/claude-code-skillforge`**

---

## What It Does

Claude Code Skillforge is a meta-skill that builds, upgrades, and scans Claude Code and Antigravity skills. Give it a raw idea, messy workflow, or an existing skill to upgrade, and it outputs a deploy-ready `SKILL.md` file that follows every official best practice.

**Three modes** — all start with a live best practices sync, then branch:

**Build Mode** — "Build a new skill":

| Step | What happens |
|---:|---|
| 1 | **Live Best Practices Sync** — Fetches latest rules from `code.claude.com` and `antigravity.google` |
| 2 | **Intake** — Collects your skill name, category, ecosystem, triggers, inputs, and outputs |
| 3 | **Discovery** — Searches 10 marketplaces in parallel to find existing similar skills |
| 4 | **Front Matter** — Engineers a spec-compliant, sub-1024-char metadata block |
| 5 | **SOP Translation** — Converts your workflow into an imperative execution pipeline |
| 6 | **Self-Validation** — Audits its own output against a 27-item, 3-section checklist before delivery |

**Upgrade Mode** — "Upgrade this skill":

| Step | What happens |
|---:|---|
| U1 | **Ingest** — Reads and parses the existing SKILL.md |
| U2 | **Diagnostic Audit** — Runs 27-item checklist, reports Pass/Warning/Fail per item |
| U3 | **Upgrade & Fix** — Applies all fixes while preserving original intent |
| U4 | **Deliver** — Change summary + upgraded SKILL.md |

**Scan Mode** — "Scan my skills":

| Step | What happens |
|---:|---|
| S1 | **Discover** — Finds all SKILL.md files in your skills directories |
| S2 | **Quick Audit** — Runs key checks on each skill |
| S3 | **Health Report** — Outputs a table sorted by most issues first |

## How It Works

### High-Level Architecture

```mermaid
flowchart TD
    A([User invokes Skillforge]) --> B[Step 0: Update Check]
    B --> C[Step 1: Sync Live Best Practices]
    C --> D{Step 1.5: Mode Detection}

    D -->|"build / create / new"| E[Build Mode]
    D -->|"upgrade / audit / fix"| F[Upgrade Mode]
    D -->|"scan / health check"| G[Scan Mode]

    E --> E1[Intake & Scoping]
    E1 --> E2[Discovery — 10 Sources]
    E2 --> E3[Front Matter Engineering]
    E3 --> E4[SOP Translation]
    E4 --> E5[Scaffold Generation]
    E5 --> E6[Validate & Deliver]

    F --> F1[Ingest Existing SKILL.md]
    F1 --> F2[Diagnostic Audit — 27 Items]
    F2 --> F3[Upgrade & Fix]
    F3 --> F4[Deliver Upgraded Skill]

    G --> G1[Discover SKILL.md Files]
    G1 --> G2[Quick Audit Each Skill]
    G2 --> G3[Health Report Table]

    style A fill:#7c3aed,color:#fff
    style D fill:#f59e0b,color:#000
    style E fill:#3b82f6,color:#fff
    style F fill:#10b981,color:#fff
    style G fill:#ef4444,color:#fff
```

### Build Mode — Full Pipeline

```mermaid
flowchart LR
    subgraph sync [" Live Sync "]
        S1[Fetch 5 docs URLs<br/>in parallel]
        S1 --> S2{All succeeded?}
        S2 -->|Yes| S3[Present best<br/>practices summary]
        S2 -->|No| S4[Fall back to<br/>cached knowledge]
    end

    subgraph intake [" Intake "]
        I1[Collect name,<br/>category, ecosystem]
        I1 --> I2[Define triggers,<br/>inputs, outputs]
    end

    subgraph discovery [" Discovery "]
        D1[Search 10 sources<br/>in parallel]
        D1 --> D2{Match found?}
        D2 -->|Yes| D3[Present report —<br/>Customise or Build new?]
        D2 -->|No| D4[Proceed to build]
    end

    subgraph build [" Build "]
        B1[Engineer<br/>front matter]
        B1 --> B2[Translate workflow<br/>to SOP steps]
        B2 --> B3[Generate scaffold<br/>+ SKILL.md]
    end

    subgraph validate [" Validate "]
        V1[Run 27-item<br/>checklist]
        V1 --> V2{All pass?}
        V2 -->|No| V3[Fix failures]
        V3 --> V1
        V2 -->|Yes| V4[Deliver output]
    end

    sync --> intake --> discovery --> build --> validate
```

### Upgrade Mode — Diagnostic & Fix

```mermaid
flowchart TD
    U0([Existing SKILL.md provided]) --> U1[Parse front matter & body]
    U1 --> U2[Run 27-item checklist]

    U2 --> U3{Results}

    U3 --> P[Pass items]
    U3 --> W[Warning items]
    U3 --> F[Fail items]

    P & W & F --> U4[Present diagnostic report]
    U4 --> U5{User confirms<br/>upgrade?}
    U5 -->|No| U6([End])
    U5 -->|Yes| U7[Apply fixes —<br/>preserve original intent]

    U7 --> U8[Change summary +<br/>upgraded SKILL.md]

    style U0 fill:#10b981,color:#fff
    style P fill:#22c55e,color:#fff
    style W fill:#f59e0b,color:#000
    style F fill:#ef4444,color:#fff
```

### Scan Mode — Health Check

```mermaid
flowchart LR
    S0([User says<br/>'Scan my skills']) --> S1

    subgraph discover [" Discover "]
        S1[Scan ~/.claude/skills/]
        S2[Scan ~/.gemini/antigravity/skills/]
        S1 & S2 --> S3[List all<br/>SKILL.md files]
    end

    subgraph audit [" Audit Each Skill "]
        S3 --> A1[Front matter check]
        S3 --> A2[Name constraints]
        S3 --> A3[Description format]
        S3 --> A4[Body line count]
        S3 --> A5[Imperative verbs]
    end

    subgraph report [" Report "]
        A1 & A2 & A3 & A4 & A5 --> R1[Health Report Table<br/>sorted by most issues]
    end

    style S0 fill:#ef4444,color:#fff
```

### 10-Source Discovery — Parallel Search

```mermaid
flowchart TD
    Q([Skill name]) --> P[Parallel search — all 10 sources]

    P --> M1[Smithery]
    P --> M2[SkillsMP]
    P --> M3[SkillsLLM]
    P --> M4[SkillHub]
    P --> M5[Antigravity Skill Vault]
    P --> M6[Awesome Skills]
    P --> M7[GitHub Topics]
    P --> M8[Composio]
    P --> M9[AI Templates]
    P --> M10[Awesome Claude Skills]

    M1 & M2 & M3 & M4 & M5 & M6 & M7 & M8 & M9 & M10 --> R{Results}

    R -->|No match| B[Build from scratch]
    R -->|Match found| C[Discovery Report —<br/>Customise or Build new?]

    style Q fill:#7c3aed,color:#fff
    style P fill:#3b82f6,color:#fff
```

### Self-Validation Checklist

```mermaid
flowchart TD
    V([Generated SKILL.md]) --> C1

    subgraph core [" Core Quality — 16 checks "]
        C1[Front matter < 1024 chars]
        C2[Standard fields only]
        C3[Name constraints]
        C4[Description format]
        C5[Body < 500 lines]
        C6[Imperative verbs]
        C7[Progressive disclosure]
        C8[...]
    end

    subgraph code [" Code & Scripts — 8 checks "]
        C9[Error handling]
        C10[No voodoo constants]
        C11[Packages listed]
        C12[...]
    end

    subgraph post [" Post-Delivery — 3 checks "]
        C13[Test across models]
        C14[Evaluation scenarios]
        C15[Real usage tests]
    end

    core & code & post --> D{All pass?}
    D -->|No| FIX[Fix failures] --> V
    D -->|Yes| SHIP([Deliver to user])

    style V fill:#f59e0b,color:#000
    style SHIP fill:#22c55e,color:#fff
```

---

## Why It Exists

Most Claude Code and Antigravity skills are written like essays. Claude Code Skillforge enforces **Progressive Disclosure** — the principle that every token in the context window must earn its place:

- Minimal footprint in the context window
- Deterministic logic offloaded to `scripts/`
- Examples and references loaded only when needed
- Strict imperative pipelines, not conversational prose

The result: skills that are faster, more reliable, and cheaper to run.

## Features

- **Dual ecosystem** — Generates skills for Claude Code or Antigravity
- **Live best practices sync** — Always builds against the latest official spec
- **Skill upgrader** — Feed it any existing SKILL.md and get a diagnostic audit + automated upgrade to latest best practices
- **Skill scanner** — Say "Scan my skills" to audit all installed skills at once and get a health report table with issues ranked by severity
- **10-source discovery** — Searches Smithery, SkillsMP, SkillsLLM, SkillHub, Composio, AI Templates, GitHub Topics, Awesome Claude Skills, and more before building from scratch
- **Graceful fallback** — If docs are unreachable, surfaces cached version and asks before proceeding
- **Self-validating** — 27-item, 3-section checklist (Core quality, Code & scripts, Post-delivery) catches errors before you see the output
- **Pattern library** — Teaches 8 authoring patterns: degrees of freedom, feedback loops, templates, examples, conditional workflows, checklists, verifiable intermediates, defaults over options
- **Evaluation-ready** — Ships with 5 evaluation scenarios covering Build, Upgrade, and Scan modes
- **Token-optimized** — The skill itself practices what it preaches (< 250 lines, ~1,800 tokens)
- **Self-updating** — Checks for newer versions on GitHub before every run, with a one-line update notice

## Repository Structure

```
claude-code-skillforge/
├── SKILL.md            ← The core SOP (v5.11.0)
├── VERSION             ← Current version string (used by self-update)
├── README.md           ← You are here
├── CHANGELOG.md        ← Full version history
├── CONTRIBUTING.md     ← How to contribute
├── LICENSE             ← MIT
├── skill.json          ← Marketplace metadata
├── examples/
│   ├── auditing-seo/SKILL.md
│   ├── formatting-commits/SKILL.md
│   ├── sample-upgrade-report.md
│   └── sample-scan-report.md
└── evaluations/
    ├── eval-simple-skill.json
    ├── eval-skill-with-scripts.json
    ├── eval-advanced-skill.json
    ├── eval-upgrade-mode.json
    └── eval-scan-mode.json
```

## Examples

**Build Mode** outputs:

- **[Auditing SEO](examples/auditing-seo/SKILL.md)** — Audits any URL for title tags, meta descriptions, heading structure, and content quality
- **[Formatting Commits](examples/formatting-commits/SKILL.md)** — Generates Conventional Commits messages from staged diffs

**Upgrade & Scan Mode** outputs:

- **[Sample Upgrade Report](examples/sample-upgrade-report.md)** — Diagnostic audit with Pass/Warning/Fail + change summary
- **[Sample Scan Report](examples/sample-scan-report.md)** — Health report table across all installed skills

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions welcome.

## Author

**[Lijin Nair](https://lijinnair.com)** — AI Systems Builder &amp; Prompt Architect

- GitHub: [@lijinnair](https://github.com/lijinnair)
- Web: [lijinnair.com](https://lijinnair.com)

---

<div align="center">

If Claude Code Skillforge saved you time, **[star the repo](https://github.com/lijinnair/claude-code-skillforge)** — it helps others find it.

</div>
