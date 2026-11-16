// Context security boundary (2026-11-16): external tools get a minimal environment, and fold receipts are read only
// from Kingmaker's private spill directory. Synthetic canaries and synthetic files only — no real secrets or files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, chmodSync, existsSync, readFileSync, realpathSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minimalEnv, BASE_ENV_KEYS } from '../lib/child-env.mjs';
import { biliChildEnv, createBiliMcpTransport, createFoldEvidence, createSpillDir, readSpillFile } from '../lib/fold-evidence.mjs';
import { runFilmTool } from '../lib/film-production.mjs';

const CANARY = 'CANARY-7f3e9c1d-not-a-real-secret';
const CANARY_KEYS = ['KINGMAKER_UPDATE_KEY', 'ANTHROPIC_API_KEY', 'SOLOMON_VOICE_ATTESTATION_KEY', 'SOLOMON_DESKTOP_CONTROL_NONCE', 'CLAUDE_CODE_SESSION_ID', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'SOME_FUTURE_TOKEN'];
function withCanaries(fn) {
  return async () => {
    const saved = {};
    for (const k of CANARY_KEYS) { saved[k] = process.env[k]; process.env[k] = k === 'NODE_OPTIONS' ? '--no-warnings' : `${CANARY}-${k}`; }
    try { await fn(); } finally { for (const k of CANARY_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const leaks = (env) => Object.entries(env).filter(([k, v]) => String(v).includes(CANARY) || ['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES'].includes(k)).map(([k]) => k);

// A fake `bili mcp`: answers initialize, and any tools/call with its OWN environment (keys + whether a canary is present).
const FAKE_SHIM = `
let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;
const env=process.env;const report={keys:Object.keys(env).sort(),canary:Object.entries(env).filter(([k,v])=>String(v).includes('CANARY-7f3e9c1d')).map(([k])=>k)};
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{}}:{content:[{type:'text',text:JSON.stringify(report)}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`;

test('minimalEnv: allowlist only; code-injection variables refused even when explicit', withCanaries(() => {
  const env = minimalEnv({ set: { TOOL_FLAG: '1' } });
  assert.deepEqual(leaks(env), []);
  assert.equal(env.TOOL_FLAG, '1');
  for (const k of Object.keys(env)) assert.ok(BASE_ENV_KEYS.includes(k) || /^LC_/.test(k) || k === 'TOOL_FLAG', k);
  assert.throws(() => minimalEnv({ set: { NODE_OPTIONS: '--require x' } }), /injects code/);
  assert.throws(() => minimalEnv({ set: { DYLD_INSERT_LIBRARIES: 'x' } }), /injects code/);
  assert.deepEqual(Object.keys(minimalEnv({ pass: ['NODE_OPTIONS'] })).filter((k) => k === 'NODE_OPTIONS'), []);
}));

test('biliChildEnv: only the bili binding variables; CLAUDE_CODE_SESSION_ID never forwarded; proxy must be loopback', withCanaries(() => {
  const env = biliChildEnv({ BILI_MCP_PROXY: 'http://127.0.0.1:8787', BILI_CONVERSATION_ID: 'conv-1' });
  assert.deepEqual(leaks(env), []);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.BILI_CONVERSATION_ID, 'conv-1');
  assert.throws(() => biliChildEnv({ ANTHROPIC_API_KEY: 'x' }), /not passed to bili/);
  assert.throws(() => biliChildEnv({ BILI_MCP_PROXY: 'http://evil.example:8787' }), /loopback/);
  assert.throws(() => biliChildEnv({ BILI_MCP_PROXY: 'http://u:p@127.0.0.1:8787' }), /loopback/);
}));

test('real child process (fake bili mcp) sees no canary — success path', withCanaries(async () => {
  const t = createBiliMcpTransport({ command: process.execPath, args: ['-e', FAKE_SHIM], env: { BILI_MCP_PROXY: 'http://127.0.0.1:8787', BILI_CONVERSATION_ID: 'conv-1' }, timeoutMs: 10_000 });
  try {
    const report = JSON.parse(await t.call('acp_status', {}));
    assert.deepEqual(report.canary, []);
    for (const k of CANARY_KEYS) assert.ok(!report.keys.includes(k), `${k} reached the child`);
    assert.ok(report.keys.includes('BILI_CONVERSATION_ID'));
  } finally { t.close(); }
}));

test('failure paths (child exits at once; child hangs → timeout) never spawn with an inherited environment', withCanaries(async () => {
  const seen = [];
  const spy = (cmd, args, opts) => { seen.push(opts.env); return spawn(cmd, args, opts); };
  const dies = createBiliMcpTransport({ command: process.execPath, args: ['-e', 'process.exit(3)'], spawnImpl: spy, timeoutMs: 3000 });
  await assert.rejects(dies.call('acp_status', {}), /exited|timed out/);
  const hangs = createBiliMcpTransport({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], spawnImpl: spy, timeoutMs: 300 });
  await assert.rejects(hangs.call('acp_status', {}), /timed out/);
  hangs.close();
  const missing = createBiliMcpTransport({ command: '/nonexistent/bili-canary-test', spawnImpl: spy, timeoutMs: 1000 });
  await assert.rejects(missing.call('acp_status', {}), /fold-evidence transport/);
  assert.equal(seen.length, 3);
  for (const env of seen) assert.deepEqual(leaks(env), []);
  // A bad variable fails at wiring time, before any process exists.
  assert.throws(() => createBiliMcpTransport({ env: { SECRET: 'x' }, spawnImpl: () => assert.fail('spawned') }), /not passed to bili/);
}));

test('other external tools: real child via runFilmTool sees no canary', withCanaries(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-film-'));
  const { stdout } = await runFilmTool(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k,v])=>String(v).includes("CANARY-7f3e9c1d")||k==="NODE_OPTIONS").map(([k])=>k)))'], { cwd: dir });
  assert.deepEqual(JSON.parse(stdout), []);
}));

