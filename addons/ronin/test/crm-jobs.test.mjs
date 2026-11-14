import './_bind.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrmJobs, openedLine, resultLines, workRequest } from '../crm-jobs.mjs';

test('work requests become jobs; quick actions, pictures and plain writing keep their own lanes', () => {
  assert.deepEqual(workRequest('make an ad about Kingmaker'), { request: 'make an ad about Kingmaker', kind: 'write' });
  assert.deepEqual(workRequest('Kingmaker, please write the proposal for Hector Tacos'), { request: 'write the proposal for Hector Tacos', kind: 'write' });
  assert.deepEqual(workRequest('research merchant processing fees in Phoenix'), { request: 'research merchant processing fees in Phoenix', kind: 'research' });
  assert.equal(workRequest('draft a short Instagram post about taco night').kind, 'write');
  assert.equal(workRequest('mak an ad for yorself that explains why people need you').kind, 'write', 'a typo at the bar still opens the job');
  assert.equal(workRequest('make an ad for yourself to explain why people should want you').kind, 'write');
  assert.equal(workRequest('make an add that explains why somone would need you instead of cloud ai').kind, 'write', '"an add" is an ad');
  assert.equal(workRequest('add a note to Hector Tacos'), null, 'adding a note is not an ad');
  assert.equal(workRequest('can you put together a marketing plan for October').kind, 'write');
  for (const quick of ['open youtube', 'draft a WhatsApp to Hector saying I am late', 'how many merchants do we have', 'make a poster for taco night',
    'send Yordi the proposal', 'write me a haiku about Phoenix heat', 'write a summary of the crest timings', 'draft an email to Hector', 'what is on my calendar', ''])
    assert.equal(workRequest(quick), null, quick);
});

