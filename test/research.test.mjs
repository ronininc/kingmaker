// Native Internet / governed research as a Kingmaker handle (lib/research.mjs, the `research` CLI verb, the
// kingmaker_research MCP tool). Hermetic: the engine is a fake fetch. The governance shape is the point — research
// answers through the governed turn loop (never an ungated egress path), and setting the research source is an
// owner write the MCP surface can never reach (no nonce).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeResearchMode, researchTurnText, RESEARCH_MODES, sourceLine } from '../lib/research.mjs';
import { callTool, TOOLS } from '../lib/mcp.mjs';
import { researchSource, setResearchSource } from '../lib/client.mjs';
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

test('researchTurnText: a research verb leads when the words do not already start with one; empty is an error', () => {
  assert.equal(researchTurnText('the latest on merchant cash advances').text, 'research the latest on merchant cash advances');
  assert.equal(researchTurnText('research merchant cash advances').text, 'research merchant cash advances');
  assert.equal(researchTurnText('investigate X').text, 'investigate X');
  assert.ok(researchTurnText('').error);
  assert.ok(researchTurnText([]).error);
});

test('normalizeResearchMode accepts only the known modes, never a silent default', () => {
  for (const m of RESEARCH_MODES) assert.deepEqual(normalizeResearchMode(m), { mode: m });
  assert.equal(normalizeResearchMode('BROWSER-FIRST').mode, 'browser-first');
  assert.ok(normalizeResearchMode('whatever').error);
  assert.ok(normalizeResearchMode('').error);
});

test('sourceLine keeps only stable fields', () => {
  assert.equal(sourceLine({ mode: 'api-first', searchEngine: 'searxng' }), 'research source: api-first · engine searxng');
  assert.equal(sourceLine({}), 'research source: ?');
});

test('client: reading the source needs no nonce; setting it refuses locally without one and sends it when present', async () => {
  const engine = fakeEngine({ '/api/research-source/settings': (c) => (c.method === 'POST' ? { ok: true, data: { mode: c.body.mode } } : { ok: true, data: { mode: 'browser-first', searchEngine: 'searxng' } }) });
  const read = await researchSource(3001, { fetchImpl: engine.fetchImpl });
  assert.equal(read.json.data.mode, 'browser-first');
  assert.equal(engine.calls.at(-1).method, 'GET');
  assert.ok(!Object.keys(engine.calls.at(-1).headers).some((h) => h === DESKTOP_NONCE_HEADER));

  await assert.rejects(setResearchSource(3001, 'api-only', { fetchImpl: engine.fetchImpl }), /OWNER_NONCE_REQUIRED/);
  const nonce = 'x'.repeat(40);
  const wrote = await setResearchSource(3001, 'api-only', { nonce, fetchImpl: engine.fetchImpl });
  assert.equal(wrote.json.data.mode, 'api-only');
  const post = engine.calls.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers[DESKTOP_NONCE_HEADER], nonce);
  assert.deepEqual(post.body, { mode: 'api-only' });
});

test('MCP: kingmaker_research answers through the governed turn, carries no nonce, and cannot set the source', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('kingmaker_research'));
  assert.ok(!names.some((n) => /source|setting|mode/.test(n)), 'no tool to set the research source');
  const tool = TOOLS.find((t) => t.name === 'kingmaker_research');
  assert.equal(tool.annotations.openWorldHint, true);

  const engine = fakeEngine({ '/api/conversation/turn': (c) => ({ ok: true, data: { conversationId: 'cr', spokenResponse: `Here is what I found. (${c.body.userText})`, workflowRoute: 'research', dispatchExecuted: true } }) });
  const res = JSON.parse((await callTool('kingmaker_research', { question: 'the latest on X' }, { port: 3001, fetchImpl: engine.fetchImpl })).content[0].text);
  assert.equal(res.asked, 'research the latest on X');
  assert.equal(res.route, 'research');
  const turnCall = engine.calls.find((c) => c.path === '/api/conversation/turn');
  assert.ok(!Object.keys(turnCall.headers).some((h) => h === DESKTOP_NONCE_HEADER), 'MCP never sends the launch nonce');
  // the only outbound path is the governed turn — no research-source or frontier-research call
  assert.ok(!engine.calls.some((c) => /research-source|frontier-research/.test(c.path)), 'no ungated egress path');

  assert.equal((await callTool('kingmaker_research', { question: '' }, { port: 3001, fetchImpl: engine.fetchImpl })).isError, true);
});

test('the research handle is on the command list', () => {
  const said = COMMAND_GROUPS.flatMap((g) => g.items).map((i) => i.say ?? '').join(' \n ');
  assert.ok(said.includes('research …'), 'research is listed');
});