test('no remaining full-environment spread in the patched external-tool call sites', () => {
  for (const f of ['fold-evidence', 'method-conductor', 'brain-application', 'film-production', 'render-carriage', 'knowledge', 'platform-compatibility', 'owner-voice', 'deterministic-archive', 'model-bench']) {
    const src = readFileSync(new URL(`../lib/${f}.mjs`, import.meta.url), 'utf8');
    assert.ok(!/\.\.\.process\.env\b/.test(src), `${f}.mjs still spreads process.env into a child`);
  }
});

// ── Spill receipts ──
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cb-spill-')));
  const dir = createSpillDir(root);
  const outside = join(root, 'outside-synthetic.txt'); writeFileSync(outside, 'SYNTHETIC OUTSIDE FILE — must never be read');
  return { root, dir, outside };
}
const ok = (p, dir, extra = {}) => readSpillFile(p, { dir, ...extra });

test('spill: a legitimate large receipt in the spill dir is read byte-exact', async () => {
  const { dir } = sandbox();
  const p = join(dir, 'receipt-b23-1.txt'); const body = 'é'.repeat(200_000); writeFileSync(p, body, { mode: 0o600 });
  assert.equal(await ok(p, dir), body);
});

test('spill: outside paths, traversal, wrong name and unexpected paths are refused', async () => {
  const { root, dir, outside } = sandbox();
  await assert.rejects(ok(outside, dir), /outside the spill directory/);
  await assert.rejects(ok(`${dir}/../outside-synthetic.txt`, dir), /not normalized/);
  await assert.rejects(ok('relative/receipt.txt', dir), /not absolute/);
  const sub = join(dir, 'sub'); mkdirSync(sub); writeFileSync(join(sub, 'r.txt'), 'x');
  await assert.rejects(ok(join(sub, 'r.txt'), dir), /outside the spill directory/);
  const p = join(dir, 'receipt-b1-a.txt'); writeFileSync(p, 'x', { mode: 0o600 });
  await assert.rejects(ok(p, dir, { expected: join(dir, 'receipt-b1-b.txt') }), /not the one Kingmaker asked for/);
  await assert.rejects(readSpillFile(p, {}), /no spill directory/);
  assert.ok(root);
});