test('the lines: who has it, and the result when it lands', () => {
  assert.equal(openedLine({ job: { title: 'Make an ad about Kingmaker' }, agent: { id: 'solomon', local: true }, status: 'queued' }),
    'On the board: “Make an ad about Kingmaker”. Kingmaker on this Mac has it. I\'ll tell you when it\'s done.');
  assert.match(openedLine({ job: { title: 'X' }, agent: { name: 'Claude', local: false }, why: "the Mac can't write now (only 1.2 GB free): Claude helps", status: 'queued' }), /Claude has it \(the Mac can't write now/);
  assert.match(openedLine({ job: { title: 'X' }, agent: { name: 'Kingmaker', local: true }, status: 'unavailable_runner', reason: 'The Mac is offline.' }), /It's waiting: The Mac is offline\./);
  const landed = resultLines({ landed: true, job: { title: 'Ad' }, parts: [{ agent: 'Kingmaker' }], result: 'Kingmaker: your Mac, at your word.' });
  assert.equal(landed.said, 'Job done: “Ad”, by Kingmaker. It\'s in the bar and on the job.');
  assert.match(landed.shown, /Kingmaker: your Mac, at your word\./);
  assert.match(resultLines({ stuck: true, job: { title: 'Ad' }, reason: 'Kingmaker proposed a plan instead' }).said, /needs you: Kingmaker proposed a plan/);
  assert.equal(resultLines({ landed: false, stuck: false }), null);
});

function desk({ opened, reads = [] }) {
  const said = [], shown = [], bodies = [], timers = [];
  let t = 0;
  const jobs = createCrmJobs({
    open: async (body) => { bodies.push(body); return opened; },
    read: async () => reads.shift() ?? { ok: true, json: { data: { landed: false, stuck: false, status: 'queued' } } },
    say: async (l) => { said.push(l); }, show: async (l) => { shown.push(l); },
    setTimer: (fn) => { timers.push(fn); return null; }, now: () => t, pollMs: 1000, maxMs: 5000, id: () => 'bar-1' });
  return { jobs, said, shown, bodies, run: async () => { const fn = timers.shift(); t += 1000; await fn?.(); }, timers };
}

test('"make an ad about Kingmaker" opens a job, says who has it, then says the result when it lands', async () => {
  const d = desk({ opened: { ok: true, json: { data: { task_id: 'aw_0123456789abcdef', job: { title: 'Make an ad about Kingmaker' }, agent: { id: 'solomon', name: 'Kingmaker', local: true }, status: 'queued' } } },
    reads: [{ ok: true, json: { data: { landed: false, status: 'claimed' } } },
      { ok: true, json: { data: { landed: true, job: { title: 'Make an ad about Kingmaker' }, parts: [{ agent: 'Kingmaker' }], result: 'Kingmaker. Your Mac, at your word.' } } }] });
  assert.equal(await d.jobs.handle('make an ad about Kingmaker'), true);
  const { detail, ...body } = d.bodies[0];
  assert.deepEqual(body, { request: 'make an ad about Kingmaker', kind: 'write', asked_by_person: true, request_id: 'bar-1' });
  assert.match(detail, /What Kingmaker is/, 'work about Kingmaker carries what Kingmaker is');
  assert.match(detail, /run on the Mac itself/); assert.doesNotMatch(detail, /Orosolu|Ronin/, 'the public facts never name the owner\'s private CRM');
  assert.match(d.said[0], /On the board: “Make an ad about Kingmaker”\. Kingmaker on this Mac has it/);
  assert.deepEqual(d.jobs.watching(), ['aw_0123456789abcdef']);
  await d.run(); // still working
  assert.equal(d.said.length, 1);
  await d.run(); // landed
  assert.match(d.said[1], /^Job done: “Make an ad about Kingmaker”, by Kingmaker/);
  assert.match(d.shown[0], /Your Mac, at your word/);
  assert.deepEqual(d.jobs.watching(), []);
  assert.equal(d.timers.length, 0, 'no more polling once it landed');
});

test('a job that never lands in time is left on the board, said once', async () => {
  const d = desk({ opened: { ok: true, json: { data: { task_id: 'aw_0123456789abcdef', job: { title: 'T' }, agent: { local: true }, status: 'queued' } } } });
  await d.jobs.handle('write the proposal');
  for (let i = 0; i < 6 && d.timers.length; i++) await d.run();
  assert.match(d.said.at(-1), /“T” is still on the board/);
  assert.equal(d.timers.length, 0);
});

test('no CRM connected (or one without job tools): Kingmaker does it right here; a refusal is said', async () => {
  for (const r of [{ ok: false, status: 409, json: { error: 'CRM_NOT_CONNECTED' } }, { ok: false, status: 501, json: { error: 'CRM_HAS_NO_JOB_TOOLS' } }, { ok: false, status: 404, json: null }]) {
    const d = desk({ opened: r });
    assert.equal(await d.jobs.handle('make an ad about Kingmaker'), false, JSON.stringify(r));
    assert.equal(d.said.length, 0);
  }
  const refused = desk({ opened: { ok: false, status: 502, json: { error: 'CRM_CALL_FAILED', detail: 'A website is built only when a person asks for it.' } } });
  assert.equal(await refused.jobs.handle('write the copy for the ad'), true);
  assert.match(refused.said[0], /The CRM didn't open that job: A website is built only when a person asks/);
  const quick = desk({ opened: null });
  assert.equal(await quick.jobs.handle('open youtube'), false);
  assert.equal(quick.bodies.length, 0, 'a quick action never reaches the CRM');
});

test('only work about Kingmaker carries the Kingmaker facts', async () => {
  const { factsFor } = await import('../../../lib/kingmaker-facts.mjs');
  assert.match(factsFor('make an ad about King Maker'), /What Kingmaker is/);
  assert.equal(factsFor('write the proposal for Hector Tacos'), '');
  assert.doesNotMatch(factsFor('make an ad about Kingmaker'), /\$\d/, 'no prices it can\'t back');
});

test('out of allocation: Kingmaker does the work here, quietly (no "needs you" about a stuck job)', async () => {
  const { createCrmJobs, outOfAllocation, resultLines } = await import('../crm-jobs.mjs');
  const waiting = { task_id: 't1', status: 'waiting', reason: 'OroSolu’s 50% allocation is exhausted. Work is queued; it cannot borrow Ronin allocation.', job: { title: 'Write a two-sentence ad for a taco truck' }, agent: { local: true } };
  assert.equal(outOfAllocation(waiting), true);
  assert.equal(outOfAllocation({ ...waiting, status: 'queued' }), false);
  const said = [];
  const jobs = createCrmJobs({ open: async () => ({ ok: true, json: { data: waiting } }), read: async () => null, say: async (l) => said.push(l), setTimer: () => null });
  assert.equal(await jobs.handle('write a two-sentence ad for a taco truck'), false, 'the local writer answers instead');
  assert.deepEqual(said, []); assert.deepEqual(jobs.watching(), []);
  assert.deepEqual(resultLines({ ...waiting, stuck: true }), { said: '', shown: null });
  assert.doesNotMatch(resultLines({ stuck: true, reason: 'needs the owner’s sign-off.', job: { title: 'x' } }).said, /\.\./, 'no doubled period');
});
