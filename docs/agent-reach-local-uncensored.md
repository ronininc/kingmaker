# Build Order: Agent Reach Channels + Local Uncensored Inference

## Objective
Two capabilities, one spec: (1) absorb Agent Reach's 13-platform internet access
into the CRM's unified layer, and (2) stand up a local uncensored model for
headless offline inference — the model that won't refuse red-team and
dual-use workloads.

---

## PART 1: Agent Reach — Unified Platform Access

### What it is
- **Repo:** https://github.com/Panniantong/Agent-Reach
- **Stars:** 31,500+ · **License:** MIT · **Language:** Python
- **What:** Capability-layer CLI that installs, configures, and health-checks the
  most reliable scraping backend for 13+ platforms. Generates a `SKILL.md` so
  agents auto-discover available channels. After install, agents call upstream
  tools directly — it is glue, not a wrapper.

### Platforms
Twitter/X · Reddit · YouTube · GitHub · Bilibili · XiaoHongShu · LinkedIn ·
Hacker News · Bluesky · Mastodon · Telegram · Discord · RSS · Web

### Architecture fit
The Ronin CRM **is** the unified layer. Agent Reach is not a replacement —
its channels get harvested into the CRM's methods registry. Each platform
becomes methods: `read-x-post`, `search-reddit`, `read-youtube-transcript`,
etc., per the skills-as-methods schema (name, trigger conditions, inputs,
outputs, cost, ref).

### Build steps
1. **Vet** the repo (security sweep: exfiltration, backdoors, credential
   handling — same standard as prior vets).
2. **Install** per upstream docs: `pip install`, `agent-reach install --env=auto`,
   `agent-reach doctor` to verify channels.
3. **Harvest** each working channel into the methods registry. Compile method
   signatures (~100 tokens each); full channel docs load on demand.
4. **Publish** to the CRM Skill Library via the skill-harvest pipeline so all
   brains get the channels.
5. **Cookie-auth channels** (X, XiaoHongShu, LinkedIn): use secondary accounts,
   never Robbie's primary. Credentials via secure vault only.

### Constraints
- $0 new spend. MIT license is compatible.
- Read-only channels first. Posting/writing capabilities stay gated behind
  Robbie's per-batch tap (no cold outreach, existing rule).
- Respect platform ToS; secondary accounts for anything authenticated.

### Acceptance
1. `agent-reach doctor` shows 10+ channels green.
2. A 3B local model selects the correct platform method for 10/10 test prompts
   from the registry alone.
3. End-to-end: prompt → method selection → live read from a platform →
   summarized result, no API keys used.

---

## PART 2: Local Uncensored Model — Headless Offline Inference

### What it is
A jailbroken Qwen3-class model (27B) with safety tuning stripped — 0% refusal
rate. Runs the workloads cloud models refuse: red-team methodology, offensive
security methods, dual-use tasks. Headless (no display), full GPU to inference.

### Why local + uncensored
- Cloud models refuse red-team/offensive work. The claude-red methods registry
  needs a model that won't refuse.
- Local = no provider watching, no kill switch, target data never leaves the
  machine. Sovereignty thesis applied to inference.

### Hardware math (honest)
| Model | Quant | RAM needed | 8GB Mac | 24GB Mac |
|-------|-------|------------|---------|----------|
| 27B | Q4 | ~17GB | Does NOT fit (swaps, crawls) | Fits comfortably |
| 7-8B | Q4 | ~5-6GB | Fits | Fits easily |

**Rule:** 27B-class needs 24GB unified memory minimum. 8GB boxes run 7-8B only.
Headless operation frees the display GPU budget, but it does not create RAM —
the model either fits in unified memory or it doesn't.

### Supply-chain rule (non-negotiable)
**Do NOT download pre-jailbroken weights from anonymous HuggingFace uploaders.**
That is a trust-me-bro binary from an unknown source — backdoored weights are
undetectable by inspection. It contradicts the entire sovereignty model.

**Correct path:** download the official base model weights (Qwen3-27B from
Alibaba's official release, hash-verified), then apply the jailbreak/abliteration
locally with open-source tooling. The uncensoring step is reproducible and
auditable; the weights are provenance-clean.

### Build steps
1. **Verify hardware:** 24GB+ unified memory before attempting 27B. Otherwise
   target 7-8B uncensored as the interim.
2. **Fetch official base weights** (Qwen3-27B), verify hashes against the
   official release.
3. **Abliterate locally:** strip refusal tuning with open-source abliteration
   tooling. Document the exact procedure for reproducibility.
4. **Serve headless:** Ollama, llama.cpp, or MLX — no display, bound to
   localhost, no external network.
5. **Wire to the methods registry:** the local model becomes the execution
   backend for gated methods (red-team, dual-use). Selection can run on a
   smaller model; execution escalates to the uncensored 27B.
6. **Yordi mirror:** document the full setup so Orosolu infrastructure can
   replicate it. Portable, no shared cloud accounts.

### Constraints
- $0 new spend (hardware already owned or planned).
- Never expose the uncensored endpoint to the network. Localhost only.
- Gating from the claude-red spec applies: offensive methods need Robbie's
  per-engagement tap, regardless of which model executes.

### Acceptance
1. 27B (or 7-8B interim) serves headless on local hardware, responds to a
   refusal-probe prompt set with 0% refusal on legitimate red-team methodology.
2. Weights provenance documented: official base + local abliteration steps.
3. Zero network calls during inference (verified offline).
4. Methods registry routes a red-team method to the local model end-to-end.

---

## Combined acceptance
An agent selects a platform-read method (Part 1) and a red-team method
(Part 2) from the registry, reads a public target profile, and produces
authorized assessment output — all local, all offline-capable, no API keys,
no refusals, no cloud.