test('spill: symlinks, hard links, FIFOs, oversize, non-UTF-8 and a loose directory are refused', async () => {
  const { root, dir, outside } = sandbox();
  const link = join(dir, 'receipt-b2-link.txt'); symlinkSync(outside, link);
  await assert.rejects(ok(link, dir), /symlink/);
  const hard = join(dir, 'receipt-b2-hard.txt'); linkSync(outside, hard);
  await assert.rejects(ok(hard, dir), /hard links/);
  const fifo = join(dir, 'receipt-b2-fifo.txt'); execFileSync('/usr/bin/mkfifo', [fifo]);
  await assert.rejects(ok(fifo, dir), /not a regular file/);
  const big = join(dir, 'receipt-b2-big.txt'); writeFileSync(big, 'x'.repeat(2048));
  await assert.rejects(ok(big, dir, { maxBytes: 1024 }), /exceeds 1024 bytes/);
  const bin = join(dir, 'receipt-b2-bin.txt'); writeFileSync(bin, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(ok(bin, dir), /UTF-8/);
  const loose = createSpillDir(root); chmodSync(loose, 0o755); const lp = join(loose, 'r.txt'); writeFileSync(lp, 'x');
  await assert.rejects(ok(lp, loose), /private directory/);
  const linkedDir = join(root, 'dir-link'); symlinkSync(dir, linkedDir);
  await assert.rejects(ok(join(linkedDir, 'receipt-b23-1.txt'), linkedDir), /private directory|outside/);
});

test('spill race: file swapped for a symlink after the path checks, before open → refused', async () => {
  const { dir, outside } = sandbox();
  const p = join(dir, 'receipt-b3-race.txt'); writeFileSync(p, 'legit', { mode: 0o600 });
  await assert.rejects(ok(p, dir, { _beforeOpen: async (q) => { unlinkSync(q); symlinkSync(outside, q); } }), /symlink/);
});

test('spill race: path swapped AFTER open cannot redirect the read (descriptor is read, not the path)', async () => {
  const { dir, outside } = sandbox();
  const p = join(dir, 'receipt-b4-race.txt'); writeFileSync(p, 'legit-content', { mode: 0o600 });
  let swapped = false;
  const text = await readSpillFile(p, { dir, _afterOpen: async (q) => { unlinkSync(q); symlinkSync(outside, q); swapped = true; } });
  assert.equal(swapped, true);
  assert.equal(text, 'legit-content');
});

test('receipt(): Kingmaker names the spill file, reads it, removes it; a different path from the engine is refused', async () => {
  const { dir, outside } = sandbox();
  const body = 'original messages '.repeat(1000);
  let asked = null;
  const honest = { call: async (name, args) => { asked = args; writeFileSync(args.toFile, body, { mode: 0o600 }); return `[Block b23 content — 80 item(s), full]\nContent (${body.length} chars) written to: ${args.toFile}\nUse the read tool to access it.`; } };
  const r = await createFoldEvidence({ transport: honest, spillDir: dir }).receipt('b23');
  assert.equal(r.text, body); assert.ok(asked.toFile.startsWith(`${dir}/receipt-b23-`)); assert.equal(existsSync(asked.toFile), false);
  const liar = { call: async () => `[Block b23 content — 1 item(s), full]\nContent (10 chars) written to: ${outside}\nUse the read tool.` };
  await assert.rejects(createFoldEvidence({ transport: liar, spillDir: dir }).receipt('b23'), /SPILL|spill read refused/);
  await assert.rejects(createFoldEvidence({ transport: liar }).receipt('b23'), /no spill directory configured/);
  const inline = { call: async () => 'short inline original' };
  assert.equal((await createFoldEvidence({ transport: inline }).receipt('b7')).text, 'short inline original');
  await assert.rejects(createFoldEvidence({ transport: inline }).receipt('../etc'), /blockId/);
  assert.throws(() => createFoldEvidence({ transport: inline, spillDir: 'relative' }), /spillDir/);
});

test('owner-voice speaker sidecar is spawned with only its model variables (no canary)', withCanaries(async () => {
  const { createSpeakerBridgeFactory } = await import('../lib/owner-voice.mjs');
  let seen = null;
  const fake = { stdin: { on() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
  const make = createSpeakerBridgeFactory({ executable: '/synthetic/speaker', model: '/synthetic/model', exists: () => true, attachSpeakerSidecar: () => ({}), spawnImpl: (cmd, args, opts) => { seen = opts.env; return fake; } });
  try { make(); } catch { /* the fake process is minimal; only the spawn options matter */ }
  assert.ok(seen, 'spawn was called');
  assert.deepEqual(leaks(seen), []);
  assert.equal(seen.SOLOMON_SPEAKER_MODEL, '/synthetic/model');
}));
