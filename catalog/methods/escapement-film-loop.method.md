# Method — Escapement Film Loop (fleet edition)

A method file in the owner item-15 shape: read by the conductor (`lib/method-conductor.mjs`) and
executed step by step. For a film task: take a one-line intent in the workDir, write the production
bible and shotlist, build every shot as code on a frozen shared toolkit, iterate on stills under a
numeric QC gate, take a director pass, render through the fleet queue under a per-frame budget with
teeth, and deliver a proof cut whose edit, grade and mix are computed from the shotlist — recording
what ran, on which node, at what measured cost, and what did not run.

Filed 2026-11-14 from the study of github.com/Leonxlnx/escapement (MIT; study receipts:
`~/workspace/escapement-first-job-2026-11-14/study/STUDY.md`). This is v2: v1 was extracted
faithfully from the source, evaluated against the streamed / 8 GB constraint, and improved
(evaluation: `~/workspace/escapement-first-job-2026-11-14/methods/METHOD-EVALUATION.md`).

**Who supplies the intelligence (not this file):** the conductor routes each `reason` step to the
smallest sufficient model for that step's declared `weights` role, streamed from the Brain Library.
No single step presumes a frontier session; the bible's look rules and the QC thresholds below are
written as checkable assertions so a small model is still governed by them.

**The render queue is the safety mechanism.** Builders and stills may run anywhere; renders enter
ONE queue. A node holds at most one render at a time (per-node lock — the source project's global
lock existed because one shared GPU crashed under concurrent renders; the rule survives, the scope
becomes per-node). Every queued job is logged (node, shot, frames, return code, seconds per frame).

**The budget has teeth.** Each shot declares `frameBudgetSec`. The runner measures the shot's first
full-tier frame; if the measured cost busts the budget, the shot is automatically re-tiered
(resolution %, then samples) and the bust + new tier are written to the iteration log. A bust is a
routing fact, never a silent quality cut.

**The output ladder.** A run's deliverable is the PROOF CUT: every shot, full edit and grade, at
proof resolution. Master-tier re-renders of hero shots are a separate later act on a seat with the
GPU for them, and are recorded as not-run in this run's record until they happen.

## Executable block

```kingmaker-method
{
  "id": "escapement-film-loop",
  "version": "2.0",
  "title": "Cinematic short from code — bible, act builders, fleet render queue, director pass, proof cut",
  "domain": "media",
  "kind": "film-production",
  "weights": { "role": "coder" },
  "inputs": {
    "intentFile": "intent.txt",
    "briefFile": "BRIEF.md",
    "shotlistFile": "shotlist.json",
    "audioManifest": "audio/manifest.json",
    "workDir": ".",
    "fps": 24,
    "proofWidth": 640,
    "proofHeight": 360,
    "masterWidth": 1920,
    "masterHeight": 1080,
    "frameBudgetSec": 30,
    "blenderTool": "blender"
  },
  "steps": [
    { "n": 1, "id": "check-blender", "type": "check-tool", "command": "blender", "into": "blenderToolInfo" },
    { "n": 2, "id": "read-intent", "type": "read-text", "path": "{{inputs.intentFile}}", "into": "intent" },
    { "n": 3, "id": "write-brief", "type": "reason", "weights": { "role": "writer" }, "into": "brief",
      "preamble": "Write the production bible (BRIEF.md): story in acts; per-act palettes; look rules as checkable assertions (clear focal subject; foreground/subject/background depth; atmosphere; motivated light; deep blacks, highlights reserved for small speculars); technical rules (per-frame budget, tier ladder, one render per node); numeric transition contracts between acts (frame counts, on-screen size %, rotation direction). Rule changes during production are APPENDED as dated rule sections. Director notes also land here as dated rule sections — the bible is the only governance surface." },
    { "n": 4, "id": "write-shotlist", "type": "render", "path": "{{inputs.shotlistFile}}",
      "template": "JSON: {fps, shots: [{id, script, cut_frames, handles, render_frames, cut_in_local, cut_out_local, edit_start_frame, desc, frameBudgetSec}]}. The edit is computed from this table by the edit step, never hand-assembled." },
    { "n": 5, "id": "build-acts", "type": "reason", "into": "actScripts",
      "preamble": "One builder per act, in parallel, each writing ONE scene script per act (shots selected via --shot <ID>) over a shared FROZEN toolkit (procedural geometry, materials, camera, light helpers). Builders never modify the shared toolkit or the runner; act helpers live in the act's own kit module. Everything on screen is code: no downloaded models or image textures. Paths are workDir-relative; the Blender binary comes from the staged blender tool (step 1), never a hard-coded path." },
    { "n": 6, "id": "test-stills", "type": "declare", "into": "stills",
      "action": "Per shot, through the render queue: test stills at proof resolution and low samples; motion checks as step-rendered contact sheets (ffmpeg tile). Builders view the stills before any full render exists.",
      "reason": "Stills-first: the still is the iteration surface; finals are rendered once, late." },
    { "n": 7, "id": "qc-stills", "type": "declare", "into": "qc",
      "action": "Numeric exposure/colour check on every judged still. Thresholds (interior/macro): clipped <= 0.5% of pixels, near-white <= 2%, p5 luma < 0.08, median luma 0.12-0.45 (daylight exteriors: median <= 0.58, p5 < 0.15). Every named failure (TOO BRIGHT / OVEREXPOSED / WASHED OUT / LOW CONTRAST / DULL COLOUR) is fixed IN THE SCENE. A failing still does not advance its shot.",
      "reason": "Measured, not eyeballed — this gate is what lets a small streamed model direct a render it cannot see well: the numbers see for it." },
    { "n": 8, "id": "iterate-acts", "type": "reason", "into": "iterationLogs",
      "preamble": "Each builder maintains a per-act iteration log (notes/act<N>.md): per round — symptoms in the stills, measured diagnosis, root cause, fix, re-measured result, and per-frame render seconds. The loop itself appends the log entry for every conducted round; a round with no log entry did not happen. Logs ship with the work." },
    { "n": 9, "id": "director-pass", "type": "reason", "weights": { "role": "reasoning" }, "into": "directorReview",
      "preamble": "A separate director (not any act's builder) reviews each act against the bible and the QC numbers, scores it, and issues named, shot-specific fixes. The review and score are appended to the bible as a dated rule section; builders then run ONE labelled revision pass applying exactly those fixes. If the score is passing and QC is green, the revision pass is recorded as not needed — never performed for ceremony." },
    { "n": 10, "id": "render-proof", "type": "declare", "into": "proofFrames",
      "action": "Queue every shot's frames at proof tier on the available nodes (one render per node; per-node lock; job log with node, shot, rc, seconds/frame). Measure each shot's first frame against its frameBudgetSec; on a bust, re-tier automatically (proof res %, then samples) and log the bust and the new tier in the act's iteration log.",
      "reason": "The queue and the budget are the fleet form of the source's single-laptop lock: same safety, composed across machines." },
    { "n": 11, "id": "edit-grade-mix", "type": "declare", "into": "proofCut",
      "action": "Generate the EDL from the shotlist; conform, transitions (cuts, match cuts on the contracted frames, dissolves where the contract names them), letterbox and grade in code (ffmpeg). Sound: build the cue sheet on the music's beat grid and mix ONLY assets listed in the audio manifest (each with source URL + license); if no manifest entries are fetched, the proof cut is delivered silent and the record says the mix did not run.",
      "reason": "Edit, grade and mix are code, reproducible from shotlist + cues. Silence honestly recorded beats synthesized or unlicensed audio." },
    { "n": 12, "id": "write-record", "type": "write-json", "path": "film-record.json",
      "value": {
        "schema": "kingmaker.film-production/1",
        "method": "{{method.id}}",
        "methodVersion": "{{method.version}}",
        "intent": "{{intent}}",
        "shots": "{{shotlist.shots}}",
        "qc": "{{qc}}",
        "directorScore": "{{directorReview.score}}",
        "renderJobs": "{{proofFrames.jobs}}",
        "deliverable": "proof-cut",
        "masterRender": "not-run"
      } },
    { "n": 13, "id": "verify-record", "type": "verify",
      "assertions": [
        { "file": "film-record.json", "field": "schema", "equals": "kingmaker.film-production/1" },
        { "file": "film-record.json", "field": "deliverable", "exists": true }
      ] }
  ]
}
```

