import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CHARS, TURN_BUDGET, GUARD_BUDGET, SOP_BUDGET, conductFor, conductParts, parseCsv, sopFor, guardrailsFor, instructionsFor, languageLine, reloadInstructions, terms, withInstructions } from '../lib/instructions.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'km-instr-'));

test('nothing set: a turn goes through unchanged, and the brief has only the auto language line', () => {
  const d = dir(); reloadInstructions(d);
  assert.equal(withInstructions(d, 'open Safari'), 'open Safari');
  assert.match(conductFor(d, 'hi', { brief: true }), /language the owner used/);
});

test('short instructions and guardrails ride along in full, guardrails first', () => {
  const d = dir();
  writeFileSync(join(d, 'instructions.md'), 'Think step by step. Prefer short answers.');
  writeFileSync(join(d, 'guardrails.md'), 'Never email anyone at acme.com.\nif (client.vip) { ask_first(); }');
  reloadInstructions(d);
  const out = withInstructions(d, 'write to Bob');
  assert.ok(out.indexOf('acme.com') < out.indexOf('step by step'));
  assert.ok(out.includes('ask_first()') && out.endsWith('write to Bob'));
});

test('read once: an edit takes effect only after reload', () => {
  const d = dir();
  writeFileSync(join(d, 'instructions.md'), 'Rule one.'); reloadInstructions(d);
  writeFileSync(join(d, 'instructions.md'), 'Rule two.');
  assert.equal(instructionsFor(d, 'x'), 'Rule one.');
  reloadInstructions(d); assert.equal(instructionsFor(d, 'x'), 'Rule two.');
});

test('ten million characters: the opening plus the sections about the turn, within budget, fast', () => {
  const d = dir();
  const filler = Array.from({ length: 4000 }, (_, i) => `## Topic ${i}\nNotes about widgets number ${i} and gadgets in batch ${i}.`).join('\n\n');
  let big = '# Core\nAlways be honest and show your work.\n\n' + filler + '\n\n## Invoices\nWhen writing an invoice, put the payment terms in bold and net 30.\n\n';
  while (big.length < MAX_CHARS) big += filler.slice(0, MAX_CHARS - big.length);
  writeFileSync(join(d, 'instructions.md'), big);
  const t0 = Date.now(); reloadInstructions(d); const loadMs = Date.now() - t0;
  const t1 = Date.now(); const got = instructionsFor(d, 'write an invoice for the Smith job'); const turnMs = Date.now() - t1;
  assert.ok(got.length <= TURN_BUDGET, `${got.length}`);
  assert.match(got, /Always be honest/); assert.match(got, /payment terms in bold/);
  assert.ok(turnMs < 1500, `turn took ${turnMs} ms (load ${loadMs} ms)`);
});

test('long guardrails: every turn still gets guardrails, at most GUARD_BUDGET, the relevant ones', () => {
  const d = dir();
  writeFileSync(join(d, 'guardrails.md'), Array.from({ length: 2000 }, (_, i) => `Rule ${i}: never touch folder vault${i}.`).join('\n\n') + '\n\nNever delete files in Taxes without asking.');
  reloadInstructions(d);
  const g = guardrailsFor(d, 'clean up my Taxes folder');
  assert.ok(g.length <= GUARD_BUDGET && /Taxes without asking/.test(g));
});

test('any language: Spanish words and Japanese text match', () => {
  assert.ok(terms('facturación del cliente').has('facturación'));
  assert.ok(terms('請求書を作成').has('請求'));
  assert.ok(terms("'find leads', 'scan an area'").has('leads'), 'a closing quote is not part of the word');
  assert.deepEqual([...terms('what do you do overnight')], ['overnight'], 'short filler words are not terms');
  const d = dir();
  writeFileSync(join(d, 'instructions.md'), 'x'.repeat(TURN_BUDGET) + '\n\n## 請求書\n請求書には支払条件を太字で書く。\n\n## Otros\nnada que ver.');
  reloadInstructions(d);
  assert.match(instructionsFor(d, '請求書を作って'), /支払条件/);
});

test('language: a fixed language always applies; auto only in the brief', () => {
  const d = dir(); writeFileSync(join(d, 'language'), 'Español'); reloadInstructions(d);
  assert.match(withInstructions(d, 'hello'), /Always answer in Español/);
  const e = dir(); reloadInstructions(e);
  assert.equal(languageLine(e), ''); assert.match(languageLine(e, { auto: true }), /switch with them/);
});

test('csv: quoted commas, doubled quotes, newlines inside quotes, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b,c\r\n1,"two, too","say ""hi""\nthen go"\r\n\r\n'), [['a', 'b', 'c'], ['1', 'two, too', 'say "hi"\nthen go']]);
});

test('operating SOP: no file adds nothing; a short one rides along whole, each row headed by its id and workflow', () => {
  const d = dir(); reloadInstructions(d);
  assert.equal(sopFor(d, 'x'), ''); assert.equal(withInstructions(d, 'x'), 'x');
  writeFileSync(join(d, 'operating-sop.csv'), 'id,workflow,owner,steps\nSOP-01,Lead intake,Dana,"1. qualify, 2. score"\nSOP-02,Site build,,deploy to Pages\n');
  assert.equal(reloadInstructions(d).sopRows, 2);
  const out = withInstructions(d, 'build the site');
  assert.match(out, /Workflows on file: SOP-01 Lead intake; SOP-02 Site build/);
  assert.match(out, /## SOP-01 Lead intake\nowner: Dana\nsteps: 1\. qualify, 2\. score/);
  assert.ok(!/owner: \n/.test(out), 'empty cells are left out');
});

test('operating SOP: a long one sends every name but only the rows about the turn, within budget, in both lanes', () => {
  const d = dir();
  const rows = Array.from({ length: 300 }, (_, i) => `SOP-${i},Widget task ${i},"Steps for widget ${i}: sort the gadgets in bin ${i}."`);
  rows.splice(150, 0, 'SOP-X,Clover menu change,"Prepare the change, show current and proposed, wait for the exact approval phrase, apply, re-read."');
  writeFileSync(join(d, 'operating-sop.csv'), ['id,workflow,steps', ...rows].join('\n'));
  reloadInstructions(d);
  const s = sopFor(d, 'change the price on the clover menu');
  assert.match(s, /exact approval phrase/); assert.match(s, /SOP-0 Widget task 0; SOP-1 Widget task 1;/);
  assert.match(s, /; and \d+ more\n/);
  assert.ok(s.length <= SOP_BUDGET + 2000 + 2, `${s.length}`);
  const { stable, turn } = conductParts(d, 'change the price on the clover menu');
  assert.match(stable, /Workflows on file:/); assert.ok(!/approval phrase/.test(stable), 'per-turn rows stay out of the cacheable prefix');
  assert.match(turn, /exact approval phrase/);
  assert.equal(conductParts(d, 'something else').stable, stable);
  // A row whose own name matches the turn beats longer rows that only mention the word in passing.
  const e = dir();
  const filler = Array.from({ length: 40 }, (_, i) => `R-${i},Task ${i},"${'Some steps that mention the approval list once. '.repeat(i % 3 + 1)}"`);
  writeFileSync(join(e, 'operating-sop.csv'), ['id,workflow,steps', ...filler, `R-Z,Approval list for the day,"${'Build it, present it, apply what is approved. '.repeat(30)}"`].join('\n'));
  reloadInstructions(e);
  assert.match(sopFor(e, 'show me the approval list'), /## R-Z Approval list for the day/);
});
