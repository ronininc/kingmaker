// The bar's method lane, end to end on the Node side (2026-11-16): panel events, cancel, voice/typed parity, owner-only
// decisions. Real child processes (POSIX sh scripts that print and sleep, one with a background grandchild) in a temp
// state dir; the reasoner is a stub, the model host is a closed loopback port — no Ollama, no model, no network.
// The machine these ran on can be heavily loaded (first exec of a new script can take seconds), so waits are generous.
// Swift rendering of these events (app/Kingmaker.swift showToolPanel) is NOT exercised here: source only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KINGMAKER_OPEN_JEV = 'off';
const { createMethodLane, DECISION_SOURCES } = await import('../lib/method-request.mjs');
const { createPanelChannel, PANEL_FINAL } = await import('../lib/tool-sessions.mjs');
const { pidAlive } = await import('../lib/kill-tree.mjs');
const { isAttestedOwnerVoice } = await import('../lib/owner-voice.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out waiting'); }
async function gone(pid, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (!pidAlive(pid)) return true; await sleep(25); } return !pidAlive(pid); }

/** A fresh profile with two selected tools and one user method "boat test": prep (read-only) → longrun (needs approval)
 *  → record → check. longrun prints "frame 1/4", starts a background grandchild, writes both pids, then sleeps. */
function profile({ quick = false } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'km-bar-panels-'));
  const bin = join(state, 'bin'); mkdirSync(bin);
  const pids = join(state, 'pids.txt');
  writeFileSync(join(bin, 'prep.sh'), '#!/bin/sh\necho "prep done"\n'); chmodSync(join(bin, 'prep.sh'), 0o755);
  writeFileSync(join(bin, 'longrun.sh'), quick
    ? '#!/bin/sh\necho "frame 4/4"\necho "render finished"\n'
    : `#!/bin/sh\necho "frame 1/4"\nsleep 60 &\necho "$$ $!" > "$1"\nsleep 60\necho "never printed"\n`);
  chmodSync(join(bin, 'longrun.sh'), 0o755);
  mkdirSync(join(state, 'abilities', 'methods'), { recursive: true });
  writeFileSync(join(state, 'abilities', 'tools.json'), JSON.stringify({ schema: 'kingmaker.selected-tools/1', tools: { prep: { path: join(bin, 'prep.sh') }, longrun: { path: join(bin, 'longrun.sh') } } }));
  const spec = { id: 'boat-test', version: '1.0', title: 'boat test', domain: 'boat test', inputs: { prompt: '' }, steps: [
    { n: 1, id: 'prep', type: 'run-tool', tool: 'prep', args: [], readOnly: true },
    { n: 2, id: 'long', type: 'run-tool', tool: 'longrun', args: [pids] },
    { n: 3, id: 'rec', type: 'write-json', path: 'r.json', value: { method: 'boat-test' } },
    { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: 'boat-test' }] }] };
  const store = join(state, 'abilities', 'methods');
  writeFileSync(join(store, 'boat-test.method.md'), `# m\n\n\`\`\`kingmaker-method\n${JSON.stringify(spec)}\n\`\`\`\n`);
  writeFileSync(join(store, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: 'boat-test', title: 'boat test', domain: 'boat test', file: 'boat-test.method.md', quality: { tier: 'draft', score: 1, basis: 't' } }] }));
  return { state, pids, cleanup: () => rmSync(state, { recursive: true, force: true }) };
}
function lane(state) {
  const shown = [], said = [], panels = [];
  const l = createMethodLane({ state, show: (x) => shown.push(x), say: async (x) => said.push(x), panel: (p) => panels.push(p),
    brainOptions: { remote: false, reasoner: async () => 'stub', base: 'http://127.0.0.1:9', storage: null } });
  return { l, shown, said, panels };
}
const readPids = (f) => readFileSync(f, 'utf8').trim().split(/\s+/).map(Number);

