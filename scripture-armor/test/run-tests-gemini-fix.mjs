#!/usr/bin/env node
// run-tests-gemini-fix.mjs — acceptance battery for the Gemini-review
// fix pass (2026-10-25). One test per fix:
//
//   1. outbox desync recovery — a package whose issuance died in the
//      sender's offline outbox beacons never-issued (testimony
//      unchanged), is recorded as a recovery candidate, and ONLY the
//      owner's approval derives + registers the issuance from the
//      package itself and opens it. A tampered package earns no
//      candidate.
//   2. socket budgets — a connection flood on the requester socket
//      is shed-and-counted while the owner channel still answers.
//   3. registry cache — an external registry edit is seen via mtime
//      invalidation without a daemon restart; re-registration heals.
//   4. RESTORE-INFO one-shot burn — a tampered sidecar refuses the
//      restore BEFORE the manifest's return is spent; fixing the
//      sidecar and re-running restores byte-for-byte.
//   5. store integrity — identity.json / addressbook.json /
//      registry.json tampering fails closed with the precise
//      store-integrity error; routing fields sit outside the
//      address book's tag by design.
//   6. migration — pre-tag stores gain their tags in place with
//      fingerprints, trust, and contents untouched.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  loadIdentity, loadAddressBook, ownerSocketFor, ownerTokenPathFor,
} from '../armor.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const NODE = process.execPath;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(file, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}
const armor = (args) => run(NODE, [ARMOR, ...args]);
const vaultd = (args) => run(NODE, [VAULTD, ...args]);

