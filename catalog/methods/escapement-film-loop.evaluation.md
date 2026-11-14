# METHOD EVALUATION — recursion 1: v1 (extracted) vs the Kingmaker constraint

Constraint (owner doctrine, 2026-11-13/14): the flagship use-loop runs on an 8 GB-class machine with
STREAMED intelligence — the smallest sufficient local model per task, weights/methods streamed in
portions; the box is small, the intelligence is not local-resident; turnaround direction is fast
("instantaneous"), not hours-per-artifact. Done-criterion: a method is done only when the loop
conducts, evaluates against the real constraint, writes the improved method, and recurses.

## Where v1 fails the constraint

1. **Render serialization is machine-shaped, not fleet-shaped.** v1 serializes ALL renders through one
   lock on one laptop because one iGPU crashed under concurrency. On the fleet, the same safety rule
   (one render per GPU) composes differently: the queue is global, the lock is PER NODE, and shots —
   the natural unit — distribute across docked machines. v1 leaves the fleet idle.
2. **Wall-clock is unbounded by design.** v1 accepts "many hours" for 36 s. Measured source cost:
   ~10–54 s per 1080p frame, ~1,400 frames. Under the constraint, per-frame budget must be a QUEUE
   rule with teeth: a shot that busts its budget is automatically re-rendered at a lower tier
   (resolution/samples) and the bust is logged — Escapement did this by hand (83% res, 16 samples,
   upscaled); v2 makes it a mechanism, not a rescue.
3. **Intelligence is assumed, not routed.** v1 presumes one frontier session for brief, builders and
   director. Under streamed doctrine each role is a conducted task with a declared weights role
   (writer for the brief, coder for builders, reasoning for the director) and the smallest sufficient
   model is picked per role; the method file must carry the look/QC rules as CHECKABLE assertions so a
   smaller model can still be governed by them.
4. **Output tier is fixed at master quality.** v1 renders finals once at 1080p. v2 adds an output
   ladder: a PROOF CUT (reduced res, all shots, full edit+grade) is the default deliverable of a run;
   hero shots may be re-rendered at master tier later, on a seat with the GPU for it. The proof cut is
   what the loop is graded on; master is a separate, later act.
5. **Director feedback transport is fragile.** In the source, standing director notes are hard-coded
   into the runner's source. v2 writes director notes into the production bible as a dated rule
   section (the bible is already the governing document) and the runner reads them from there.
6. **Audio is an open-web fetch at production time.** v2 keeps the license manifest (it is good
   practice and legally necessary) but sources audio through the same catalog/stream discipline as
   other assets: manifest first, fetch recorded, nothing bundled that the license does not allow.
7. **Paths are laptop-absolute.** v2 makes every path workDir-relative and the runner takes the
   Blender binary as an input (on a Kingmaker node: the staged Blender tool, pulled by the library).

## What survives unchanged (the actual gold)

- The production bible as single governing document, amended by appended dated rule sections.
- The shotlist as data; the edit computed from it (EDL generated, never hand-built).
- Act-parallel builders over a FROZEN shared toolkit; builders may not modify shared code.
- Stills-first iteration; motion contact sheets; finals rendered once, late.
- Numeric QC with hard thresholds, fixed in the scene, never in post.
- The director pass as a separate conducted role with a score and named fixes; a labelled revision pass.
- Per-act iteration logs as published production artifacts (symptom → diagnosis → root cause → fix →
  re-measurement).
- Transition contracts specified numerically and owned by both neighbouring acts.
- Per-frame render budget, measured on one full-tier still before committing to finals.

## Recursion record

- Conduct (v1): extracted faithfully from the corpus → methods/escapement-film-loop.v1-extracted.method.md.
- Evaluate: the seven failures above, each tied to a named doctrine or a measured number.
- Improve: v2 written → methods/escapement-film-loop.method.md (fleet queue, budget-with-teeth,
  routed roles, output ladder, bible-carried director notes, catalogued audio, relative paths).
- Conduct (v2): the TICK run in ../run/ (see ../JOB-REPORT.md for grades and recursion 2,
  the evaluation of v2 by its own run).

---

## Recursion 2 — v2 evaluated by its own first run (TICK, 2026-11-14)

The run (`../run/`: TICK.mp4, notes_act1.md, film-record.json) exercised v2 end to end at proof
tier. What the run taught, as v2.1 deltas (to be folded into the method file at its next
revision; v2.0 stands as filed):

1. **Tool check must probe RENDER capability, not binary presence.** v2's `check-blender`
   verifies the tool resolves and reports a version — on this node Blender 4.5.16 was present
   and healthy, but the default engine (EEVEE) aborted (no libEGL). The wall surfaced at the
   first still, not at check time. v2.1: step 1 gains a one-frame probe render at the declared
   engine; engine routing (EEVEE where GL exists, Cycles CPU where it doesn't) becomes a
   recorded step-1 output, priced into the budget before any builder starts.
2. **The budget needs a node's measured rate, not a guess.** The 20 s/frame budget was set
   blind; this node measures 28–38 s/frame at proof tier. v2.1: the runner's job log becomes
   the pricing source — a node's first job on a shot class measures s/frame and the queue
   re-plans remaining shots from the measurement (the log format already carries what's
   needed). A bust predicted from measurement routes shots BEFORE they're spent, not after.
3. **Lighting QC should sample the shot's head, not only its hero frame.** Shot B passed its
   still (f24, the money frame) while its head (f6) ran low-contrast. v2.1: stills-first
   renders TWO frames per shot — head and hero — and QC gates both.
4. **Material defaults are method content.** The two defects that cost this run its first
   revision round (solid-disc "gears" hiding their spokes; stone-textured brass) were
   construction defaults, not taste. v2.1: hero-subject builders ship with an open-construction
   default and the measured material ranges (fine-grain noise, weak bump) written into the
   method's toolkit notes, so the next run starts where this one finished.
5. **What held unchanged:** bible-as-governance (the T1 spin contract verified in the final
   contact sheet, not just in keys), shotlist-as-data (edit reconciles exactly), serialized
   per-node rendering (zero contention across 48 frames), director pass with labelled rounds,
   silent-over-unlicensed audio, and the record schema — the run produced a complete
   film-record.json with the budget bust stated in it, which is the loop working as designed.
