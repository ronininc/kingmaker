// Tool panels: TRUE progress and completion, the user's real UI settings, verified cancel (2026-11-16, panels follow-up).
// Real child processes (python3 / sh) in temp dirs; no model, no network, no live profile. The Swift side
// (app/Kingmaker.swift showToolPanel) is checked here only by reading its source — it is NOT built or run in-app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barThemeFromDefaults, createPanelChannel, createToolSessions, PROGRESS_PARSERS, PROGRESS_READERS, progressLabel, readPhase, readingPercent, renderToolPanels } from '../lib/tool-sessions.mjs';
import { pidAlive } from '../lib/kill-tree.mjs';

const registry = { tools: { python3: { path: '/usr/bin/python3' }, sh: { path: '/bin/sh' } } };
const dir = () => mkdtempSync(join(tmpdir(), 'km-panels-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilEvent = (ts, pred, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { ts.events.off('update', on); reject(new Error('timed out waiting for a panel event')); }, ms);
  const on = (k, v) => { if (pred(k, v)) { clearTimeout(t); ts.events.off('update', on); resolve(v); } };
  ts.events.on('update', on);
});

test('readers: steps, bytes and percent come only from what the tool printed; no total → no percentage', () => {
  const g = PROGRESS_READERS.generic;
  assert.deepEqual(g('frame 3 of 10'), { kind: 'steps', done: 3, total: 10 });
  assert.deepEqual(g('Sample 8/32'), { kind: 'steps', done: 8, total: 32 });
  assert.deepEqual(g('1048576 of 4194304 bytes'), { kind: 'bytes', done: 1048576, total: 4194304 });
  assert.deepEqual(g('12.5 MB / 40 MB'), { kind: 'bytes', done: 12500000, total: 40000000 });
  assert.deepEqual(g('45%'), { kind: 'percent', done: 45, total: 100 });
  assert.deepEqual(g('downloaded 12 MB'), { kind: 'bytes', done: 12000000, total: null });
  assert.equal(readingPercent(g('downloaded 12 MB')), null, 'bytes without a total: indeterminate');
  assert.equal(readingPercent(g('7/3')), null, 'done > total is not a progress reading');
  assert.equal(readingPercent({ kind: 'steps', done: 0, total: 0 }), null);
  assert.equal(g('Fra:1 Mem:12M | Syncing'), null);
  assert.equal(PROGRESS_PARSERS.generic('step 2/8'), 25, 'the number parser the lane uses is unchanged in meaning');
  assert.equal(readPhase('phase: encoding'), 'encoding'); assert.equal(readPhase('[stage] upload'), 'upload'); assert.equal(readPhase('encoding phase done'), null);
});

test('panel channel: job steps/bytes/phase drive progress; unknown total is indeterminate; final is never indeterminate and never forced to 100%; no timer moves anything', async () => {
  const out = [];
  const ch = createPanelChannel({ emit: (v) => out.push(v) });
  ch.update('j', { tool: 'export', state: 'running', activity: 'starting' });
  assert.equal(out.at(-1).indeterminate, true); assert.equal(out.at(-1).progress, null);
  ch.update('j', { phase: 'copying', bytes: { done: 5e6, total: null } });
  assert.deepEqual([out.at(-1).indeterminate, out.at(-1).progress, out.at(-1).bytes.done, out.at(-1).phase], [true, null, 5e6, 'copying']);
  assert.match(progressLabel(out.at(-1)), /5\.0 MB so far \(total not reported\)/);
  ch.update('j', { steps: { done: 2, total: 5 }, phase: 'rendering' });
  assert.deepEqual([out.at(-1).indeterminate, out.at(-1).progress, out.at(-1).steps], [false, 40, { done: 2, total: 5 }]);
  assert.equal(progressLabel(out.at(-1)), '2/5 · 40%');
  ch.update('j', { steps: { done: 9, total: 5 } });
  assert.equal(out.at(-1).progress, 40, 'an incoherent reading (9 of 5) is ignored; the last real one stays');
  ch.update('j', { line: 'writing the file' });
  assert.equal(out.at(-1).progress, 40, 'a line with no reading keeps the last real value');
  const n = out.length; await sleep(250);
  assert.equal(out.length, n, 'no events without job events: nothing advances by time');
  ch.update('j', { state: 'completed', activity: 'Outcome: done' });
  assert.deepEqual([out.at(-1).state, out.at(-1).progress, out.at(-1).indeterminate], ['completed', 40, false], 'completion keeps the real reading (not dressed up as 100%)');
  const f = createPanelChannel({ emit: (v) => out.push(v) });
  f.update('k', { tool: 'x', state: 'running' }); f.update('k', { state: 'failed', activity: 'exit 2' });
  assert.deepEqual([out.at(-1).state, out.at(-1).indeterminate, out.at(-1).progress], ['failed', false, null]);
  assert.equal(f.update('k', { state: 'completed' }).ok, false, 'a failure can not become completed later');
});

