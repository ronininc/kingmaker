#!/usr/bin/env node
// run-tests-v2-airlock.mjs — Closure 3 acceptance battery (SPEC §3.6)
// plus the Addendum A.3 case (Strip Outside Influence Unless Requested):
// no dock = no crossing surface at all; an owner-opened dock is the
// request, inbound executables are scanned in the chamber before they
// cross, and every exception is logged request/verdict/outcome.
//
// The airlock child is a separate process per session holding no keys
// and no store path; case 12 proves that from the outside (cmdline,
// environ, session-dir contents).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadIdentity, parseScriptureFile, ownerSocketFor, ownerTokenPathFor } from '../armor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const NODE = process.execPath;
const GHIDRA_HOME = path.join(os.homedir(), 'workspace', 'tools', 'ghidra');
const JDK21 = path.join(os.homedir(), 'workspace', 'tools', 'jdk-21');

let passed = 0, failed = 0, blocked = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(file, args, { input = null, env = {}, cwd = ROOT } = {}) {
  const r = spawnSync(file, args, { input, env: { ...process.env, ...env }, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const armor = (args, opts) => run(NODE, [ARMOR, ...args], opts);

const BLOCKS = new Map();
function publicBlockOf(dir) {
  if (BLOCKS.has(dir)) return BLOCKS.get(dir);
  const r = armor(['identity', '--identity-dir', dir]);
  const block = r.out.trim();
  if (block.length > 40) { BLOCKS.set(dir, block); return block; }
  return null;
}
function mkStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sa2a-${label}-`));
  const r = armor(['identity', '--label', label, '--identity-dir', dir]);
  if (r.code !== 0) throw new Error(`identity ${label}: ${r.err}`);
  const block = r.out.trim();
  if (block.length > 40) BLOCKS.set(dir, block);
  return dir;
}
function trustSelf(storeDir) {
  const me = loadIdentity(storeDir);
  const block = publicBlockOf(storeDir);
  const r = armor(['trust', me.label, block, '--identity-dir', storeDir]);
  if (r.code !== 0) throw new Error(`self-trust: ${r.err}`);
}
function writePolicy(storeDir, policy) {
  // The keyless airlock child inherits only PATH: pass reviewed engine paths through its scan policy.
  policy = { ...policy, scan: { ghidra_home: process.env.SCRIPTURE_GHIDRA_HOME || null, jdk_home: process.env.JAVA_HOME || null, ...(policy.scan || {}) } };
  fs.writeFileSync(path.join(storeDir, 'policy.json'), JSON.stringify(policy, null, 2), { mode: 0o600 });
}
function registryOf(storeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(storeDir, 'registry.json'), 'utf8')); }
  catch { return { entries: {} }; }
}
function vaultLog(storeDir) {
  try { return fs.readFileSync(path.join(storeDir, 'vaultd.log'), 'utf8'); } catch { return ''; }
}
function airlockRecords(storeDir) {
  try {
    return fs.readFileSync(path.join(storeDir, 'airlock.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
async function waitAirlock(storeDir, pred, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const hit = airlockRecords(storeDir).find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(250);
  }
}

async function startDaemon(storeDir) {
  const socket = path.join(storeDir, 'vaultd.sock');
  const proc = spawn(NODE, [VAULTD, 'serve', '--identity-dir', storeDir, '--approval-window-ms', '120000'], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`daemon start timeout: ${out}`)), 15000);
    proc.stdout.on('data', (d) => { out += d; if (out.includes('listening')) { clearTimeout(to); resolve(); } });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`daemon exited ${c}: ${out}`)); });
  });
  return { proc, socket, storeDir };
}
function rpcOnce(socket, obj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(obj) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { conn.end(); } catch {} resolve(JSON.parse(buf.slice(0, i))); }
    });
    conn.on('error', reject);
    setTimeout(() => { try { conn.destroy(); } catch {} reject(new Error('rpc timeout')); }, timeoutMs);
  });
}
// Streaming dock-open: resolves .opened with the session-open message.
function dockOpenStream(socket, profile) {
  const msgs = [];
  let openedResolve; const opened = new Promise((r) => { openedResolve = r; });
  let pendingResolve; const pending = new Promise((r) => { pendingResolve = r; });
  const conn = net.createConnection(socket);
  let buf = '';
  conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'dock-open', profile }) + '\n'));
  conn.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line); msgs.push(m);
      if (m.state === 'pending-approval') pendingResolve(m);
      if (m.state === 'session-open') { openedResolve(m); try { conn.end(); } catch {} }
      if (m.ok === false) { openedResolve(m); try { conn.end(); } catch {} }
    }
  });
  conn.on('error', () => {});
  return { pending, opened, msgs, conn };
}
// Phase 4 (FIX 1): approvals are owner acts (owner socket + token).
function ownerRpc(socket, obj) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(path.dirname(socket)), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(path.dirname(socket)), { ...obj, owner_token: token });
}
async function openSession(socket, profile) {
  const s = dockOpenStream(socket, profile);
  const pend = await s.pending;
  await ownerRpc(socket, { cmd: 'approve', id: pend.id });
  const opened = await s.opened;
  return { pend, opened, session: opened.session, socketPath: opened.socket, dir: path.dirname(opened.socket || '') };
}
// A scripted peer: connects to peer.sock, performs the actions in a
// JSON file ([{sendFile|sendB64|sendText, delayMs, partialThenDie}]),
// and logs every received frame (sha256 + receipt time) to a log file.
const PEER_SRC = `
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
const [sock, actionsPath, logPath] = process.argv.slice(2);
const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
const log = (o) => fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...o }) + '\\n');
const conn = net.connect(sock);
let buf = Buffer.alloc(0);
conn.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) return;
    const payload = Buffer.from(buf.subarray(4, 4 + len));
    buf = buf.subarray(4 + len);
    log({ recv_sha256: crypto.createHash('sha256').update(payload).digest('hex'), recv_bytes: payload.length, recv_b64: payload.toString('base64') });
  }
});
conn.on('error', (e) => log({ error: e.message }));
conn.on('close', () => log({ closed: true }));
const frame = (payload) => { const h = Buffer.alloc(4); h.writeUInt32BE(payload.length, 0); return Buffer.concat([h, payload]); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
conn.on('connect', async () => {
  log({ connected: true });
  for (const a of actions) {
    if (a.delayMs) await sleep(a.delayMs);
    if (a.partialThenDie) { conn.write(Buffer.from([0, 0])); conn.destroy(); return; }
    let payload = null;
    if (a.sendFile) payload = fs.readFileSync(a.sendFile);
    else if (a.sendText) payload = Buffer.from(a.sendText, 'utf8');
    else if (a.sendBytes) payload = Buffer.alloc(a.sendBytes, 65);
    if (payload) conn.write(frame(payload));
  }
});
setTimeout(() => process.exit(0), actions.lifetimeMs || 30000);
`;
function startPeer(T, name, socketPath, actions) {
  const actionsPath = path.join(T, `${name}-actions.json`);
  const logPath = path.join(T, `${name}-peer.log`);
  fs.writeFileSync(actionsPath, JSON.stringify(actions));
  const proc = spawn(NODE, [path.join(T, 'peer.mjs'), socketPath, actionsPath, logPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { proc, logPath };
}
function peerLog(logPath) {
  try { return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
async function waitPeer(logPath, pred, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const hit = peerLog(logPath).find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(200);
  }
}
const BASE_POLICY = (extra = {}) => ({
  // No tool pins: scan.mjs auto-detects Ghidra/JDK under
  // ~/workspace/tools; a set-but-wrong pin fails closed (Phase 1 rule).
  scan: {},
  airlock: {
    max_message_bytes: 65536, max_session_bytes: 262144, max_messages: 1000,
    idle_s: 120, max_violations: 3,
    profiles: {
      echo: { classes: ['text', 'data', 'source', 'binary'] },
      plaincode: { classes: ['text', 'data', 'source', 'binary'], plaintext_code: true },
      textonly: { classes: ['text', 'data'] },
    },
    ...extra,
  },
});

async function main() {
  console.log('Scripture Armor v2 — Closure 3 acceptance battery');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2a-battery-'));
  fs.writeFileSync(path.join(T, 'peer.mjs'), PEER_SRC);
  const BIN = path.join(T, 'bin'); fs.mkdirSync(BIN);
  const gcc = run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', path.join(BIN, 'bad.bin'), path.join(HERE, 'fixtures-src', 'bad.c')]);
  if (gcc.code !== 0) throw new Error(`gcc fixture build failed: ${gcc.err}`);
  const badBin = path.join(BIN, 'bad.bin');
  // The warn-verdict subject for the A.3 exception case: a source file
  // with a high pattern (dynamic-code) — verdict warn, tier 1. The
  // Tier-2 subject is bad.bin wrapped under a signed override.
  const warnSrc = path.join(T, 'warn-src.mjs');
  fs.writeFileSync(warnSrc, 'console.log("warn subject", eval("6*7"));\n');

  const A = mkStore('airlock-host');
  trustSelf(A);
  writePolicy(A, BASE_POLICY());
  const dA = await startDaemon(A);
  const airlockRoot = path.join(os.tmpdir(), 'sa-airlocks');
  const sessionsBefore = fs.existsSync(airlockRoot) ? fs.readdirSync(airlockRoot).length : 0;

  // ============ Case A3/1: no dock ⇒ no surface; dock-open pends ======
  console.log('\n[A3+1] Strip Outside Influence: with no dock open there is no crossing surface; dock-open pends and shows the profile');
  {
    check('no session sockets exist before any dock opens',
      (fs.existsSync(airlockRoot) ? fs.readdirSync(airlockRoot).length : 0) === sessionsBefore);
    const s = dockOpenStream(dA.socket, 'echo');
    const pend = await s.pending;
    check('dock-open pends for the owner', !!pend && pend.state === 'pending-approval');
    check('the pend shows the profile classes', (pend?.notices || []).some((n) => /content classes allowed inbound/.test(n)),
      JSON.stringify(pend?.notices || []).slice(0, 200));
    check('the pend declares the plaintext-code posture in plain words',
      (pend?.notices || []).some((n) => /travel as \.scripture packages, never plaintext code/.test(n)));
    await sleep(600);
    check('an UNAPPROVED dock creates no socket and no session dir',
      (fs.existsSync(airlockRoot) ? fs.readdirSync(airlockRoot).length : 0) === sessionsBefore);
    await ownerRpc(dA.socket, { cmd: 'approve', id: pend.id });
    const opened = await s.opened;
    check('approval opens the session', opened?.state === 'session-open' && !!opened.socket, JSON.stringify(opened).slice(0, 200));
    check('the peer socket now exists', !!opened.socket && fs.existsSync(opened.socket));
    var S1 = { session: opened.session, socketPath: opened.socket, dir: path.dirname(opened.socket) }; // eslint-disable-line no-var
    const openRec = await waitAirlock(A, (r) => r.event === 'open' && r.session === S1.session);
    check('the open is recorded (the owner request, on the record)', !!openRec && openRec.chamber === 'dir (degraded)',
      JSON.stringify(openRec));
  }

  // ============ Case 3 (IN text) + chamber wipe ========================
  console.log('\n[3] IN text arrives inside ONLY as a registered airlock-in package; no plaintext in shell dirs; chamber wiped');
  {
    const peer = startPeer(T, 'p3', S1.socketPath, [{ sendText: 'hello airlock', lifetimeMs: 15000 }]);
    const rec = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === S1.session && r.dir === 'in');
    check('inbound crossing recorded with a canary', !!rec && !!rec.canary, JSON.stringify(rec));
    check('crossing sha256 matches the sent bytes', rec?.sha256 === sha256Hex(Buffer.from('hello airlock', 'utf8')));
    const entry = rec ? registryOf(A).entries[rec.canary] : null;
    check('registered with origin airlock-in', entry?.origin === 'airlock-in', JSON.stringify(entry).slice(0, 150));
    check('the package exists under inbound/', !!rec && fs.existsSync(path.join(A, 'inbound', `${rec.canary}.scripture`)));
    let leak = false;
    const needle = Buffer.from('hello airlock', 'utf8');
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && fs.readFileSync(p).includes(needle)) leak = p;
      }
    };
    walk(A);
    check('the plaintext appears in NO file inside the shell store', leak === false, String(leak));
    await sleep(400);
    check('chamber wiped after the crossing', fs.readdirSync(path.join(S1.dir, 'chamber')).length === 0,
      fs.readdirSync(path.join(S1.dir, 'chamber')).join(','));
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 2: OUT recorded BEFORE delivery ===================
  console.log('\n[2] OUT crossing: the record (with sha256) is written BEFORE the peer receives the bytes');
  {
    const payload = Buffer.from('out-payload-42', 'utf8');
    const f = path.join(T, 'out42.txt');
    fs.writeFileSync(f, payload);
    // Wait for session 1 to be closed by its peer's death, then open a
    // fresh session with a listening peer.
    await waitAirlock(A, (r) => r.event === 'close' && r.session === S1.session, 20000);
    const S2 = await openSession(dA.socket, 'echo');
    const peer = startPeer(T, 'p2', S2.socketPath, [{ lifetimeMs: 20000 }]);
    await waitPeer(peer.logPath, (l) => l.connected);
    const before = airlockRecords(A).length;
    const sendRes = await rpcOnce(dA.socket, { cmd: 'dock-send', session: S2.session, path: f });
    check('dock-send reports delivered', sendRes?.delivered === true, JSON.stringify(sendRes));
    const got = await waitPeer(peer.logPath, (l) => l.recv_sha256 === sha256Hex(payload));
    check('peer received byte-identical payload', !!got);
    const recs = airlockRecords(A).slice(before);
    const rec = recs.find((r) => r.event === 'crossing' && r.dir === 'out' && r.session === S2.session);
    check('OUT crossing record exists with the delivered sha256', !!rec && rec.sha256 === sha256Hex(payload));
    check('record timestamp precedes the peer receipt', !!rec && !!got && Date.parse(rec.ts) <= got.ts + 5,
      `rec=${rec?.ts} peer=${got?.ts}`);
    var S2keep = S2; // eslint-disable-line no-var
    var peer2 = peer; // eslint-disable-line no-var
  }

  // ============ Case 7: program OUT — wrapped by default ==============
  console.log('\n[7] a program handed OUT crosses as a .scripture package by default; plaintext only under a declared profile');
  {
    const prog = path.join(T, 'prog-out.mjs');
    fs.writeFileSync(prog, 'console.log("crossing program");\n');
    const progBytes = fs.readFileSync(prog);
    const r1 = await rpcOnce(dA.socket, { cmd: 'dock-send', session: S2keep.session, path: prog });
    check('program dock-send delivered (wrapped)', r1?.delivered === true, JSON.stringify(r1));
    const got1 = await waitPeer(peer2.logPath, (l) => l.recv_b64 && Buffer.from(l.recv_b64, 'base64').toString('utf8').startsWith('SCRIPTURE-ARMOR'));
    check('peer received a .scripture package, not plaintext code', !!got1);
    const recOut = airlockRecords(A).filter((r) => r.event === 'crossing' && r.dir === 'out').pop();
    check('the record notes program_wrapped', recOut?.program_wrapped === true, JSON.stringify(recOut));
    // Plaintext-code profile: the same file crosses as itself.
    const S3 = await openSession(dA.socket, 'plaincode');
    const peer3 = startPeer(T, 'p7', S3.socketPath, [{ lifetimeMs: 20000 }]);
    await waitPeer(peer3.logPath, (l) => l.connected);
    const r2 = await rpcOnce(dA.socket, { cmd: 'dock-send', session: S3.session, path: prog });
    check('plaintext-profile dock-send delivered', r2?.delivered === true, JSON.stringify(r2));
    const got2 = await waitPeer(peer3.logPath, (l) => l.recv_sha256 === sha256Hex(progBytes));
    check('under the declared profile the peer receives byte-identical plaintext code', !!got2);
    await rpcOnce(dA.socket, { cmd: 'dock-close', session: S3.session });
    peer3.proc.kill('SIGKILL');
  }

  // ============ Case 8: airlock-in ⇒ full activation gates =============
  console.log('\n[8] an airlock-in package faces Closure 2 unchanged: arrival is custody, not trust');
  {
    // A session dies with its peer, so this case opens its OWN session
    // (S2's peer had a 20s lifetime and is gone by now).
    const S8 = await openSession(dA.socket, 'echo');
    const srcText = fs.readFileSync(path.join(HERE, 'fixtures-cell', 'tierprobe.mjs'), 'utf8');
    const peer = startPeer(T, 'p8', S8.socketPath, [{ sendText: srcText, lifetimeMs: 25000 }]);
    const rec = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === S8.session && r.dir === 'in' && r.canary
      && registryOf(A).entries[r.canary]?.origin === 'airlock-in'
      && registryOf(A).entries[r.canary]?.scan?.verdict === 'pass', 60000);
    check('source crossed IN as an airlock-in package (scanned first)', !!rec, JSON.stringify(rec));
    if (rec) {
      const pkgPath = path.join(A, 'inbound', `${rec.canary}.scripture`);
      const act = await rpcOnce(dA.socket, { cmd: 'activate', path: pkgPath }).catch((e) => ({ ok: false, error: e.message }));
      // activate streams; rpcOnce returns the FIRST message — a refusal.
      check('activation of an airlock-in package is refused (not-activatable)',
        act?.ok === false && /not-activatable/.test(act?.error || ''), JSON.stringify(act).slice(0, 200));
    } else {
      check('activation of an airlock-in package is refused (not-activatable)', false, 'no crossing to activate');
    }
    peer.proc.kill('SIGKILL');
    peer2.proc.kill('SIGKILL');
  }

  // ============ Case 4: critical binary IN ⇒ quarantine + close =======
  console.log('\n[4] IN critical binary: refused at the scan gate, sealed into quarantine, beacon fires, session closes on first strike');
  {
    const S4 = await openSession(dA.socket, 'echo');
    const peer = startPeer(T, 'p4', S4.socketPath, [{ sendFile: badBin, lifetimeMs: 25000 }]);
    const rec = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === S4.session && r.verdict === 'critical', 180000);
    check('critical crossing recorded with verdict critical', !!rec, JSON.stringify(rec));
    check('record carries the airlock-scan reason class', rec?.reason_class === 'airlock-scan');
    const entry = rec ? registryOf(A).entries[rec.canary] : null;
    check('custody bytes registered as QUARANTINED', !!entry?.quarantined, JSON.stringify(entry).slice(0, 200));
    check('sealed package held under quarantine/', !!rec && fs.existsSync(path.join(A, 'quarantine', `${rec.canary}.scripture`)));
    check('quarantined bytes never entered inbound/', !!rec && !fs.existsSync(path.join(A, 'inbound', `${rec.canary}.scripture`)));
    const close = await waitAirlock(A, (r) => r.event === 'close' && r.session === S4.session, 30000);
    check('session closed on first strike (violations-scan)', close?.reason === 'violations-scan', JSON.stringify(close));
    check('beacon testified in the daemon log', /"event":\s*"beacon".*airlock-scan/.test(vaultLog(A)));
    const st = await rpcOnce(dA.socket, { cmd: 'status' });
    check('daemon healthy throughout', st?.ok === true);
    peer.proc.kill('SIGKILL');
  }

  // ============ Case A3x: requested exception, scanned, logged ========
  console.log('\n[A3] owner-requested exception: a warn-verdict binary crosses only after the chamber scan; request/verdict/outcome all logged');
  {
    const S5 = await openSession(dA.socket, 'echo');
    const peer = startPeer(T, 'p5', S5.socketPath, [{ sendFile: warnSrc, lifetimeMs: 25000 }]);
    const rec = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === S5.session && r.dir === 'in' && !!r.canary, 180000);
    check('warn binary crossed IN after scanning', !!rec, JSON.stringify(rec));
    check('the crossing record carries the scan verdict (warn)', rec?.verdict === 'warn', rec?.verdict);
    const entry = rec ? registryOf(A).entries[rec.canary] : null;
    check('outcome registered: airlock-in entry with the warn scan block',
      entry?.origin === 'airlock-in' && entry?.scan?.verdict === 'warn', JSON.stringify(entry?.scan));
    check('the request itself is on the record (session open event)',
      airlockRecords(A).some((r) => r.event === 'open' && r.session === S5.session));
    await rpcOnce(dA.socket, { cmd: 'dock-close', session: S5.session });
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 5: violation ladder ==============================
  console.log('\n[5] oversize: violations 1–2 drop and the session survives; the third closes it; the shell is untouched');
  {
    const S6 = await openSession(dA.socket, 'echo');
    const big = 70000; // policy max_message_bytes is 65536
    const peer = startPeer(T, 'p6', S6.socketPath, [
      { sendBytes: big }, { delayMs: 700, sendBytes: big }, { delayMs: 700, sendText: 'still-alive' },
      { delayMs: 700, sendBytes: big }, { lifetimeMs: 20000 },
    ]);
    const v1 = await waitAirlock(A, (r) => r.event === 'violation' && r.session === S6.session && r.reason_class === 'airlock-oversize');
    check('first oversize dropped + recorded as a violation', !!v1);
    const alive = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === S6.session && r.dir === 'in', 30000);
    check('session survives violations 1–2 (a valid crossing still lands)', !!alive);
    const close = await waitAirlock(A, (r) => r.event === 'close' && r.session === S6.session, 30000);
    check('third violation closes the session', close?.reason === 'violations', JSON.stringify(close));
    const st = await rpcOnce(dA.socket, { cmd: 'status' });
    check('daemon status healthy after the ladder', st?.ok === true);
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 6: peer dies mid-frame ============================
  console.log('\n[6] peer killed mid-frame ⇒ partial discarded, closed: peer-gone, nothing crossed');
  {
    const S7 = await openSession(dA.socket, 'echo');
    const before = airlockRecords(A).filter((r) => r.session === S7.session && r.event === 'crossing').length;
    const peer = startPeer(T, 'p7x', S7.socketPath, [{ partialThenDie: true, lifetimeMs: 10000 }]);
    const close = await waitAirlock(A, (r) => r.event === 'close' && r.session === S7.session, 30000);
    check('session closed as peer-gone', close?.reason === 'peer-gone', JSON.stringify(close));
    const after = airlockRecords(A).filter((r) => r.session === S7.session && r.event === 'crossing').length;
    check('the partial frame crossed nothing', after === before, `before=${before} after=${after}`);
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 10: budget exhaustion is a clean close ============
  console.log('\n[10] session byte budget exhausted ⇒ clean close (budget), no violation, no beacon');
  {
    const polNow = JSON.parse(fs.readFileSync(path.join(A, 'policy.json'), 'utf8'));
    polNow.airlock.max_session_bytes = 100;
    writePolicy(A, polNow);
    const S8 = await openSession(dA.socket, 'echo');
    const logBefore = vaultLog(A).length;
    const peer = startPeer(T, 'p10', S8.socketPath, [
      { sendBytes: 60 }, { delayMs: 800, sendBytes: 60 }, { lifetimeMs: 15000 },
    ]);
    const close = await waitAirlock(A, (r) => r.event === 'close' && r.session === S8.session, 30000);
    check('budget exhaustion closes the session cleanly', close?.reason === 'budget', JSON.stringify(close));
    check('no violation recorded for the budget close',
      !airlockRecords(A).some((r) => r.session === S8.session && r.event === 'violation'));
    check('no beacon fired for the budget close', !/beacon/.test(vaultLog(A).slice(logBefore)));
    writePolicy(A, BASE_POLICY());
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 11: Tier-2 session violation ⇒ anomaly ===========
  console.log('\n[11] a violation in a session serving a Tier-2 program sets that program\'s anomaly');
  {
    const w = armor(['wrap', badBin, '--to', 'airlock-host', '--socket', dA.socket, '--identity-dir', A, '--override-scan', 'battery: tier-2 anomaly subject, owner-accepted'], { input: 'OVERRIDE\n' });
    check('bad.bin wraps under override (tier 2)', w.code === 0, w.err.slice(0, 200));
    // Phase 4 (FIX 3): entries carry no plaintext hash — find this
    // case's issuance by its package's frame canary.
    const rec = registryOf(A).entries[parseScriptureFile(fs.readFileSync(`${badBin}.scripture`, 'utf8')).frame.canary];
    check('tier-2 entry present', rec?.tier?.tier === 2, JSON.stringify(rec?.tier).slice(0, 150));
    const polNow = JSON.parse(fs.readFileSync(path.join(A, 'policy.json'), 'utf8'));
    polNow.airlock.profiles.t2dock = { classes: ['text', 'data', 'source', 'binary'], serves: rec.canary };
    writePolicy(A, polNow);
    const S9 = await openSession(dA.socket, 't2dock');
    const peer = startPeer(T, 'p11', S9.socketPath, [{ sendBytes: 70000, lifetimeMs: 15000 }]);
    const v = await waitAirlock(A, (r) => r.event === 'violation' && r.session === S9.session, 30000);
    check('violation recorded in the serving session', !!v);
    await sleep(500);
    const after = registryOf(A).entries[rec.canary];
    check('the Tier-2 program now carries an anomaly', !!after?.anomaly, JSON.stringify(after?.anomaly));
    await rpcOnce(dA.socket, { cmd: 'dock-close', session: S9.session });
    writePolicy(A, BASE_POLICY());
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 9: kill -9 the airlock mid-session ================
  console.log('\n[9] airlock process killed -9 mid-session ⇒ daemon survives, registry + pendings intact, other session unaffected');
  {
    const SA = await openSession(dA.socket, 'echo');
    const SB = await openSession(dA.socket, 'echo');
    const pidOut = run('pgrep', ['-f', `airlock.mjs serve --session-dir ${SA.dir}`]);
    const childPid = Number((pidOut.out || '').trim().split('\n')[0]);
    check('airlock child process found', Number.isFinite(childPid) && childPid > 0, pidOut.out);
    const regBefore = Object.keys(registryOf(A).entries).length;
    process.kill(childPid, 'SIGKILL');
    const close = await waitAirlock(A, (r) => r.event === 'close' && r.session === SA.session, 30000);
    check('the killed session closes as airlock-fault', close?.reason === 'airlock-fault', JSON.stringify(close));
    check('incident testified in the daemon log', /airlock-fault/.test(vaultLog(A)));
    const st = await rpcOnce(dA.socket, { cmd: 'status' });
    check('daemon alive and answering', st?.ok === true);
    check('registry intact (same issuance count)', Object.keys(registryOf(A).entries).length === regBefore);
    // The other session still crosses.
    const peer = startPeer(T, 'p9', SB.socketPath, [{ sendText: 'unaffected', lifetimeMs: 15000 }]);
    const rec = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === SB.session && r.dir === 'in', 30000);
    check('the other session is unaffected and still crosses', !!rec && !!rec.canary);
    await rpcOnce(dA.socket, { cmd: 'dock-close', session: SB.session });
    peer.proc.kill('SIGKILL');
  }

  // ============ Case 12: the airlock holds no keys =====================
  console.log('\n[12] the airlock process holds no keys: no store path in cmdline/environ, no identity material in its session dir');
  {
    const SX = await openSession(dA.socket, 'echo');
    const pidOut = run('pgrep', ['-f', `airlock.mjs serve --session-dir ${SX.dir}`]);
    const childPid = Number((pidOut.out || '').trim().split('\n')[0]);
    check('child found for inspection', Number.isFinite(childPid) && childPid > 0);
    if (fs.existsSync(`/proc/${childPid}/environ`) && fs.existsSync(`/proc/${childPid}/cmdline`)) {
    let environ = '';
    try { environ = fs.readFileSync(`/proc/${childPid}/environ`, 'utf8'); } catch {}
    check('child environ contains NO reference to the daemon store', !environ.includes(A), 'unexpected daemon-store reference');
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${childPid}/cmdline`, 'utf8'); } catch {}
    check('child cmdline names only the session dir (never the store)', cmdline.includes(SX.dir) && !cmdline.includes(A));
    } else if (process.platform === 'darwin') {
      // Inspect only this synthetic keyless child (its spawn environment is PATH + HOME).
      // Missing evidence stays BLOCKED; never treat an empty OS read as proof.
      const cmd = run('/bin/ps', ['-ww', '-p', String(childPid), '-o', 'command=']);
      const env = run('/bin/ps', ['eww', '-p', String(childPid), '-o', 'command=']);
      if (cmd.code === 0 && cmd.out.includes(SX.dir)) check('native Mac child command line names only its session, not the daemon store', !cmd.out.includes(A));
      else { blocked++; console.log('BLOCKED: native Mac child command-line evidence unavailable.'); }
      if (env.code === 0 && env.out.includes(`HOME=${SX.dir}`) && env.out.includes('PATH=')) check('native Mac keyless child environment contains no daemon-store reference', !env.out.includes(A));
      else { blocked++; console.log('BLOCKED: native Mac child environment evidence unavailable.'); }
    } else { blocked += 2; console.log('BLOCKED: /proc environment and command-line evidence unavailable on this host; no empty-read PASS.'); }
    const names = [];
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); names.push(n); if (fs.lstatSync(p).isDirectory()) walk(p); } };
    walk(SX.dir);
    check('no identity.json / registry.json anywhere in the session dir',
      !names.some((n) => n === 'identity.json' || n === 'registry.json'), names.join(','));
    const cfg = fs.readFileSync(path.join(SX.dir, 'config.json'), 'utf8');
    check('session config carries no store path', !cfg.includes(A));
    await rpcOnce(dA.socket, { cmd: 'dock-close', session: SX.session });
  }

  try { dA.proc.kill('SIGTERM'); } catch {}
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(blocked ? `RUNNABLE AIRLOCK CHECKS PASSED; ${blocked} platform observations BLOCKED` : 'ALL AIRLOCK BATTERY CHECKS PASSED');
  }
}

main().catch((e) => { console.error('battery error:', e); process.exitCode = 1; });
