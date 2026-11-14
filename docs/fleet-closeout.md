# Fleet Replication closeout — the two named gaps

This page covers the closeout of the two open items the fleet follow-ons
build (docs/fleet-followons.md) named in its own report: model portion
manifests in the published catalog, and a scheduler for the churn cycle.
The third follow-on wall — live Headscale carriage — is a seat act, not a
build; its staged package lives outside the tree (the fleet workspace's
`fleet-closeout-2026-11-14/seat/`) and is graded STAGED until the owner
runs the sitting and the receipts say PASS.

## 1. Model portion manifests — the fetcher-wired publish run

`lib/brain-library-fleet-door.mjs` supplies the publish composition's
two missing pieces:

- `loadDoorModels()` reads the door's model list from the public
  `library.json` (LIBRARY_RAW), unauthenticated, exactly where the
  shipped engine reads its catalog. Entries without complete weights are
  named in `withoutWeights`, never silently dropped.
- `createDoorRangeFetcher()` is a `fetchModelRange` with the access
  layer's exact contract, answered by HTTP Range requests against the
  release assets' browser download URLs — the same URLs the shipped
  CLI's pull constructs. It is deliberately not the runtime fetcher
  (lib/brain-library-fetch.mjs): that one is API-first, and GitHub's
  unauthenticated API budget (60 requests/hour) cannot carry a publish
  pass that reads a whole model portion by portion (1,057 ranges for the
  smallest weights model at 1 MiB portions). The download-URL path is
  the door's public path and consumes no API budget;
  github-release-asset.mjs sanctions it as its own fallback. An optional
  prefetch window (publish runs only) fetches the next ranges of a part
  in the background; correctness never depends on it.

`scripts/publish-fleet-catalog.mjs` runs the composition: local items
from the bundled catalog at the catalog portion size, then each chosen
model's descriptor built from live door bytes at the 1 MiB portion bound,
merged into one `catalog/fleet.json`. The default selection is the
smallest weights-bearing model; unchosen models are printed by name, so
the file's silence about a model is never mistaken for coverage. The
builder's own acceptance gates the result: a descriptor is emitted only
when the whole-item hash computed from the door's bytes equals the door
catalog's pinned sha256, and the written file is re-loaded and
re-validated before the script reports.

## 2. The churn scheduler

The codebase's cadence pattern is a systemd oneshot service + timer —
the same shape as Scripture Armor's streaming churn scan
(`scripture-armor/streaming-churn.service` / `.timer`: `Type=oneshot`,
`OnCalendar=daily`, `Persistent=true`). The fleet churn adopts it
unchanged:

- `scripts/fleet-churn-run.mjs` — one cycle as a standalone job: wires
  the install's real state dirs (store / cache / state / churn-state /
  churn-log under `--root`) and the published catalog into
  `createFleetChurn().runCycle`, prints verdicts, and leaves the cycle
  record in `churn-log/` as the receipt. A cycle that finds a tampered
  resident has done its job (exit 0); a cycle that cannot run exits
  nonzero.
- `deploy/systemd/kingmaker-fleet-churn.service` — the oneshot unit
  (`__KINGMAKER_DIR__` / `__KINGMAKER_STATE_DIR__` are install-time
  substitutions, as in the Armor units), with a 2 GiB default store
  budget.
- `deploy/systemd/kingmaker-fleet-churn.timer` — `OnCalendar=daily`,
  `Persistent=true`, `WantedBy=timers.target`.

Proven under real systemd with a shortened test cadence (every 15 s,
labeled as such in the proof receipts): the timer — never a hand start —
fired a clean cycle, then, after a resident was tampered on disk, fired
a second cycle whose record carries the TAMPERED verdict with both
hashes, the tampered bytes untouched.
