import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand, createLocalTaskContexts, isLocalFollowUp, localTaskIntent, reclaimProgramPaths, runFollowUp, runLocalTask } from '../lib/local-task.mjs';

function folder(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'kingmaker-local-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('pathless coding and creative prompts remain outside the existing-file lane', (t) => {
  for (const text of ['Complete this Python function. Return only the complete Python code.', 'Write solution.py to sort a list', 'Explain Python generators', 'Render a new five-second video of a blue circle', 'What does Python zip do?']) assert.equal(localTaskIntent(text), null, text);
  for (const text of ['Run python3 sim.py', 'execute tool.mjs', 'Please unzip the attachment', 'pilot one scored attempt', 'inspect the attached file']) assert.deepEqual(localTaskIntent(text), { paths: [], bare: false }, text);
  const cwd = folder(t);
  assert.deepEqual(localTaskIntent(`Inspect ${cwd}`)?.paths, [cwd]);
});

test('short task followups stay local; unrelated questions do not', () => {
  const at = 10_000, last = { cwd: '/saved/task', at };
  for (const text of ['Verify the final score and replay the race', 'replay it', 'please show me the results', 'What was the final score?', 'How did it do?', 'status', 'check it']) assert.equal(isLocalFollowUp(text, last, at + 1), true, text);
  for (const text of ['What is the latest football score?', 'show me stock prices', 'play music', 'check the weather', 'What was the score of the Suns game?', 'open the video on YouTube', 'run it again', '']) assert.equal(isLocalFollowUp(text, last, at + 1), false, text);
  assert.equal(isLocalFollowUp('replay it', last, at - 1), false);
  assert.equal(isLocalFollowUp('replay it', last, at + 60 * 60_000), false);
});

test('context is conversation scoped, bounded and expires without extending the run timestamp', () => {
  let now = 1000;
  const tasks = createLocalTaskContexts({ now: () => now, limit: 3 });
  const bar = { cwd: '/bar', at: now }, a = { cwd: '/a', at: now };
  tasks.set(null, bar); tasks.set('phone-a', a); tasks.set('bar', { cwd: '/named-bar', at: now });
  assert.equal(tasks.get(undefined), bar);
  assert.equal(tasks.get('phone-a'), a);
  assert.equal(tasks.get('phone-b'), null);
  assert.equal(tasks.get('bar').cwd, '/named-bar');
  tasks.set('phone-b', { cwd: '/b', at: now });
  assert.equal(tasks.get(null), null, 'oldest context evicted');
  now += 60 * 60_000;
  assert.equal(tasks.get('phone-a'), null);
});

