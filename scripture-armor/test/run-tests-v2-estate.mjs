#!/usr/bin/env node
// run-tests-v2-estate.mjs — Closure 4 acceptance battery (SPEC §4.7,
// checks 1–14) plus the Phase-3 extras: a third peer enrolling
// mid-stream, sync repairing lost registrations in both directions
// (want-in-response and fulfill_request), untrust, and a peer 25 h
// stale under the DEFAULT 24 h bound.
//
// Harness: multiple identity stores + daemons on ONE host, mesh
// listeners bound to loopback — the same code path as tailnet binding.
// What this battery does NOT prove (named, per SPEC §4.7): WireGuard
// itself (platform-provided transport), a live multi-machine tailnet,
// and Tier-2/HARD-cell behavior across the estate (no KVM here).
// A TCP proxy tees the alpha→bravo mesh traffic so check 9 can prove
// no key material crosses by scanning the actual bytes.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadIdentity, signPayload, meshRpc, fingerprintOfRaw,
  ownerSocketFor, ownerTokenPathFor,
} from '../armor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const NODE = process.execPath;

let passed = 0, failed = 0, blocked = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fpOf = (x) => fingerprintOfRaw(Buffer.from(x, 'base64url'));

function run(file, args, { input = null, env = {}, cwd = ROOT } = {}) {
  const r = spawnSync(file, args, { input, env: { ...process.env, ...env }, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const armor = (args, opts) => run(NODE, [ARMOR, ...args], opts);
const vaultd = (args, opts) => run(NODE, [VAULTD, ...args], opts);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const BLOCKS = new Map();
function publicBlockOf(dir) {
  if (BLOCKS.has(dir)) return BLOCKS.get(dir);
  const r = armor(['identity', '--identity-dir', dir]);
  const block = r.out.trim();
  if (block.length > 40) { BLOCKS.set(dir, block); return block; }
  return null;
}
function mkStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sa2e-${label}-`));
  const r = armor(['identity', '--label', label, '--identity-dir', dir]);
  if (r.code !== 0) throw new Error(`identity ${label}: ${r.err}`);
  const block = r.out.trim();
  if (block.length > 40) BLOCKS.set(dir, block);
  return dir;
}
function trust(storeDir, label, otherDir, meshAddr = null) {
  const args = ['trust', label, publicBlockOf(otherDir), '--identity-dir', storeDir];
  if (meshAddr) args.push('--mesh', meshAddr);
  const r = armor(args);
  if (r.code !== 0) throw new Error(`trust ${label}: ${r.err}`);
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
function saveRegistry(storeDir, reg) {
  fs.writeFileSync(path.join(storeDir, 'registry.json'), JSON.stringify(reg, null, 2), { mode: 0o600 });
}
function vaultLog(storeDir) {
  try { return fs.readFileSync(path.join(storeDir, 'vaultd.log'), 'utf8'); } catch { return ''; }
}
function estateStatus(storeDir, socket) {
  return ownerRpc(socket, { cmd: 'estate-status' });
}
async function startDaemon(storeDir, { mesh = false } = {}) {
  const socket = path.join(storeDir, 'vaultd.sock');
  const proc = spawn(NODE, [VAULTD, 'serve', '--identity-dir', storeDir, '--approval-window-ms', '120000'], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`daemon start timeout: ${out}`)), 20000);
    proc.stdout.on('data', (d) => {
      out += d;
      if (out.includes('vaultd listening') && (!mesh || out.includes('mesh listening'))) {
        clearTimeout(to); resolve();
      }
    });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`daemon exited ${c}: ${out}`)); });
  });
  return { proc, socket, storeDir };
}
async function stopDaemon(d) {
  if (!d || d.proc.exitCode !== null) return;
  d.proc.kill('SIGTERM');
  await new Promise((r) => { d.proc.on('exit', r); setTimeout(r, 5000); });
}
function rpcOnce(socket, obj, timeoutMs = 20000) {
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
// Phase 4 (FIX 1): owner acts (approve, revoke, mesh-sync,
// estate-status) ride the owner socket with the daemon's token.
function ownerRpc(socket, obj, timeoutMs = 20000) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(path.dirname(socket)), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(path.dirname(socket)), { ...obj, owner_token: token }, timeoutMs);
}
// Streaming unwrap: pends, the test approves on a second connection,
// resolves with every message the presenting connection received.
function presentAndApprove(socket, pkgPath, { approve = true } = {}) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = '';
    const msgs = [];
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'unwrap', path: pkgPath }) + '\n'));
    conn.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'pending-approval' && approve) {
          await ownerRpc(socket, { cmd: 'approve', id: m.id });
        }
        if (m.state === 'unwrapped' || m.ok === false) { try { conn.end(); } catch {} resolve(msgs); }
      }
    });
    conn.on('error', () => resolve(msgs));
    setTimeout(() => { try { conn.destroy(); } catch {} resolve(msgs); }, 30000);
  });
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2e-work-'));
  const writePayload = (name, text) => {
    const p = path.join(work, name);
    fs.writeFileSync(p, text);
    return p;
  };

  const Aport = await freePort();
  const Bport = await freePort();
  const proxyPort = await freePort();
  const Cport = await freePort();
  const Eport = await freePort();

  const A = mkStore('alpha');
  const B = mkStore('bravo');
  const C = mkStore('charlie');
  const D = mkStore('delta');
  const E = mkStore('echo');
  const F = mkStore('foxtrot');
  const X = mkStore('xray');
  const idA = loadIdentity(A);
  const idB = loadIdentity(B);
  const idC = loadIdentity(C);
  const idE = loadIdentity(E);
  const idX = loadIdentity(X);

  writePolicy(A, { estate: { mesh_listen: `127.0.0.1:${Aport}`, tier3: [{ label: 'iphone-witness', note: "the owner's phone" }] } });
  writePolicy(B, { estate: { mesh_listen: `127.0.0.1:${Bport}` } });
  writePolicy(C, { estate: { mesh_listen: `127.0.0.1:${Cport}` } });
  writePolicy(E, { estate: { mesh_listen: `127.0.0.1:${Eport}`, revocation_max_stale: 3 } });

  // TCP tee proxy (its OWN process — spawnSync blocks this process's
  // event loop, so an in-process proxy would freeze mid-exchange):
  // alpha's mesh traffic to bravo flows through it and every byte in
  // both directions lands in the capture file for check 9.
  const captureFile = path.join(work, 'mesh-capture.bin');
  const proxy = spawn(NODE, [path.join(HERE, 'mesh-tee.mjs'), String(proxyPort), String(Bport), captureFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('tee start timeout')), 10000);
    proxy.stdout.on('data', (d) => { if (String(d).includes('tee')) { clearTimeout(to); resolve(); } });
    proxy.on('exit', (c) => { clearTimeout(to); reject(new Error(`tee exited ${c}`)); });
  });

  // Mutual trust A <-> B (the ceremony's owner acts, SPEC §4.3 steps
  // 2-3). Alpha reaches bravo's daemon via the proxy; bravo reaches
  // alpha directly.
  trust(A, 'bravo', B, `127.0.0.1:${proxyPort}`);
  trust(B, 'alpha', A, `127.0.0.1:${Aport}`);

  let dA = await startDaemon(A, { mesh: true });
  let dB = await startDaemon(B, { mesh: true });
  let dC = null; let dE = null; let dF = null;

  try {
    // ---- mesh status RPC (§4.2) --------------------------------------
    {
      const doc = signPayload(idA, { type: 'status', to_seal_fp: idB.sealFp, body: {} });
      const resp = await meshRpc(`127.0.0.1:${Bport}`, doc);
      check('estate: mesh status RPC — signed view of members/tiers/last-sync from a peer daemon',
        !!resp && resp.body?.ok === true && resp.body.self?.sign_fp === idB.signFp
        && Array.isArray(resp.body.members),
        JSON.stringify(resp?.body ?? resp).slice(0, 200));
    }

    // ---- check 1: enrollment ceremony --------------------------------
    {
      const outDir = path.join(work, 'enroll-b');
      const r = armor(['enroll', 'bravo', '--out-dir', outDir, '--identity-dir', A]);
      const [descPath, probePath] = r.out.trim().split('\n').map((s) => s.trim());
      check('estate[1a]: enroll seals a descriptor + probe package for the new endpoint',
        r.code === 0 && fs.existsSync(descPath) && fs.existsSync(probePath), r.err.slice(0, 200));
      const stPending = await estateStatus(A, dA.socket);
      const mPending = stPending.members.find((m) => m.sign_fp === idB.signFp);
      check('estate[2a]: before the proof lands, the enrolling endpoint lists the member as pending (status names it)',
        mPending && mPending.state === 'pending', JSON.stringify(mPending));
      // The descriptor approval at bravo's daemon is the act of joining.
      const descMsgs = await presentAndApprove(dB.socket, descPath);
      const descFinal = descMsgs[descMsgs.length - 1];
      const descPend = descMsgs.find((m) => m.state === 'pending-approval');
      check('estate[1b]: descriptor package return-matches at the new daemon (cross-registered over mesh) and unwraps on owner approval',
        descPend?.registry_status === 'issued-by-this-machine' && descFinal?.state === 'unwrapped',
        JSON.stringify(descMsgs).slice(0, 300));
      const bView = await estateStatus(B, dB.socket);
      check('estate[1c]: descriptor opening installs the roster at the new endpoint (members + mesh host + Tier-3 named)',
        bView.members.some((m) => m.sign_fp === idA.signFp)
        && bView.tier3.some((t) => t.label === 'iphone-witness' && t.keys === false),
        JSON.stringify(bView).slice(0, 300));
      // The probe round-trip is the proof.
      const probeMsgs = await presentAndApprove(dB.socket, probePath);
      const probeFinal = probeMsgs[probeMsgs.length - 1];
      check('estate[1d]: probe package return-matches and unwraps at the new daemon',
        probeFinal?.state === 'unwrapped', JSON.stringify(probeMsgs).slice(0, 200));
      check('estate[1e]: the new endpoint logs enroll-verified for the probe',
        vaultLog(B).includes('"enroll-verified"') && !!probeFinal?.canary
        && vaultLog(B).includes(probeFinal.canary));
      // Bravo reports the proof back over sync; alpha verifies its side.
      const syncRes = await ownerRpc(dB.socket, { cmd: 'mesh-sync', to: 'alpha' });
      const stAfter = await estateStatus(A, dA.socket);
      const mAfter = stAfter.members.find((m) => m.sign_fp === idB.signFp);
      check('estate[1f]: after the proof is reported over sync, BOTH endpoints have logged enroll-verified and the member is verified',
        syncRes.ok === true && mAfter?.state === 'verified'
        && vaultLog(A).includes('"enroll-verified"'),
        JSON.stringify({ syncRes, mAfter }).slice(0, 300));
      // Alpha syncs back over the proxy too (traffic for check 9).
      await ownerRpc(dA.socket, { cmd: 'mesh-sync', to: 'bravo' });
      // Stash the descriptor plaintext path for check 11.
      main.descOut = descFinal.out;
    }

    // ---- check 9: no key material crosses -----------------------------
    {
      const capText = fs.readFileSync(captureFile, 'utf8');
      const idAJson = JSON.parse(fs.readFileSync(path.join(A, 'identity.json'), 'utf8'));
      const idBJson = JSON.parse(fs.readFileSync(path.join(B, 'identity.json'), 'utf8'));
      const leaks = [idAJson.seal_priv, idAJson.sign_priv, idBJson.seal_priv, idBJson.sign_priv]
        .filter((v) => v && capText.includes(v));
      check('estate[9]: a capture of the enrollment + sync exchanges carries no identity.json contents and no private key fields',
        capText.includes('"type":"register"') && capText.length > 2000
        && leaks.length === 0
        && !capText.includes('seal_priv') && !capText.includes('sign_priv')
        && !capText.includes('identity.json'),
        `capture ${capText.length} bytes, leaks ${leaks.length}`);
    }

    // ---- check 3: cross-endpoint package ------------------------------
    let payload1Path;
    {
      const src = writePayload('payload1.txt', 'estate payload one — the loop crosses machines now.\n');
      payload1Path = `${src}.scripture`;
      const w = armor(['wrap', src, '--to', 'bravo', '--identity-dir', A], { cwd: work });
      const msgs = await presentAndApprove(dB.socket, payload1Path);
      const fin = msgs[msgs.length - 1];
      const identical = fin?.state === 'unwrapped'
        && fs.readFileSync(fin.out).equals(fs.readFileSync(src));
      check('estate[3]: package wrapped on A to B, registered over mesh, return-matches and unwraps at B byte-identical',
        w.code === 0 && identical, JSON.stringify(msgs).slice(0, 250));
    }

    // ---- check 4: offline queueing on the mesh transport --------------
    {
      await stopDaemon(dB);
      const src = writePayload('payload2.txt', 'queued while bravo was away.\n');
      const w = armor(['wrap', src, '--to', 'bravo', '--identity-dir', A], { cwd: work });
      const outboxFile = path.join(A, 'registry-outbox.jsonl');
      const queued = fs.existsSync(outboxFile)
        && fs.readFileSync(outboxFile, 'utf8').includes(idB.sealFp);
      check('estate[4a]: with B down at wrap time, the issuance queues in A\'s outbox (v1 semantics, new transport)',
        w.code === 0 && queued && w.err.includes('queued'), w.err.slice(0, 200));
      dB = await startDaemon(B, { mesh: true });
      const flush = armor(['register', '--to', 'bravo', '--identity-dir', A], { cwd: work });
      const msgs = await presentAndApprove(dB.socket, `${src}.scripture`);
      const fin = msgs[msgs.length - 1];
      check('estate[4b]: on B\'s return the queue syncs (register --to) and the package unwraps at B',
        flush.code === 0 && fin?.state === 'unwrapped'
        && fs.readFileSync(fin.out).equals(fs.readFileSync(src)),
        JSON.stringify({ flushErr: flush.err.slice(0, 150), fin }).slice(0, 300));
    }

    // ---- check 5: the signature gate ----------------------------------
    {
      const unsigned = {
        mesh: 1, type: 'register', from_label: 'alpha', from_sign_fp: idA.signFp,
        from_seal_fp: idA.sealFp, from_sign_pub: idA.sign_pub, to_seal_fp: idB.sealFp,
        at: new Date().toISOString(), nonce: crypto.randomUUID(), body: { entries: [] },
      };
      const r1 = await meshRpc(`127.0.0.1:${Bport}`, unsigned);
      const tampered = signPayload(idA, { type: 'register', to_seal_fp: idB.sealFp, body: { entries: [] } });
      tampered.body = { entries: [{ canary: 'x' }] };
      const r2 = await meshRpc(`127.0.0.1:${Bport}`, tampered);
      const fromX = signPayload(idX, { type: 'register', to_seal_fp: idB.sealFp, body: { entries: [] } });
      const r3 = await meshRpc(`127.0.0.1:${Bport}`, fromX);
      const log = vaultLog(B);
      check('estate[5]: unsigned and wrongly-signed mesh RPCs are refused and logged; a mesh register from an untrusted fingerprint is refused',
        r1?.body?.error === 'bad-signature' && r2?.body?.error === 'bad-signature'
        && r3?.body?.error === 'untrusted-sender'
        && log.includes('refused: bad-signature') && log.includes('refused: untrusted-sender'),
        JSON.stringify({ r1: r1?.body, r2: r2?.body, r3: r3?.body }).slice(0, 300));
    }

    // ---- check 10: opening is never a mesh act -------------------------
    {
      const errs = [];
      for (const type of ['unwrap', 'approve', 'activate']) {
        const doc = signPayload(idA, { type, to_seal_fp: idB.sealFp, body: {} });
        const resp = await meshRpc(`127.0.0.1:${Bport}`, doc);
        errs.push(resp?.body?.error || '');
      }
      check('estate[10]: unwrap/approve/activate are not mesh-callable — RPC attempts on the mesh listener are refused unknown-command',
        errs.every((e) => e.startsWith('unknown-command'))
        && vaultLog(B).includes('refused: unknown-command'),
        errs.join(' | '));
    }

    // ---- check 6: the listener binds only the configured address -------
    {
      // Darwin does not necessarily route an unconfigured 127.0.0.2 alias.
      // Probe only an address actually assigned to this same host, never a third party.
      const ownOtherAddress = Object.values(os.networkInterfaces()).flat().find(address => address && !address.internal && address.family === 'IPv4')?.address || '127.0.0.2';
      const onOther = await new Promise((resolve) => {
        const c = net.connect(Bport, ownOtherAddress);
        c.on('connect', () => { c.destroy(); resolve(false); });
        c.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? true : null));
        setTimeout(() => { try { c.destroy(); } catch {} resolve(null); }, 3000);
      });
      const onConfigured = await new Promise((resolve) => {
        const c = net.connect(Bport, '127.0.0.1');
        c.on('connect', () => { c.destroy(); resolve(true); });
        c.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      });
      if (onOther !== null) {
        check('estate[6]: the mesh listener binds only the configured address — connections on other local interfaces are refused',
          onOther === true && onConfigured === true,
          `other-refused=${onOther} configured-accepts=${onConfigured}`);
      } else {
        blocked++; console.log('BLOCKED estate[6] alternate-loopback refusal: route timed out or unavailable; this is not proof of connection acceptance or rejection.');
        if (fs.existsSync('/usr/sbin/lsof')) {
          const bound = run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(dB.proc.pid), `-iTCP:${Bport}`, '-sTCP:LISTEN', '-Fn']);
          const names = bound.out.split('\n').filter(line => line.startsWith('n'));
          check('estate[6] actual OS socket metadata binds only the configured loopback and that endpoint accepts',
            onConfigured === true && bound.code === 0 && names.length === 1 && names[0] === `n127.0.0.1:${Bport}`,
            `configured-accepts=${onConfigured}; socket names=${names.join(',')}`);
        } else { blocked++; console.log('BLOCKED estate[6] OS socket metadata: lsof unavailable.'); }
      }
    }

    // ---- check 11: Tier-3 conformance ----------------------------------
    {
      const desc = JSON.parse(fs.readFileSync(main.descOut, 'utf8'));
      const t3 = (desc.tier3 || []).find((t) => t.label === 'iphone-witness');
      const dnsDir = path.join(ROOT, 'dns-profiles');
      const dnsFiles = fs.readdirSync(dnsDir).filter((f) => fs.statSync(path.join(dnsDir, f)).isFile());
      const dnsOk = dnsFiles.length >= 5 && dnsFiles.every((f) =>
        fs.readFileSync(path.join(dnsDir, f), 'utf8').includes('example-loop.invalid'));
      // Provably cannot open: no key material for the device exists in
      // the descriptor, in either endpoint's address book, or as an
      // identity store anywhere — there is nothing to open WITH.
      const bookA = JSON.parse(fs.readFileSync(path.join(A, 'addressbook.json'), 'utf8'));
      const bookB = JSON.parse(fs.readFileSync(path.join(B, 'addressbook.json'), 'utf8'));
      const noKeysAnywhere = !!t3 && t3.tier === 3 && t3.keys === false && t3.can_open === false
        && !('seal_pub' in t3) && !('sign_pub' in t3)
        && !('iphone-witness' in bookA) && !('iphone-witness' in bookB)
        && !fs.existsSync(path.join(os.tmpdir(), 'iphone-witness-identity'));
      check('estate[11]: Tier-3 — dns-profiles templates keep their placeholders, and the estate descriptor lists the posture device at Tier 3 with no keys (it provably cannot open: no key material for it exists anywhere)',
        dnsOk && noKeysAnywhere && !JSON.stringify(desc).includes('seal_priv'),
        JSON.stringify(t3));
    }

    // ---- check 12: Tier-0 presentation ---------------------------------
    {
      trust(X, 'bravo', B, `127.0.0.1:${Bport}`);
      const src = writePayload('payload-x.txt', 'from an unenrolled identity.\n');
      const w = armor(['wrap', src, '--to', 'bravo', '--identity-dir', X], { cwd: work });
      const msgs = await presentAndApprove(dB.socket, `${src}.scripture`, { approve: false });
      const fin = msgs[msgs.length - 1];
      const logB = vaultLog(B);
      check('estate[12]: Tier-0 — a package from an unenrolled identity is refused registration (untrusted-sender) and is never-issued at the estate daemon',
        w.code !== 0 && w.err.includes('untrusted-sender')
        && fin?.beacon === true && fin?.reason_class === 'never-issued'
        && logB.includes('"reason_class":"never-issued"'),
        JSON.stringify({ code: w.code, fin }).slice(0, 300));
    }

    // ---- check 13: forged registry claim surfaces at sync ---------------
    let forgedCanary;
    {
      forgedCanary = crypto.randomUUID();
      const reg = registryOf(B);
      reg.entries[forgedCanary] = {
        canary: forgedCanary, sha256: 'ab'.repeat(32),
        recipient_seal_fp: idB.sealFp, sender_sign_fp: idA.signFp,
        expiry: null, issued_at: new Date().toISOString(), returned_at: null,
        origin: 'egress', scan: null, tier: null, repo: null,
        report_for: null, report_only: false, superseded_by: null,
        anomaly: null, estate: null, quarantined: null, grants: null,
        activations: [], lease: null, candidate: false,
      };
      saveRegistry(B, reg);
      const syncRes = await ownerRpc(dA.socket, { cmd: 'mesh-sync', to: 'bravo' });
      const logA = vaultLog(A);
      const logB = vaultLog(B);
      const aIssued = fs.readFileSync(path.join(A, 'issued-log.jsonl'), 'utf8');
      check('estate[13]: a forged registry claim on B for a canary A never issued surfaces at sync as a conflict, logged on BOTH sides, and does not overwrite A\'s record',
        syncRes.ok === true
        && (syncRes.conflicts || []).some((c) => c.canary === forgedCanary)
        && logA.includes(forgedCanary) && logB.includes('"sync-conflict"') && logB.includes(forgedCanary)
        && !(forgedCanary in registryOf(A).entries) && !aIssued.includes(forgedCanary)
        && forgedCanary in registryOf(B).entries,
        JSON.stringify(syncRes).slice(0, 300));
    }

    // ---- extra: sync repairs lost registrations, both directions --------
    {
      // (i) A issued to B; B's registry loses the entry; A initiates —
      // B's want rides the response and A fulfills it with a register.
      const srcR = writePayload('payload-r.txt', 'lost and repaired (want path).\n');
      armor(['wrap', srcR, '--to', 'bravo', '--identity-dir', A], { cwd: work });
      const pkgR = `${srcR}.scripture`;
      const frameR = JSON.parse(fs.readFileSync(pkgR, 'utf8').split('\n')[1]);
      const regB1 = registryOf(B);
      delete regB1.entries[frameR.canary];
      saveRegistry(B, regB1);
      const lostMsgs = await presentAndApprove(dB.socket, pkgR, { approve: false });
      const syncRes = await ownerRpc(dA.socket, { cmd: 'mesh-sync', to: 'bravo' });
      const repaired = registryOf(B).entries[frameR.canary]?.digest === (frameR.commit ?? frameR.sha256);
      const openMsgs = await presentAndApprove(dB.socket, pkgR);
      const finR = openMsgs[openMsgs.length - 1];
      // (ii) B issued to A; A's registry loses the entry; B initiates —
      // B's own want (from the response view) triggers fulfill_request.
      const srcU = writePayload('payload-u.txt', 'lost and repaired (fulfill path).\n');
      armor(['wrap', srcU, '--to', 'alpha', '--identity-dir', B], { cwd: work });
      const pkgU = `${srcU}.scripture`;
      const frameU = JSON.parse(fs.readFileSync(pkgU, 'utf8').split('\n')[1]);
      const regA1 = registryOf(A);
      delete regA1.entries[frameU.canary];
      saveRegistry(A, regA1);
      const syncRes2 = await ownerRpc(dB.socket, { cmd: 'mesh-sync', to: 'alpha' });
      const repaired2 = registryOf(A).entries[frameU.canary]?.digest === (frameU.commit ?? frameU.sha256);
      const openMsgs2 = await presentAndApprove(dA.socket, pkgU);
      const finU = openMsgs2[openMsgs2.length - 1];
      check('estate[X1]: sync repairs a lost registration in both directions (want-in-response and fulfill_request); the lost package is never-issued until repaired, then opens',
        lostMsgs[lostMsgs.length - 1]?.reason_class === 'never-issued'
        && syncRes.ok === true && repaired && finR?.state === 'unwrapped'
        && syncRes2.ok === true && repaired2 && finU?.state === 'unwrapped',
        JSON.stringify({ syncRes, syncRes2 }).slice(0, 300));
    }

    // ---- checks 2 + 15: a third peer enrolls mid-stream ------------------
    {
      trust(A, 'charlie', C, `127.0.0.1:${Cport}`);
      trust(C, 'alpha', A, `127.0.0.1:${Aport}`);
      trust(B, 'charlie', C, `127.0.0.1:${Cport}`);
      trust(C, 'bravo', B, `127.0.0.1:${Bport}`);
      dC = await startDaemon(C, { mesh: true });
      const outDir = path.join(work, 'enroll-c');
      const r = armor(['enroll', 'charlie', '--out-dir', outDir, '--identity-dir', A]);
      const [descPath, probePath] = r.out.trim().split('\n').map((s) => s.trim());
      const stPending = await estateStatus(A, dA.socket);
      const mPending = stPending.members.find((m) => m.sign_fp === idC.signFp);
      check('estate[2]: enrollment without the probe proof does not add the member — descriptor state shows pending, status names it',
        r.code === 0 && mPending?.state === 'pending', JSON.stringify(mPending));
      await presentAndApprove(dC.socket, descPath);
      await presentAndApprove(dC.socket, probePath);
      await ownerRpc(dC.socket, { cmd: 'mesh-sync', to: 'alpha' });
      const stAfter = await estateStatus(A, dA.socket);
      const mAfter = stAfter.members.find((m) => m.sign_fp === idC.signFp);
      const src = writePayload('payload-c.txt', 'for the mid-stream joiner.\n');
      armor(['wrap', src, '--to', 'charlie', '--identity-dir', A], { cwd: work });
      const msgs = await presentAndApprove(dC.socket, `${src}.scripture`);
      const fin = msgs[msgs.length - 1];
      check('estate[15]: a third peer enrolls MID-STREAM (estate already live) and is fully operational — verified membership + cross-endpoint package opens',
        mAfter?.state === 'verified' && fin?.state === 'unwrapped'
        && fs.readFileSync(fin.out).equals(fs.readFileSync(src)),
        JSON.stringify({ mAfter, fin }).slice(0, 300));
    }

    // ---- extra: untrust --------------------------------------------------
    {
      trust(A, 'delta', D);
      trust(D, 'alpha', A, `127.0.0.1:${Aport}`);
      const u = armor(['untrust', 'delta', '--identity-dir', A]);
      const bookA = JSON.parse(fs.readFileSync(path.join(A, 'addressbook.json'), 'utf8'));
      const idD = loadIdentity(D);
      const doc = signPayload(idD, { type: 'status', to_seal_fp: idA.sealFp, body: {} });
      const resp = await meshRpc(`127.0.0.1:${Aport}`, doc);
      const events = fs.readFileSync(path.join(A, 'estate-events.jsonl'), 'utf8');
      check('estate[X2]: untrust removes the address-book entry (logged), and the untrusted peer\'s mesh RPCs are refused from then on',
        u.code === 0 && !('delta' in bookA) && events.includes('"untrust"')
        && resp?.body?.error === 'untrusted-sender',
        JSON.stringify(resp?.body ?? resp).slice(0, 200));
    }

    // ---- check 7: revocation, all three branches --------------------------
    {
      // A pre-revocation package: issued + registered at B BEFORE any
      // revocation exists. It is presented only after the revocation.
      const srcPre = writePayload('pkg-pre.txt', 'issued before the fall.\n');
      armor(['wrap', srcPre, '--to', 'bravo', '--identity-dir', A], { cwd: work });
      // Bravo goes down; charlie's owner revokes alpha. Distribution
      // to bravo fails (it is down) — the record is revocation-pending.
      await stopDaemon(dB);
      const revRes = await ownerRpc(dC.socket, { cmd: 'revoke', label: 'alpha', reason: 'battery: simulated compromise' });
      const recId = revRes.record?.id;
      const cView1 = await estateStatus(C, dC.socket);
      const bMember1 = cView1.members.find((m) => m.sign_fp === idB.signFp);
      check('estate[7a]: revocation distributes over the mesh; an unreachable member shows as revocation-pending in status until it acks',
        revRes.ok === true && (revRes.revocation_pending || []).includes('bravo')
        && Array.isArray(bMember1?.revocation_pending) && bMember1.revocation_pending.includes(recId),
        JSON.stringify({ revRes, bMember1 }).slice(0, 300));
      // Bravo returns; alpha issues a NEW package (after the revocation
      // instant) and registers it at bravo — bravo has not yet received
      // the record, so the registration lands.
      dB = await startDaemon(B, { mesh: true });
      const srcPost = writePayload('pkg-post.txt', 'issued after the fall, registered before the news arrived.\n');
      const wPost = armor(['wrap', srcPost, '--to', 'bravo', '--identity-dir', A], { cwd: work });
      // The news arrives: bravo syncs with charlie and merges the record.
      const syncRes = await ownerRpc(dB.socket, { cmd: 'mesh-sync', to: 'charlie' });
      // One more exchange: bravo's revocation_ids list now names the
      // record, which is what clears charlie's revocation-pending mark
      // (acks converge from the holding list, not from hope).
      await ownerRpc(dB.socket, { cmd: 'mesh-sync', to: 'charlie' });
      const cView2 = await estateStatus(C, dC.socket);
      const bMember2 = cView2.members.find((m) => m.sign_fp === idB.signFp);
      // Branch 1: the post-revocation-dated package beacon-refuses.
      const postMsgs = await presentAndApprove(dB.socket, `${srcPost}.scripture`, { approve: false });
      const postFin = postMsgs[postMsgs.length - 1];
      // Branch 2: the pre-revocation package still returns, with the
      // REVOKED SENDER fact in the approval prompt.
      const preMsgs = await presentAndApprove(dB.socket, `${srcPre}.scripture`);
      const prePend = preMsgs.find((m) => m.state === 'pending-approval');
      const preFin = preMsgs[preMsgs.length - 1];
      // Branch 3: new registrations from the revoked fingerprint refuse.
      const srcNew = writePayload('pkg-new.txt', 'must never register.\n');
      const wNew = armor(['wrap', srcNew, '--to', 'bravo', '--identity-dir', A], { cwd: work });
      const logB = vaultLog(B);
      check('estate[7]: revocation — post-revocation-dated package beacon-refuses revoked-sender; pre-revocation package still returns with REVOKED SENDER in the prompt; new registrations from the revoked fp are refused (register-revoked); acks clear the pending mark',
        wPost.code === 0 && syncRes.ok === true
        && (bMember2?.revocation_pending || []).length === 0
        && postFin?.beacon === true && postFin?.reason_class === 'revoked-sender'
        && (prePend?.notices || []).some((n) => n.includes('REVOKED SENDER'))
        && preFin?.state === 'unwrapped'
        && wNew.code !== 0 && wNew.err.includes('register-revoked')
        && logB.includes('register-revoked'),
        JSON.stringify({ postFin, preFin, wNewErr: wNew.err.slice(0, 160) }).slice(0, 400));
    }

    // ---- check 8: revocation staleness ------------------------------------
    {
      trust(A, 'echo', E, `127.0.0.1:${Eport}`);
      trust(E, 'alpha', A, `127.0.0.1:${Aport}`);
      dE = await startDaemon(E, { mesh: true });
      // A completed sync makes echo fresh; a registration lands.
      await ownerRpc(dA.socket, { cmd: 'mesh-sync', to: 'echo' });
      const src1 = writePayload('to-echo-1.txt', 'fresh window.\n');
      const w1 = armor(['wrap', src1, '--to', 'echo', '--identity-dir', A], { cwd: work });
      // Past revocation_max_stale (3 s here) with no new sync: stale.
      await sleep(3600);
      const src2 = writePayload('to-echo-2.txt', 'stale window.\n');
      const w2 = armor(['wrap', src2, '--to', 'echo', '--identity-dir', A], { cwd: work });
      // Local traffic is unaffected by mesh staleness.
      trust(E, 'echo', E);
      const srcLocal = writePayload('echo-local.txt', 'local traffic.\n');
      const wLocal = armor(['wrap', srcLocal, '--to', 'echo', '--identity-dir', E], { cwd: work });
      const localMsgs = await presentAndApprove(dE.socket, `${srcLocal}.scripture`);
      const localFin = localMsgs[localMsgs.length - 1];
      // A sync cures the staleness; registrations land again.
      await ownerRpc(dE.socket, { cmd: 'mesh-sync', to: 'alpha' });
      const src3 = writePayload('to-echo-3.txt', 'after resync.\n');
      const w3 = armor(['wrap', src3, '--to', 'echo', '--identity-dir', A], { cwd: work });
      const regE = registryOf(E);
      const landed = [src1, src3].every((s) => {
        const f = JSON.parse(fs.readFileSync(`${s}.scripture`, 'utf8').split('\n')[1]);
        return f.canary in regE.entries;
      });
      check('estate[8]: an endpoint past revocation_max_stale refuses new mesh registrations as estate-stale until it syncs; local traffic unaffected',
        w1.code === 0 && w2.code !== 0 && w2.err.includes('estate-stale')
        && wLocal.code === 0 && localFin?.state === 'unwrapped'
        && w3.code === 0 && landed,
        JSON.stringify({ w2err: w2.err.slice(0, 160), localFin }).slice(0, 300));

      // The task's literal case: 25 h stale under the DEFAULT 24 h bound.
      await stopDaemon(dE);
      writePolicy(E, { estate: { mesh_listen: `127.0.0.1:${Eport}` } });
      const stE = JSON.parse(fs.readFileSync(path.join(E, 'estate.json'), 'utf8'));
      stE.last_sync_any = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
      fs.writeFileSync(path.join(E, 'estate.json'), JSON.stringify(stE, null, 2), { mode: 0o600 });
      dE = await startDaemon(E, { mesh: true });
      const srcOld = writePayload('to-echo-old.txt', 'a day stale.\n');
      const wOld = armor(['wrap', srcOld, '--to', 'echo', '--identity-dir', A], { cwd: work });
      check('estate[X3]: a peer whose last sync is 25 h old refuses mesh registrations under the default 24 h revocation_max_stale bound',
        wOld.code !== 0 && wOld.err.includes('estate-stale'), wOld.err.slice(0, 200));
    }

    // ---- check 14 (in-battery part): no estate policy = v1 behavior -------
    {
      dF = await startDaemon(F, { mesh: false });
      const st = await rpcOnce(dF.socket, { cmd: 'status' });
      trust(F, 'foxtrot', F);
      const src = writePayload('foxtrot-local.txt', 'no estate here.\n');
      const w = armor(['wrap', src, '--to', 'foxtrot', '--identity-dir', F], { cwd: work });
      const msgs = await presentAndApprove(dF.socket, `${src}.scripture`);
      const fin = msgs[msgs.length - 1];
      check('estate[14]: a daemon with no estate policy configured exposes no estate surface and behaves as v1 (self round-trip intact); the full v1 suite is the regression gate (run separately)',
        st.ok === true && !('estate' in st)
        && w.code === 0 && fin?.state === 'unwrapped',
        JSON.stringify(st).slice(0, 200));
    }
  } finally {
    await stopDaemon(dA); await stopDaemon(dB); await stopDaemon(dC);
    await stopDaemon(dE); await stopDaemon(dF);
    try { proxy.kill('SIGTERM'); } catch {}
  }

  console.log(`\n==== Closure 4 battery: ${passed} passed, ${failed} failed, ${blocked} platform observations blocked ====`);
  if (failures.length) console.log(`failed: ${failures.join('; ')}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(`battery error: ${e.stack || e}`); process.exitCode = 1; });
