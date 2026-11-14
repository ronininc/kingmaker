import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIST_MAX_AGE_MS, MAX_DRAFTS_PER_DAY, approvalCard, nightBrain, approveList, buildList, createNightly, draftPrompt, editItem, inWindow, jobRequest,
  latestList, nightlyCommand, nightlyDir, parseDrafts, readChecks, readSwitch, runChecks, windowNight, writeSwitch,
} from '../nightly.mjs';
import { claudeDraftArgs } from '../../../lib/claude-brain.mjs';
import { CODEX_DRAFT_TOOLS, codexDraftArgs } from '../../../lib/chatgpt-brain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), 'km-nightly-'));
// 2:30 am local on 2026-10-17: inside the default night window.
const NIGHT = new Date(2026, 9, 17, 2, 30).getTime();
const okFetch = async () => ({ status: 200 });
const downFetch = async () => { throw new Error('ECONNREFUSED'); };
const reply = JSON.stringify([
  { target: 'Merchant 496577092885', field: 'Current Status Notes', current: '', proposed: 'Menu photos uploaded — RG', source: 'Clover read 2026-10-16', owner: 'RG' },
  { target: 'Merchant 496577092885', field: 'Phone', current: '', proposed: '(602) 579-9198', source: 'Google listing' },
]);

function loop(state, over = {}) {
  const calls = { draft: [], submit: [], card: [], note: [] };
  const n = createNightly({
    state, now: () => NIGHT, brainName: () => 'claude', fetchImpl: okFetch,
    draft: (p) => { calls.draft.push(p); return reply; },
    sop: () => 'OS-79 draft everything',
    submit: (group, items) => { calls.submit.push({ group, items }); return { ok: true, taskId: `t-${group}` }; },
    card: (b) => calls.card.push(b), note: (l) => calls.note.push(l),
    setIntervalImpl: () => null, clearIntervalImpl: () => {},
    ...over,
  });
  return { n, calls };
}

test('ships off: no run, whatever the hour', () => {
  const s = dir();
  assert.equal(readSwitch(s).on, false);
  const { n, calls } = loop(s);
  n.tick();
  assert.equal(calls.draft.length, 0);
  assert.equal(latestList(s), null);
});

test('the window: 1–5 am by default, and a window may wrap midnight', () => {
  assert.equal(inWindow(2), true); assert.equal(inWindow(5), false); assert.equal(inWindow(0), false);
  assert.equal(inWindow(23, 23, 4), true); assert.equal(inWindow(3, 23, 4), true); assert.equal(inWindow(12, 23, 4), false);
});

test('on, in the window: one run a night, held by a meeting or a turn in progress', async () => {
  const s = dir(); writeSwitch(s, { on: true });
  let meeting = true;
  const { n, calls } = loop(s, { meeting: () => meeting });
  n.tick(); assert.equal(calls.draft.length, 0, 'a meeting holds it');
  meeting = false; n.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.draft.length, 1);
  assert.equal(readSwitch(s).lastRun, '2026-10-17');
  n.tick(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.draft.length, 1, 'never twice in one night');
});

