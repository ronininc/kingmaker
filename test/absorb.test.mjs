// Kingmaker absorbs what it connects to (lib/absorb.mjs): tools become candidate skills while learning is on, uses are
// scored, the proven ones graduate (fastest first), the failing and idle ones retire. Minting never grants anything.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { absorbConnector, absorbedView, isGatedTool, recordUse, scorecard, skillBrief, skillForTool, sweepIdle } from '../lib/absorb.mjs';

const tools = [
  { name: 'list_zones', description: 'List the DNS zones in the account', inputSchema: { properties: { page: { type: 'number', description: 'page' } } } },
  { name: 'workers_deploy', description: 'Deploy a Worker script', inputSchema: { properties: { name: { description: 'script name' } }, required: ['name'] } },
];
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 15, 12, 0, tick++)).toISOString();
const fresh = () => mkdtempSync(join(tmpdir(), 'absorb-'));

test('a tool that acts on the world always carries the owner\'s OK; a reading tool just reads', () => {
  assert.equal(isGatedTool(tools[0]), false); assert.equal(isGatedTool(tools[1]), true);
  assert.equal(isGatedTool({ name: 'send_email' }), true); assert.equal(isGatedTool({ name: 'get_weather' }), false);
  const g = skillForTool('cloudflare', tools[1]);
  assert.equal(g.name, 'cloudflare-workers-deploy'); assert.match(g.markdown, /only after they say go ahead/); assert.match(g.markdown, /`name` \(required\)/);
  assert.match(skillForTool('cloudflare', tools[0]).markdown, /It only reads/);
});

test('learning on: every tool becomes a candidate skill once; learning off: nothing is minted', () => {
  const state = fresh();
  const r = absorbConnector('cloudflare', tools, { state, now: clock });
  assert.deepEqual(r.minted, ['cloudflare-list-zones', 'cloudflare-workers-deploy']);
  assert.ok(existsSync(join(state, 'skills', 'absorbed', 'cloudflare-list-zones', 'SKILL.md')));
  assert.deepEqual(absorbConnector('cloudflare', tools, { state, now: clock }).minted, [], 'known skills are not minted twice');
  const off = fresh();
  assert.equal(absorbConnector('github', tools, { state: off, learningOn: () => false }).why, 'learning is off');
  assert.equal(existsSync(join(off, 'skills', 'absorbed')), false);
});

test('scored uses: a skill that keeps working graduates; one that keeps failing retires (moved aside, not deleted)', () => {
  const state = fresh(); absorbConnector('cloudflare', tools, { state, now: clock });
  for (let i = 0; i < 3; i++) recordUse('cloudflare-list-zones', { ok: true, ms: 400 + i }, { state, now: clock });
  assert.equal(absorbedView(state).find((s) => s.name === 'cloudflare-list-zones').status, 'graduated');
  for (let i = 0; i < 5; i++) recordUse('cloudflare-workers-deploy', { ok: false }, { state, now: clock });
  assert.equal(absorbedView(state).find((s) => s.name === 'cloudflare-workers-deploy').status, 'retired');
  assert.ok(existsSync(join(state, 'skills', 'absorbed', '.retired', 'cloudflare-workers-deploy', 'SKILL.md')), 'kept, out of the way');
  assert.equal(recordUse('cloudflare-list-zones', { ok: true }, { state, learningOn: () => false }), null, 'learning off: nothing is scored');
});

test('the brief: proven skills first, the faster of two first, a few new ones to try, and short', () => {
  const state = fresh();
  absorbConnector('a', [{ name: 'lookup', description: 'find a thing' }], { state, now: clock });
  absorbConnector('b', [{ name: 'lookup', description: 'find a thing' }, { name: 'peek', description: 'look' }], { state, now: clock });
  for (let i = 0; i < 3; i++) { recordUse('a-lookup', { ok: true, ms: 900 }, { state, now: clock }); recordUse('b-lookup', { ok: true, ms: 200 }, { state, now: clock }); }
  const brief = skillBrief(state);
  assert.ok(brief.indexOf('b-lookup') < brief.indexOf('a-lookup'), 'equally reliable: the faster one leads');
  assert.match(brief, /b-peek .*new, worth trying/);
  assert.ok(brief.split('\n').length <= 12);
  assert.deepEqual(scorecard([{ ok: true, ms: 5 }, { ok: false }, { ok: true, ms: 7 }]).cleanStreak, 1);
});

test('a candidate never used in 30 days is retired', () => {
  const state = fresh();
  absorbConnector('x', [{ name: 'rarely' }], { state, now: () => '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(sweepIdle({ state, now: () => '2026-10-15T00:00:00.000Z' }), ['x-rarely']);
  assert.match(readFileSync(join(state, 'skills', 'absorbed', 'ledger.json'), 'utf8'), /never used/);
});
