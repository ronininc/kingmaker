// Tests for the light runtime: the state contract (light-runtime/state-schema.mjs) and its server
// (scripts/light-runtime-server.mjs). The tile math is checked to the digit against hand-computed fixtures;
// the honesty rules are the point — a simulated run can never certify the 200 tok/s target, a malformed
// report or control is refused by validation, and the server binds loopback only.
// Run: node tests/light-runtime.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROOF_TARGET_TOK_PER_SEC, CONTROL_FILE, assembleState, computeTiles, defaultControl, fmtTokS,
  normalizeVerdicts, pillText, readControl, targetState, validateControl, validateProofReport,
  validateState, writeControl,
} from '../light-runtime/state-schema.mjs';
import { createLightRuntimeServer, listenLightRuntime, meterTotalsFromLog } from '../scripts/light-runtime-server.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

/* ---------------- fixtures ---------------- */
// A 10M token run, hand-computed: 9.8M read in 44,000 s (222.7 t/s) + 200k written in 5,000 s (40 t/s).
// Total 10,000,000 tokens over 49,000 s → sustained 204.1 t/s → PASS against the 200 target.
const METER = { decodeTokS: 11.2, prefillTokS: 222.7, generated: 200000, prompt: 9800000, since: '2026-10-01T00:00:00.000Z' };
const STAGES = [
  { label: 'Read · the library', tokens: 9800000, seconds: 44000, kind: 'REAL', source: 'proof runner · ollama /api/generate' },
  { label: 'Write · the answers', tokens: 200000, seconds: 5000, kind: 'REAL', source: 'proof runner · ollama /api/generate' },
];
const REPORT = { at: '2026-10-21T12:00:00.000Z', stages: STAGES };
const PROFILE = {
  class: 8, label: '8 GB standard (M1/M2/M3 base)', mac: { chip: 'M3', ramGb: 8, model: 'Mac15,3' },
  router: 'granite', writer: 'granite', coder: 'coder', vision: 'vision', reasoning: 'granite',
  concurrent: 1, context: 4096, maxResidentGb: 3.3, gpuBudgetGb: 4.8, voice: 'off', imageLane: false, basis: 'measured',
};
const PLAN = { active: true, model: 'tev1', seatGb: 1.01, workerGb: 3.3, pairGb: 4.31, budgetGb: 4.8, maxLoadedModels: 2, reason: 'pinned' };

/* ---------------- the tile math, exact ---------------- */
{
  const tiles = computeTiles(STAGES, METER);
  ok('tiles: total tokens sum the stages', tiles.totalTokens === 10000000);
  ok('tiles: sustained is total tokens over total seconds', tiles.sustainedTokPerSec === 204.1);
  ok('tiles: peak is the fastest stage', tiles.peakTokPerSec === 222.7);
  ok('tiles: write share is decode over all metered tokens', tiles.writeSharePct === 2);
  ok('target: a measured 204.1 passes the 200 bar', targetState(STAGES, tiles) === 'PASS');
  ok('the target is 200 tok/s', PROOF_TARGET_TOK_PER_SEC === 200);

  const slow = [{ label: 'Read', tokens: 9000000, seconds: 60000, kind: 'REAL' }];
  const slowTiles = computeTiles(slow, METER);
  ok('target: a measured 150 t/s fails', slowTiles.sustainedTokPerSec === 150 && targetState(slow, slowTiles) === 'FAIL');

  const sim = STAGES.map((s) => ({ ...s, kind: 'SIMULATED' }));
  ok('target: a simulated run at proof speed is UNMEASURED, never PASS', targetState(sim, computeTiles(sim, METER)) === 'UNMEASURED');
  ok('tiles: no meter means no write share', computeTiles(STAGES, null).writeSharePct === null);
  ok('tiles: a stage with no seconds carries no rate', computeTiles([{ label: 'x', tokens: 5, kind: 'REAL' }], null).sustainedTokPerSec === null);

  const claimed = validateProofReport({ stages: [{ label: 'Read', tokens: 1000, seconds: 10, tokPerSec: 9999, kind: 'REAL' }] });
  ok('a claimed rate never survives normalization — the computed 100 stands', claimed.ok && claimed.value.stages[0].tokPerSec === 100);
  ok('fmtTokS: proof scale is whole, small rates keep a decimal', fmtTokS(204.08) === '204' && fmtTokS(33.33) === '33.3' && fmtTokS(null) === '—');
}

