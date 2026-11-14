# test-os — TypeScript suites consolidated from kingmaker-os

These six suites are the kingmaker-os test set, moved here (2026-10-23) so they
collide with neither `test/` nor `tests/`. They stage at the PROMOTION.md gate
with the contracts and engines they exercise.

Runnable today against the migrated tree (`npm run test:os`):
- `federation-collector.test.ts` — exercises `runtime/solomon-federation-collector.ts`
- `record-of-dissent.test.ts` — exercises `contracts/record-of-dissent.ts`

Staged with their modules (the TypeScript originals were NOT duplicated into
`runtime/`; the shipped JavaScript / stack forms in this repo remain the
implementations of record until the publish gate rules otherwise):
- `abliterate-model.test.ts` — TS original of the abliteration method;
  implementation of record: `lib/abliterate-model.mjs`. heretic-llm (AGPL-3.0)
  is driven as a subprocess only, never vendored or linked.
- `decision-router.test.ts` — TS original of the reflex-layer client;
  implementation of record: `lib/decision-router.mjs` + `lib/fast-route.mjs`.
- `darkweb-search.test.ts` — TS original; shipped suite of record lives with
  `stack/darkweb-search/`.
- `hardening.test.ts` — Phase-1 stack hardening (audit chain, guards);
  implementations of record: `stack/lib/`.
