# Slash-command job buckets — Kingmaker command layer (Robbie's directive, 2026-10-20)

## The directive (his words, condensed)

- Robbie gives direct orders by text box with slash commands per task genre: `/createmedia`, `/videogame`, `/crm`, `/codegen`, `/fabrication`, `/godseye`, `/osiris`, etc.
- Each field of skills has a **job bucket**: invoking the command configures Kingmaker for that field — the relevant skills, tools, models, and context loaded as one working set.
- Buckets self-configure on a **memory-palace architecture** (his term: rooms in a palace, one per field) — with an open question from Robbie: is there something better now for faster, cheaper retrieval? (Verdict below.)
- **Any /command that references a tool** resolves in this order: Kingmaker *uses* the tool if it has it → *finds* it if it exists somewhere reachable → *absorbs* it through the Cage if it exists outside → *recreates* it natively (remake belt) if none of those work — whichever is easiest and best. Then it does the request with that tool.
- **Capability on request only** (the Cage posture, his words): "It can do everything but only on request — and then it does the request with the relevant tools." Nothing loads, runs, or reaches out until a command asks. The bucket is a configuration, never an ambient process.

## Design notes (Muse)

- **Bucket = a manifest, not a copy.** Each bucket is a small descriptor: name, skill set (references into the one skill tree — never duplicated files), tool set, default lane/tier for the router, context pack (the corpus slices and standing files for that field), and its governance class. Invoking `/crm` assembles the working set from the manifest; closing the task releases it.
- **Memory palace, honestly graded.** The palace is the right SHAPE for this: rooms = buckets, loci = the skill/tool slots inside them, one deliberate walk to retrieve. As a retrieval *mechanism* under the hood, the faster/cheaper stack is what the palace compiles down to: a tiered index — bucket card (tiny, always in reach) → skill cards (one line each) → full skill text only for the chosen few — plus ranked passage lookup over the field's corpus (the XERJ seat). That is the palace, implemented as an index tree instead of a metaphor the model has to hold in context. It honors the doctrine already standing: read enormously, write minimally; capability lives around the model.
  - Verdict for Robbie's question: keep the palace as the architecture (it's how the buckets organize and how he'll think about them), implement retrieval as tiered index + hybrid lexical/ranked search. No new memory system to buy or build — the pieces (skill tree, router lanes, XERJ, corpus) already exist; the bucket layer is the composition.
- **Governance inherits, never resets.** A bucket carries the governance class of its contents: `/crm` runs under CRM rules (outreach taps, TCPA his alone); the private-side buckets (`/godseye`, `/osiris` class) stay Kingmaker-only, never surface in Solomon, never named in public material, and their tool resolution still passes the Cage (absorb = the 7-stage ingestion, Stage 4 his tap). A slash command is an order, not a permission slip — the gates inside the bucket still apply.
- **Tool resolution order** (for a /command naming a tool Kingmaker lacks): use → find → absorb (Cage) → recreate (remake belt) → report the gap if all four fail. "Easier and better" is judged on: already-governed beats new, local beats remote, licensed-clean beats questionable — the same triage as every intake.
- **Surfaces:** the text box first (his ask). The same bucket manifests should be invocable from the other surfaces later (voice wake + bucket name; CLI; MCP) — one manifest, many doors. Not part of this build until the text box proves it.

## Reconstruction doctrine (Robbie, 2026-10-20 — corrected framing)

The pipeline for a capability Kingmaker doesn't have is **LittleBrother-driven reconstruction**, and it is already the architecture — the work is amplification, not redesign:

1. **Point LittleBrother at it.** LB studies how the thing was accomplished — the public record: papers, architecture write-ups, repos, teardowns, benchmarks. The output is understanding of the *method*, not a copy of the artifact.
2. **Reconstruct from the ground up under doctrine.** Build the capability natively — governed, audited, fitted to the fleet and the skill tree — informed by how they did it, and better where their version fights the doctrine (license locks, telemetry, cloud dependence, streaming-off-disk hacks).
3. **The bucket then runs the native build.** The slash command doesn't care that the seat's tool was reconstructed rather than installed; it does the request with the relevant tools.

Worked example (same day): MiniMax H3 — its community license excludes US local deployment, so the weights were never a runtime candidate. As an LB study target it's fully available: how a 33B omni-modal DiT folds native stereo audio into the same pass, omni-reference conditioning, the quantization path that got it onto consumer hardware. What gets reconstructed under doctrine is a native video-gen capability that learned from those methods — no license lock, no territory clause, fitted to Apple Silicon. The license restricts running *their weights*; it does not restrict learning from the public record of how they built it.

Relationship to the older seats language: REA's behavior spec is one input to step 2, not the whole pattern. LB's how-it-was-accomplished harvest is the fuller feed, and reconstruction — not engine-swapping — is the default ambition. Engine-swapping (drive a lawful third-party engine via CLI) remains the fallback when reconstruction isn't worth it yet.

## Scope for the build

1. Bucket manifest format + the first buckets: `/codegen`, `/crm`, `/createmedia`, `/videogame`, `/fabrication`, plus the private-side pair (names recorded here only).
2. Command parsing in the Kingmaker text box: `/bucket` + the rest of the line is the order, routed to the assembled working set.
3. Tool-resolution pipeline wired to the existing Cage + remake belt (no new intake machinery).
4. Bucket usage lands in the audit chain like everything else: which bucket, which tools resolved, which gates were hit.

Status: spec captured 2026-10-20; build sequencing is Robbie's call (4.2 candidate).
