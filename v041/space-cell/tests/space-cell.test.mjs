/**
 * tests/space-cell.test.mjs
 *
 * Exercises the SPACE cell (space-client + cell-governor) against a FAKE
 * transport implementing the documented SPACE API shape (see
 * lib/space-client.mjs header): 202 + operation polling, colon-verb
 * lifecycle, command sessions, SSE event frames. No network, $0.
 *
 * Run: node tests/space-cell.test.mjs
 */

import assert from 'node:assert/strict';
import { createSpaceClient } from '../lib/space-client.mjs';
import {
  createCellGovernor, verifyCellOutput, CellGovernorError,
} from '../lib/cell-governor.mjs';
import { createChain, appendEntry, verifyChain } from '../lib/audit-chain.mjs';

const API = 'https://space.test';
const DATA = 'https://space-data.test';
const API_TOKEN = 'api-token-for-tests';

function makeAuditLog() {
  const chain = createChain('space-cell-test');
  return {
    entries: chain,
    append: (e) => appendEntry(chain, e),
    verify: () => verifyChain(chain),
  };
}

/** Default guest script: a friendly hello and a clean exit. */
function defaultScript() {
  return [
    { type: 'attached', session_id: 'x', route_generation: 1, current_node_id: 'node-1' },
    { type: 'process_started', process_id: 'x', pid: 42 },
    { type: 'stdout', seq: 1, data_base64: Buffer.from('hello from the cell\n').toString('base64') },
    { type: 'process_exited', exit_code: 0 },
  ];
}

/** A guest that exits cleanly but says nothing. */
function emptyScript() {
  return [
    { type: 'attached', session_id: 'x', route_generation: 1, current_node_id: 'node-1' },
    { type: 'process_exited', exit_code: 0 },
  ];
}

/**
 * Fake SPACE deployment. Operations report 'running' on the first poll and
 * 'succeeded' on the second, so client polling is genuinely exercised.
 * Every call is recorded in `calls` (method, path, headers, body).
 */
function createFakeSpace({ script = defaultScript } = {}) {
  const calls = [];
  const sandboxes = new Map();
  const operations = new Map();
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  function newOperation(kind, sandboxId, effect) {
    const id = `op_${uuid()}`;
    operations.set(id, { id, kind, sandboxId, polls: 0, effect });
    return id;
  }

  async function transport({ method, url, headers = {}, body = undefined, stream = false }) {
    const u = new URL(url);
    const path = u.pathname;
    calls.push({ method, path, url, headers, body, stream });

    if (stream && path.startsWith('/v1/sessions/')) {
      const frames = script();
      async function* gen() {
        for (const f of frames) yield `data: ${JSON.stringify(f)}\n\n`;
      }
      return { status: 200, body: gen() };
    }
    const seg = path.split('/').filter(Boolean); // ['v1','sandboxes',...]

    if (method === 'POST' && path === '/v1/sandboxes') {
      const sandboxId = `sbx_${uuid()}`;
      sandboxes.set(sandboxId, { id: sandboxId, state: 'creating', template: body.template });
      const operationId = newOperation('create', sandboxId, (sb) => { sb.state = 'running'; });
      return { status: 202, body: { sandbox_id: sandboxId, operation_id: operationId } };
    }
    if (method === 'GET' && seg[1] === 'operations') {
      const op = operations.get(seg[2]);
      if (!op) return { status: 404, body: { error: { message: 'no such operation' } } };
      op.polls += 1;
      const state = op.polls >= 2 ? 'succeeded' : 'running';
      if (state === 'succeeded' && op.effect) {
        const sb = sandboxes.get(op.sandboxId);
        if (sb) op.effect(sb);
        op.effect = null;
      }
      return { status: 200, body: { id: op.id, kind: op.kind, state, target_id: op.sandboxId } };
    }
    if (seg[1] === 'sandboxes' && seg[2]) {
      const [idPart, verb] = seg[2].split(':');
      const sb = sandboxes.get(idPart);
      if (!sb) return { status: 404, body: { error: { message: 'no such sandbox' } } };
      if (method === 'GET' && seg.length === 3) {
        return { status: 200, body: { id: sb.id, state: sb.state, template: sb.template, template_digest: 'sha256:fake' } };
      }
      if (method === 'GET' && seg[3] === 'processes') {
        return { status: 200, body: { data: [] } };
      }
      if (method === 'POST' && seg[3] === 'commands') {
        const sessionId = `proc_${uuid()}`;
        return {
          status: 201,
          body: {
            session_id: sessionId,
            process_id: sessionId,
            sandbox_id: sb.id,
            state: 'created',
            attach: {
              url: 'wss://space-data.test/attach',
              events_url: `${DATA}/v1/sessions/${sessionId}/events`,
              token: `attach-token-${sessionId}`,
              expires_at: '2999-01-01T00:00:00Z',
              token_transport: ['bearer'],
            },
          },
        };
      }
      if (method === 'POST' && verb) {
        const target = { pause: 'paused', suspend: 'suspended', wake: 'running' }[verb];
        const operationId = newOperation(verb, sb.id, (s) => { s.state = target; });
        return { status: 202, body: { sandbox_id: sb.id, operation_id: operationId } };
      }
      if (method === 'DELETE') {
        const operationId = newOperation('delete', sb.id, (s) => { s.state = 'deleted'; });
        return { status: 202, body: { sandbox_id: sb.id, operation_id: operationId } };
      }
    }
    return { status: 404, body: { error: { message: `fake: unrouted ${method} ${path}` } } };
  }

  return { transport, calls, sandboxes, operations };
}

