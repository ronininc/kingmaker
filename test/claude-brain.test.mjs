import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs, claudeEnv, createClaudeBrain, parseClaudeOutput, resolveBrain } from '../lib/claude-brain.mjs';

test('brain choice: env wins, then saved, then local', () => {
  assert.equal(resolveBrain({ SOL_GHOST_BRAIN: 'claude' }, 'local'), 'claude');
  assert.equal(resolveBrain({}, 'claude'), 'claude');
  assert.equal(resolveBrain({}, 'junk'), 'local');
});

test('never bills the API: keys stripped from the CLI env', () => {
  const env = claudeEnv({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', HOME: '/h', PATH: '/bin' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.HOME, '/h');
});

test('only Kingmaker MCP, its memory file, and a resumed session', () => {
  const a = claudeArgs({ text: 'hi', sessionId: 's1', mcpConfigPath: '/m.json' });
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(a.includes('Edit(./CLAUDE.md)'));
  assert.ok(a.includes('Bash'));
  assert.deepEqual(a.slice(-2), ['--resume', 's1']);
});

test('parses claude -p json', () => {
  assert.deepEqual(parseClaudeOutput('{"result":"Hello.","session_id":"abc","is_error":false}'), { ok: true, text: 'Hello.', sessionId: 'abc' });
  assert.equal(parseClaudeOutput('nope').ok, false);
});

test('a turn speaks the answer and keeps the session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'km-brain-'));
  const said = []; const calls = [];
  const run = (bin, args, opts, cb) => { calls.push({ args, opts }); cb(null, JSON.stringify({ result: 'Three open leads.', session_id: 'sess-1' }), ''); };
  const brain = createClaudeBrain({ paths: { state }, port: 4999, say: async (l) => said.push(l), env: { HOME: state, PATH: '' }, run });
  await brain.runTurn('what leads are open in my CRM');
  await brain.runTurn('next');
  assert.deepEqual(said, ['Three open leads.', 'Three open leads.']);
  assert.ok(calls[1].args.includes('sess-1'));
  assert.equal(calls[0].opts.cwd, join(state, 'claude-brain'));
  assert.match(readFileSync(join(state, 'claude-brain', 'mcp.json'), 'utf8'), /"mcp"/);
});
