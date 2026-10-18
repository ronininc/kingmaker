import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersonalization, redactSecrets, tagEvent } from '../lib/personalization.mjs';

let clock = Date.parse('2026-10-13T09:00:00Z');
const now = () => new Date(clock += 60_000).toISOString();
const store = (tenant = 'ronin') => openPersonalization({ root: mkdtempSync(join(tmpdir(), 'km-pers-')), tenant, now });
const owner = (text, extra = {}) => ({ tenant: 'ronin', consent: true, actor: 'owner', source: 'voice', text, ...extra });

test('acceptance: the same correction twice becomes a standing-preference candidate; the owner confirms it', () => {
  const s = store();
  assert.equal(s.ingest(owner('No, use metric units')).outcome, 'correction');
  assert.equal(s.ingest(owner('Actually, use metric units')).outcome, 'candidate');
  assert.match(s.memory().candidates['use metric units'].reason, /same correction 2×/);
  assert.throws(() => s.decideCandidate('use metric units', { approve: true, by: 'agent' }), /only the owner/);
  const p = s.decideCandidate('use metric units', { approve: true, by: 'owner' });
  assert.equal(p.kind, 'confirmed-candidate');
  assert.equal(s.memory().candidates['use metric units'], undefined);
});

test('acceptance: the same request three times becomes a candidate, not before', () => {
  const s = store();
  assert.equal(s.ingest(owner('Summarize the board for me')).outcome, 'logged');
  assert.equal(s.ingest(owner('summarize the board for me!')).outcome, 'logged');
  assert.equal(s.ingest(owner('Summarize the board for me.')).outcome, 'candidate');
});

test('acceptance: explicit "always" is recorded with its source; a conflicting later statement supersedes it', () => {
  const s = store();
  assert.equal(s.ingest(owner('Always give me the PR link first')).outcome, 'preference-recorded');
  assert.equal(s.ingest(owner('From now on give me the PR link first and the head commit')).outcome, 'preference-recorded');
  const r = s.ingest(owner('Always give me the PR link first, then tests'));
  assert.equal(s.memory().preferences['give me the pr link first'].polarity, 'always');
  assert.ok(['preference-recorded', 'preference-superseded'].includes(r.outcome));
  s.ingest(owner('Never give me the PR link first'));
  const pref = s.memory().preferences['give me the pr link first'];
  assert.equal(pref.polarity, 'never');
  assert.equal(pref.history.length, 1, 'the older statement is kept as superseded history, dated');
});

test('acceptance: nightly synthesis is written locally and read back at session start', () => {
  const s = store();
  s.ingest(owner('Always lead with the verdict'));
  s.ingest(owner('Too long, be brief'));
  const file = s.synthesize('2026-10-13');
  assert.ok(existsSync(file));
  const brief = s.startupBrief();
  assert.equal(brief.date, '2026-10-13');
  assert.match(brief.text, /Always lead with the verdict — always, since 2026-10-13 \[source [0-9a-f]{16}\]/);
  assert.match(brief.text, /never change what I may do/);
  const dailyDir = join(file, '..', '..', 'daily');
  for (const f of readdirSync(dailyDir)) assert.ok(!readFileSync(join(dailyDir, f), 'utf8').includes('lead with the verdict'), 'daily notes carry ids and tags, not raw text');
  assert.match(brief.text, /latest: shorter/);
});