test('draft-only: the night writes nothing anywhere but its own list, which is private', async () => {
  const s = dir();
  const { n, calls } = loop(s);
  const r = await n.runNow();
  assert.ok(r.ok);
  assert.equal(calls.submit.length, 0, 'nothing goes to the CRM before approval');
  assert.equal(r.list.status, 'open');
  assert.equal(r.list.items.filter((i) => i.group === 'data').length, 2);
  const file = join(nightlyDir(s), 'list-2026-10-17.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(calls.draft[0], /DRAFT ONLY/); assert.match(calls.draft[0], /OS-79 draft everything/);
  assert.equal(calls.card.at(-1).yesCommand, `nightly approve ${r.list.hash}`);
});

test('the local model never drafts at night: the list asks which cloud brain to use instead', async () => {
  const s = dir();
  const { n, calls } = loop(s, { brainName: () => 'local' });
  const r = await n.runNow();
  assert.equal(calls.draft.length, 0);
  assert.ok(r.list.items.some((i) => i.group === 'question' && /Claude or ChatGPT/.test(i.target)));
});

test('parseDrafts: no source is dropped, no value is a question, sensitive numbers never land; phones and MIDs do', () => {
  const p = parseDrafts(`Here you go:\n${JSON.stringify([
    { target: 'A', field: 'Notes', proposed: 'x' },
    { target: 'B', field: 'Hours', current: '9-5', proposed: '', source: 'GBP' },
    { target: 'C', field: 'Owner SSN', proposed: '123-45-6789', source: 'doc' },
    { target: 'D', field: 'Bank account number', proposed: '000123456789', source: 'void check' },
    { target: 'E', field: 'Card', proposed: '4242 4242 4242 4242', source: 'x' },
    { target: 'Merchant 496577092885', field: 'Phone', proposed: '602-579-9198', source: 'GBP' },
  ])}`);
  assert.deepEqual(p.items.map((i) => i.target), ['Merchant 496577092885']);
  assert.equal(p.questions.length, 1); assert.match(p.questions[0], /^B · Hours/);
  assert.equal(p.dropped.length, 4);
  assert.ok(!JSON.stringify(p).includes('123-45-6789') && !JSON.stringify(p).includes('000123456789'));
  assert.deepEqual(parseDrafts('no list here').items, []);
});

test('health: a page that does not answer or a stale file becomes a drafted fix; healthy ones do not', async () => {
  const s = dir();
  const log = join(s, 'dock.log'); writeFileSync(log, 'x');
  writeFileSync(join(s, 'nightly-checks.json'), JSON.stringify([
    { name: 'Site', kind: 'http', url: 'https://example.test/', fix: 'Check the deploy' },
    { name: 'Dock', kind: 'fresh', file: log, maxAgeMinutes: 30, fix: 'Restart the dock' },
    { name: 'Bad', kind: 'ftp' },
  ]));
  const { checks, skipped } = readChecks(s);
  assert.equal(checks.length, 2); assert.deepEqual(skipped, ['Bad']);
  const res = await runChecks(checks, { fetchImpl: downFetch, now: () => statSync(log).mtimeMs + 90 * 60_000 });
  assert.deepEqual(res.map((r) => r.ok), [false, false]);
  const { n } = loop(s, { fetchImpl: downFetch, brainName: () => 'claude', now: () => statSync(log).mtimeMs + 90 * 60_000 });
  const r = await n.runNow();
  const fixes = r.list.items.filter((i) => i.group === 'fix');
  assert.deepEqual(fixes.map((f) => f.proposed), ['Check the deploy', 'Restart the dock']);
  assert.ok(r.list.dropped.some((d) => /Bad/.test(d)));
});

test('one click approves exactly what the card showed: an edit makes a new hash, the old card is refused', async () => {
  const s = dir();
  const { n, calls } = loop(s);
  const { list } = await n.runNow();
  const old = list.hash;
  const e = n.edit('1', 'Menu photos uploaded, 3 missing — RG');
  assert.ok(e.ok); assert.notEqual(e.list.hash, old);
  assert.equal(calls.card.at(-1).yesCommand, `nightly approve ${e.list.hash}`, 'the card is shown again with the new hash');
  const refused = await n.approve({ hash: old });
  assert.equal(refused.ok, false); assert.match(refused.error, /changed/);
  assert.equal(calls.submit.length, 0);
  const done = await n.approve({ hash: e.list.hash });
  assert.ok(done.ok);
  assert.equal(calls.submit.length, 1, 'one job for the data group');
  assert.equal(calls.submit[0].items[0].proposed, 'Menu photos uploaded, 3 missing — RG');
  assert.deepEqual(done.results.map((x) => x.status), ['Submitted', 'Submitted']);
  assert.equal(calls.card.at(-1), null, 'the card comes down');
  const again = await n.approve({ hash: e.list.hash });
  assert.equal(again.ok, false); assert.match(again.error, /already approved/);
});

test('skip leaves items out; a failed submit is reported once and never retried', async () => {
  const s = dir();
  let tries = 0;
  const { n } = loop(s, { submit: () => { tries++; return { ok: false, error: 'CRM_NOT_CONNECTED' }; } });
  const { list } = await n.runNow();
  const r = await n.approve({ hash: list.hash, skip: ['2'] });
  assert.ok(r.ok);
  assert.equal(tries, 1);
  assert.deepEqual(r.results, [{ id: '1', status: 'Failed', detail: 'CRM_NOT_CONNECTED' }]);
  assert.equal(latestList(s).items.find((i) => i.id === '2').result, undefined);
});

test('usage: a job the CRM holds for its allocation is Held, and cloud drafts stop at the daily cap', async () => {
  const s = dir();
  const { n, calls } = loop(s, { submit: (group) => ({ ok: true, taskId: `t-${group}`, held: "OroSolu's 50% allocation is exhausted" }) });
  const { list } = await n.runNow({ manual: true });
  const r = await n.approve({ hash: list.hash });
  assert.deepEqual(r.results.map((x) => x.status), ['Held', 'Held']);
  assert.match(r.results[0].detail, /allocation/);
  for (let i = 1; i < MAX_DRAFTS_PER_DAY + 2; i++) await n.runNow({ manual: true });
  assert.equal(calls.draft.length, MAX_DRAFTS_PER_DAY);
  assert.ok(latestList(s).dropped.some((d) => /cloud drafts allowed today/.test(d)));
});

test('stale drafts: a list older than a day and a half, or replaced by a newer night, is refused', async () => {
  const s = dir();
  const list = buildList({ now: NIGHT, drafts: parseDrafts(reply) });
  assert.equal(approveList(list, { hash: list.hash }, NIGHT + LIST_MAX_AGE_MS + 1).ok, false);
  let t = NIGHT;
  const { n } = loop(s, { now: () => t });
  const first = (await n.runNow()).list;
  t = NIGHT + 24 * 3600_000;
  const second = (await n.runNow()).list;
  assert.equal(JSON.parse(readFileSync(join(nightlyDir(s), `list-${first.date}.json`), 'utf8')).status, 'expired');
  assert.equal((await n.approve({ hash: first.hash })).ok, false);
  assert.ok((await n.approve({ hash: second.hash })).ok);
});

test('questions stay until answered, and the answers ride into the next night', async () => {
  const s = dir();
  let t = NIGHT;
  const { n, calls } = loop(s, { now: () => t, draft: (p) => { calls.draft.push(p); return JSON.stringify([{ target: 'Shop X', field: 'Hours', current: '', proposed: '', source: 'GBP' }]); } });
  const first = (await n.runNow()).list;
  const q = first.items.find((i) => i.group === 'question');
  assert.equal(approvalCard(first), null, 'questions alone are not a one-click card');
  assert.ok(n.answer(q.id, 'Mon–Sat 10–9').ok);
  assert.equal(n.answer(q.id, 'SSN 123-45-6789').ok, false);
  t = NIGHT + 24 * 3600_000;
  await n.runNow();
  assert.match(calls.draft.at(-1), /Mon–Sat 10–9/);
});

test('commands: typed and the card\'s control lines', () => {
  assert.deepEqual(nightlyCommand(':nightly on'), { op: 'on' });
  assert.deepEqual(nightlyCommand(':nightly'), { op: 'status' });
  assert.deepEqual(nightlyCommand('nightly approve 0123456789abcdef0123456789abcdef'), { op: 'approve', hash: '0123456789abcdef0123456789abcdef', skip: [] });
  assert.deepEqual(nightlyCommand(':nightly approve skip 2, 3'), { op: 'approve', hash: null, skip: ['2', '3'] });
  assert.deepEqual(nightlyCommand(':nightly edit 2 New value'), { op: 'edit', id: '2', text: 'New value' });
  assert.equal(nightlyCommand('nightly is my favourite word').op, 'help');
  assert.equal(nightlyCommand('turn on the nightly loop'), null);
});

test('the job says exactly what was approved and how to report it', () => {
  const j = jobRequest('data', [{ id: '1', target: 'Row 1', field: 'Notes', current: '', proposed: 'Done — RG', source: 'Clover' }]);
  assert.match(j.request, /in the CRM/);
  assert.match(j.detail, /Stale/); assert.match(j.detail, /1\. Row 1 · Notes: \(blank\) → Done — RG/);
  assert.equal(editItem(buildList({ now: NIGHT, drafts: parseDrafts(reply) }), '1', 'routing 123456789').ok, true, 'a field not about bank details keeps a plain number');
});

test('the draft runs are fresh, read-only and silent', () => {
  const c = claudeDraftArgs({ text: 'x', mcpConfigPath: '/m.json' });
  assert.ok(!c.includes('--resume') && !c.some((a) => /CLAUDE\.md/.test(a)));
  const allowed = c.slice(c.indexOf('--allowedTools') + 1, c.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['mcp__kingmaker__kingmaker_turn', 'mcp__kingmaker__kingmaker_status', 'mcp__kingmaker__kingmaker_pending'], 'reads only: no iPhone, text or call tools');
  assert.equal(c[c.indexOf('--tools') + 1], '', 'no built-in tools');
  for (const t of ['send-imessage-to-contact', 'call-from-phone', 'tap-phone', 'type-on-phone']) assert.ok(c.includes(`mcp__kingmaker__${t}`), `${t} is denied by name`);
  const x = codexDraftArgs({ text: 'x', port: 1, outFile: '/o.txt' });
  assert.ok(!x.includes('resume'));
  assert.equal(x[x.indexOf('--sandbox') + 1], 'read-only');
  assert.match(draftPrompt({ date: '2026-10-17' }), /DRAFT ONLY/);
});

test('the bar shows the card with its own words and commands, and takes it down when done', () => {
  const swift = readFileSync(join(here, '..', '..', '..', 'app', 'Kingmaker.swift'), 'utf8');
  assert.match(swift, /obj\["approvalAsk"\]/); assert.match(swift, /obj\["approvalAskClose"\]/);
  assert.match(swift, /onCommand\(shareCommands\.yes\)/);
  const cli = readFileSync(join(here, '..', '..', '..', 'lib', 'cli.mjs'), 'utf8');
  assert.match(cli, /\/\^nightly\\s\+\(approve\|later\|show\)\\b\//, 'the card\'s buttons reach the loop');
});

test('the night has its own brain: Claude unless set, or the daytime brain when that is a cloud one; never the local model', () => {
  assert.equal(nightBrain(null, 'local'), 'claude');
  assert.equal(nightBrain(null, 'chatgpt'), 'chatgpt');
  assert.equal(nightBrain('chatgpt', 'claude'), 'chatgpt');
  const s = dir(); writeSwitch(s, { brain: 'local' }); assert.equal(readSwitch(s).brain, null, 'the local model is never a night brain');
  writeSwitch(s, { brain: 'claude' }); assert.equal(readSwitch(s).brain, 'claude');
  assert.deepEqual(nightlyCommand(':nightly brain ChatGPT'), { op: 'brain', brain: 'chatgpt' });
});

test('approving needs the code the owner saw: no code shows it instead of approving the latest list', async () => {
  const s = dir();
  const { n, calls } = loop(s);
  const { list } = await n.runNow();
  const r = await n.approve({ skip: ['2'] });
  assert.equal(r.ok, false); assert.ok(r.error.includes(`:nightly approve ${list.hash} skip 2`));
  assert.equal(calls.submit.length, 0, 'nothing went to the CRM');
  assert.ok((await n.approve({ hash: list.hash })).ok);
});

test('two approvals at once submit once: the list is claimed before anything goes out', async () => {
  const s = dir();
  let release; const gate = new Promise((r) => { release = r; });
  const { n, calls } = loop(s, { submit: async (group, items) => { calls.submit.push({ group, items }); await gate; return { ok: true, taskId: 't' }; } });
  const { list } = await n.runNow();
  const first = n.approve({ hash: list.hash });
  const second = await n.approve({ hash: list.hash });
  assert.equal(second.ok, false);
  release();
  assert.ok((await first).ok);
  const third = await n.approve({ hash: list.hash });
  assert.equal(third.ok, false); assert.match(third.error, /already approved/);
  assert.equal(calls.submit.length, 1);
});

test('a wrapped window (23 → 4) is one night: the run at 23:30 is not repeated after midnight', async () => {
  assert.equal(windowNight(new Date(2026, 9, 16, 23, 30).getTime(), 23, 4), '2026-10-16');
  assert.equal(windowNight(new Date(2026, 9, 17, 2, 0).getTime(), 23, 4), '2026-10-16');
  assert.equal(windowNight(new Date(2026, 9, 17, 2, 0).getTime(), 1, 5), '2026-10-17');
  const s = dir(); writeSwitch(s, { on: true, startHour: 23, endHour: 4 });
  let t = new Date(2026, 9, 16, 23, 30).getTime();
  const { n, calls } = loop(s, { now: () => t });
  n.tick(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.draft.length, 1);
  t = new Date(2026, 9, 17, 1, 0).getTime();
  n.tick(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.draft.length, 1, 'same window, no second list');
  t = new Date(2026, 9, 17, 23, 15).getTime();
  n.tick(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.draft.length, 2, 'the next night runs');
});

test('the ChatGPT draft sees only the read-only Kingmaker tools', () => {
  assert.deepEqual(CODEX_DRAFT_TOOLS, ['kingmaker_turn', 'kingmaker_status', 'kingmaker_pending']);
  const x = codexDraftArgs({ text: 'x', port: 1, outFile: '/o.txt' });
  assert.ok(x.includes(`mcp_servers.kingmaker.enabled_tools=${JSON.stringify(CODEX_DRAFT_TOOLS)}`));
});

test('the bar queues a second card instead of hiding the first', () => {
  const swift = readFileSync(join(here, '..', '..', '..', 'app', 'Kingmaker.swift'), 'utf8');
  assert.match(swift, /if shareCard != nil, let shown = shownBoxKind, shown != kind \{ waitBox\(box\); return \}/);
  assert.match(swift, /let next = waitingBoxes\.removeFirst\(\)\.box/);
});
