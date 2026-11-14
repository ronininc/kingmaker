import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { conduct, executionPolicy } = await import(process.env.CONDUCTOR_MODULE
  ? pathToFileURL(process.env.CONDUCTOR_MODULE).href : '../lib/state-conductor.mjs');

function fixture(t, { succeeds = true, verifyFails = false, neverEnds = false, terminalOnlyGoal = false, control = .5, probeDelayMs = 0, stepDelayMs = 0 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'km-conductor-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'kit'), methods = join(root, 'methods'), audit = join(root, 'audit.jsonl');
  mkdirSync(cwd); mkdirSync(methods);
  writeFileSync(join(cwd, 'tool.mjs'), `
import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2), sub=args[0], audit=${JSON.stringify(audit)};
if(args.includes('--help')){console.log(sub==='step'?'usage: tool step --run RUN --control CONTROL --reason REASON':'usage: tool {init,step,verify}');process.exit(0);}
const firstScratchInit=sub==='init'&&process.cwd()!==${JSON.stringify(cwd)}&&(!existsSync(audit)||!readFileSync(audit,'utf8').includes('"sub":"init"'));
appendFileSync(audit,JSON.stringify({sub,cwd:process.cwd()})+'\\n');
const save=s=>{writeFileSync('state.json',JSON.stringify(s));console.log(JSON.stringify(s));};
if(sub==='init'){if(firstScratchInit)await new Promise(r=>setTimeout(r,${probeDelayMs}));save({terminal:false,${terminalOnlyGoal ? '' : 'finished:false,'}goal_distance:1,t:0});}
else if(sub==='step'){await new Promise(r=>setTimeout(r,${stepDelayMs}));appendFileSync(audit,JSON.stringify({sub:'step-completed',cwd:process.cwd()})+'\\n');const c=Number(args[args.indexOf('--control')+1]);save({terminal:${!neverEnds},finished:${succeeds && !neverEnds}&&c>=0.8,goal_distance:1-c,t:1});}
else if(sub==='verify'){console.log(readFileSync('state.json','utf8'));process.exit(${verifyFails ? 3 : 0});}
`);
  writeFileSync(join(methods, 'control.method.json'), JSON.stringify({ name: 'control', requires: ['goal_distance'], rules: [{ type: 'const', name: 'control', action: 'control', value: control }] }));
  const docs = 'node tool.mjs init --run result\nnode tool.mjs step\n--control (0 to 1)\nnode tool.mjs verify --run result';
  const events = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { cwd, methods, docs, events, options: { cwd, docs, methodDirs: [methods], show: async () => {}, maxSteps: 5, budget: { attempts: 24, ms: 20_000 } } };
}

test('single scored attempt performs exactly one initialization, no scratch practice', async t => {
  const f = fixture(t);
  const r = await conduct({ ...f.options, task: 'One scored attempt. No practice, resets or reruns.' });
  assert.equal(f.events().filter(e => e.sub === 'init').length, 1);
  assert.equal(r.practice.attempts, 0);
  assert.equal(r.ok, false); assert.equal(r.met, false);
  assert.equal(f.events().filter(e => e.sub === 'verify').length, 1);
});

test('kit restrictions override owner request for iteration', async t => {
  const f = fixture(t);
  const r = await conduct({ ...f.options, docs: `${f.docs}\nDo not run practice races.`, task: 'Improve and retry until it succeeds.' });
  assert.equal(f.events().filter(e => e.sub === 'init').length, 1);
  assert.equal(r.practice.attempts, 0);
});

test('impossible goal stops at attempt budget and reports failure', async t => {
  const f = fixture(t, { succeeds: false });
  const r = await conduct({ ...f.options, task: 'Practice and improve.', budget: { attempts: 3, ms: 10_000 } });
  assert.equal(r.practice.attempts, 3); assert.equal(r.ok, false); assert.equal(r.met, false);
});

test('zero practice budget makes only one actual attempt', async t => {
  const f = fixture(t);
  const r = await conduct({ ...f.options, task: 'Practice and improve.', budget: { attempts: 0, ms: 10_000 } });
  assert.equal(r.practice.attempts, 0);
  assert.equal(f.events().filter(e => e.sub === 'init').length, 1);
});

test('no-autopilot instructions use model values, not the matching fixed method', async t => {
  const f = fixture(t); let calls = 0;
  const r = await conduct({ ...f.options, task: 'Make every steering decision yourself. Do not write an autopilot.', complete: async () => { calls++; return '{"control":0.9}'; } });
  assert.equal(r.ok, true); assert.equal(r.method, null); assert.equal(calls, 1);
  assert.equal(f.events().filter(e => e.sub === 'init').length, 1);
});

test('invalid model response fails without silently selecting zero controls', async t => {
  const f = fixture(t);
  const r = await conduct({ ...f.options, task: 'No autopilot.', complete: async () => 'probably 0.9' });
  assert.equal(r.ok, false); assert.match(r.why, /finite numeric/);
  assert.equal(f.events().filter(e => e.sub === 'step').length, 0);
});

test('failed verification cannot report a successful task', async t => {
  const f = fixture(t, { verifyFails: true });
  const r = await conduct({ ...f.options, task: 'No autopilot.', complete: async () => '{"control":1}' });
  assert.equal(r.met, true); assert.equal(r.ok, false); assert.match(r.why, /exit 3/);
});

test('a completion field first appearing at termination determines success or failure', async t => {
  for (const succeeds of [false, true]) {
    const f = fixture(t, { terminalOnlyGoal: true, succeeds, control: 1 });
    const r = await conduct({ ...f.options, task: 'One scored attempt.' });
    assert.equal(r.goal?.field, 'finished');
    assert.equal(r.met, succeeds);
    assert.equal(r.ok, succeeds);
    assert.equal(f.events().filter(e => e.sub === 'init').length, 1);
    assert.equal(f.events().filter(e => e.sub === 'verify').length, 1);
  }
});

test('the practice deadline includes initialization; a late step cannot complete after the shared budget', async t => {
  const f = fixture(t, { control: 1, probeDelayMs: 1500, stepDelayMs: 1500 });
  const r = await conduct({ ...f.options, task: 'Practice and improve.', budget: { attempts: 1, ms: 2500 } });
  const scratch = f.events().filter(e => e.cwd !== f.cwd);
  assert.equal(r.practice.met, false, 'the probe and step together exceed the single practice deadline');
  assert.equal(scratch.filter(e => e.sub === 'step-completed').length, 0, 'the deadline stops the practice step before it publishes a successful state');
  assert.equal(scratch.filter(e => e.sub === 'init').length, 1, 'the baseline reuses the initialized probe');
  assert.equal(r.practice.initializations, 1);
  assert.equal(r.ok, true, 'the separate real run still has its normal execution budget');
  assert.equal(f.events().filter(e => e.sub === 'init' && e.cwd === f.cwd).length, 1);
  for (const e of scratch) assert.equal(existsSync(e.cwd), false, 'timed-out practice folders are cleaned');
});

test('step exhaustion is incomplete, not done', async t => {
  const f = fixture(t, { neverEnds: true });
  const r = await conduct({ ...f.options, maxSteps: 1, task: 'Run this task.' });
  assert.equal(r.ok, false); assert.equal(r.steps, 1); assert.match(r.why, /budget exhausted/);
});

test('practice requires owner opt-in; documentation cannot grant it', () => {
  assert.equal(executionPolicy('Run this tool', 'Practice until successful').practice, false);
  assert.equal(executionPolicy('Improve it', 'One scored run only').practice, false);
  assert.equal(executionPolicy('Run it').practice, false);
});

test('authorized practice improves a failing method, retains trace and leaves one real attempt', async t => {
  const f = fixture(t); const notes = [];
  const r = await conduct({ ...f.options, task: 'Practice and tune the controls until finished.', note: n => notes.push(n) });
  assert.equal(r.ok, true); assert.equal(r.met, true);
  assert.ok(r.practice.attempts > 1 && r.practice.attempts <= 24);
  assert.equal(r.practice.history[0].grade.met, false);
  assert.equal(r.practice.history.at(-1).grade.met, true);
  assert.equal(f.events().filter(e => e.sub === 'init' && e.cwd === f.cwd).length, 1);
  assert.ok(r.practice.saved.startsWith(join(f.cwd, '.kingmaker-methods')));
  assert.equal(JSON.parse(readFileSync(join(f.methods, 'control.method.json'))).rules[0].value, .5);
  assert.ok(notes.some(n => n.startsWith('PRACTICE ')));
  for (const e of f.events().filter(e => e.cwd !== f.cwd)) assert.equal(existsSync(e.cwd), false);
});