function rpcOnce(socket, obj, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = '';
    const done = (v) => { try { conn.destroy(); } catch {} resolve(v); };
    conn.on('connect', () => conn.write(JSON.stringify(obj) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); } }
    });
    conn.on('error', () => done(null));
    conn.on('close', () => done(null));
    setTimeout(() => done(null), timeoutMs);
  });
}
function ownerRpc(socket, obj, timeoutMs = 8000) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(socket), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(socket), { ...obj, owner_token: token }, timeoutMs);
}
// Present a package and collect every daemon message (no approvals).
function present(socket, pkgPath, outName = null) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    const msgs = [];
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'unwrap', path: pkgPath, out: outName }) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'unwrapped' || m.ok === false) { try { conn.end(); } catch {} resolve(msgs); return; }
      }
    });
    conn.on('error', () => resolve(msgs));
    setTimeout(() => { try { conn.destroy(); } catch {} resolve(msgs); }, 15000);
  });
}
async function approveUntilDone(child, sockArgs) {
  const seen = new Set();
  let exited = false;
  child.on('exit', () => { exited = true; });
  while (!exited) {
    const p = await vaultd(['pending', ...sockArgs]);
    try {
      const msg = JSON.parse(p.stdout.trim().split('\n').pop());
      for (const entry of msg.pending || []) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          await vaultd(['approve', '--id', entry.id, ...sockArgs]);
        }
      }
    } catch {}
    await sleep(120);
  }
}
async function startDaemon(sockPath, outDir, idDir, windowMs = '30000') {
  const proc = spawn(NODE, [VAULTD, 'serve', '--identity-dir', idDir, '--socket', sockPath,
    '--out-dir', outDir, '--approval-window-ms', String(windowMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const args = ['--socket', sockPath, '--identity-dir', idDir];
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(150);
    if (fs.existsSync(sockPath)) {
      const st = await vaultd(['status', ...args]);
      up = st.code === 0 && st.stdout.includes('"ok":true');
    }
  }
  return { proc, args, up };
}
async function stopDaemon(handle) {
  if (!handle || !handle.proc) return;
  const exited = new Promise((r) => handle.proc.on('exit', r));
  handle.proc.kill('SIGTERM');
  await Promise.race([exited, sleep(3000)]);
}
const registryOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
const frameOf = (pkg) => JSON.parse(fs.readFileSync(pkg, 'utf8').split('\n')[1]);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-gemini-'));
  const idA = path.join(tmp, 'idA');
  const idB = path.join(tmp, 'idB');
  const sockB = path.join(tmp, 'b.sock');
  const outB = path.join(tmp, 'outB');
  fs.mkdirSync(outB, { recursive: true });

  // ---- pairing: A and B, mutual trust --------------------------------
  const blkA = (await armor(['identity', '--label', 'vault-a', '--identity-dir', idA])).stdout.trim();
  const blkB = (await armor(['identity', '--label', 'vault-b', '--identity-dir', idB])).stdout.trim();
  await armor(['trust', 'vault-b', blkB, '--identity-dir', idA, '--daemon-socket', sockB]);
  await armor(['trust', 'vault-a', blkA, '--identity-dir', idB, '--daemon-socket', path.join(tmp, 'a.sock')]);
  check('setup: paired identities created and trusted', blkA.length > 40 && blkB.length > 40);

  // ================= FIX 1: outbox recovery ==========================
  // Wrap two packages while B's daemon is DOWN: both issuances queue.
  const p1 = path.join(tmp, 'lost-one.txt');
  const d1 = Buffer.from('the package the outbox lost\n');
  fs.writeFileSync(p1, d1);
  const w1 = await armor(['wrap', p1, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sockB]);
  const p2 = path.join(tmp, 'lost-two.txt');
  fs.writeFileSync(p2, 'the tampered twin\n');
  const w2 = await armor(['wrap', p2, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sockB]);
  const outboxFile = path.join(idA, 'registry-outbox.jsonl');
  check('fix1: wraps with the daemon down queue in the outbox',
    w1.code === 0 && w2.code === 0 && fs.existsSync(outboxFile)
    && fs.readFileSync(outboxFile, 'utf8').includes(frameOf(`${p1}.scripture`).canary));
  // The desync: the queue is lost before it ever syncs.
  fs.unlinkSync(outboxFile);
  // Tamper the twin's body: its frame signature no longer verifies.
  {
    const lines = fs.readFileSync(`${p2}.scripture`, 'utf8').split('\n');
    const first = [...lines[2]][0];
    lines[2] = (first === 'A' ? 'B' : 'A') + [...lines[2]].slice(1).join('');
    fs.writeFileSync(`${p2}.scripture`, lines.join('\n'));
  }
  const canary1 = frameOf(`${p1}.scripture`).canary;
  const canary2 = frameOf(`${p2}.scripture`).canary;

  let daemonB = await startDaemon(sockB, outB, idB);
  check('fix1: recipient daemon up', daemonB.up);

  const msgs1 = await present(sockB, `${p1}.scripture`, 'recovered.txt');
  const fin1 = msgs1[msgs1.length - 1];
  check('fix1: unregistered package still beacons never-issued (testimony unchanged)',
    fin1?.beacon === true && fin1?.reason_class === 'never-issued');
  const recList = await ownerRpc(sockB, { cmd: 'recovery' });
  const cand = (recList.recovery_candidates || []).find((c) => c.canary === canary1);
  check('fix1: signature-valid package from an enrolled peer is recorded as a recovery candidate',
    !!cand && recList.recovery_candidates.length === 1, JSON.stringify(recList).slice(0, 200));

  const msgs2 = await present(sockB, `${p2}.scripture`, 'twin.txt');
  const recList2 = await ownerRpc(sockB, { cmd: 'recovery' });
  check('fix1: tampered package (bad frame signature) earns NO recovery candidate',
    msgs2[msgs2.length - 1]?.reason_class === 'never-issued'
    && !(recList2.recovery_candidates || []).some((c) => c.canary === canary2));

  const appr = await vaultd(['approve', '--id', cand.id, '--socket', sockB, '--identity-dir', idB]);
  const recoveredPath = path.join(outB, 'recovered.txt');
  check('fix1: owner approval registers the derived issuance and opens the package',
    appr.stdout.includes('"unwrapped"') && fs.existsSync(recoveredPath)
    && sha(fs.readFileSync(recoveredPath)) === sha(d1),
    appr.stdout.trim().split('\n').pop() || '');
  const regB1 = registryOf(idB);
  check('fix1: registry shows the recovery (registered_via owner-recovery, return consumed)',
    regB1.entries[canary1]?.registered_via === 'owner-recovery' && !!regB1.entries[canary1]?.returned_at);

  // ================= FIX 2: socket budgets ===========================
  const held = [];
  for (let i = 0; i < 70; i++) {
    const c = net.createConnection(sockB);
    c.on('error', () => {});
    held.push(c);
  }
  await sleep(600);
  const stOwner = await ownerRpc(sockB, { cmd: 'status' });
  check('fix2: owner channel still answers during a requester connection flood',
    stOwner?.ok === true);
  check('fix2: flood excess is shed and counted on the owner status',
    (stOwner?.socket_shed?.requester || 0) >= 1, `shed=${stOwner?.socket_shed?.requester}`);
  // Per-connection frame cap: 600 junk lines on one connection.
  const shedBefore = stOwner.socket_shed.requester;
  await new Promise((resolve) => {
    const c = net.createConnection(sockB);
    c.on('error', () => {});
    c.on('connect', () => { for (let i = 0; i < 600; i++) c.write('{"cmd":"status"}\n'); });
    c.on('close', () => resolve());
    setTimeout(() => { try { c.destroy(); } catch {} resolve(); }, 4000);
  });
  for (const c of held) { try { c.destroy(); } catch {} }
  await sleep(300);
  const stOwner2 = await ownerRpc(sockB, { cmd: 'status' });
  check('fix2: per-connection frame flood is shed and counted too',
    (stOwner2?.socket_shed?.requester || 0) > shedBefore,
    `shed ${shedBefore} -> ${stOwner2?.socket_shed?.requester}`);

  // ================= FIX 3: registry cache ===========================
  const p3 = path.join(tmp, 'cached.txt');
  fs.writeFileSync(p3, 'registered, deleted, re-registered\n');
  await armor(['wrap', p3, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sockB]);
  const canary3 = frameOf(`${p3}.scripture`).canary;
  const stA = await ownerRpc(sockB, { cmd: 'status' });
  const regB2 = registryOf(idB);
  delete regB2.entries[canary3];
  fs.writeFileSync(path.join(idB, 'registry.json'), JSON.stringify(regB2, null, 2), { mode: 0o600 });
  const stB = await ownerRpc(sockB, { cmd: 'status' });
  check('fix3: external registry edit is picked up via mtime (no restart, no stale read)',
    stA.registry_issued - stB.registry_issued === 1,
    `issued ${stA.registry_issued} -> ${stB.registry_issued}`);
  await armor(['register', `${p3}.scripture`, '--socket', sockB, '--identity-dir', idA]);
  const stC = await ownerRpc(sockB, { cmd: 'status' });
  check('fix3: re-registration restores the count (and heals the store)',
    stC.registry_issued === stA.registry_issued && stC.registry_integrity === 'ok',
    `issued=${stC.registry_issued} integrity=${stC.registry_integrity}`);

  // ================= FIX 5 (registry): tamper fails closed ===========
  const regB3 = registryOf(idB);
  regB3.entries[canary3].digest = 'ff'.repeat(32);
  fs.writeFileSync(path.join(idB, 'registry.json'), JSON.stringify(regB3, null, 2), { mode: 0o600 });
  const tamperMsgs = await present(sockB, `${p3}.scripture`, 'cached-back.txt');
  const tamperFin = tamperMsgs[tamperMsgs.length - 1];
  const logB = fs.readFileSync(path.join(idB, 'vaultd.log'), 'utf8');
  check('fix5: a tampered registry refuses the presentation with the precise store-integrity error',
    tamperFin?.ok === false && String(tamperFin?.error || '').includes('store-integrity')
    && !fs.existsSync(path.join(outB, 'cached-back.txt')));
  check('fix5: the tamper is testified in the daemon log',
    logB.includes('store-integrity'));
  // Heal for the remaining tests: re-register (signed, owner-trusted path).
  await armor(['register', `${p3}.scripture`, '--socket', sockB, '--identity-dir', idA]);

  // ================= FIX 4: sidecar one-shot burn ====================
  const src = path.join(tmp, 'tree');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'one.txt'), 'first file\n');
  fs.writeFileSync(path.join(src, 'two.txt'), 'second file, a little longer\n');
  fs.writeFileSync(path.join(src, 'three.bin'), Buffer.from([9, 8, 7, 6, 5]));
  const wrapped = path.join(tmp, 'wrapped');
  await armor(['wrap-repo', src, '--to', 'vault-b', '--out', wrapped, '--identity-dir', idA, '--register-socket', sockB]);
  const manifestCanary = frameOf(path.join(wrapped, 'MANIFEST.scripture')).canary;
  const riPath = path.join(wrapped, 'RESTORE-INFO.json');
  const riGood = fs.readFileSync(riPath, 'utf8');
  const ri = JSON.parse(riGood);
  ri.fileCount += 5;
  fs.writeFileSync(riPath, JSON.stringify(ri, null, 2));

  const runUnwrapRepo = async (into) => {
    const child = spawn(NODE, [ARMOR, 'unwrap-repo', wrapped, '--into', into,
      '--socket', sockB, '--daemon-out-dir', outB, '--identity-dir', idB], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const exitP = new Promise((r) => child.on('exit', r));
    await approveUntilDone(child, daemonB.args);
    return { code: await exitP, err };
  };
  const bad = await runUnwrapRepo(path.join(tmp, 'restored-bad'));
  check('fix4: tampered RESTORE-INFO refuses the restore with the scale-mismatch error',
    bad.code !== 0 && bad.err.includes('restore scale mismatch'),
    bad.err.trim().split('\n').pop() || '');
  check('fix4: the refusal did NOT burn the manifest return (returned_at still null)',
    registryOf(idB).entries[manifestCanary]?.returned_at == null);
  fs.writeFileSync(riPath, riGood);
  const good = await runUnwrapRepo(path.join(tmp, 'restored-good'));
  const restoredOk = good.code === 0
    && fs.readFileSync(path.join(tmp, 'restored-good', 'one.txt'), 'utf8') === 'first file\n'
    && fs.readFileSync(path.join(tmp, 'restored-good', 'two.txt'), 'utf8') === 'second file, a little longer\n'
    && sha(fs.readFileSync(path.join(tmp, 'restored-good', 'three.bin'))) === sha(Buffer.from([9, 8, 7, 6, 5]));
  check('fix4: sidecar fixed, retry SUCCEEDS and restores byte-for-byte', restoredOk,
    good.err.trim().split('\n').pop() || '');

  await stopDaemon(daemonB); daemonB = null;

  // ================= FIX 5 (identity + address book) =================
  let threw = null;
  const idDoc = JSON.parse(fs.readFileSync(path.join(idB, 'identity.json'), 'utf8'));
  const origSignPub = idDoc.sign_pub;
  idDoc.sign_pub = (origSignPub[0] === 'A' ? 'B' : 'A') + origSignPub.slice(1);
  fs.writeFileSync(path.join(idB, 'identity.json'), JSON.stringify(idDoc, null, 2), { mode: 0o600 });
  try { loadIdentity(idB); } catch (e) { threw = e; }
  check('fix5: tampered identity.json fails closed on load with the precise error',
    !!threw && threw.message.includes('store-integrity'), threw?.message || 'no throw');
  idDoc.sign_pub = origSignPub;
  idDoc.integrity = undefined;
  delete idDoc.integrity;
  fs.writeFileSync(path.join(idB, 'identity.json'), JSON.stringify(idDoc, null, 2), { mode: 0o600 });

  threw = null;
  const bookB = JSON.parse(fs.readFileSync(path.join(idB, 'addressbook.json'), 'utf8'));
  const peerEntry = bookB['vault-a'];
  const origPeerSign = peerEntry.sign_pub;
  peerEntry.sign_pub = (origPeerSign[0] === 'A' ? 'B' : 'A') + origPeerSign.slice(1);
  fs.writeFileSync(path.join(idB, 'addressbook.json'), JSON.stringify(bookB, null, 2), { mode: 0o600 });
  try { loadAddressBook(idB); } catch (e) { threw = e; }
  check('fix5: swapped peer key in addressbook.json fails closed on load',
    !!threw && threw.message.includes('store-integrity'), threw?.message || 'no throw');
  peerEntry.sign_pub = origPeerSign;
  peerEntry.daemon_socket = '/tmp/somewhere-else.sock';
  fs.writeFileSync(path.join(idB, 'addressbook.json'), JSON.stringify(bookB, null, 2), { mode: 0o600 });
  let routingOk = true;
  try { loadAddressBook(idB); } catch { routingOk = false; }
  check('fix5: routing fields (daemon_socket) sit OUTSIDE the tag by design and load fine',
    routingOk);

  // ================= FIX 6: migration preserves ======================
  const idM = path.join(tmp, 'idM');
  const blkM = (await armor(['identity', '--label', 'vault-m', '--identity-dir', idM])).stdout.trim();
  await armor(['trust', 'vault-b', blkB, '--identity-dir', idM]);
  const before = loadIdentity(idM);
  const bookBefore = JSON.parse(fs.readFileSync(path.join(idM, 'addressbook.json'), 'utf8'));
  // Strip every tag: the store is now exactly a pre-fix legacy store.
  const mDoc = JSON.parse(fs.readFileSync(path.join(idM, 'identity.json'), 'utf8'));
  delete mDoc.integrity;
  fs.writeFileSync(path.join(idM, 'identity.json'), JSON.stringify(mDoc, null, 2), { mode: 0o600 });
  const mBook = JSON.parse(fs.readFileSync(path.join(idM, 'addressbook.json'), 'utf8'));
  delete mBook.__store_integrity__;
  fs.writeFileSync(path.join(idM, 'addressbook.json'), JSON.stringify(mBook, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(idM, 'registry.json'), JSON.stringify({ v: 1, entries: {} }, null, 2), { mode: 0o600 });

  const after = loadIdentity(idM);
  loadAddressBook(idM);
  const sockM = path.join(tmp, 'm.sock');
  const daemonM = await startDaemon(sockM, path.join(tmp, 'outM'), idM);
  const mIdFile = JSON.parse(fs.readFileSync(path.join(idM, 'identity.json'), 'utf8'));
  const mBookFile = JSON.parse(fs.readFileSync(path.join(idM, 'addressbook.json'), 'utf8'));
  const mRegFile = JSON.parse(fs.readFileSync(path.join(idM, 'registry.json'), 'utf8'));
  check('fix6: legacy stores migrate in place — tags appear on all three stores',
    typeof mIdFile.integrity === 'string' && typeof mBookFile.__store_integrity__ === 'string'
    && typeof mRegFile.integrity === 'string' && daemonM.up);
  check('fix6: migration preserves seal/sign fingerprints and trust contents',
    after.sealFp === before.sealFp && after.signFp === before.signFp
    && mBookFile['vault-b'].sign_pub === bookBefore['vault-b'].sign_pub
    && mBookFile['vault-b'].seal_pub === bookBefore['vault-b'].seal_pub);
  await stopDaemon(daemonM);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    console.log(`artifacts kept for inspection: ${tmp}`);
    process.exit(1);
  }
  console.log('ALL GEMINI-FIX TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
