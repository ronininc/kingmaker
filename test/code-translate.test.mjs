// test/code-translate.test.mjs — the code translator's caller (lib/code-translate.mjs).
// Three contracts under test:
//   (1) TARGET PRECEDENCE (design §2.2): explicit > method-declared > surface >
//       intent-keywords > nothing — and nothing means NO translation: the caller
//       conducts nothing and picks nothing when no rule fires.
//   (2) THE GRADE (design §3.4): composed from the trace, never from intent — PARSE
//       only when the parse step executed through the library-pulled tool, exited 0,
//       and its stdout carries langcheck's OK verdict naming a real checker; an
//       exit-0 NO-CHECKER is structural, never a parse pass.
//   (3) THE PICK'S SHAPES PASS THROUGH: escalation and no-sufficient-model return
//       with the selector's receipts and conduct nothing; a sufficient pick conducts
//       exactly once, on the picked model.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gradeTranslation, resolveTargetLanguage, runCodeTranslation } from '../lib/code-translate.mjs';

const SURFACES = { 'blender-script': 'python', 'engine-shell': 'bash', 'site-or-crm': 'javascript' };

test('target precedence: explicit beats declared, surface and intent', () => {
  const r = resolveTargetLanguage({ explicitTarget: 'rust', declaredTarget: 'python', surface: 'blender-script', requestText: 'in bash please', surfaceLanguages: SURFACES });
  assert.deepEqual(r, { targetLanguage: 'rust', targetChosenBy: 'explicit' });
});

test('target precedence: method-declared beats surface and intent', () => {
  const r = resolveTargetLanguage({ declaredTarget: 'swift', surface: 'blender-script', requestText: 'in python', surfaceLanguages: SURFACES });
  assert.deepEqual(r, { targetLanguage: 'swift', targetChosenBy: 'method-declared' });
});

test('target precedence: surface beats intent keywords naming another language', () => {
  const r = resolveTargetLanguage({ surface: 'engine-shell', requestText: 'translate this into python', surfaceLanguages: SURFACES });
  assert.deepEqual(r, { targetLanguage: 'bash', targetChosenBy: 'surface' });
});

test('target precedence: intent keywords — a named language, then a named surface', () => {
  assert.deepEqual(
    resolveTargetLanguage({ requestText: 'please translate this function into Python', surfaceLanguages: SURFACES }),
    { targetLanguage: 'python', targetChosenBy: 'intent-keywords' });
  assert.deepEqual(
    resolveTargetLanguage({ requestText: 'make this work as a blender script', surfaceLanguages: SURFACES }),
    { targetLanguage: 'python', targetChosenBy: 'intent-keywords' });
});

test('target precedence: aliases normalize, and no signal resolves to null', () => {
  assert.deepEqual(resolveTargetLanguage({ explicitTarget: 'py', surfaceLanguages: SURFACES }), { targetLanguage: 'python', targetChosenBy: 'explicit' });
  assert.equal(resolveTargetLanguage({ requestText: 'make this better', surfaceLanguages: SURFACES }), null);
  assert.equal(resolveTargetLanguage({ surfaceLanguages: SURFACES }), null);
  assert.equal(resolveTargetLanguage({ surface: 'no-such-surface', surfaceLanguages: SURFACES }), null);
});

const traceParseOk = [
  { n: 6, id: 'verify-translation', type: 'verify', status: 'executed' },
  { n: 7, id: 'parse-check', type: 'declare', status: 'executed', result: { executedVia: 'library-tool', exitCode: 0, stdout: 'langcheck: OK python translated.py (checker: python3 -m py_compile)\n' } },
  { n: 9, id: 'verify-record', type: 'verify', status: 'executed' },
];
const completedWith = (trace) => ({ status: 'completed', haltedAt: null, reason: null, trace, outputs: {}, declared: [] });

test('grade: an executed parse at exit 0 with the OK verdict is PARSE', () => {
  const g = gradeTranslation(completedWith(traceParseOk));
  assert.equal(g.tier, 'PARSE');
  assert.deepEqual(g.checks[0], { name: 'parse', ran: true, exitCode: 0, ok: true, checker: 'python3 -m py_compile' });
  assert.equal(g.checks[1].ok, true);
});

test('grade: an exit-0 NO-CHECKER is STRUCT, never PARSE', () => {
  const trace = traceParseOk.map((t) => t.id === 'parse-check'
    ? { ...t, result: { executedVia: 'library-tool', exitCode: 0, stdout: 'langcheck: NO-CHECKER translated.swift — no checker covers ".swift"\n' } }
    : t);
  const g = gradeTranslation(completedWith(trace));
  assert.equal(g.tier, 'STRUCT');
  assert.equal(g.checks[0].ran, true);
  assert.equal(g.checks[0].ok, false);
  assert.equal(g.checks[0].outcome, 'no-checker-for-language');
});

test('grade: a declared (unexecuted) parse check is STRUCT when verifies passed', () => {
  const trace = traceParseOk.map((t) => t.id === 'parse-check'
    ? { n: 7, id: 'parse-check', type: 'declare', status: 'declared', result: { action: 'langcheck translated.py' } }
    : t);
  const g = gradeTranslation(completedWith(trace));
  assert.equal(g.tier, 'STRUCT');
  assert.deepEqual(g.checks[0], { name: 'parse', ran: false, exitCode: null, ok: false, checker: null });
});