test('typed: plan first, then a running panel with the tool\'s real line and its own progress; "stop" kills the process tree, panel → cancelled, report says what ran, nothing completed', async () => {
  const p = profile(); const { l, panels, said } = lane(p.state);
  try {
    assert.equal(await l.wants('Kingmaker, run the boat test', null), true);
    const plan = await l.handle('Kingmaker, run the boat test', null, { source: 'typed' });
    assert.equal(plan.status, 'awaiting-approval');
    assert.deepEqual(plan.plan.map((x) => x.tool), ['longrun']);
    assert.equal(panels.length, 0, 'nothing runs (no panel) before approval');
    const running = l.handle('yes, run it', null, { source: 'typed' });
    await until(() => existsSync(p.pids) && readFileSync(p.pids, 'utf8').trim().split(/\s+/).length === 2);
    const [root, grandchild] = readPids(p.pids);
    assert.ok(pidAlive(root) && pidAlive(grandchild), 'both processes are up while running');
    await until(() => panels.some((e) => e.state === 'running' && e.tail.includes('frame 1/4')));
    const live = panels.findLast((e) => e.state === 'running');
    assert.equal(live.progress, 25, 'progress comes from the tool\'s own "frame 1/4"');
    assert.ok(panels.filter((e) => e.state === 'running' && e.tail.length === 0).every((e) => e.progress === null), 'no percentage before the tool reported one');
    assert.equal(l.running().length, 1);
    assert.equal(await l.wants('stop', null), true, 'a running method claims "stop"');

    const r = await l.handle('Kingmaker, stop.', null, { source: 'typed' });
    assert.equal(r.status, 'cancelled');
    assert.ok(await gone(root), `root pid ${root} is gone`);
    assert.ok(await gone(grandchild), `grandchild pid ${grandchild} is gone`);
    const report = r.report;
    assert.equal(report.outcome, 'cancelled');
    const text = report.lines.join('\n');
    assert.match(text, /Already ran before the cancel: prep\b/);
    assert.match(text, /Stopped longrun\.sh .*process tree killed \(pids [\d, ]+\); verified gone/);
    assert.match(text, /Outcome: NOT done \(cancelled\) — nothing was marked completed\./);
    assert.doesNotMatch(text, /never printed/);
    assert.equal((await running).outcome, 'cancelled', 'the approving turn resolves with the same cancelled report');
    const mine = panels.filter((e) => e.id === live.id);
    assert.equal(mine.at(-1).state, 'cancelled');
    assert.ok(!mine.some((e) => e.state === 'completed' || e.state === 'unverified'), 'never completed/unverified');
    assert.match(said.at(-1), /cancelled/);
    const saved = JSON.parse(readFileSync(join(report.workDir, 'kingmaker-report.json'), 'utf8'));
    assert.equal(saved.outcome, 'cancelled'); assert.equal(saved.cancel.by, 'typed');
    assert.equal(l.running().length, 0);
    assert.equal(existsSync(join(report.workDir, 'r.json')), false, 'steps after the cancel did not run');
  } finally { try { for (const pid of readPids(p.pids)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } p.cleanup(); }
});

test('only the owner decides: unverified voice and the job inbox can ask but never approve, decline or cancel', async () => {
  const p = profile(); const { l, said } = lane(p.state);
  try {
    assert.deepEqual([...DECISION_SOURCES], ['typed', 'owner-voice']);
    await l.handle('Kingmaker, run the boat test', 'c', { source: 'job' });
    for (const [source, words] of [['job', 'yes, run it'], ['voice', 'yes, run it'], ['job', 'no'], ['voice', 'Kingmaker, cancel']]) {
      const r = await l.handle(words, 'c', { source });
      assert.equal(r.status, 'refused-not-owner', `${source} "${words}"`);
    }
    assert.match(said.join('\n'), /inbox can only propose/); assert.match(said.join('\n'), /needs your verified voice/);
    assert.equal(existsSync(p.pids), false, 'nothing ran');
    const unknown = await l.handle('yes, run it', 'c', { source: 'phone-or-anything' });
    assert.equal(unknown.status, 'refused-not-owner', 'an unknown source is treated as the inbox');
    // The plan is still pending for the owner; the owner starts it; a non-owner cannot stop it; the owner can.
    const started = await l.handle('yes, run it', 'c', { source: 'owner-voice', background: true });
    assert.equal(started.status, 'started');
    await until(() => existsSync(p.pids) && readFileSync(p.pids, 'utf8').trim().split(/\s+/).length === 2);
    const [root, grandchild] = readPids(p.pids);
    for (const source of ['job', 'voice']) assert.equal((await l.handle('stop', 'c', { source })).status, 'refused-not-owner');
    await sleep(100);
    assert.ok(pidAlive(root), 'a refused cancel leaves the run alone');
    const r = await l.handle('Kingmaker, cancel', 'c', { source: 'owner-voice' });
    assert.equal(r.status, 'cancelled'); assert.equal(r.report.cancel.by, 'owner-voice');
    assert.ok(await gone(root) && await gone(grandchild));
    assert.match(r.report.lines.join('\n'), /Cancelled by your verified voice/);
  } finally { try { for (const pid of readPids(p.pids)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } p.cleanup(); }
});

test('voice and typed take the same lane: same plan, same run, same honest final state', async () => {
  const runAs = async (source) => {
    const p = profile({ quick: true }); const { l, shown, panels } = lane(p.state);
    try {
      const plan = await l.handle('Kingmaker, run the boat test', null, { source });
      const res = await l.handle('yes, run it', null, { source, background: source !== 'typed' });
      const report = res.status === 'started' ? await res.done : res;
      return { plan: plan.plan.map((x) => `${x.step}:${x.tool}`), planShown: shown.filter((x) => /^ {2}long:|will run these tools/.test(x)).map((x) => x.replace(p.state, '<state>')), outcome: report.outcome, final: panels.at(-1).state, states: [...new Set(panels.map((e) => e.state))], progress: panels.at(-1).progress, steps: report.steps.map((s) => `${s.step}:${s.status}`) };
    } finally { p.cleanup(); }
  };
  const typed = await runAs('typed');
  const voice = await runAs('owner-voice');
  assert.deepEqual(voice, typed);
  assert.equal(typed.outcome, 'completed');
  assert.equal(typed.final, 'unverified', 'a record-only check is "ran, not verified", never "completed"');
  assert.deepEqual(typed.states, ['running', 'unverified']);
  assert.equal(typed.progress, 100, 'the tool itself printed 4/4');
});

test('panel channel: forward-only states, final is final, progress only when the tool reports it, real output tail', () => {
  const out = [];
  const ch = createPanelChannel({ emit: (v) => out.push(v), tail: 2 });
  ch.update('a', { tool: 'blender', state: 'running', activity: 'starting' });
  assert.equal(out[0].progress, null);
  ch.update('a', { line: 'Fra:1 Mem:12M | Syncing', progress: null });
  assert.equal(out.at(-1).progress, null, 'no number in the output → no percentage');
  ch.update('a', { line: 'Sample 8/32', progress: 25 });
  ch.update('a', { line: 'writing tile', progress: null });
  assert.equal(out.at(-1).progress, 25, 'the last reported value stays; nothing is advanced by time');
  assert.deepEqual(out.at(-1).tail, ['Sample 8/32', 'writing tile']);
  assert.equal(ch.update('a', { progress: 140 }).view.progress, 25, 'out-of-range progress is ignored');
  assert.equal(ch.update('a', { state: 'bogus' }).ok, false);
  ch.update('a', { state: 'cancelled', activity: 'cancelled by you' });
  const n = out.length;
  for (const state of ['completed', 'running', 'unverified']) assert.equal(ch.update('a', { state }).ok, false, `${state} after cancelled is dropped`);
  assert.equal(out.length, n);
  assert.equal(out.at(-1).state, 'cancelled'); assert.ok(out.at(-1).endedAt);
  assert.ok(out.every((v, i) => i === 0 || v.seq > out[i - 1].seq), 'seq strictly increases (the bar ignores stale events)');
  assert.ok(PANEL_FINAL.includes('unverified') && PANEL_FINAL.includes('cancelled'));
});

test('attested owner voice = a solvox2 token AND the gate\'s owner_match; a token alone is not authority', () => {
  assert.equal(isAttestedOwnerVoice('solvox2.abc', { reason: 'owner_match', ownerMatch: true }), true);
  assert.equal(isAttestedOwnerVoice('solvox2.abc', { reason: 'owner_match' }), true);
  for (const reason of ['not_owner', 'self_echo', 'owner_not_enrolled', 'embedding_unavailable', 'too_short']) assert.equal(isAttestedOwnerVoice('solvox2.abc', { reason, ownerMatch: false }), false, reason);
  assert.equal(isAttestedOwnerVoice(null, { reason: 'owner_match', ownerMatch: true }), false);
  assert.equal(isAttestedOwnerVoice('solvox1.old', { reason: 'owner_match', ownerMatch: true }), false);
  assert.equal(isAttestedOwnerVoice('solvox2.abc', { reason: 'owner_match', ownerMatch: false }), false);
});

test('wiring (source check): voice and typed bar turns reach the same lane with their source; a job turn is tagged; stop jumps the queue; the bar draws toolPanel events', () => {
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /lane\.handle\(text, opts\?\.conversationId \?\? null, \{ source: who\?\.ownerVoice \? 'owner-voice' : 'voice', background: true \}\)/);
  assert.match(cli, /ownerVoice: isAttestedOwnerVoice\(attestation, decision\)/);
  assert.match(cli, /\.handle\(text, phoneConv, \{ source: turnSource \}\)/);
  assert.match(cli, /const turnSource = t\?\.source === 'job' \? 'job' : 'typed';/);
  assert.match(cli, /phoneTurn\(text, \{ conversationId, source: 'job' \}\)/);
  assert.match(cli, /methodLane\?\.running\(\)\.length && methodLane\.isCancel\(jumpText\)/);
  assert.match(cli, /process\.stdout\.write\(`@@ghost \$\{JSON\.stringify\(\{ toolPanel: ev \}\)\}\\n`\)/);
  const swift = readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
  assert.match(swift, /if let panel = obj\["toolPanel"\] as\? \[String: Any\] \{ bar\.showToolPanel\(panel\) \}/);
  assert.match(swift, /func showToolPanel\(_ p: \[String: Any\]\)/);
});