function makeClient(fake, extra = {}) {
  return createSpaceClient({
    transport: fake.transport,
    apiToken: API_TOKEN,
    apiUrl: API,
    dataPlaneUrl: DATA,
    sleep: async () => {},
    pollIntervalMs: 0,
    ...extra,
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} — ${err.message}`]);
  }
}

// ---------------------------------------------------------------- client ---

await test('client: sandbox lifecycle end-to-end (create → command → output → pause → wake → delete)', async () => {
  const fake = createFakeSpace();
  const client = makeClient(fake);
  const { sandboxId, operationId } = await client.createSandbox('seed:latest');
  assert.match(sandboxId, /^sbx_/);
  assert.match(operationId, /^op_/);
  // create polled its operation more than once (fake succeeds on poll #2)
  const opPolls = fake.calls.filter((c) => c.method === 'GET' && c.path === `/v1/operations/${operationId}`);
  assert.ok(opPolls.length >= 2, 'operation was polled until succeeded');
  // management calls carried the API bearer token + idempotency key
  const createCall = fake.calls.find((c) => c.method === 'POST' && c.path === '/v1/sandboxes');
  assert.equal(createCall.headers.Authorization, `Bearer ${API_TOKEN}`);
  assert.ok(createCall.headers['Idempotency-Key'], 'mutation carries Idempotency-Key');

  const session = await client.runCommand(sandboxId, { command: ['echo', 'hello'] });
  const out = await client.collectOutput(session.sessionId);
  assert.equal(out.stdout, 'hello from the cell\n');
  assert.equal(out.exitCode, 0);
  // the events stream was attached with the SESSION token, not the API token
  const evCall = fake.calls.find((c) => c.stream);
  assert.match(evCall.headers.Authorization, /^Bearer attach-token-/);

  const paused = await client.pauseSandbox(sandboxId);
  assert.equal(paused.sandbox.state, 'paused');
  const woken = await client.wakeSandbox(sandboxId);
  assert.equal(woken.sandbox.state, 'running');
  await client.deleteSandbox(sandboxId);
  assert.equal(fake.sandboxes.get(sandboxId).state, 'deleted');
});

await test('client: attach to an unexpected events URL is refused', async () => {
  const fake = createFakeSpace();
  const evil = async (req) => {
    const res = await fake.transport(req);
    if (req.method === 'POST' && req.url.includes('/commands')) {
      res.body.attach.events_url = 'https://evil.example/v1/sessions/x/events';
    }
    return res;
  };
  const client = makeClient({ transport: evil, calls: fake.calls });
  const { sandboxId } = await client.createSandbox('seed:latest');
  await assert.rejects(() => client.runCommand(sandboxId, { command: ['true'] }), /unexpected events URL/);
});

// -------------------------------------------------------------- governor ---

await test('governor: intent is audit-logged BEFORE the first transport call', async () => {
  const fake = createFakeSpace();
  const auditLog = makeAuditLog();
  let actionsAtFirstCall = null;
  const spying = async (req) => {
    if (actionsAtFirstCall === null) actionsAtFirstCall = auditLog.entries.map((e) => e.action);
    return fake.transport(req);
  };
  const client = makeClient({ transport: spying, calls: fake.calls });
  const gov = createCellGovernor({ client, auditLog, spineMode: 'custom' });
  const res = await gov.runWorkload({ kind: 'cage-eval', command: ['run-skill', 'candidate'] });
  assert.ok(actionsAtFirstCall.includes('cell.intent'), 'intent entry existed before transport was touched');
  const intent = auditLog.entries.find((e) => e.action === 'cell.intent');
  const created = auditLog.entries.find((e) => e.action === 'cell.sandbox.created');
  assert.ok(intent.seq < created.seq, 'intent precedes the create record');
  assert.equal(res.intentSeq, intent.seq);
  assert.equal(auditLog.verify().ok, true);
});

await test('governor: credential is brokered into the session env ONLY — never template, command, or audit', async () => {
  const SECRET = 'TEST-SECRET-VALUE-123';
  const fake = createFakeSpace();
  const auditLog = makeAuditLog();
  const gov = createCellGovernor({
    client: makeClient(fake), auditLog, spineMode: 'custom',
    credentialBroker: { resolve: async (name) => (name === 'huggingface-token' ? SECRET : null) },
  });
  await gov.runWorkload({
    kind: 'cage-eval',
    command: ['printenv', 'HUGGINGFACE_TOKEN'],
    credentials: ['huggingface-token'],
  });
  const createCall = fake.calls.find((c) => c.method === 'POST' && c.path === '/v1/sandboxes');
  const cmdCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/commands'));
  assert.equal(cmdCall.body.env.HUGGINGFACE_TOKEN, SECRET, 'value injected into the command session env');
  assert.ok(!JSON.stringify(createCall.body).includes(SECRET), 'secret absent from sandbox create (template/env)');
  assert.ok(!JSON.stringify(cmdCall.body.command).includes(SECRET), 'secret absent from command text');
  const auditJson = JSON.stringify(auditLog.entries);
  assert.ok(!auditJson.includes(SECRET), 'secret absent from the audit log');
  assert.ok(auditJson.includes('huggingface-token'), 'credential NAME is what the audit records');
});

await test('governor: a credential value in command text is refused before any session exists', async () => {
  const SECRET = 'TEST-SECRET-VALUE-123';
  const fake = createFakeSpace();
  const gov = createCellGovernor({
    client: makeClient(fake), auditLog: makeAuditLog(), spineMode: 'custom',
    credentialBroker: { resolve: async () => SECRET },
  });
  await assert.rejects(
    () => gov.runWorkload({ kind: 'cage-eval', command: ['echo', SECRET], credentials: ['huggingface-token'] }),
    (err) => err instanceof CellGovernorError && err.code === 'credential-in-command',
  );
  assert.equal(fake.calls.filter((c) => c.path.endsWith('/commands')).length, 0);
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sandboxes').length, 0);
});

await test('governor: deny-all is the default egress — registered kinds and an unregistered-policy kind alike', async () => {
  const fake = createFakeSpace();
  const gov = createCellGovernor({
    client: makeClient(fake), auditLog: makeAuditLog(), spineMode: 'custom',
    workloadOverrides: { 'adhoc-probe': { template: 'kingmaker/adhoc:latest', spine: 'custom', credentials: [] } },
  });
  await gov.runWorkload({ kind: 'digital-twin', command: ['true'] });
  await gov.runWorkload({ kind: 'adhoc-probe', command: ['true'] }); // override carries NO egress policy
  const creates = fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sandboxes');
  assert.equal(creates.length, 2);
  for (const c of creates) {
    assert.deepEqual(c.body.network_policy, { egress: { mode: 'deny-all', allow: [] } });
  }
});

await test('governor: unknown workload kind is refused and never reaches the transport', async () => {
  const fake = createFakeSpace();
  const auditLog = makeAuditLog();
  const gov = createCellGovernor({ client: makeClient(fake), auditLog, spineMode: 'custom' });
  await assert.rejects(
    () => gov.runWorkload({ kind: 'does-not-exist', command: ['true'] }),
    (err) => err instanceof CellGovernorError && err.code === 'unknown-workload',
  );
  assert.equal(fake.calls.length, 0);
  assert.ok(auditLog.entries.some((e) => e.action === 'cell.refused'));
});

await test('governor: Red Hat kinds refuse in custom spine mode, run under kingmaker-x-heretic', async () => {
  const fakeCustom = createFakeSpace();
  const auditLog = makeAuditLog();
  const govCustom = createCellGovernor({ client: makeClient(fakeCustom), auditLog, spineMode: 'custom' });
  await assert.rejects(
    () => govCustom.runWorkload({ kind: 'redhat-darkweb', command: ['search'] }),
    (err) => err instanceof CellGovernorError && err.code === 'spine-required',
  );
  assert.equal(fakeCustom.calls.length, 0, 'refusal happened before any request');
  assert.ok(auditLog.entries.some((e) => e.action === 'cell.refused' && e.meta.code === 'spine-required'));

  const fakeHeretic = createFakeSpace();
  const govHeretic = createCellGovernor({
    client: makeClient(fakeHeretic), auditLog: makeAuditLog(), spineMode: 'kingmaker-x-heretic',
  });
  const res = await govHeretic.runWorkload({ kind: 'redhat-abliterate', command: ['abliterate', 'model'] });
  assert.equal(res.exitCode, 0);
});

await test('governor: kuroko-voice is registered, runs in custom mode, deny-all egress', async () => {
  const fake = createFakeSpace();
  const gov = createCellGovernor({ client: makeClient(fake), auditLog: makeAuditLog(), spineMode: 'custom' });
  const kinds = gov.listWorkloads();
  const kuroko = kinds.find((k) => k.kind === 'kuroko-voice');
  assert.ok(kuroko, 'kuroko-voice is in the registry');
  assert.equal(kuroko.spine, 'custom');
  assert.equal(kuroko.egress.mode, 'deny-all');
  const res = await gov.runWorkload({ kind: 'kuroko-voice', command: ['voice-studio', 'synthesize'] });
  assert.equal(res.verification.pass, true);
  const createCall = fake.calls.find((c) => c.method === 'POST' && c.path === '/v1/sandboxes');
  assert.deepEqual(createCall.body.network_policy, { egress: { mode: 'deny-all', allow: [] } });
});

await test('governor: the output verifier catches an empty result (and a refusal)', async () => {
  const fake = createFakeSpace({ script: emptyScript });
  const gov = createCellGovernor({ client: makeClient(fake), auditLog: makeAuditLog(), spineMode: 'custom' });
  const res = await gov.runWorkload({ kind: 'digital-twin', command: ['say-nothing'] });
  assert.equal(res.verification.pass, false);
  assert.ok(res.verification.reasons.some((r) => r.includes('empty')), 'empty output flagged');

  const v = verifyCellOutput({ stdout: "I'm sorry, but I can't help with that.", stderr: '', exitCode: 0 });
  assert.equal(v.pass, false);
  assert.ok(v.reasons.some((r) => r.includes('refusal')));
});

// ---------------------------------------------------------------- report ---

let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed += 1;
  console.log(`${status}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