/* ---------------- report + state validation ---------------- */
{
  ok('report: a stage without a kind is refused', !validateProofReport({ stages: [{ label: 'x', tokens: 1 }] }).ok);
  ok('report: a stage with negative tokens is refused', !validateProofReport({ stages: [{ label: 'x', tokens: -1, kind: 'REAL' }] }).ok);
  ok('report: an empty stages array is refused', !validateProofReport({ stages: [] }).ok);
  ok('report: a name stands in for a label', validateProofReport({ stages: [{ name: 'Read', tokens: 5, kind: 'simulated' }] }).ok);

  const state = assembleState({ meter: METER, profile: PROFILE, seatPlan: PLAN, report: REPORT, control: defaultControl() });
  ok('state: the assembled proof state validates', validateState(state).ok);
  ok('state: the pill carries the number that matters', state.pill === 'PROOF · 204 T/S · TARGET 200');
  ok('state: seats ride the profile roles', state.seats.length === 5 && state.seats[0].role === 'router');
  ok('pill: a failed proof still shows its rate', pillText(assembleState({ report: { stages: [{ label: 'r', tokens: 9000000, seconds: 60000, kind: 'REAL' }] } })) === 'PROOF · 150 T/S · TARGET 200');
  ok('pill: simulated-only reads SIMULATED, not a verdict', pillText(assembleState({ report: { stages: STAGES.map((s) => ({ ...s, kind: 'SIMULATED' })) } })).includes('SIMULATED'));
  ok('pill: no proof falls back to the reflex', pillText(assembleState({})) === 'REFLEX ONLINE' && pillText(assembleState({ reflexOn: false })) === 'REFLEX OFF');

  const bad = assembleState({ report: { stages: [{ label: 'x', tokens: -3, kind: 'REAL' }] } });
  ok('state: a malformed report becomes proofError, never a crash or a fake proof', bad.proof === null && typeof bad.proofError === 'string');
  ok('state validation: a tampered schema is rejected', !validateState({ ...state, schema: 99 }).ok);
  ok('state validation: a forged verdict is rejected', !validateState({ ...state, proof: { ...state.proof, target: { tokPerSec: 200, state: 'CERTIFIED' } } }).ok);

  const v = normalizeVerdicts([{ question: 'q', answer: 'a', probability: 0.97, model: 'tev1', ms: 33, at: '2026-10-21T00:00:00Z' }, 'junk', {}]);
  ok('verdicts: junk dropped, fields normalized', v.length === 2 && v[0].answer === 'a' && v[1].question === null);
  ok('verdicts: capped at 12', normalizeVerdicts(Array.from({ length: 30 }, () => ({}))).length === 12);
}

/* ---------------- control: validate, write, read back ---------------- */
{
  const dir = mkdtempSync(join(tmpdir(), 'km-light-'));
  ok('control: absent file reads as the default', JSON.stringify(readControl(dir)) === JSON.stringify(defaultControl()));
  ok('control: the default carries no run intent', defaultControl().proofRun === null && defaultControl().reflex === true);
  const written = writeControl(dir, { proofRun: 'start', reflex: false });
  ok('control: write returns the merged switches', written.proofRun === 'start' && written.reflex === false && written.reflexPin === true);
  ok('control: the file landed and reads back', existsSync(join(dir, CONTROL_FILE)) && readControl(dir).proofRun === 'start');
  assert.throws(() => writeControl(dir, { proofRun: 'go' }), /proofRun/); passed += 1; console.log('  ok - control: an invalid intent is refused at write');
  assert.throws(() => writeControl(dir, { reflex: 'yes' }), /reflex/); passed += 1; console.log('  ok - control: a non-boolean switch is refused at write');
  ok('control: validate names every error', validateControl({ proofRun: 'go', reflexPin: 1 }).errors.length === 2);
  writeFileSync(join(dir, CONTROL_FILE), '{torn');
  ok('control: a torn file reads as the default, never a throw', readControl(dir).proofRun === null);
}

/* ---------------- the meter's log ---------------- */
{
  const dir = mkdtempSync(join(tmpdir(), 'km-meter-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'metrics'), { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  writeFileSync(join(dir, 'metrics', `model-calls-${month}.jsonl`),
    `${JSON.stringify({ provider: 'ollama', prompt: 100, generated: 5 })}\n${JSON.stringify({ provider: 'ollama', prompt: 50, generated: 5 })}\nnot json\n`);
  const totals = meterTotalsFromLog(dir);
  ok('meter log: totals sum the recorded calls, torn lines skipped', totals.generated === 10 && totals.prompt === 150 && totals.decodeTokS === null);
  ok('meter log: no state dir, no totals', meterTotalsFromLog(null) === null);
}

/* ---------------- the server: page, state, control over HTTP ---------------- */
{
  const assetsDir = fileURLToPath(new URL('../light-runtime/', import.meta.url));
  const stateDir = mkdtempSync(join(tmpdir(), 'km-light-srv-'));
  const fixture = assembleState({ meter: METER, profile: PROFILE, seatPlan: PLAN, report: REPORT, control: readControl(stateDir) });
  const server = createLightRuntimeServer({ assetsDir, stateDir, stateProvider: () => fixture });
  const addr = await listenLightRuntime(server, 0);
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    ok('server: bound to loopback only', addr.address === '127.0.0.1');
    const page = await fetch(`${base}/`);
    const html = await page.text();
    ok('server: the page is the window', page.status === 200 && html.includes('KINGMAKER') && html.includes('Evidence Wall'));
    const st = await (await fetch(`${base}/state`)).json();
    ok('server: /state serves the assembled state', st.pill === 'PROOF · 204 T/S · TARGET 200' && st.proof.tiles.totalTokens === 10000000);
    const post = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reflexPin: false }) });
    const posted = await post.json();
    ok('server: POST /control writes the switch', post.status === 200 && posted.control.reflexPin === false && readControl(stateDir).reflexPin === false);
    const badPost = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proofRun: 'launch' }) });
    ok('server: an invalid switch is a 400, not a write', badPost.status === 400 && readControl(stateDir).proofRun === null);
    const missing = await fetch(`${base}/nope`);
    ok('server: unknown paths are 404', missing.status === 404);
    ok('server: the written control file is the contract shape', JSON.parse(readFileSync(join(stateDir, CONTROL_FILE), 'utf8')).reflexPin === false);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

console.log(`\nlight-runtime: ${passed} checks passed`);
