// Project Twin as a Kingmaker handle (lib/project-twin.mjs, the `twin` CLI verb, the kingmaker_twins MCP tool).
// Hermetic: the engine is a fake fetch. Class C — the engine's routes are read-and-record only
// (noExternalSideEffect); the one owner decision (a back-burner task action) is held behind the launch nonce and is
// never reachable from the MCP surface.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backBurnerLines, normalizeTwinAction, TWIN_ACTIONS, twinLine, twinTaskBody } from '../lib/project-twin.mjs';
import { callTool, TOOLS } from '../lib/mcp.mjs';
import { projectTwins, projectTwinTaskAction } from '../lib/client.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';
import { COMMAND_GROUPS } from '../lib/command-list.mjs';

function fakeEngine(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const entry = { path: u.pathname, query: u.search, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(entry);
    const json = answers[u.pathname]?.(entry) ?? { ok: false };
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchImpl };
}

test('normalizeTwinAction accepts only the engine\'s actions', () => {
  for (const a of TWIN_ACTIONS) assert.deepEqual(normalizeTwinAction(a), { action: a });
  assert.equal(normalizeTwinAction('APPROVE').action, 'approve');
  assert.ok(normalizeTwinAction('delete').error);
  assert.ok(normalizeTwinAction('').error);
});

test('twinLine and twinTaskBody keep only what is given', () => {
  assert.equal(twinLine({ twinId: 't1', name: 'Taco site', domain: 'codegen', status: 'ACTIVE' }), '· Taco site (t1) — codegen · ACTIVE');
  assert.equal(twinLine({ id: 't2' }), '· (unnamed) (t2)');
  assert.deepEqual(twinTaskBody('approve'), { action: 'approve' });
  assert.deepEqual(twinTaskBody('edit', 'new text'), { action: 'edit', draftText: 'new text' });
});

test('backBurnerLines summarizes tasks + the recommended next action', () => {
  const lines = backBurnerLines({ backBurner: { tasks: [{ id: 'k1', title: 'Draft reply', state: 'STAGED' }], reviewPacket: { status: 'STAGED_FOR_REVIEW', decisionsNeeded: ['x'], recommendedNextAction: 'Review packet.' } } });
  assert.match(lines[0], /1 task.*STAGED_FOR_REVIEW/);
  assert.match(lines.join('\n'), /k1: Draft reply \[STAGED\]/);
  assert.match(lines.join('\n'), /→ Review packet\./);
});

test('client: reads carry no nonce and send tenantId; a task action refuses locally without a nonce and sends it with one', async () => {
  const engine = fakeEngine({
    '/api/project-twins/': () => ({ ok: true, data: { projectTwins: [{ twinId: 't1', name: 'A' }] } }),
    '/api/project-twins/t1/back-burner/tasks/k1': (c) => ({ ok: true, data: { backBurner: { tasks: [] }, noExternalSideEffect: true, echo: c.body } }),
  });
  const list = await projectTwins(3001, { fetchImpl: engine.fetchImpl });
  assert.equal(list.json.data.projectTwins[0].twinId, 't1');
  assert.match(engine.calls.at(-1).query, /tenantId=primary/);
  assert.ok(!Object.keys(engine.calls.at(-1).headers).some((h) => h === DESKTOP_NONCE_HEADER), 'a read sends no nonce');

  await assert.rejects(projectTwinTaskAction(3001, 't1', 'k1', { action: 'approve' }, { fetchImpl: engine.fetchImpl }), /OWNER_NONCE_REQUIRED/);
  const nonce = 'q'.repeat(40);
  const r = await projectTwinTaskAction(3001, 't1', 'k1', twinTaskBody('approve'), { nonce, fetchImpl: engine.fetchImpl });
  const patch = engine.calls.at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.headers[DESKTOP_NONCE_HEADER], nonce);
  assert.deepEqual(patch.body, { action: 'approve' });
  assert.equal(r.json.data.noExternalSideEffect, true);
});

test('MCP: kingmaker_twins is read-only and there is NO task-action tool', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('kingmaker_twins'));
  assert.ok(!names.some((n) => /twin.*(task|approve|action|patch)|back.?burner/.test(n)), 'no Project Twin task-action tool');
  assert.equal(TOOLS.find((t) => t.name === 'kingmaker_twins').annotations.readOnlyHint, true);

  const engine = fakeEngine({ '/api/project-twins/': () => ({ ok: true, data: { projectTwins: [{ twinId: 't1', name: 'A', domain: 'codegen' }] } }) });
  const res = JSON.parse((await callTool('kingmaker_twins', {}, { port: 3001, fetchImpl: engine.fetchImpl })).content[0].text);
  assert.equal(res.count, 1);
  assert.match(res.twins[0], /A \(t1\) — codegen/);
  assert.match(res.note, /owner/i);
  // only read routes touched — never a task PATCH
  assert.ok(!engine.calls.some((c) => c.method === 'PATCH'), 'MCP never PATCHes a task');
});

test('the twin handle is on the command list', () => {
  const said = COMMAND_GROUPS.flatMap((g) => g.items).map((i) => i.say ?? '').join(' \n ');
  assert.ok(said.includes('twin list'), 'twin is listed');
});