test('a real tool: progress from its own output, phase lines, still "running" after it prints 100% — completed only on its observed exit 0', async () => {
  const cwd = dir();
  try {
    const ts = createToolSessions({ registry });
    const s = ts.start({ tool: 'python3', args: ['-u', '-c', 'import time\nprint("phase: download")\nprint("1048576 of 4194304 bytes")\ntime.sleep(0.3)\nprint("100%")\ntime.sleep(0.8)\nprint("tidying up")'], cwd });
    const bytes = await untilEvent(ts, (k, v) => v.id === s.id && v.bytes);
    assert.deepEqual([bytes.progress, bytes.bytes.total, bytes.phase, bytes.indeterminate], [25, 4194304, 'download', false]);
    const hundred = await untilEvent(ts, (k, v) => v.id === s.id && v.progress === 100);
    assert.equal(hundred.state, 'running', 'the tool said 100% but has not exited: not completed');
    await sleep(200);
    assert.equal(ts.get(s.id).state, 'running', 'still running until the exit is observed');
    const end = await ts.wait(s.id);
    assert.deepEqual([end.state, end.exitCode, end.indeterminate], ['completed', 0, false]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('a real tool with no measurable progress is indeterminate while running; a failure keeps its last real reading and is reported failed', async () => {
  const cwd = dir();
  try {
    const ts = createToolSessions({ registry });
    const quiet = ts.start({ tool: 'python3', args: ['-u', '-c', 'import time\nprint("thinking")\ntime.sleep(0.4)'], cwd });
    const live = await untilEvent(ts, (k, v) => v.id === quiet.id && v.activity === 'thinking');
    assert.deepEqual([live.state, live.progress, live.indeterminate], ['running', null, true]);
    assert.match(renderToolPanels([live], { look: 'black', accent: '#4ADE80', textSize: 14 }), /<progress data-indeterminate/);
    const q = await ts.wait(quiet.id);
    assert.deepEqual([q.state, q.progress, q.indeterminate], ['completed', null, false], 'completed with no invented percentage');
    const bad = ts.start({ tool: 'python3', args: ['-u', '-c', 'import sys\nprint("step 5/10")\nsys.exit(2)'], cwd });
    const b = await ts.wait(bad.id);
    assert.deepEqual([b.state, b.exitCode, b.progress, b.steps], ['failed', 2, 50, { done: 5, total: 10 }], 'failure: real last reading, not 100%');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('cancel: the whole tree (including a setsid grandchild outside the group) is killed and EVERY pid verified gone before the panel says cancelled', async () => {
  const cwd = dir();
  try {
    const ts = createToolSessions({ registry, graceMs: 1500 });
    const states = []; ts.events.on('update', (k, v) => states.push(v.state));
    // The child forks a grandchild that calls setsid() (leaves the process group), prints both pids, then both sleep.
    const s = ts.start({ tool: 'python3', args: ['-u', '-c', 'import os,time\npid=os.fork()\nif pid==0:\n  os.setsid()\n  time.sleep(60)\n  os._exit(0)\nprint("pids", os.getpid(), pid, flush=True)\nprint("frame 1/4", flush=True)\ntime.sleep(60)'], cwd });
    const v = await untilEvent(ts, (k, x) => x.id === s.id && /^pids /.test(x.activity));
    const [root, grand] = v.activity.split(' ').slice(1).map(Number);
    if (ts.get(s.id).progress !== 25) await untilEvent(ts, (k, x) => x.id === s.id && x.progress === 25);
    assert.ok(pidAlive(root) && pidAlive(grand));
    const d = await ts.dismiss(s.id);
    assert.equal(d.ok, true); assert.equal(d.verifiedGone, true);
    assert.ok(d.pids.includes(root) && d.pids.includes(grand), `killTree found the setsid grandchild: ${d.pids}`);
    assert.ok(!pidAlive(root) && !pidAlive(grand), 'both verified gone');
    const final = ts.get(s.id);
    assert.equal(final.state, 'cancelled'); assert.deepEqual(final.tree.stillAlive, []); assert.equal(final.indeterminate, false);
    assert.ok(!states.includes('completed') && !states.includes('failed'), 'a cancelled run is never shown completed or failed');
    assert.equal((await ts.wait(s.id)).state, 'cancelled');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the panel follows the user\'s real settings: look (black / glass / system), reply colour, text size, Reduce Motion; unknown values fall back to the bar\'s defaults', () => {
  const prefs = (o) => (key, domain) => (domain === 'com.apple.universalaccess' ? o.reduceMotion ?? null : o[key] ?? null);
  const glass = barThemeFromDefaults({ read: prefs({ 'km.look': 'glass', 'km.replyColor': 'blue', 'km.textSize': '16', 'km.position': 'bottom', reduceMotion: '1' }) });
  assert.deepEqual([glass.look, glass.accent, glass.textSize, glass.position, glass.reduceMotion], ['glass', '#73B8FF', 16, 'bottom', true]);
  const odd = barThemeFromDefaults({ read: prefs({ 'km.look': 'neon', 'km.replyColor': 'purple', 'km.textSize': 'huge' }) });
  assert.deepEqual([odd.look, odd.accent, odd.textSize, odd.reduceMotion], ['black', '#4ADE80', 14, false]);
  const running = { id: 'p', tool: 'export', state: 'running', activity: 'a', progress: null, indeterminate: true, visible: true };
  const g = renderToolPanels([running], glass);
  assert.match(g, /color-scheme:dark;font:16px/); assert.match(g, /background:Canvas/);
  assert.doesNotMatch(g, /<progress/, 'Reduce Motion: no animated indeterminate bar');
  assert.match(g, /working — the tool reports no total/);
  const sys = renderToolPanels([{ ...running, progress: 40, indeterminate: false, steps: { done: 2, total: 5 } }], barThemeFromDefaults({ read: prefs({ 'km.look': 'system' }) }));
  assert.doesNotMatch(sys, /color-scheme:dark/); assert.match(sys, /<progress value="40" max="100" style="accent-color:#4ADE80">/); assert.match(sys, /2\/5 · 40%/);
});

test('Swift source (NOT built, not run in-app): showToolPanel reads the same settings and the same progress fields', () => {
  const src = readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('func showToolPanel('), src.indexOf('func showSources('));
  for (const k of ['km.look', 'km.replyColor', 'km.textSize']) assert.match(src, new RegExp(`forKey: "${k.replace('.', '\\.')}"`));
  for (const f of ['"steps"', '"bytes"', '"indeterminate"', '"phase"', 'lookPref', 'replyColour', 'textSize']) assert.ok(fn.includes(f), `showToolPanel uses ${f}`);
  assert.ok(fn.includes('working — the tool reports no total'), 'same words as progressLabel for an unknown total');
  assert.doesNotMatch(fn, /Timer|asyncAfter|CABasicAnimation/, 'no timer-driven progress in the panel');
});
