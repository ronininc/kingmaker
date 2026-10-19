/**
 * Titan adaptation — tests. Injected fakes; no I/O, no network.
 * Run: node test/titan-adapt.test.mjs
 */
import assert from 'node:assert';
import { reportBlockage, exhaustAvenues } from '../lib/titan-adapt.mjs';

function deps(approved = true) {
  const audit = [];
  const learned = [];
  return {
    audit,
    learned,
    appendAudit: (e) => audit.push(e),
    learnPathway: (b, a, r) => learned.push({ blockage: b.id, avenue: a.name, result: r }),
    isApproved: () => approved,
    now: () => '2026-10-18T20:40:00.000Z',
  };
}

// 1. Blockage is reported honestly — user hears "not okay" first.
{
  const d = deps();
  const { blockage, userMessage } = reportBlockage({
    task: 'render 2hr film',
    reason: 'machine too heavy: needs 64GB, has 8GB',
    deps: d,
  });
  assert.ok(blockage.id.startsWith('block-'));
  assert.match(userMessage, /Not okay yet/);
  assert.match(userMessage, /background/);
  assert.equal(d.audit[0].type, 'titan/blockage');
}

// 2. First working avenue wins and is learned.
{
  const d = deps();
  const { blockage } = reportBlockage({ task: 't', reason: 'heavy', deps: d });
  const avenues = [{ name: 'decompose' }, { name: 'condense-further' }, { name: 'skill-search' }];
  const attempt = (a) => (a.name === 'condense-further' ? { ok: true, result: 'fits-now' } : { ok: false });
  const r = exhaustAvenues({ blockage, avenues, attempt, deps: d });
  assert.equal(r.ok, true);
  assert.equal(r.avenue, 'condense-further');
  assert.equal(r.learned, true);
  assert.deepEqual(r.tried, ['decompose', 'condense-further']);
  assert.equal(d.learned.length, 1);
  assert.equal(d.learned[0].avenue, 'condense-further');
  assert.equal(d.audit[d.audit.length - 1].type, 'titan/adapted');
}

// 3. Gate denied → no background work, honest stop.
{
  const d = deps(false);
  const { blockage } = reportBlockage({ task: 't', reason: 'heavy', deps: d });
  const r = exhaustAvenues({ blockage, avenues: [{ name: 'x' }], attempt: () => ({ ok: true }), deps: d });
  assert.equal(r.ok, false);
  assert.equal(r.learned, false);
  assert.deepEqual(r.tried, []);
  assert.match(r.reason, /gate denied/);
}

// 4. Every avenue fails → honestly still blocked, all tried.
{
  const d = deps();
  const { blockage } = reportBlockage({ task: 't', reason: 'heavy', deps: d });
  const r = exhaustAvenues({
    blockage,
    avenues: [{ name: 'a1' }, { name: 'a2' }],
    attempt: () => ({ ok: false, note: 'nope' }),
    deps: d,
  });
  assert.equal(r.ok, false);
  assert.equal(r.learned, false);
  assert.deepEqual(r.tried, ['a1', 'a2']);
  assert.match(r.reason, /honestly reported/);
}

// 5. Thrown attempt → treated as failed avenue, loop continues.
{
  const d = deps();
  const { blockage } = reportBlockage({ task: 't', reason: 'heavy', deps: d });
  const r = exhaustAvenues({
    blockage,
    avenues: [{ name: 'boom' }, { name: 'works' }],
    attempt: (a) => {
      if (a.name === 'boom') throw new Error('kaboom');
      return { ok: true, result: 'recovered' };
    },
    deps: d,
  });
  assert.equal(r.ok, true);
  assert.equal(r.avenue, 'works');
}

console.log('titan-adapt: 5/5 passed');
