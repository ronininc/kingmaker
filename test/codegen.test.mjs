// CodeGen as a Kingmaker handle (lib/codegen.mjs, the `build` CLI verb, the kingmaker_build MCP tool).
// Hermetic: the engine is a fake fetch; no server, no files. The point of these tests is the governance shape —
// a build is read back and waits for the owner, and the MCP tool (which never holds the nonce) can only propose.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTurnText, classifyBuildAsk, projectLine } from '../lib/codegen.mjs';
import { callTool, TOOLS } from '../lib/mcp.mjs';
import { READ_BACK_LINE, turn } from '../lib/client.mjs';
import { COMMAND_GROUPS } from '../lib/command-list.mjs';

/** A fake engine: records each request and answers like the real routes. */
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
const answer = (json) => async () => ({ ok: true, status: 200, json: async () => json });

test('classifyBuildAsk: status words read, modify words modify, everything else is a build', () => {
  for (const w of ['status', 'list', 'projects', 'project']) assert.equal(classifyBuildAsk([w]), 'status', w);
  for (const w of ['modify', 'change', 'edit', 'update']) assert.equal(classifyBuildAsk([w, 'abc', 'x']), 'modify', w);
  assert.equal(classifyBuildAsk(['a', 'tracker', 'for', 'leads']), 'build');
  assert.equal(classifyBuildAsk(['build', 'a', 'dashboard']), 'build');
  assert.equal(classifyBuildAsk([]), 'build');
  assert.equal(classifyBuildAsk('make a parser'), 'build');
});

test('buildTurnText: a fresh ask gets a build verb; status carries no turn; empty is an error', () => {
  assert.deepEqual(buildTurnText('a tracker for my leads'), { text: 'build a tracker for my leads', kind: 'build' });
  // already-a-verb asks are passed through, not double-prefixed
  assert.equal(buildTurnText('build a dashboard').text, 'build a dashboard');
  assert.equal(buildTurnText('make a calculator').text, 'make a calculator');
  assert.equal(buildTurnText('generate a parser').text, 'generate a parser');
  // status is answered by a read route, not a turn
  assert.deepEqual(buildTurnText(['status']), { text: null, kind: 'status' });
  // nothing to build
  assert.ok(buildTurnText('').error);
  assert.ok(buildTurnText([]).error);
});

test('buildTurnText modify: the project id rides the sentence so a threaded turn works on it', () => {
  assert.equal(buildTurnText('modify abc123 add a dark mode toggle').text, 'modify the project abc123: add a dark mode toggle');
  assert.equal(buildTurnText('change add a footer', { projectId: 'p-9' }).text, 'modify the project p-9: add a footer');
  // modify with no instruction is an error, never a blank turn
  assert.ok(buildTurnText('modify abc123').error ?? buildTurnText('modify').error);
  assert.ok(buildTurnText('modify').error);
});

test('projectLine keeps only stable fields and never invents one', () => {
  assert.equal(projectLine({ projectId: 'x1', projectName: 'Leads', updatedAt: '2026-10-18' }), '· Leads (x1) — 2026-10-18');
  assert.equal(projectLine({ id: 'x2' }), '· (unnamed) (x2)');
  assert.equal(projectLine({}), '· (unnamed) (?)');
});

test('client.turn reads back a held build as confirmationRequired, not executed', async () => {
  const held = { ok: true, data: { conversationId: 'c1', spokenResponse: 'I will build a lead tracker. Say go ahead to build it.', confirmationRequired: true, dispatchExecuted: false, workflowRoute: 'codegen' } };
  assert.ok(READ_BACK_LINE.test(held.data.spokenResponse));
  const r = await turn(3001, { text: 'build a lead tracker', fetchImpl: answer(held) });
  assert.equal(r.confirmationRequired, true);
  assert.equal(r.executed, false);
  assert.equal(r.route, 'codegen');
});

test('MCP: kingmaker_build is a write that comes back proposed, and nothing here approves or runs or deploys', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('kingmaker_build'));
  assert.ok(!names.some((n) => /approve|confirm|deploy|execute/.test(n)), 'no approve/deploy/execute tool');
  const tool = TOOLS.find((t) => t.name === 'kingmaker_build');
  assert.equal(tool.annotations.readOnlyHint, false, 'never advertised read-only');

  const engine = fakeEngine({
    '/api/conversation/turn': (c) => ({ ok: true, data: { conversationId: 'conv-b', spokenResponse: `I will build it. Say go ahead to build it. (${c.body.userText})`, confirmationRequired: true, dispatchExecuted: false, workflowRoute: 'codegen' } }),
  });
  const res = JSON.parse((await callTool('kingmaker_build', { request: 'a tracker for my leads' }, { port: 3001, fetchImpl: engine.fetchImpl })).content[0].text);
  assert.equal(res.asked, 'build a tracker for my leads');
  assert.equal(res.awaitingOwnerApproval, true);
  assert.equal(res.executed, false);
  assert.match(res.note, /owner/i);
  // the turn carried NO desktop nonce — the MCP surface can only propose
  const turnCall = engine.calls.find((c) => c.path === '/api/conversation/turn');
  assert.ok(!Object.keys(turnCall.headers).some((h) => /nonce/i.test(h)), 'MCP never sends the launch nonce');

  assert.equal((await callTool('kingmaker_build', { request: '' }, { port: 3001, fetchImpl: engine.fetchImpl })).isError, true);
});

test('the build handle is on the command list', () => {
  const said = COMMAND_GROUPS.flatMap((g) => g.items).map((i) => i.say ?? '').join(' \n ');
  assert.ok(said.includes('build …'), 'build is listed');
});
