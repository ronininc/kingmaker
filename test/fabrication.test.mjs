// Fabrication as a Kingmaker handle (lib/fabrication.mjs, the `fabricate`/`cad` CLI verb, the kingmaker_fabricate
// MCP tool). Hermetic: the engine is a fake fetch. The point is the planning-only guarantee — this handle reaches
// ONLY the engine's planning turn, refuses execution/real-machine asks, and exposes no execute path anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fabricateTurnText, isExecutionAsk } from '../lib/fabrication.mjs';
import { callTool, TOOLS } from '../lib/mcp.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';
import { COMMAND_GROUPS } from '../lib/command-list.mjs';

function fakeEngine(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = answers[path]?.(calls.at(-1)) ?? { ok: false };
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchImpl };
}

test('fabricateTurnText: a fabrication verb leads; empty is an error', () => {
  assert.equal(fabricateTurnText('a wall bracket for a 35mm pipe').text, 'fabricate a wall bracket for a 35mm pipe');
  assert.equal(fabricateTurnText('design a phone stand').text, 'design a phone stand');
  assert.equal(fabricateTurnText('cad a gear 20 teeth').text, 'cad a gear 20 teeth');
  assert.ok(fabricateTurnText('').error);
});

test('execution / real-machine asks are refused before they can become a turn', () => {
  for (const ask of [
    'a bracket and run it on the printer',
    'mill it on the CNC',
    'execute the fabrication job',
    'print it for real',
    'send it to the machine',
    'a part, actuate the real machine',
    'generate the g-code and start the print',
  ]) {
    assert.ok(isExecutionAsk(ask), `isExecutionAsk: ${ask}`);
    assert.ok(fabricateTurnText(ask).error, `refused: ${ask}`);
  }
  // a plain planning ask is not flagged
  assert.ok(!isExecutionAsk('a wall bracket for a 35mm pipe'));
});

test('MCP: kingmaker_fabricate plans only, reaches just the turn, and there is NO execute/dispatch tool', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('kingmaker_fabricate'));
  assert.ok(!names.some((n) => /fabricat.*(execute|run|dispatch|machine)|adapter|execute$/.test(n)), 'no fabrication execute/dispatch tool');
  const tool = TOOLS.find((t) => t.name === 'kingmaker_fabricate');
  assert.equal(tool.annotations.readOnlyHint, true);

  const engine = fakeEngine({ '/api/conversation/turn': (c) => ({ ok: true, data: { conversationId: 'cf', spokenResponse: `Here is a plan. (${c.body.userText})`, workflowRoute: 'fabrication', dispatchExecuted: false } }) });
  const res = JSON.parse((await callTool('kingmaker_fabricate', { concept: 'a wall bracket for a 35mm pipe' }, { port: 3001, fetchImpl: engine.fetchImpl })).content[0].text);
  assert.equal(res.asked, 'fabricate a wall bracket for a 35mm pipe');
  assert.match(res.note, /planning only/i);
  // the ONLY engine call is the governed turn — never a fabrication /start, /execute, /search-decision or /adapter/dispatch
  assert.deepEqual(engine.calls.map((c) => c.path), ['/api/conversation/turn']);
  assert.ok(!engine.calls.some((c) => /fabrication|adapter|execute|search-decision/.test(c.path)), 'no execution route touched');
  assert.ok(!Object.keys(engine.calls[0].headers).some((h) => h === DESKTOP_NONCE_HEADER), 'MCP sends no nonce');

  // an execution ask through MCP is refused, not forwarded
  const refused = await callTool('kingmaker_fabricate', { concept: 'mill it on the CNC' }, { port: 3001, fetchImpl: engine.fetchImpl });
  assert.equal(refused.isError, true);
});

test('the codebase exposes no fabrication execute/dispatch call from lib/', () => {
  // A guard against a future edit wiring an execution path: lib/ must not call the engine's fabrication execute,
  // search-decision, or adapter/dispatch routes.
  // Scan CODE lines only (drop //-comment lines, which legitimately name the routes we avoid), looking for an
  // actual fabrication execute / search-decision / adapter-dispatch path.
  for (const f of ['lib/fabrication.mjs', 'lib/cli.mjs', 'lib/mcp.mjs', 'lib/client.mjs']) {
    const code = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      .split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
    assert.ok(!/\/api\/fabrication\/[^'"`\s]*(?:execute|search-decision)/.test(code), `${f} must not call fabrication execute/search-decision`);
    assert.ok(!/adapter\/dispatch/.test(code), `${f} must not call adapter/dispatch`);
  }
});

test('the fabricate handle is on the command list', () => {
  const said = COMMAND_GROUPS.flatMap((g) => g.items).map((i) => i.say ?? '').join(' \n ');
  assert.ok(said.includes('fabricate …'), 'fabricate is listed');
});
