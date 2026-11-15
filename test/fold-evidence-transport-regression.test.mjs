import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createBiliMcpTransport } from '../lib/fold-evidence.mjs';

function shim(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.messages = []; child.killed = false;
  child.send = (msg) => child.stdout.write(JSON.stringify(msg) + '\n');
  child.stdin = new Writable({ write(bytes, enc, cb) {
    const msg = JSON.parse(String(bytes)); child.messages.push(msg);
    queueMicrotask(() => handler(msg, child)); cb();
  } });
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  return child;
}
const answer = (msg, child) => {
  if (msg.id) child.send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? {} : { content: [{ type: 'text', text: 'evidence' }] } });
};

test('handshake, id matching, and stderr drain', async () => {
  const p = shim((msg, child) => { child.send({ id: 9999, result: {} }); answer(msg, child); });
  const t = createBiliMcpTransport({ spawnImpl: () => p });
  try {
    assert.equal(await t.call('acp_status'), 'evidence');
    assert.deepEqual(p.messages.map(m => m.method), ['initialize', 'notifications/initialized', 'tools/call']);
    assert.equal(p.stderr.readableFlowing, true);
  } finally { t.close(); }
});

test('exit during call rejects instead of silently resolving empty evidence; next call reinitializes', async () => {
  const first = shim((msg, child) => msg.method === 'tools/call' ? child.emit('exit', 1) : answer(msg, child));
  const second = shim(answer); const children = [first, second];
  const t = createBiliMcpTransport({ spawnImpl: () => children.shift() });
  try {
    await assert.rejects(t.call('acp_status'), /exited/);
    assert.equal(await t.call('acp_status'), 'evidence');
    assert.equal(second.messages[0].method, 'initialize');
    first.emit('exit', 1); // late event from the old process must not poison replacement
    assert.equal(await t.call('acp_status'), 'evidence');
  } finally { t.close(); }
});

test('spawn error rejects and permits retry', async () => {
  let n = 0;
  const t = createBiliMcpTransport({ spawnImpl: () => {
    if (n++ === 0) throw new Error('spawn unavailable'); return shim(answer);
  } });
  try {
    await assert.rejects(t.call('acp_status'), /spawn unavailable/);
    assert.equal(await t.call('acp_status'), 'evidence');
  } finally { t.close(); }
});

test('silent initialize is bounded and killed', async () => {
  const p = shim(() => {});
  const t = createBiliMcpTransport({ spawnImpl: () => p, timeoutMs: 20 });
  await assert.rejects(t.call('acp_status'), /initialize timed out/);
  assert.equal(p.killed, true); t.close();
});

test('silent tool call is bounded', async () => {
  const p = shim((msg, child) => { if (msg.method === 'initialize') answer(msg, child); });
  const t = createBiliMcpTransport({ spawnImpl: () => p, timeoutMs: 20 });
  await assert.rejects(t.call('acp_status'), /tools\/call timed out/); t.close();
});

test('close rejects inflight request', async () => {
  const p = shim(() => {}); const t = createBiliMcpTransport({ spawnImpl: () => p });
  const result = t.call('acp_status'); t.close();
  await assert.rejects(result, /closed/);
});

test('async process and stdin errors reject', async () => {
  for (const surface of ['process', 'stdin']) {
    const p = shim((msg, child) => (surface === 'stdin' ? child.stdin : child).emit('error', new Error('broken pipe')));
    const t = createBiliMcpTransport({ spawnImpl: () => p });
    await assert.rejects(t.call('acp_status'), /broken pipe/); t.close();
  }
});

test('oversized complete and partial lines fail closed', async () => {
  for (const suffix of ['', '\n']) {
    const p = shim((msg, child) => child.stdout.write('x'.repeat(65) + suffix));
    const t = createBiliMcpTransport({ spawnImpl: () => p, maxLineBytes: 64 });
    await assert.rejects(t.call('acp_status'), /line limit/); t.close();
  }
});

test('JSON-RPC error and MCP tool error remain failures', async () => {
  for (const response of [{ error: { message: 'rpc refused' } }, { result: { isError: true, content: [{ type: 'text', text: 'tool refused' }] } }]) {
    const p = shim((msg, child) => {
      if (msg.method === 'initialize') answer(msg, child);
      else if (msg.id) child.send({ id: msg.id, ...response });
    });
    const t = createBiliMcpTransport({ spawnImpl: () => p });
    await assert.rejects(t.call('acp_status'), /refused/); t.close();
  }
});
