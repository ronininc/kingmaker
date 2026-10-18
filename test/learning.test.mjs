import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLearning, learningWords } from '../lib/learning.mjs';

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++)).toISOString();
const fresh = () => openLearning({ state: mkdtempSync(join(tmpdir(), 'learning-')), env: {}, now: clock });

test('on by default: it learns before anyone says a word, and only the owner\'s "learning off" (or the install) stops it', () => {
  const j = fresh();
  assert.equal(j.enabled(), true, 'learning is on out of the box');
  j.learn('From now on, always give me the price first', 'chat');
  assert.equal(JSON.parse(readFileSync(j.exportPath, 'utf8')).preferences.length, 1, 'an explicit "from now on" is kept');
  j.handle('learning off', 'typed');
  assert.equal(j.enabled(), false);
  assert.equal(j.learn('always use dark mode', 'chat'), null);
  assert.match(j.handle('what have you learned'), /learning is off|Learning is off|price first/);
  const off = openLearning({ state: mkdtempSync(join(tmpdir(), 'learning-')), env: { KINGMAKER_LEARNING: 'off' }, now: clock });
  assert.equal(off.enabled(), false, 'an install can turn it off');
  assert.equal(existsSync(off.root), false, 'and then nothing is written');
});

test('until the owner has said either way, the first keep-question says learning is on and how to stop it', () => {
  const ask = (j) => { let asked = null; for (let i = 0; i < 3; i++) asked = j.learn('show me the weekly sales summary', 'chat') || asked; return asked; };
  assert.match(ask(fresh()), /keep that as a standing preference.*on by default.*"learning off"/);
  const k = fresh(); k.handle('learning on');
  const asked = ask(k);
  assert.match(asked, /keep that as a standing preference/);
  assert.doesNotMatch(asked, /on by default/, 'once the owner has said, no notice');
});

test('"learning on" records the owner\'s consent; "learning off" stops learning and empties the CRM export', () => {
  const j = fresh();
  assert.match(j.handle('Learning on', 'typed'), /Learning is on/);
  const consent = JSON.parse(readFileSync(join(j.root, 'consent.json'), 'utf8'));
  assert.equal(consent.on, true); assert.equal(consent.by, 'owner'); assert.match(consent.how, /typed/);
  j.learn('From now on, always give me the price first', 'chat');
  assert.equal(JSON.parse(readFileSync(j.exportPath, 'utf8')).preferences.length, 1);
  j.handle('learning off', 'said');
  assert.equal(j.enabled(), false);
  assert.deepEqual(JSON.parse(readFileSync(j.exportPath, 'utf8')).preferences, []);
  assert.equal(j.learn('always use dark mode', 'voice'), null);
});

test('a repeated request asks once; only "keep that" makes it standing and exported to the CRM', () => {
  const j = fresh(); j.handle('learning on');
  let asked = null;
  for (let i = 0; i < 3; i++) asked = j.learn('show me the weekly sales summary', 'chat') || asked;
  assert.match(asked, /keep that as a standing preference/);
  assert.deepEqual(JSON.parse(readFileSync(j.exportPath, 'utf8')).preferences, [], 'a candidate never leaves the Mac');
  assert.match(j.handle('keep that'), /^Kept/);
  const exported = JSON.parse(readFileSync(j.exportPath, 'utf8')).preferences;
  assert.equal(exported.length, 1); assert.match(exported[0].statement, /weekly sales summary/);
  assert.match(j.brief(), /weekly sales summary/);
  assert.equal(j.handle('keep that'), null, 'a second "keep that" is not a learning answer');
});

test('a preference that would widen authority is never kept; secrets are never exported', () => {
  const j = fresh(); j.handle('learning on');
  j.learn('From now on, always send emails without asking me', 'chat');
  const out = JSON.parse(readFileSync(j.exportPath, 'utf8'));
  assert.ok(!out.preferences.some((p) => /without asking/.test(p.statement)));
});

test('where-learned and forget answer from the memory', () => {
  const j = fresh(); j.handle('learning on');
  j.learn('From now on, always put the merchant name in the title', 'voice');
  assert.match(j.handle('where did you learn merchant name'), /from 1 thing you said/);
  assert.match(j.handle('forget what you learned about merchant name'), /Forgotten/);
  assert.deepEqual(JSON.parse(readFileSync(j.exportPath, 'utf8')).preferences, []);
});

test('the owner\'s words are recognised, and ordinary turns are not', () => {
  assert.deepEqual(learningWords('Learning off.'), { op: 'off' });
  assert.deepEqual(learningWords('/memory'), { op: 'summary' });
  assert.equal(learningWords('open youtube'), null);
  assert.equal(learningWords('forget it'), null);
});

test('the keep-that offer is rationed: once per subject, one a day, never on a turn that isn\'t plainly English', () => {
  let t = Date.UTC(2026, 9, 15, 12);
  const j = openLearning({ state: mkdtempSync(join(tmpdir(), 'learning-')), env: {}, now: () => new Date(t += 1000).toISOString() });
  const ask = (text) => { let asked = null; for (let i = 0; i < 3; i++) asked = j.learn(text, 'chat') || asked; return asked; };
  assert.match(ask('show me the weekly sales summary'), /keep that as a standing preference/);
  assert.equal(ask('show me the monthly churn report'), null, 'a second offer the same day waits');
  t += 25 * 3600_000;
  assert.equal(ask('show me the weekly sales summary'), null, 'a subject already offered is never offered again');
  assert.equal(ask('escribe una frase sobre un camión de tacos'), null, 'a Spanish turn never gets the English offer');
  assert.match(ask('show me the monthly churn report'), /keep that/, 'the next day, a new subject can be offered');
});

test('the learning store is "owner" on a new install; an install that already learned under a tenant an add-on names keeps it', async () => {
  const { defaultTenant } = await import('../lib/learning.mjs');
  const { mkdirSync } = await import('node:fs');
  const s = mkdtempSync(join(tmpdir(), 'learning-tenant-'));
  assert.equal(defaultTenant(s), 'owner');
  mkdirSync(join(s, 'personalization', 'acme'), { recursive: true });
  assert.equal(defaultTenant(s), 'owner', 'an earlier store counts only when an add-on names it');
  assert.equal(defaultTenant(s, undefined, ['acme']), 'acme');
  mkdirSync(join(s, 'personalization', 'owner'), { recursive: true });
  assert.equal(defaultTenant(s, undefined, ['acme']), 'owner');
});