## Steps (prose mirror)

1. **check-blender** — Is the staged Blender tool on this node (PATH or Brain Library pull)? Its presence and version land in the record; absent → the run stops at the wall, named (failure modes).
2. **read-intent** — The one-line (or one-paragraph) film intent, read verbatim.
3. **write-brief** — The production bible: story, palettes, look rules as assertions, technical rules, transition contracts. All later governance (client rules, director notes) appends here as dated sections.
4. **write-shotlist** — The shot table as data. The edit will be computed from it.
5. **build-acts** — Act-parallel builders on the frozen shared toolkit; everything procedural.
6. **test-stills** — Proof-res stills + motion contact sheets through the queue.
7. **qc-stills** — The numeric gate. Failures fixed in the scene; failing shots do not advance.
8. **iterate-acts** — The per-act logs, appended by the loop itself, every round.
9. **director-pass** — Independent review, a score, named fixes, one labelled revision pass.
10. **render-proof** — Fleet queue, per-node lock, per-frame budget with automatic re-tiering on a bust.
11. **edit-grade-mix** — EDL from the shotlist; code edit/grade; manifest-only audio, or honestly silent.
12. **write-record** — The production record: shots, QC, director score, render jobs with measured costs, deliverable tier, and what did not run.
13. **verify-record** — Re-read the record; confirm the schema and deliverable fields landed.

## Failure modes

- **Blender tool absent** → step 1 finds nothing; the conduction reports the wall (no Blender on this node, nothing staged) and produces the bible, shotlist and scripts as declared-not-executed artifacts. It never substitutes a different renderer silently.
- **A shot busts its frame budget at every tier** → the shot is delivered at the lowest tier with the bust recorded, or cut by the director with the cut recorded — never silently dropped from the edit (the shotlist and the EDL must reconcile).
- **QC cannot pass a still** → the shot does not advance; the director decides (re-light, re-frame, or cut) and the decision lands in the log. The proof cut is never assembled from failing shots without the failure riding in the record.
- **No audio manifest entries fetched** → silent proof cut, record says the mix did not run. Synthesized or unlicensed audio is never substituted (source project's client rule, kept).
- **A node's render dies mid-shot** → the job log shows the rc; the queue re-issues the shot's remaining frames to any node, including the same one. Frames on disk are the state; nothing is rendered twice knowingly.
- **Director and builder disagree** → the bible governs: the director's fixes are appended as a rule section, the builder's objection is appended under it, and the director's call stands for this run. The disagreement ships in the record.