test('acceptance: "where did you learn that?" returns the exact source events', () => {
  const s = store();
  const a = s.ingest(owner('No, put tests before the summary', { source: 'chat' }));
  const b = s.ingest(owner('Instead, put tests before the summary', { source: 'voice' }));
  const w = s.whereLearned('tests before the summary');
  assert.equal(w.kind, 'candidate');
  assert.deepEqual(w.learned_from.map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(w.learned_from.map((x) => x.source), ['chat', 'voice']);
  assert.match(w.learned_from[0].text, /put tests before the summary/);
});

test('correction → fix → owner reaction is tracked end to end', () => {
  const s = store();
  const c = s.ingest(owner('No, the deploy note is missing the rollback id', { ref: 'reply-17' }));
  const f = s.ingest({ tenant: 'ronin', consent: true, actor: 'claude', kind: 'fix', source: 'agent', text: 'Added rollback id to the deploy note', in_reply_to: c.id });
  assert.equal(f.outcome, 'fix-linked');
  assert.equal(s.ingest(owner('Looks good', { in_reply_to: f.id })).outcome, 'reaction-linked');
  const chain = s.memory().chains[c.id];
  assert.deepEqual([chain.correction, chain.fix, chain.reaction], [c.id, f.id, 'approved']);
  assert.match(readFileSync(s.synthesize('2026-10-13'), 'utf8'), new RegExp(`${c.id} → ${f.id} → approved`));
});

test('in_reply_to is fail-closed and role-specific', () => {
  const s = store();
  assert.throws(() => s.ingest({ tenant: 'ronin', consent: true, actor: 'claude', kind: 'fix', source: 'agent', text: 'fixed', in_reply_to: 'unknown' }), /known event/);
  const request = s.ingest(owner('Summarize the board'));
  assert.throws(() => s.ingest({ tenant: 'ronin', consent: true, actor: 'claude', kind: 'fix', source: 'agent', text: 'fixed', in_reply_to: request.id }), /answer a correction/);
  assert.throws(() => s.ingest(owner('Looks good', { in_reply_to: request.id })), /answer a fix/);
});

test('learning never widens authority: permission-changing "always" is refused and stays inactive', () => {
  const s = store();
  for (const t of ['Always send replies without asking', 'From now on auto-approve small payments', 'Always skip the approval for deploys', 'Never ask me before you merge, just merge']) {
    assert.equal(s.ingest(owner(t)).outcome, 'refused-authority', t);
  }
  assert.equal(Object.keys(s.memory().preferences).length, 0);
  assert.equal(s.whereLearned('send replies without asking').kind, 'refused');
  assert.match(readFileSync(s.synthesize('2026-10-13'), 'utf8'), /Refused \(would have changed authority\)/);
});

test('never stores credentials, codes or card data', () => {
  const s = store();
  s.ingest(owner('Always use card 4242 4242 4242 4242 for this'));
  s.ingest(owner('My verification code is 381920'));
  s.ingest(owner('the key is sk-live_abcdefghijklmnopqrstuvwxyz123456'));
  const raw = readFileSync(join(s.synthesize('2026-10-13'), '..', '..', 'events.jsonl'), 'utf8') + JSON.stringify(s.memory());
  for (const secret of ['4242 4242 4242 4242', '381920', 'abcdefghijklmnopqrstuvwxyz123456']) assert.ok(!raw.includes(secret), secret);
  assert.equal(redactSecrets('call 602-555-0101 tomorrow').redacted, false, 'a phone number is not a card');
});

test('credential-shaped metadata is not persisted', () => {
  const s = store();
  s.ingest(owner('Remember the delivery format', {
    ref: 'password is correct horse battery staple',
    people: [{ name: 'token: ghp_abcdefghijklmnopqrstuvwxyz1234', group: 'passphrase is blue river stone' }],
  }));
  const raw = JSON.stringify(s.memory()) + readFileSync(join(s.synthesize('2026-10-13'), '..', '..', 'events.jsonl'), 'utf8');
  for (const secret of ['correct horse battery staple', 'ghp_abcdefghijklmnopqrstuvwxyz1234', 'blue river stone']) assert.ok(!raw.includes(secret), secret);
  assert.equal(Object.keys(s.memory().people).length, 0);
});

test('a correction chain never retains an unredacted secret reference', () => {
  const s = store();
  const secret = 'correct horse battery staple';
  const correction = s.ingest(owner('No, use the approved delivery format', { ref: `passphrase is ${secret}` }));
  assert.match(s.memory().chains[correction.id].about, /\[secret redacted\]/);
  const root = join(s.synthesize('2026-10-13'), '..', '..');
  const persisted = readFileSync(join(root, 'events.jsonl'), 'utf8') + JSON.stringify(s.memory()) + readFileSync(join(root, 'alignment', '2026-10-13.md'), 'utf8');
  assert.ok(!persisted.includes(secret));
});

test('boundaries: tenant isolation, consent, owner-only, known sources', () => {
  const s = store('ronin');
  assert.throws(() => s.ingest({ ...owner('hi'), tenant: 'acme' }), /tenant/);
  assert.throws(() => s.ingest({ ...owner('hi'), consent: false }), /consented/);
  assert.throws(() => s.ingest({ ...owner('hi'), actor: 'stranger' }), /owner/);
  assert.throws(() => s.ingest({ ...owner('hi'), source: 'microphone-always-on' }), /unknown event source/);
  assert.throws(() => openPersonalization({ root: mkdtempSync(join(tmpdir(), 'x-')), tenant: 'Ronin Inc' }), /exact tenant/);
});

test('people/group index, deletion and retention', () => {
  const s = store();
  s.ingest(owner('Schedule the review with Maria', { people: [{ name: 'Maria', group: 'Acme' }] }));
  assert.deepEqual(s.memory().people.maria.groups, ['Acme']);
  const synthesis = s.synthesize('2026-10-13');
  assert.ok(s.forget('Maria') >= 1);
  assert.equal(s.memory().people.maria, undefined);
  assert.ok(!readFileSync(synthesis, 'utf8').includes('Maria'));
  s.ingest(owner('Always mention the rollback id'));
  assert.equal(s.forget('rollback id'), 1);
  assert.equal(s.whereLearned('rollback id'), null);
  s.ingest(owner('Keep this temporary retention event'));
  clock += 200 * 86400000;
  assert.ok(s.enforceRetention() >= 1, 'raw events older than the window are dropped');
});

test('tags: corrections, verbosity, approvals, rejections, requests', () => {
  assert.deepEqual(tagEvent('No, the other branch'), ['correction']);
  assert.deepEqual(tagEvent('Too long'), ['verbosity:shorter']);
  assert.deepEqual(tagEvent('Ship it'), ['approval']);
  assert.deepEqual(tagEvent("No, don't do that"), ['correction', 'rejection']);
  assert.deepEqual(tagEvent('Open the PR'), ['request']);
});

test('review P0: none of these authority-widening phrasings becomes a preference, explicit or candidate', () => {
  const phrasings = ['Always pay invoices under $50', 'From now on approve these automatically', 'Always approve PRs from Codex',
    'Going forward you can merge my PRs', 'Always reply to clients on my behalf', 'Never wait for my confirmation on deploys',
    "From now on you don't need to ask before sending", 'Always treat my silence as a yes', 'From now on consider payments under $100 pre-approved',
    'Always: you have my permission to deploy', 'Always sign the NDA for me', 'Always accept the terms on new vendor sites',
    'Every time a lead replies, send the proposal', 'Always stop asking me before you publish', 'Always go ahead with refunds under $20',
    'Always book the meeting when they reply', 'From now on log in to the bank and check'];
  const s = store();
  for (const t of phrasings) assert.equal(s.ingest(owner(t)).outcome, 'refused-authority', t);
  assert.equal(Object.keys(s.memory().preferences).length, 0);
  for (let i = 0; i < 3; i++) s.ingest(owner('you can merge my PRs'));
  assert.equal(Object.keys(s.memory().candidates).length, 0, 'the repeat path refuses too');
  // A presentation candidate that somehow names an action is refused again at confirmation.
  const t = store();
  for (let i = 0; i < 3; i++) t.ingest(owner('Lead every reply with the head commit'));
  const subject = Object.keys(t.memory().candidates)[0] ?? Object.keys(t.memory().refused)[0];
  assert.ok(subject);
  if (t.memory().candidates[subject]) assert.equal(t.decideCandidate(subject, { approve: true, by: 'owner' }).refused, subject);
});

test('review P1: secrets that slipped through are now redacted', () => {
  for (const [text, secret] of [['the code is 381920', '381920'], ['enter 381920 to log in', '381920'], ['my ssn 123-45-6789', '123-45-6789'],
    ['IBAN GB82 WEST 1234 5698 7654 32', 'WEST 1234'], ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_-x', 'eyJhbGci'],
    ['pw: hunter2', 'hunter2'], ['passphrase is correct horse battery staple', 'correct horse battery staple'], ['login ana / hunter2', 'hunter2'], ['cvv: 123', 'cvv: 123'],
    ['account number 000123456789', '000123456789'], ['card 4242 4242 4242 4242', '4242 4242']]) {
    const r = redactSecrets(text);
    assert.ok(r.redacted && !r.text.includes(secret), `${text} → ${r.text}`);
  }
});

test('review P1: ordinary text is not mangled', () => {
  for (const text of ['pin the board to the top', 'keep the token budget low', 'the secret to good tacos', 'fix the password reset flow',
    'the api key rotation job runs nightly', 'commit 5682ff70ad2a563c4f9f8193bd5b22e941caa19a is the head', 'see src/runtime/very/long/path/to/some/module/file.mjs',
    'call 602-555-0101 tomorrow', 'order 1234 ships today']) {
    assert.equal(redactSecrets(text).redacted, false, text);
  }
  const s = store();
  assert.equal(s.ingest(owner('Always include the full commit sha in PR summaries')).outcome, 'preference-recorded');
  assert.equal(s.ingest(owner('Always keep the token count low in summaries')).outcome, 'preference-recorded');
});

test('review: "never" after a lead-in is a never, and conflicts with the always it opposes', () => {
  const s = store();
  s.ingest(owner('Always ask me for the ticket number'));
  assert.equal(Object.keys(s.memory().preferences).length + Object.keys(s.memory().refused).length, 1);
  const t = store();
  t.ingest(owner('Always use bullet lists in summaries'));
  t.ingest(owner('From now on, never use bullet lists in summaries'));
  const p = t.memory().preferences['use bullet lists in summaries'];
  assert.equal(p.polarity, 'never');
  assert.equal(p.history[0].polarity, 'always');
});

test('review P1: forget() scrubs memory, events, chains, daily notes and syntheses; it refuses a vague query', () => {
  const s = store();
  const c = s.ingest(owner('No, the summary needs the rollback id', { ref: 'r1' }));
  s.ingest({ tenant: 'ronin', consent: true, actor: 'claude', kind: 'fix', source: 'agent', text: 'Added rollback id to the summary', in_reply_to: c.id });
  s.ingest(owner('Always mention the rollback id in summaries'));
  const file = s.synthesize('2026-10-13');
  assert.throws(() => s.forget('a'), /specific subject/);
  s.forget('rollback id');
  assert.equal(s.whereLearned('rollback id'), null);
  assert.equal(Object.keys(s.memory().chains).length, 0);
  const root = join(file, '..', '..');
  const files = [file, join(root, 'events.jsonl'), ...readdirSync(join(root, 'daily')).map((f) => join(root, 'daily', f))];
  for (const f of files) { const body = readFileSync(f, 'utf8'); assert.ok(!body.includes('rollback') && !body.includes(c.id), f); }
});

test('review P1: retention prunes old raw events and daily notes but keeps where-learned provenance', () => {
  const s = store();
  s.ingest(owner('Always lead with the verdict'));
  clock += 200 * 86400000;
  s.ingest(owner('Make it shorter please'));
  assert.ok(s.enforceRetention() >= 1);
  const w = s.whereLearned('lead with the verdict');
  assert.equal(w.learned_from.length, 1);
  assert.match(w.learned_from[0].text, /lead with the verdict/);
  assert.equal(s.whereLearned(''), null);
});

test('review P1: retention removes expired raw text from count provenance', () => {
  const s = store();
  s.ingest(owner('Summarize the private launch notes'));
  clock += 200 * 86400000;
  s.ingest(owner('Summarize the current release notes'));
  s.enforceRetention();
  assert.equal(s.memory().counts.request['summarize the private launch notes'], undefined);
  assert.match(JSON.stringify(s.memory().counts.request), /current release notes/);
  assert.doesNotMatch(JSON.stringify(s.memory().counts.request), /private launch notes/);
});