test('grade: a failed conduction earns NONE, however far it got', () => {
  const failed = { status: 'failed', haltedAt: 'parse-check', reason: 'exit 1', trace: [
    { n: 6, id: 'verify-translation', type: 'verify', status: 'executed' },
    { n: 7, id: 'parse-check', type: 'declare', status: 'failed', result: { executedVia: 'library-tool', exitCode: 1, stdout: 'langcheck: FAIL python translated.py (checker: python3 -m py_compile)\n' } },
  ], outputs: {}, declared: [] };
  const g = gradeTranslation(failed);
  assert.equal(g.tier, 'NONE');
  assert.equal(g.checks[0].ran, true);
  assert.equal(g.checks[0].exitCode, 1);
  assert.equal(g.checks[0].ok, false);
});

test('grade: a completed conduction with no checks at all is NONE', () => {
  const g = gradeTranslation(completedWith([{ n: 4, id: 'translate', type: 'reason', status: 'executed' }]));
  assert.equal(g.tier, 'NONE');
});

// ── the caller end to end, with injected records + a stub conductor ──
const CODER = { model: 'fixture-coder:1.5b', genTokS: 26.8, loadS: 2.01, sizeGb: 1.24, evalShare: 0.75, benchFile: 'bench_host.jsonl', roles: ['coder'], capabilities: [] };
const WRITER = { model: 'fixture-writer:3b', genTokS: 20, loadS: 3, sizeGb: 2.2, evalShare: 0.75, benchFile: 'bench_host.jsonl', roles: ['writer'], capabilities: [] };
const HUGE_CODER = { model: 'fixture-coder:30b', genTokS: 9, loadS: 8, sizeGb: 16.4, evalShare: 0.99, benchFile: 'bench_host.jsonl', roles: ['coder'], capabilities: [] };
const DEVICE = { ramGb: 8, freeGb: 4.6 };

const stubConductor = (result, captured) => ({
  conduct: async (id, opts) => {
    captured.id = id; captured.inputs = opts.inputs;
    captured.answer = await opts.reasoner({ preamble: 'pre', prompt: 'prompt', methodText: 'method' });
    return result;
  },
});

test('caller: no target signal conducts nothing and picks nothing', async () => {
  let conducted = false, completed = false;
  const r = await runCodeTranslation({
    sourceText: 'const a = 1;', requestText: 'make this nicer',
    records: [CODER], device: DEVICE,
    conductor: { conduct: async () => { conducted = true; throw new Error('must not conduct'); } },
    complete: async () => { completed = true; return 'x'; },
  });
  assert.equal(r.status, 'no-target');
  assert.equal(r.targetLanguage, null);
  assert.equal(conducted, false);
  assert.equal(completed, false);
});

test('caller: escalation passes through untouched — no conduction, no substitution', async () => {
  let conducted = false;
  const r = await runCodeTranslation({
    sourceText: 'const a = 1;', explicitTarget: 'python',
    records: [HUGE_CODER], device: DEVICE,
    conductor: { conduct: async () => { conducted = true; throw new Error('must not conduct'); } },
    complete: async () => 'x',
  });
  assert.equal(r.status, 'escalated');
  assert.equal(r.escalation.model, 'fixture-coder:30b');
  assert.ok(Array.isArray(r.escalation.lanes) && r.escalation.lanes.length >= 1);
  assert.equal(conducted, false);
});

test('caller: no sufficient model returns the considered[] receipt', async () => {
  const r = await runCodeTranslation({
    sourceText: 'const a = 1;', explicitTarget: 'python',
    records: [WRITER], device: DEVICE,
    conductor: { conduct: async () => { throw new Error('must not conduct'); } },
    complete: async () => 'x',
  });
  assert.equal(r.status, 'no-sufficient-model');
  assert.equal(r.model, null);
  assert.ok(r.considered.some((c) => c.model === 'fixture-writer:3b' && c.verdict === 'not-sufficient'));
});

test('caller: a sufficient pick conducts once, on the picked model, inputs recorded', async () => {
  const captured = {};
  let completeModel = null;
  const workDir = await mkdtemp(join(tmpdir(), 'km-translate-caller-'));
  const r = await runCodeTranslation({
    sourceText: 'function slugify(t) { return t; }', sourceLanguage: 'javascript', explicitTarget: 'python',
    records: [WRITER, CODER], device: DEVICE, workDir,
    conductor: stubConductor(completedWith(traceParseOk), captured),
    complete: async (model) => { completeModel = model; return '# translated'; },
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.model, 'fixture-coder:1.5b');
  assert.equal(completeModel, 'fixture-coder:1.5b');
  assert.equal(r.evidenced, true);
  assert.equal(r.delivery.strategy, 'resident');
  assert.equal(r.verification.tier, 'PARSE');
  assert.equal(captured.id, 'code-translate');
  assert.equal(captured.inputs.targetLanguage, 'python');
  assert.equal(captured.inputs.targetChosenBy, 'explicit');
  assert.equal(captured.inputs.model, 'fixture-coder:1.5b');
  assert.equal(captured.inputs.targetFile, 'translated.py');
});

test('caller: a failed conduction returns failed with the step named', async () => {
  const failed = { status: 'failed', haltedAt: 'read-source', reason: 'read-text failed: ENOENT', trace: [], outputs: {}, declared: [] };
  const r = await runCodeTranslation({
    sourceFile: 'missing.js', explicitTarget: 'python',
    records: [CODER], device: DEVICE, workDir: await mkdtemp(join(tmpdir(), 'km-translate-fail-')),
    conductor: stubConductor(failed, {}),
    complete: async () => 'x',
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.haltedAt, 'read-source');
  assert.equal(r.verification.tier, 'NONE');
});

test('caller: complete() is a precondition, not an option', async () => {
  await assert.rejects(
    () => runCodeTranslation({ sourceText: 'x', explicitTarget: 'python', records: [CODER], device: DEVICE }),
    /complete\(\) is required/);
});
