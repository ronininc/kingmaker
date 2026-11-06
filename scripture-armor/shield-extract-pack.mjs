#!/usr/bin/env node
// B4 build tool — extract a scan-stage rule pack from a PRE-REFACTOR
// scan.mjs (one whose detector tables are still code constants) into
// versioned rule-pack data (SPEC §4.1).
//
// Since the B4 integration, the shipped scanner (../scan.mjs) loads its
// tables FROM packs/scan-rules-pack.json — the pack is the source of
// truth and this tool is not part of the runtime. It remains for one job:
// regenerating/verifying a pack against a historical scanner (e.g. the
// base commit's scan.mjs) to prove the extraction was mechanical.
//
// Usage: node extract-pack.mjs <scan.mjs> <out.json>
//
// The module-scope tables (SRC_PACKS, EXEC_SINKS, UNBOUNDED_SINKS,
// IMPORT_CATEGORIES, INPUT_FNS, SOURCE_SNIFFS) are read by importing a
// temp copy of the given file with the internals appended as exports —
// mechanical extraction, not transcription. PROMOTE / FAMILY / verdict
// weights live inside functions in the pre-refactor source; they are
// transcribed from that source as read (computeVerdictRisk +
// scanSourceText) and are PROVEN by the digest-equivalence test in
// test/shield-b4-equivalence.test.mjs — if the transcription were wrong,
// corpus digests would diverge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [scanPath, outPath] = process.argv.slice(2);
if (!scanPath || !outPath) {
  console.error('usage: node extract-pack.mjs <scan.mjs> <out.json>');
  process.exit(2);
}
const src = fs.readFileSync(scanPath, 'utf8');
if (!src.includes('const SRC_PACKS')) {
  console.error('refused: the given scan.mjs has no code-constant SRC_PACKS (already pack-driven?)');
  process.exit(1);
}
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pack-extract-')), 'scan-extract-tmp.mjs');
fs.writeFileSync(tmp, src + `\nexport const __TABLES = { SRC_PACKS, EXEC_SINKS, UNBOUNDED_SINKS, IMPORT_CATEGORIES, INPUT_FNS, SOURCE_SNIFFS };\n`);
const mod = await import(pathToFileURL(tmp).href);
const T = mod.__TABLES;
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });

const rx = (re) => ({ source: re.source, flags: re.flags });
const pack = {
  format: 'scripture-armor-rule-pack/1',
  rules_version: 'scan-rules/1', // the baseline pack IS scan-rules/1, as data
  base_rules: 'scan-rules/1',
  src_packs: T.SRC_PACKS.map((p) => ({ rule: p.rule, sev: p.sev, langs: p.langs, re: rx(p.re), detail: p.detail })),
  source_sniffs: T.SOURCE_SNIFFS.map(rx),
  binary: {
    exec_sinks: [...T.EXEC_SINKS].sort(),
    unbounded_sinks: [...T.UNBOUNDED_SINKS].sort(),
    import_categories: T.IMPORT_CATEGORIES.map((c) => ({ cat: c.cat, sev: c.sev, behavior: c.behavior ?? null, names: [...c.names].sort() })),
    input_fns: [...T.INPUT_FNS].sort(),
  },
  // Transcribed from the pre-refactor scan.mjs (computeVerdictRisk +
  // scanSourceText locals); proven by digest equivalence over the corpus.
  weights: { critical: 40, high: 15, medium: 5, low: 2, cap: 100 },
  composite: {
    promote: ['src-eval-call', 'src-dynamic-function', 'src-vm-run', 'src-child-process-exec-interp',
      'src-shell-pipe-exec', 'src-shell-eval', 'src-shell-decode-exec', 'src-shell-download',
      'src-py-eval-exec', 'src-py-os-system', 'src-py-subprocess-shell', 'src-py-pickle-loads'],
    family: { 'src-eval-call': 'eval-exec', 'src-py-eval-exec': 'eval-exec' },
  },
  // tierParams() code defaults in the pre-refactor scan.mjs, as data.
  tier_defaults: {
    2: { expiry_cap_hours: 24, reseal_hours: 24, dual_approval: true, min_cell: 'hard', downgrade_allowed: false, egress: 'airlock-only', reverify: 'every-activation+freshness', scan_max_age_hours: 24, beacon_anomaly: true },
    1: { expiry_cap_hours: 168, reseal_hours: 720, dual_approval: false, min_cell: 'hard', downgrade_allowed: true, egress: 'peers+airlock', reverify: 'every-activation', scan_max_age_hours: null, beacon_anomaly: false },
    0: { expiry_cap_hours: null, reseal_hours: null, dual_approval: false, min_cell: 'policy-default', downgrade_allowed: true, egress: 'any', reverify: 'registration+first', scan_max_age_hours: null, beacon_anomaly: false },
  },
};
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2));
console.log(`wrote ${outPath}: ${pack.src_packs.length} src packs, ${pack.binary.exec_sinks.length} exec sinks, ${pack.binary.import_categories.length} import categories`);
