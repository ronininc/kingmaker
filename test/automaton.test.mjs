import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutomaton, defaultAutomatonState, spentFrom, capCheck, installPlan, AUTOMATON_SOURCES, MODES } from '../lib/automaton.mjs';

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../catalog/kronos.json', import.meta.url)), 'utf8'));

function place() {
  const state = mkdtempSync(join(tmpdir(), 'km-auto-'));
  return { state, audit: () => (existsSync(join(state, 'automaton-audit.jsonl')) ? readFileSync(join(state, 'automaton-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []), done: () => rmSync(state, { recursive: true, force: true }) };
}
// A supervisor with a fixed clock. approve() says yes by default; gateOffConsent() refuses by default (ships off).
const make = (p, over = {}) => createAutomaton({ state: p.state, now: () => Date.UTC(2026, 9, 15, 12, 0, 0), approve: async () => true, ...over });

test('pins: both Conway sources are pinned to a 40-hex commit; automaton is MIT and bundled, skills are unlicensed and never bundled', () => {
  for (const s of [AUTOMATON_SOURCES.program, AUTOMATON_SOURCES.skills]) assert.match(s.commit, /^[0-9a-f]{40}$/);
  assert.equal(AUTOMATON_SOURCES.program.license, 'MIT');
  assert.equal(AUTOMATON_SOURCES.program.bundled, true);
  assert.equal(AUTOMATON_SOURCES.skills.license, null);
  assert.equal(AUTOMATON_SOURCES.skills.bundled, false);
  assert.equal(AUTOMATON_SOURCES.skills.fetchOnEnable, true);
});

test('installPlan is pinned to the commits and fetches Conway skills only on enable', () => {
  const plan = installPlan({ dir: '/tmp/k' });
  assert.equal(plan.program.pinned, AUTOMATON_SOURCES.program.commit);
  assert.ok(plan.program.steps.some((s) => s.includes(AUTOMATON_SOURCES.program.commit)));
  assert.ok(plan.program.steps.some((s) => s.includes('checkout --detach')));
  assert.equal(plan.skills.pinned, AUTOMATON_SOURCES.skills.commit);
  assert.equal(plan.skills.fetchOnEnable, true);
  assert.equal(plan.skills.license, null);
});

test('the Kronos catalog ships off and its pins are the same single source of truth as the module', () => {
  assert.equal(catalog.default, 'off');
  assert.equal(catalog.rails.enabledByDefault, false);
  assert.equal(catalog.rails.capRequired, true);
  assert.equal(catalog.rails.gate.offToggle.shipsOff, true);
  assert.equal(catalog.rails.replication, 'never');
  assert.equal(catalog.program.commit, AUTOMATON_SOURCES.program.commit);
  assert.equal(catalog.program.license, AUTOMATON_SOURCES.program.license);
  assert.equal(catalog.skills.commit, AUTOMATON_SOURCES.skills.commit);
  assert.equal(catalog.skills.license, AUTOMATON_SOURCES.skills.license);
  assert.equal(catalog.skills.bundled, false);
});

test('ships off and safe: off, gate on, dry-run, no cap, no replication', () => {
  const d = defaultAutomatonState();
  assert.equal(d.enabled, false);
  assert.equal(d.gateMode, 'on');
  assert.equal(d.mode, 'dry-run');
  assert.equal(d.replication, false);
  assert.equal(d.caps.totalCents, 0);
  assert.ok(MODES.includes(d.mode));
});

test('the agent facade exposes only requestAction; the owner facade holds every authority', () => {
  const p = place();
  try {
    const a = make(p);
    assert.deepEqual(Object.keys(a.agent), ['requestAction']);
    for (const k of ['setCap', 'setMode', 'enable', 'disable', 'setGateMode', 'clearKill', 'wallet']) assert.equal(typeof a.owner[k], 'function', `owner.${k}`);
    // The agent surface carries no authority method and no way to reach the owner facade.
    assert.equal(a.agent.setCap, undefined);
    assert.equal(a.agent.setGateMode, undefined);
    assert.equal(a.agent.owner, undefined);
  } finally { p.done(); }
});

test('no cap, no start: enable is refused until a cap is set', () => {
  const p = place();
  try {
    const a = make(p);
    assert.equal(a.owner.enable().reason, 'no-cap');
    a.owner.setCap({ totalCents: 5000 });
    assert.equal(a.owner.enable().ok, true);
    assert.equal(a.state().enabled, true);
  } finally { p.done(); }
});

test('cap math is pure and enforced: total and daily ceilings, and no cap means nothing spends', () => {
  const spent = { totalCents: 0, todayCents: 0 };
  assert.equal(capCheck({ cents: 100, caps: { totalCents: 0, dailyCents: 0 }, spent }), 'no-cap');
  assert.equal(capCheck({ cents: 100, caps: { totalCents: 500, dailyCents: 0 }, spent }), null);
  assert.equal(capCheck({ cents: 600, caps: { totalCents: 500, dailyCents: 0 }, spent }), 'total-cap');
  assert.equal(capCheck({ cents: 300, caps: { totalCents: 500, dailyCents: 200 }, spent }), 'daily-cap');
  assert.equal(capCheck({ cents: 0, caps: { totalCents: 500 }, spent }), null);
});

test('spentFrom splits total from the current UTC day', () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const entries = [{ at: '2026-10-14T23:00:00Z', cents: 100 }, { at: '2026-10-15T01:00:00Z', cents: 200 }, { at: '2026-10-15T11:00:00Z', cents: 50 }];
  assert.deepEqual(spentFrom(entries, now), { totalCents: 350, todayCents: 250 });
});

test('gate ON: every spend and every self-mod asks; a decline spends nothing; the ledger holds only approved spends', async () => {
  const p = place();
  try {
    const asked = [];
    const a = make(p, { approve: async (act) => { asked.push(act.kind); return act.cents <= 1000; } });
    a.owner.setCap({ totalCents: 10_000, dailyCents: 5000 });
    a.owner.enable();
    assert.equal((await a.agent.requestAction({ kind: 'spend', cents: 800, summary: 'api credits' })).how, 'approve');
    assert.equal((await a.agent.requestAction({ kind: 'spend', cents: 4000 })).reason, 'declined'); // asked, owner said no
    assert.equal((await a.agent.requestAction({ kind: 'self-mod', summary: 'patch its own strategy' })).how, 'approve');
    assert.deepEqual(asked, ['spend', 'spend', 'self-mod']);
    const led = JSON.parse(readFileSync(join(p.state, 'automaton-ledger.json'), 'utf8'));
    assert.deepEqual(led.entries.map((e) => e.cents), [800], 'only the approved spend is on the ledger; the declined one is not');
  } finally { p.done(); }
});

test('gate OFF needs a cap AND out-of-band consent; then money runs autonomously but self-mod still asks and replication is refused', async () => {
  const p = place();
  try {
    let asks = 0;
    const a = make(p, { approve: async () => { asks += 1; return true; }, gateOffConsent: async () => true });
    a.owner.setCap({ totalCents: 10_000 });
    a.owner.enable();
    const off = await a.owner.setGateMode('off');
    assert.equal(off.ok, true);
    assert.equal(a.state().gateMode, 'off');
    // Autonomous money within the cap: no ask.
    assert.equal((await a.agent.requestAction({ kind: 'trade', cents: 2000 })).how, 'auto');
    assert.equal(asks, 0);
    // But over the cap is still refused, self-mod still asks, replication is refused.
    assert.equal((await a.agent.requestAction({ kind: 'trade', cents: 9000 })).reason, 'total-cap');
    assert.equal((await a.agent.requestAction({ kind: 'self-mod' })).how, 'approve');
    assert.equal(asks, 1);
    assert.equal((await a.agent.requestAction({ kind: 'replicate' })).reason, 'replication-off');
  } finally { p.done(); }
});

test('gate-off cannot be self-serviced: without out-of-band consent it ships refusing and stays on', async () => {
  const p = place();
  try {
    const a = make(p); // default gateOffConsent refuses
    a.owner.setCap({ totalCents: 10_000 });
    const r = await a.owner.setGateMode('off');
    assert.equal(r.ok, false);
    assert.equal(r.needsConsent, true);
    assert.equal(r.token, undefined, 'no token is handed back for a caller to echo');
    assert.equal(a.state().gateMode, 'on');
  } finally { p.done(); }
});

test('gate-off is refused without a cap even when the owner consents', async () => {
  const p = place();
  try {
    const a = make(p, { gateOffConsent: async () => true });
    assert.equal((await a.owner.setGateMode('off')).reason, 'no-cap');
  } finally { p.done(); }
});

test('requestAction cannot pass its own approver (no options override)', async () => {
  const p = place();
  try {
    let realApproveCalled = false;
    const a = make(p, { approve: async () => { realApproveCalled = true; return false; } });
    a.owner.setCap({ totalCents: 10_000 });
    a.owner.enable();
    // An attacker-supplied second argument must be ignored: the construction-time approve (which refuses) still governs.
    const r = await a.agent.requestAction({ kind: 'spend', cents: 100 }, { approve: async () => true });
    assert.equal(r.reason, 'declined');
    assert.equal(realApproveCalled, true);
  } finally { p.done(); }
});

test('real funds are refused outside live mode, whatever the action asks', async () => {
  const p = place();
  try {
    const a = make(p);
    a.owner.setCap({ totalCents: 10_000 }); a.owner.enable();
    assert.equal((await a.agent.requestAction({ kind: 'spend', cents: 500, realFunds: true })).reason, 'not-live-mode');
    a.owner.setMode('live');
    assert.equal((await a.agent.requestAction({ kind: 'spend', cents: 500, realFunds: true })).how, 'approve');
  } finally { p.done(); }
});

test('M8: two overlapping gate-on approvals cannot both slip past one cap', async () => {
  const p = place();
  try {
    let release; const gate = new Promise((r) => { release = r; });
    const a = make(p, { approve: async () => { await gate; return true; } });
    a.owner.setCap({ totalCents: 1000 }); a.owner.enable();
    const r1 = a.agent.requestAction({ kind: 'spend', cents: 700 });
    const r2 = a.agent.requestAction({ kind: 'spend', cents: 700 }); // both fit alone, not together
    release();
    const [o1, o2] = await Promise.all([r1, r2]);
    assert.equal([o1, o2].filter((x) => x.ok).length, 1, 'only one 700¢ spend records against a 1000¢ cap');
    assert.ok([o1, o2].some((x) => x.reason === 'total-cap'), 'the second is refused by the post-approval re-check');
  } finally { p.done(); }
});

test('the kill switch stops everything, freezes spending, puts the gate back on; "stop approving" fires it; only the owner clears it', async () => {
  const p = place();
  try {
    let killedChildren = 0, alerts = 0;
    const a = make(p, { killChildren: async () => { killedChildren += 1; }, alert: () => { alerts += 1; }, gateOffConsent: async () => true });
    a.owner.setCap({ totalCents: 10_000 });
    await a.owner.setGateMode('off');
    a.owner.enable();
    assert.equal(a.state().gateMode, 'off');
    assert.equal(a.onText('please stop approving now'), true);
    assert.equal(killedChildren, 1);
    assert.equal(a.state().killed, true);
    assert.equal(a.state().gateMode, 'on', 'the gate is forced back on');
    assert.equal((await a.agent.requestAction({ kind: 'spend', cents: 10 })).reason, 'killed');
    assert.equal(a.owner.enable().reason, 'killed', 'cannot re-enable while killed');
    a.owner.clearKill();
    assert.equal(a.state().killed, false);
    assert.equal(a.state().enabled, false, 'clearing the kill leaves it off');
    assert.ok(alerts >= 1, 'a problem alert went to the phone');
  } finally { p.done(); }
});

test('an ordinary line does not fire the kill switch', () => {
  const p = place();
  try {
    const a = make(p);
    assert.equal(a.onText('approve the next trade please'), false);
    assert.equal(a.state().killed, false);
  } finally { p.done(); }
});

test('every decision is audited (request, approve/auto/refuse, cap, gate, kill)', async () => {
  const p = place();
  try {
    const a = make(p);
    a.owner.setCap({ totalCents: 10_000 }); a.owner.enable();
    await a.agent.requestAction({ kind: 'spend', cents: 500 });
    await a.agent.requestAction({ kind: 'spend', cents: 99_999 });
    await a.stop('test');
    const events = p.audit().map((e) => e.event);
    for (const want of ['cap', 'enable', 'request', 'approve', 'refuse', 'kill']) assert.ok(events.includes(want), `audit has ${want}`);
  } finally { p.done(); }
});

test('state survives a reload: a second supervisor on the same folder sees the cap, gate and ledger', async () => {
  const p = place();
  try {
    const a = make(p);
    a.owner.setCap({ totalCents: 10_000 }); a.owner.enable();
    await a.agent.requestAction({ kind: 'spend', cents: 700 });
    const b = make(p);
    assert.equal(b.state().enabled, true);
    assert.equal(b.state().caps.totalCents, 10_000);
    assert.equal(b.status().spent.totalCents, 700);
  } finally { p.done(); }
});
