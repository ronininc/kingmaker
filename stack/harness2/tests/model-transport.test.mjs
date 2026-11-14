// Tests for lib/harness2-model-transport.mjs — a stub HTTP server stands in
// for Ollama / an OpenAI-compatible endpoint; the improver runs a full
// Propose–Probe–Compose cycle over real HTTP through the transport.
// Run: node tests/model-transport.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessImprover } from '../lib/harness2-governed.mjs';
import { createModelClient, createModelEditor, createModelRunner } from '../lib/harness2-model-transport.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const hits = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    hits.push({ url: req.url, model: parsed.model, roles: (parsed.messages ?? []).map((m) => m.role) });
    const sys = parsed.messages?.[0]?.content ?? '';
    let text;
    if (sys.includes('You improve an agent harness')) {
      text = JSON.stringify({ component: 'systemPrompt', content: 'You are precise and brief.', rationale: 'stub edit' });
    } else if (sys.includes('You score how well')) {
      text = JSON.stringify({ score: 0.8, signal: 'stub judge: accomplished' });
    } else {
      text = 'the task output';
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/chat') res.end(JSON.stringify({ message: { role: 'assistant', content: text } }));
    else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  for (const protocol of ['ollama', 'openai']) {
    const client = createModelClient({ protocol, baseUrl: base, model: 'stub-model' });
    const editor = createModelEditor(client);
    const harness = { components: { systemPrompt: 'You are an agent.' } };
    const task = { id: 't1', prompt: 'Write a haiku about gates.' };
    const edits = await editor(harness, task);
    ok(`${protocol}: editor returns one valid edit`, edits.length === 1 && edits[0].component === 'systemPrompt');

    const runner = createModelRunner(client);
    const signal = await runner(harness, task);
    ok(`${protocol}: runner executes + judges over HTTP`, signal.score === 0.8 && signal.signal.includes('stub judge'));
  }
  ok('requests carried the model name', hits.every((h) => h.model === 'stub-model'));
  ok('ollama + openai endpoints both hit', hits.some((h) => h.url === '/api/chat') && hits.some((h) => h.url === '/v1/chat/completions'));

  // Full governed cycle over the transport.
  const d = mkdtempSync(join(tmpdir(), 'h2-transport-'));
  const client = createModelClient({ protocol: 'ollama', baseUrl: base, model: 'stub-model' });
  const improver = createHarnessImprover({
    auditPath: join(d, 'audit.jsonl'),
    libraryPath: join(d, 'library.json'),
    verifyTap: (t) => t === 'tap-ok',
    runner: createModelRunner(client),
  });
  const harness = { components: { systemPrompt: 'You are an agent.' } };
  const task = { id: 't1', prompt: 'Write a haiku about gates.' };
  const cycle = await improver.runCycle({ task, harness, editors: [createModelEditor(client)] });
  ok('full cycle over real transport produces a winner', cycle.ok === true && cycle.winner.component === 'systemPrompt' && cycle.adopted === false);
  const refusedAdopt = await improver.adopt({ task, harness, winner: cycle.winner, tapToken: 'nope' });
  ok('adoption without a valid tap is refused', refusedAdopt.ok === false);
  const adopted = await improver.adopt({ task, harness, winner: cycle.winner, tapToken: 'tap-ok' });
  ok('adoption with the founder tap lands + writes the lesson', adopted.ok === true && adopted.harness.components.systemPrompt === 'You are precise and brief.' && improver.lessons().length === 1);
  ok('audit chain verifies', improver.verifyAudit().ok !== false);
} finally {
  server.close();
}
console.log(`harness2-model-transport: ${passed} checks passed`);