test('verify and replay uses only saved verification and video; no init, step or render', async (t) => {
  const cwd = folder(t), video = join(cwd, 'race.mp4');
  writeFileSync(video, 'fixture'); writeFileSync(join(cwd, 'sim.mjs'), '// fixture');
  const last = { cwd, made: [video], summary: 'Did not finish: 0 points.', tool: { after: [
    ['node', 'sim.mjs', 'init', '--run', 'verify'],
    ['node', 'sim.mjs', 'step', '--reason', 'check'],
    ['node', 'sim.mjs', 'verify', '--run', 'saved-run'],
    ['node', 'sim.mjs', 'render', '--out', 'result.mp4'],
  ] } };
  const executed = [], opened = [], delivered = [], said = [];
  const r = await runFollowUp('Verify the final score and replay the race', last, {
    say: async (s) => said.push(s), execute: async (...args) => { executed.push(args); return { code: 0, out: 'verified: score 0' }; },
    openFile: async (p) => { opened.push(p); return { code: 0 }; }, deliver: async (files) => delivered.push(files),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(executed.map((a) => a[1]), [['sim.mjs', 'verify', '--run', 'saved-run']]);
  assert.deepEqual(opened, [video]); assert.deepEqual(delivered, [[video]]);
  assert.match(said[0], /Recorded result: Did not finish: 0 points/);
});

test('missing files and a deleted task report failure without recreating or running it', async (t) => {
  const cwd = folder(t), said = [];
  const deps = { say: async (s) => said.push(s), execute: async () => assert.fail('must not execute'), openFile: async () => assert.fail('must not open') };
  const r = await runFollowUp('replay it', { cwd, made: [join(cwd, 'gone.mp4')] }, deps);
  assert.equal(r.ok, false); assert.match(said[0], /saved video is missing/);
  rmSync(cwd, { recursive: true });
  assert.equal((await runFollowUp('verify it', { cwd }, deps)).ok, false);
  assert.match(said[1], /folder is no longer available/);
});

test('verification and player errors are reported honestly', async (t) => {
  const cwd = folder(t), video = join(cwd, 'run.mp4'), said = [];
  writeFileSync(video, 'fixture'); writeFileSync(join(cwd, 'sim.py'), '# fixture');
  const r = await runFollowUp('verify it and replay it', { cwd, made: [video], tool: { after: [['python3', 'sim.py', 'verify']] } }, {
    say: async (s) => said.push(s), execute: async () => ({ code: 1, out: 'hash mismatch' }), openFile: async () => ({ code: 2, out: 'no player' }),
  });
  assert.equal(r.ok, false); assert.match(said[0], /hash mismatch/); assert.match(said[0], /Could not open/); assert.doesNotMatch(said[0], /Playing/);
});

test('paths reclaimed from program tags stay paths, and node verification only runs an existing script', (t) => {
  const cwd = folder(t), script = join(cwd, 'sim.mjs'); writeFileSync(script, '// fixture');
  assert.deepEqual(reclaimProgramPaths([script.slice(1), 'Chrome']), { paths: [script], programs: ['Chrome'] });
  assert.equal(checkCommand('node sim.mjs verify', cwd).error, undefined);
  assert.match(checkCommand('node -e "process.exit(0)"', cwd).error, /existing script/);
});

test('conductor failure, unmet goals and output failures never become done or inflate step counts', async (t) => {
  const cwd = folder(t); writeFileSync(join(cwd, 'README.md'), 'Task docs.');
  for (const result of [
    { ok: false, why: 'budget exhausted', steps: 3 },
    { ok: true, steps: 4, goal: { text: 'finished = true' }, met: false },
    { ok: true, steps: 5, outputs: [{ cmd: 'verify', code: 1, out: 'mismatch' }] },
  ]) {
    const said = [];
    const r = await runLocalTask('Run the local task', { paths: [cwd] }, { say: async (s) => said.push(s), workRoot: cwd, conductTask: async () => result, complete: async () => assert.fail('no model fallback') });
    assert.equal(r.ok, false); assert.equal(r.steps, result.steps); assert.match(r.summary, /couldn't finish/); assert.doesNotMatch(r.summary, /^Done|^Completed/);
  }
});

test('all instruction restrictions and real step budget reach the conductor together', async (t) => {
  const cwd = folder(t);
  writeFileSync(join(cwd, 'PROMPT.md'), 'Run the tool.'); writeFileSync(join(cwd, 'README.md'), `${'Documentation. '.repeat(800)}No practice or retries.`);
  let received;
  const r = await runLocalTask('Run one scored attempt', { paths: [cwd] }, {
    say: async () => {}, workRoot: cwd, maxSteps: 12, complete: async () => assert.fail('no fallback'),
    conductTask: async (args) => { received = args; return { ok: true, steps: 2, goal: { text: 'finished = true' }, met: true }; },
  });
  assert.match(received.docs, /Run the tool/); assert.match(received.docs, /No practice or retries/);
  assert.equal(received.task, 'Run one scored attempt'); assert.equal(received.maxSteps, 12);
  assert.equal(r.ok, true); assert.equal(r.steps, 2);
});

test('a successful tool state does not hide a missing requested output', async (t) => {
  const cwd = folder(t); writeFileSync(join(cwd, 'README.md'), 'render --out final.mp4');
  const r = await runLocalTask('Make the output', { paths: [cwd] }, {
    say: async () => {}, workRoot: cwd, conductTask: async () => ({ ok: true, steps: 2, goal: { text: 'finished' }, met: true }),
  });
  assert.equal(r.ok, false); assert.match(r.summary, /requested outputs are missing: final.mp4/);
});

test('real saved-run verification runs without invoking init or changing the saved outcome', async (t) => {
  const cwd = folder(t), saved = join(cwd, 'saved.json'); writeFileSync(saved, '{"score":0,"finished":false}');
  writeFileSync(join(cwd, 'fixture.mjs'), `import { readFileSync } from 'node:fs';\nif (process.argv[2] !== 'verify') process.exit(3);\nconsole.log(readFileSync('saved.json', 'utf8'));\n`);
  const said = [];
  const r = await runFollowUp('verify the score', { cwd, tool: { after: [['node', 'fixture.mjs', 'verify']] } }, { say: async (s) => said.push(s) });
  assert.equal(r.ok, true); assert.match(said[0], /"score":0/); assert.equal(readFileSync(saved, 'utf8'), '{"score":0,"finished":false}');
});

test('CLI connects task memory to the current conversation and tracks its queued job', () => {
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const localTasks = createLocalTaskContexts\(\)/);
  assert.match(cli, /localTasks\.get\(phoneConv\)/);
  assert.match(cli, /localTasks\.set\(phoneConv, result\)/);
  assert.match(cli, /let typedTurns = Promise\.resolve\(\)/);
  assert.match(cli, /typedTurns = queueTurn\(async/);
});
