#!/usr/bin/env node
// run-tests-v2-cell.mjs — Closure 2 acceptance battery (SPEC §2.8) plus
// the Phase-1 deferred halves that belong to this phase:
//   case 11 (activation half): v1 package ⇒ untiered ⇒ activation refusal
//   case 21: Tier-2 placement — HARD-cell-only, downgrade forbidden
//   case 22b: per-access report re-verification at activation
//   case 26: untiered repo part ⇒ activation refusal naming the part
// and the Addendum I CAPABILITY case: an agent process in a cell loads a
// plugin-shaped module, runs CLI tools, and emits through the governed
// egress — capability intact, crossings governed.
//
// Substrate honesty: this host has NO /dev/kvm and no firecracker, so
// HARD cells cannot run here. The battery proves the SOFT substrate
// (unshare namespaces) end-to-end and proves the HARD path as a named
// refusal/probe — never as a fake pass.

import { probeCells } from '../cell.mjs';
import { legacyFixtureHome } from './legacy-v1-fixture.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadIdentity, sealPlaintext, parseScriptureFile, frameDigest,
  ownerSocketFor, ownerTokenPathFor, ownerConfirmPathFor,
} from '../armor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const V1 = legacyFixtureHome(path.join(ROOT, '..', 'scripture-armor-standalone'));
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const NODE = process.execPath;
const FIX = path.join(HERE, 'fixtures-cell');
// No ghidra_home/jdk_home pins: scan.mjs auto-detects the installs
// under ~/workspace/tools — a set-but-wrong pin FAILS CLOSED instead
// of falling through (scan.mjs resolveGhidra), which is why this
// battery deliberately leaves the scan policy empty, like Phase 1's.
const SCAN_POLICY = { scan: {} };

let passed = 0, failed = 0;
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
const armorV1 = (args, opts) => run(NODE, [path.join(V1, 'armor.mjs'), ...args], opts);
const vaultdCli = (args, opts) => run(NODE, [VAULTD, ...args], opts);

const BLOCKS = new Map();
function publicBlockOf(dir) {
  if (BLOCKS.has(dir)) return BLOCKS.get(dir);
  const r = armor(['identity', '--identity-dir', dir]);
  const block = r.out.trim();
  if (block.length > 40) { BLOCKS.set(dir, block); return block; }
  return null;
}
function mkStore(label, policy = SCAN_POLICY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sa2c-${label}-`));
  const r = armor(['identity', '--label', label, '--identity-dir', dir]);
  if (r.code !== 0) throw new Error(`identity ${label}: ${r.err}`);
  const block = r.out.trim();
  if (block.length > 40) BLOCKS.set(dir, block);
  if (policy) writePolicy(dir, policy);
  return dir;
}
function trustPeer(storeDir, peerDir, label = null) {
  const peer = loadIdentity(peerDir);
  const block = publicBlockOf(peerDir);
  if (!block) throw new Error(`no public block captured for ${peerDir}`);
  const r = armor(['trust', label || peer.label, block, '--identity-dir', storeDir]);
  if (r.code !== 0) throw new Error(`trust ${label || peer.label} -> ${storeDir}: ${r.err}`);
}
function writePolicy(storeDir, policy) {
  fs.writeFileSync(path.join(storeDir, 'policy.json'), JSON.stringify(policy, null, 2), { mode: 0o600 });
}
function registryOf(storeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(storeDir, 'registry.json'), 'utf8')); }
  catch { return { entries: {} }; }
}
function vaultLog(storeDir) {
  try { return fs.readFileSync(path.join(storeDir, 'vaultd.log'), 'utf8'); } catch { return ''; }
}
// Phase 4 (FIX 1 + FIX 3): owner acts ride the owner socket; registry
// entries are found by canary (v3 frames carry no plaintext hash to
// look an entry up by — the entry's digest is a keyed commitment).
function ownerRpc(socket, obj) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(path.dirname(socket)), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(path.dirname(socket)), { ...obj, owner_token: token });
}
function readConfirm(socket, id) {
  try { return JSON.parse(fs.readFileSync(ownerConfirmPathFor(path.dirname(socket), id), 'utf8')); } catch { return null; }
}
function entryForPkg(storeDir, pkgPath) {
  try {
    const { frame } = parseScriptureFile(fs.readFileSync(pkgPath, 'utf8'));
    return registryOf(storeDir).entries[frame.canary];
  } catch { return undefined; }
}

async function startDaemon(storeDir, { windowMs = 120000 } = {}) {
  const socket = path.join(storeDir, 'vaultd.sock');
  const proc = spawn(NODE, [VAULTD, 'serve', '--identity-dir', storeDir, '--approval-window-ms', String(windowMs)], {
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
function stopDaemon(d) {
  try { d.proc.kill('SIGTERM'); } catch {}
}
function rpcOnce(socket, obj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = '';
    const timer = setTimeout(() => { try { conn.destroy(); } catch {} reject(new Error('rpc timeout')); }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify(obj) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(timer); try { conn.end(); } catch {} resolve(JSON.parse(buf.slice(0, i))); }
    });
    conn.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
// Streaming activate: collects every daemon message until the terminal
// one (activation-complete / refusal). .pending resolves at the pend.
function activateStream(socket, pkgPath, { entry = null } = {}) {
  const msgs = [];
  let pendingResolve, pendingTimer, finalTimer;
  const pending = new Promise((r) => {
    pendingResolve = r;
    // A refusal (or a grant launch) never pends: resolve null on a
    // timer so a caller awaiting the pend cannot hang forever.
    pendingTimer = setTimeout(() => r(null), 60000);
  });
  const final = new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = '';
    const done = () => { clearTimeout(pendingTimer); clearTimeout(finalTimer); pendingResolve(null); try { conn.end(); } catch {} resolve(msgs); };
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'activate', path: pkgPath, entry }) + '\n'));
    conn.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'pending-approval') pendingResolve(m);
        if (m.state === 'activation-complete' || m.ok === false || m.beacon) { setTimeout(done, 50); return; }
      }
    });
    conn.on('error', done);
    finalTimer = setTimeout(done, 150000);
  });
  return { pending, final, msgs };
}
async function waitPending(socket, pred, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = await rpcOnce(socket, { cmd: 'pending' }).catch(() => null);
    const hit = (r?.pending || []).find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(250);
  }
}
async function activateAndApprove(socket, pkgPath, { entry = null, dual = false } = {}) {
  const s = activateStream(socket, pkgPath, { entry });
  const pend = await s.pending;
  if (!pend) {
    const msgs = await s.final;
    return { pend: null, appr: null, msgs, last: msgs[msgs.length - 1] };
  }
  let appr = await ownerRpc(socket, { cmd: 'approve', id: pend.id });
  if (dual && appr?.approved_stage === 1) {
    // The confirm code lives in the owner channel state (FIX 1) — it
    // is never delivered on any socket, activation stream included.
    await sleep(300);
    const code = readConfirm(socket, pend.id)?.code;
    if (code) appr = await ownerRpc(socket, { cmd: 'approve', id: pend.id, confirm: code });
  }
  const msgs = await s.final;
  return { pend, appr, msgs, last: msgs[msgs.length - 1] };
}
// One-shot activate expecting NO pend (grant launch or outright refusal).
async function activateBare(socket, pkgPath, { entry = null } = {}) {
  const s = activateStream(socket, pkgPath, { entry });
  const msgs = await s.final;
  return { msgs, last: msgs[msgs.length - 1] };
}
function present(socket, pkgPath, outName) {
  let pendingResolve;
  const pending = new Promise((r) => { pendingResolve = r; setTimeout(() => r(null), 60000); });
  const final = new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = ''; const msgs = [];
    const done = () => { try { conn.end(); } catch {} resolve(msgs); };
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'unwrap', path: pkgPath, out: outName }) + '\n'));
    conn.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'pending-approval') pendingResolve(m);
        if (m.state === 'unwrapped' || m.beacon || m.ok === false) { setTimeout(done, 50); return; }
      }
    });
    conn.on('error', () => resolve(msgs));
    setTimeout(done, 45000);
  });
  return { pending, final };
}
function flipBodyChar(text) {
  const lines = text.split('\n');
  const row = lines[2].split('');
  row[3] = row[3] === 'X' ? 'Y' : 'X';
  lines[2] = row.join('');
  return lines.join('\n');
}
const wrapAct = (storeDir, socket, file, extra = []) => armor(
  ['wrap', file, '--to', loadIdentity(storeDir).label, '--for-activation', '--socket', socket, '--identity-dir', storeDir, ...extra]);
const wrapEgress = (storeDir, socket, file, extra = []) => armor(
  ['wrap', file, '--to', loadIdentity(storeDir).label, '--socket', socket, '--identity-dir', storeDir, ...extra]);

async function main() {
  console.log('Scripture Armor v2 — Closure 2 acceptance battery');
  const substrate = probeCells();
  const refusalOnly = process.argv.includes('--refusal-only');
  if (!substrate.soft.available && !refusalOnly) {
    console.log(`BLOCKED: SOFT cell substrate unavailable; full cell execution cannot be proved on ${process.platform}. HARD status: ${JSON.stringify(substrate.hard)}. Run --refusal-only for real pre-execution denial proofs.`);
    process.exitCode = 2; return;
  }
  if (refusalOnly) console.log('REFUSAL-ONLY: positive execution/egress/capability outcomes remain BLOCKED, never counted as PASS.');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2c-battery-'));
  const BIN = path.join(T, 'bin'); fs.mkdirSync(BIN);
  const gcc = run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', path.join(BIN, 'clean.bin'), path.join(HERE, 'fixtures-src', 'clean.c')]);
  const gcc2 = run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', path.join(BIN, 'bad.bin'), path.join(HERE, 'fixtures-src', 'bad.c')]);
  if (gcc.code !== 0 || gcc2.code !== 0) throw new Error(`gcc fixture build failed: ${gcc.err} ${gcc2.err}`);
  const cleanBin = path.join(BIN, 'clean.bin');
  // Tier 2 is produced the Phase-1 way: the critical binary wrapped
  // under a signed scan override lands at tier 2.
  const badBin = path.join(BIN, 'bad.bin');

  // Store A hosts activations; store B is the armored peer ("owner").
  const A = mkStore('cell-host');
  const B = mkStore('owner');
  trustPeer(A, B, 'owner'); trustPeer(B, A); trustPeer(A, A);
  const dB = await startDaemon(B);
  const dA = await startDaemon(A);
  // The peer entry on A points at B's daemon so emissions register live.
  {
    const bookPath = path.join(A, 'addressbook.json');
    const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
    book.owner.daemon_socket = dB.socket;
    fs.writeFileSync(bookPath, JSON.stringify(book, null, 2), { mode: 0o600 });
  }
  const echoFile = path.join(FIX, 'echohash.mjs');
  const echoBytes = fs.readFileSync(echoFile);
  const echoSha = sha256Hex(echoBytes);

  if (!refusalOnly) {
  // ================= Case 1: activation + emission + return-match =====
  console.log('\n[1] pass-verdict activation runs; stdout emission arrives as a registered package at the peer; return-match succeeds');
  {
    const w = wrapAct(A, dA.socket, echoFile);
    check('echohash wraps into the activation store', w.code === 0 && fs.existsSync(`${echoFile}.scripture`), w.err.slice(0, 200));
    const r = await activateAndApprove(dA.socket, `${echoFile}.scripture`);
    check('first activation pends for the owner', !!r.pend && r.pend.state === 'pending-approval');
    check('activation completes', r.last?.state === 'activation-complete', JSON.stringify(r.last).slice(0, 300));
    check('run exited 0', r.last?.exit === 0, `exit=${r.last?.exit} stderr=${(r.last?.stderr_tail || '').slice(0, 200)}`);
    check('cell class is SOFT (source lane, this host)', r.last?.cell_class === 'soft' && r.last?.downgraded === false, `class=${r.last?.cell_class} downgraded=${r.last?.downgraded}`);
    check('staging destroyed after the run', r.last?.destroyed === true);
    const regB = registryOf(B);
    // The emission's plaintext is the digest STRING the program printed,
    // so the issuance's sha256 is the hash of that string's bytes.
    const emission = Object.values(regB.entries).find((e) => e.origin === 'egress');
    check('emission registered at the peer daemon as an egress issuance of the digest bytes', !!emission,
      JSON.stringify(Object.values(regB.entries).map((e) => e.digest)).slice(0, 200));
    // RETURN-MATCH at the peer: present the emission package, approve,
    // and the digest string itself comes back.
    const emFile = path.join(A, 'emissions', `${emission?.canary}.scripture`);
    check('emission package written on the sender side', fs.existsSync(emFile));
    const p = present(dB.socket, emFile, 'echo-digest.txt');
    const pend = await p.pending;
    await ownerRpc(dB.socket, { cmd: 'approve', id: pend.id });
    const pmsgs = await p.final;
    const un = pmsgs.find((m) => m.state === 'unwrapped');
    check('return-match unwrap succeeds at the peer', !!un, JSON.stringify(pmsgs).slice(0, 200));
    const back = un ? fs.readFileSync(path.join(B, 'out', 'echo-digest.txt'), 'utf8') : '';
    check('returned bytes are the program\'s emitted digest', back === echoSha, back.slice(0, 80));
  }

  // ================= Case 2: no network inside the cell ===============
  console.log('\n[2] direct network attempt fails; the run completes; the shell is unaffected');
  {
    const log = vaultLog(A);
    check('cell log testifies the network attempt failed (no route)', /echohash net-attempt: failed:/.test(log),
      (log.match(/echohash net-attempt: \S+/) || ['<none>'])[0]);
    check('no CONNECTED network attempt anywhere in the log', !/net-attempt: CONNECTED/.test(log));
    const st = await rpcOnce(dA.socket, { cmd: 'status' });
    check('daemon healthy after the cell run', st.ok === true && st.activations_running === 0);
  }

  // ================= Case 3: no plaintext on any persistent path ======
  console.log('\n[3] no plaintext on any persistent path during/after the run (incl. out/ + the store)');
  {
    let leak = null;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && st.size === echoBytes.length) {
          if (fs.readFileSync(p).equals(echoBytes)) leak = p;
        }
      }
    };
    walk(A); walk(path.join(A, 'out'));
    check('fixture bytes appear nowhere as a plaintext file in the host store', leak === null, leak || '');
    check('no staging residue under cells/', fs.readdirSync(path.join(A, 'cells')).length === 0,
      fs.readdirSync(path.join(A, 'cells')).join(','));
  }

  // ================= Case 4: image is read-only ======================
  console.log('\n[4] image read-only — self-modification fails inside the cell');
  {
    const tw = path.join(FIX, 'trywrite.mjs');
    const w = wrapAct(A, dA.socket, tw);
    check('trywrite wraps', w.code === 0, w.err.slice(0, 150));
    const r = await activateAndApprove(dA.socket, `${tw}.scripture`);
    const tail = r.last?.stdout_tail || '';
    check('image write FAILED inside the cell', /image-write: FAILED/.test(tail), tail.slice(0, 200));
    check('sibling write FAILED inside the cell', /sibling-write: FAILED/.test(tail), tail.slice(0, 200));
  }

  // ================= Case 5+10: scratch lifecycle + wall-clock kill ===
  console.log('\n[5+10] scratch exists during the run and is gone after; sleeper overruns max_seconds ⇒ killed + destroyed');
  {
    writePolicy(A, { ...SCAN_POLICY, cell: { max_seconds: 3, lease_s: 30 } });
    const sl = path.join(FIX, 'sleeper.mjs');
    const w = wrapAct(A, dA.socket, sl);
    check('sleeper wraps', w.code === 0, w.err.slice(0, 150));
    const s = activateStream(dA.socket, `${sl}.scripture`);
    const pend = await s.pending;
    await ownerRpc(dA.socket, { cmd: 'approve', id: pend.id });
    // While it runs: the staging tree (image + scratch mounts) exists.
    // The scratch's CONTENTS are a tmpfs inside the cell's namespace —
    // invisible from the host by design (that invisibility IS the
    // RAM-only property); writability is proven by the fixtures' own
    // exit-0 runs (echohash writes its scratch note every run).
    await sleep(1200);
    const cellDirs = fs.readdirSync(path.join(A, 'cells'));
    let scratchSeen = false;
    for (const d of cellDirs) {
      if (fs.existsSync(path.join(A, 'cells', d, 'scratch'))) scratchSeen = true;
    }
    check('staging + scratch mount exist during the run', scratchSeen, cellDirs.join(','));
    const msgs = await s.final;
    const last = msgs[msgs.length - 1];
    check('sleeper killed at the wall-clock cap', last?.killed === 'wall-clock', JSON.stringify(last).slice(0, 200));
    check('cell destroyed after the kill', last?.destroyed === true);
    check('staging path gone after destroy', fs.readdirSync(path.join(A, 'cells')).length === 0);
    const rec = entryForPkg(A, `${sl}.scripture`);
    check('activation record names the kill', (rec?.activations || []).some((a) => a.killed === 'wall-clock' && a.destroyed === true));
    writePolicy(A, SCAN_POLICY);
  }

  // ================= Case 6: tampered image ⇒ beacon, no boot =========
  console.log('\n[6] tampered image (1 glyph flipped) ⇒ refusal + beacon, nothing boots');
  {
    const pkgPath = `${echoFile}.scripture`;
    const tampered = path.join(T, 'echohash-tampered.scripture');
    fs.writeFileSync(tampered, flipBodyChar(fs.readFileSync(pkgPath, 'utf8')));
    const logBefore = vaultLog(A).length;
    // The tampered copy has the same canary; present it under the real
    // name so the daemon reads it as the issued package.
    const stash = path.join(T, 'echohash-orig.scripture');
    fs.copyFileSync(pkgPath, stash);
    fs.copyFileSync(tampered, pkgPath);
    const r = await activateBare(dA.socket, pkgPath);
    fs.copyFileSync(stash, pkgPath);
    check('tampered presentation refused', r.last?.ok === false || r.last?.beacon === true, JSON.stringify(r.last).slice(0, 200));
    check('beacon emitted for the tamper', /bad-frame-signature|image-mismatch|hash-mismatch/.test(vaultLog(A).slice(logBefore)));
    const rec = entryForPkg(A, `${echoFile}.scripture`);
    check('no activation record was created for the tampered copy',
      (rec?.activations || []).filter((a) => a.refused || a.boot_failed).length === 0);
  }

  // ================= Case 7+8: grant, tap-free rerun, revoke ===========
  console.log('\n[7+8] grant written at first approval; second activation tap-free; revoke-grant ⇒ pends again');
  {
    const recBefore = entryForPkg(A, `${echoFile}.scripture`);
    check('a grant stands on the echohash entry', !!recBefore?.grants, JSON.stringify(recBefore?.grants));
    const r2 = await activateBare(dA.socket, `${echoFile}.scripture`);
    check('second activation launches under the grant (no pend)', r2.last?.state === 'activation-complete'
      && !r2.msgs.some((m) => m.state === 'pending-approval'), JSON.stringify(r2.msgs.map((m) => m.state)));
    const recMid = entryForPkg(A, `${echoFile}.scripture`);
    check('both runs are in the activations record', (recMid?.activations || []).length >= 2,
      `count=${(recMid?.activations || []).length}`);
    const rv = vaultdCli(['revoke-grant', '--canary', recBefore.canary, '--socket', dA.socket, '--identity-dir', A]);
    check('revoke-grant succeeds', rv.code === 0 && /"revoked":\s*true/.test(rv.out), rv.out.slice(0, 150));
    const s3 = activateStream(dA.socket, `${echoFile}.scripture`);
    const pend3 = await s3.pending;
    check('after revoke, activation pends again', !!pend3 && pend3.state === 'pending-approval');
    if (pend3) await ownerRpc(dA.socket, { cmd: 'approve', id: pend3.id });
    const msgs3 = await s3.final;
    check('re-approved activation completes', msgs3[msgs3.length - 1]?.state === 'activation-complete');
  }

  // ================= Case 9: egress-origin ⇒ not-activatable ==========
  console.log('\n[9] egress-origin package ⇒ not-activatable');
  {
    const tw2 = path.join(T, 'egress-only.mjs');
    fs.copyFileSync(path.join(FIX, 'tierprobe.mjs'), tw2);
    const w = wrapEgress(A, dA.socket, tw2);
    check('plain egress wrap succeeds', w.code === 0, w.err.slice(0, 150));
    const r = await activateBare(dA.socket, `${tw2}.scripture`);
    check('activation refused as not-activatable', r.last?.ok === false && /not-activatable/.test(r.last?.error || ''),
      JSON.stringify(r.last).slice(0, 200));
  }

  // ================= Case 13: unknown destination dropped ==============
  console.log('\n[13] emission to an unresolvable destination is dropped + logged; no alternate path');
  {
    const eu = path.join(FIX, 'emitunk.mjs');
    const w = wrapAct(A, dA.socket, eu);
    check('emitunk wraps', w.code === 0, w.err.slice(0, 150));
    const r = await activateAndApprove(dA.socket, `${eu}.scripture`);
    check('run completes despite the dead destination', r.last?.state === 'activation-complete' && r.last?.exit === 0);
    check('the emission is recorded as dropped (unresolved-destination)',
      (r.last?.emissions || []).some((e) => e.dropped === 'unresolved-destination'),
      JSON.stringify(r.last?.emissions));
    check('the drop is testified in the daemon log', /egress-drop.*unresolved-destination/.test(vaultLog(A)));
  }

  // ================= Case 11 (§2.8): the mantrap/promotion door ========
  console.log('\n[11] emitted executables are NOT delivered — clean becomes a candidate behind scan+grant; critical is refused promotion');
  {
    const sc = path.join(FIX, 'spawner-clean.mjs');
    const w = wrapAct(A, dA.socket, sc);
    check('spawner-clean wraps', w.code === 0, w.err.slice(0, 150));
    const r = await activateAndApprove(dA.socket, `${sc}.scripture`);
    check('spawner-clean completes', r.last?.state === 'activation-complete' && r.last?.exit === 0, JSON.stringify(r.last).slice(0, 200));
    check('exactly one candidate artifact recorded', (r.last?.artifacts || []).length === 1, JSON.stringify(r.last?.artifacts));
    const candCanary = (r.last?.artifacts || [])[0];
    const candEntry = registryOf(A).entries[candCanary];
    check('candidate registered origin activation-store + candidate flag',
      candEntry?.origin === 'activation-store' && candEntry?.candidate === true, JSON.stringify(candEntry || null).slice(0, 200));
    const candPkg = path.join(A, 'candidates', `${candCanary}.scripture`);
    check('candidate package held in candidates/ (not delivered anywhere)', fs.existsSync(candPkg));
    // The candidate itself still needs the full gates: it pends.
    const rc = await activateAndApprove(dA.socket, candPkg);
    check('candidate activation pends for its own grant', !!rc.pend);
    check('candidate runs after its grant', rc.last?.state === 'activation-complete' && rc.last?.exit === 0
      && /spawned candidate/.test(rc.last?.stdout_tail || ''), (rc.last?.stdout_tail || '').slice(0, 120));
  }
  {
    const sb = path.join(FIX, 'spawner-bad.mjs');
    const sbBytes = fs.readFileSync(sb);
    const w = wrapAct(A, dA.socket, sb); // wrap BEFORE the hash is listed
    check('spawner-bad wraps (its hash is not yet listed)', w.code === 0, w.err.slice(0, 150));
    fs.writeFileSync(path.join(A, 'badhashes.txt'), `${sha256Hex(sbBytes)}\n`, { mode: 0o600 });
    const candBefore = new Set(Object.values(registryOf(A).entries).filter((e) => e.candidate).map((e) => e.canary));
    const r = await activateAndApprove(dA.socket, `${sb}.scripture`);
    fs.rmSync(path.join(A, 'badhashes.txt'), { force: true });
    check('spawner-bad itself completes', r.last?.state === 'activation-complete', JSON.stringify(r.last).slice(0, 200));
    check('critical emission refused promotion (no candidate artifact)',
      (r.last?.artifacts || []).length === 0
      && (r.last?.emissions || []).some((e) => e.refused === 'scan-critical'),
      JSON.stringify(r.last?.emissions));
    // Phase 4 (FIX 3): entries no longer carry a plaintext hash to match
    // the listed hash against — the refusal is proven by the candidate
    // set being unchanged: the listed program produced NO new candidate.
    check('no new registry candidate from the listed-hash program',
      !Object.values(registryOf(A).entries).some((e) => e.candidate && !candBefore.has(e.canary)));
    check('promotion refusal testified', /promotion-refused/.test(vaultLog(A)));
  }

  // ================= Case CAP: capability intact (Addendum I) =========
  console.log('\n[CAP] an agent in a cell keeps its capabilities: plugin load + CLI tools + governed egress');
  {
    const tu = path.join(FIX, 'tooluser.mjs');
    const w = wrapAct(A, dA.socket, tu);
    check('tooluser wraps', w.code === 0, w.err.slice(0, 150));
    const r = await activateAndApprove(dA.socket, `${tu}.scripture`);
    check('tooluser completes exit 0', r.last?.state === 'activation-complete' && r.last?.exit === 0,
      `exit=${r.last?.exit} stderr=${(r.last?.stderr_tail || '').slice(0, 200)}`);
    const version = run(NODE, ['--version']).out.trim();
    const expected = `plugin says hello, owner | node ${version} | cli-tool-ran`;
    // Phase 4 (FIX 3): registry entries carry the keyed commitment, not
    // a plaintext hash, so the crossing is proven the strong way — find
    // the egress issuance at B, open its package there, compare bytes.
    const regB = registryOf(B);
    const emis = Object.values(regB.entries)
      .filter((e) => e.origin === 'egress' && e.sender_sign_fp === loadIdentity(A).signFp);
    const eEntry = emis[emis.length - 1];
    let crossed = false;
    if (eEntry) {
      const epkg = path.join(A, 'emissions', `${eEntry.canary}.scripture`);
      if (fs.existsSync(epkg)) {
        const p = present(dB.socket, epkg, 'cap-emission.out');
        const pend = await p.pending;
        if (pend) await ownerRpc(dB.socket, { cmd: 'approve', id: pend.id });
        const msgs = await p.final;
        const last = msgs[msgs.length - 1];
        crossed = last?.state === 'unwrapped'
          && fs.readFileSync(path.join(B, 'out', 'cap-emission.out'), 'utf8') === expected;
      }
    }
    check('plugin greeting + CLI outputs crossed as one governed emission', crossed, expected);
    check('capability log testified by the daemon', /tooluser capability-ok/.test(vaultLog(A)));
  }

  // ================= Cases 15+14 on a second host store ================
  console.log('\n[15] max_instances 1 ⇒ a second concurrent activation is refused');
  const C = mkStore('cell-host-2');
  trustPeer(C, C);
  let dC = await startDaemon(C);
  const sleeperC = path.join(T, 'sleeper-c.mjs');
  fs.copyFileSync(path.join(FIX, 'sleeper.mjs'), sleeperC);
  {
    writePolicy(C, { ...SCAN_POLICY, cell: { max_seconds: 2, lease_s: 30 } });
    const w = wrapAct(C, dC.socket, sleeperC);
    check('sleeper (store C) wraps', w.code === 0, w.err.slice(0, 150));
    const r0 = await activateAndApprove(dC.socket, `${sleeperC}.scripture`);
    check('first (short) activation completes and writes the grant', r0.last?.state === 'activation-complete'
      && !!entryForPkg(C, `${sleeperC}.scripture`)?.grants);
    writePolicy(C, { ...SCAN_POLICY, cell: { max_seconds: 120, lease_s: 3 } });
    const s1 = activateStream(dC.socket, `${sleeperC}.scripture`);
    // Wait until the run is actually live.
    const t0 = Date.now();
    while (!s1.msgs.some((m) => m.state === 'activated') && Date.now() - t0 < 20000) await sleep(200);
    check('long run launched under the grant', s1.msgs.some((m) => m.state === 'activated'), JSON.stringify(s1.msgs.map((m) => m.state)));
    const rBusy = await activateBare(dC.socket, `${sleeperC}.scripture`);
    check('second concurrent activation refused (activation-busy)',
      rBusy.last?.ok === false && /activation-busy/.test(rBusy.last?.error || ''), JSON.stringify(rBusy.last).slice(0, 200));
    // Leave the long run live for case 14: kill the DAEMON, not the cell.
    var liveStream = s1; // eslint-disable-line no-var
  }

  console.log('\n[14] daemon killed mid-run ⇒ orphan reaped at lease expiry on next start');
  {
    const cellsDir = path.join(C, 'cells');
    const dirs = fs.readdirSync(cellsDir);
    check('a live staging dir exists before the kill', dirs.length === 1, dirs.join(','));
    let marker = null;
    if (dirs.length === 1) {
      try { marker = JSON.parse(fs.readFileSync(path.join(cellsDir, dirs[0], 'marker.json'), 'utf8')); } catch {}
    }
    check('marker carries the cell pid', !!marker?.pid, JSON.stringify(marker));
    dC.proc.kill('SIGKILL');
    await sleep(500);
    let cellAlive = false;
    try { process.kill(marker.pid, 0); cellAlive = true; } catch {}
    check('the cell outlives its daemon (it is a real separate process)', cellAlive === true);
    await sleep(4500); // heartbeat is 2s; lease is 3s ⇒ the marker is stale
    dC = await startDaemon(C);
    await sleep(300);
    check('orphan reap testified at next start', /cell-orphan-reaped/.test(vaultLog(C)));
    check('staging destroyed by the reaper', fs.readdirSync(cellsDir).length === 0);
    let aliveAfter = false;
    try { process.kill(marker.pid, 0); aliveAfter = true; } catch {}
    check('orphaned cell process is dead after the reap', aliveAfter === false);
    stopDaemon(dC);
  }

  // ================= Case 13 (§2.8): SOFT downgrade only by tap ========
  console.log('\n[13] binary activation: HARD required by default; SOFT only via a recorded owner tap');
  {
    const w = wrapAct(A, dA.socket, cleanBin);
    check('clean.bin wraps into the activation store', w.code === 0, w.err.slice(0, 200));
    const s = activateStream(dA.socket, `${cleanBin}.scripture`);
    const pend = await s.pending;
    check('binary activation pends (no silent downgrade)', !!pend, JSON.stringify(s.msgs).slice(0, 200));
    check('the pend names the downgrade + the SOFT substrate',
      (pend?.reasons || []).includes('cell-downgrade')
      && (pend?.notices || []).some((n) => /cell: SOFT/.test(n)),
      JSON.stringify(pend?.notices || []).slice(0, 300));
    if (pend) await ownerRpc(dA.socket, { cmd: 'approve', id: pend.id });
    const msgs = await s.final;
    const last = msgs[msgs.length - 1];
    check('approved downgrade runs in a SOFT cell', last?.state === 'activation-complete' && last?.cell_class === 'soft',
      JSON.stringify(last).slice(0, 200));
    check('the record says downgraded: true', last?.downgraded === true);
    const rec = entryForPkg(A, `${cleanBin}.scripture`);
    check('registry activation record carries the downgrade',
      (rec?.activations || []).some((a) => a.downgraded === true && a.cell_class === 'soft'));
  }

  } else console.log("BLOCKED: SOFT execution, confinement, egress and capability checks require a real cell substrate.");

  // ================= Deferred 21: Tier-2 placement =====================
  console.log('\n[D21] Tier-2 placement: HARD-cell-only + airlock-only egress; on a HARD-less host activation refuses (no downgrade exists)');
  {
    const w = armor(['wrap', badBin, '--to', 'cell-host', '--for-activation', '--socket', dA.socket,
      '--identity-dir', A, '--override-scan', 'battery: tier-2 placement subject, owner-accepted'],
      { input: 'OVERRIDE\n' });
    check('bad.bin wraps under override (tier 2)', w.code === 0, w.err.slice(0, 200));
    const rec = entryForPkg(A, `${badBin}.scripture`);
    check('tier snapshot: tier 2, min_cell hard, egress airlock-only, downgrade forbidden',
      rec?.tier?.tier === 2 && rec?.tier?.params?.min_cell === 'hard'
      && rec?.tier?.params?.egress === 'airlock-only' && rec?.tier?.params?.downgrade_allowed === false,
      JSON.stringify(rec?.tier ?? null).slice(0, 250));
    const r = await activateBare(dA.socket, `${badBin}.scripture`);
    check('Tier-2 activation refuses on this host (HARD unavailable, downgrade forbidden)',
      r.last?.ok === false && /cell-unavailable/.test(r.last?.error || '') && /forbids downgrade/.test(r.last?.error || ''),
      JSON.stringify(r.last).slice(0, 250));
    check('no activation record exists for the refused Tier-2 run',
      (entryForPkg(A, `${badBin}.scripture`)?.activations || []).length === 0);
  }

  // ================= Deferred 22b: report re-verification ==============
  console.log('\n[D22b] per-access report re-verification at activation (tampered report ⇒ refusal before any cell)');
  {
    const tp = path.join(T, 'tierprobe-22b.mjs');
    fs.copyFileSync(path.join(FIX, 'tierprobe.mjs'), tp);
    const w = wrapAct(A, dA.socket, tp);
    check('tierprobe wraps', w.code === 0, w.err.slice(0, 150));
    const reportPath = `${tp}.scan-report.scripture`;
    const pristine = fs.readFileSync(reportPath, 'utf8');
    fs.writeFileSync(reportPath, flipBodyChar(pristine));
    const r = await activateBare(dA.socket, `${tp}.scripture`);
    check('tampered report ⇒ activation refused (report-mismatch)',
      r.last?.ok === false && /report-mismatch/.test(r.last?.error || ''), JSON.stringify(r.last).slice(0, 220));
    fs.writeFileSync(reportPath, pristine);
    if (!refusalOnly) {
    const r2 = await activateAndApprove(dA.socket, `${tp}.scripture`);
    check('pristine report ⇒ activation proceeds', r2.last?.state === 'activation-complete', JSON.stringify(r2.last).slice(0, 200));
    // Tier 1 re-verifies EVERY activation: tamper after a completed run.
    const t1 = path.join(T, 'tier1-22b.mjs');
    fs.writeFileSync(t1, 'console.log("tier1 fixture", eval("40+2"));\n');
    const w1 = wrapAct(A, dA.socket, t1);
    check('tier-1 fixture wraps (eval pattern, warn/high)', w1.code === 0, w1.err.slice(0, 200));
    const t1rec = entryForPkg(A, `${t1}.scripture`);
    check('tier-1 fixture really is tier 1', t1rec?.tier?.tier === 1, JSON.stringify(t1rec?.tier).slice(0, 150));
    const ra = await activateAndApprove(dA.socket, `${t1}.scripture`);
    check('tier-1 first activation completes (warn pends, owner approves)', ra.last?.state === 'activation-complete',
      JSON.stringify(ra.last).slice(0, 200));
    const t1Report = `${t1}.scan-report.scripture`;
    fs.writeFileSync(t1Report, flipBodyChar(fs.readFileSync(t1Report, 'utf8')));
    const rb = await activateBare(dA.socket, `${t1}.scripture`);
    check('tier-1 second activation re-verifies and refuses the tampered report',
      rb.last?.ok === false && /report-mismatch/.test(rb.last?.error || ''), JSON.stringify(rb.last).slice(0, 220));
  }

    }
  // ================= Deferred 11: v1 package ⇒ refusal ==============
  console.log('\n[D11] v1-wrapped package presented for activation: classified untiered ⇒ refused');
  {
    const V = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2c-v1store-'));
    const idr = armorV1(['identity', '--label', 'v1-side', '--identity-dir', V]);
    check('v1 identity created', idr.code === 0, idr.err.slice(0, 150));
    // v1 store trusts A; wrap with the v1 tool, register at A's daemon.
    const blockA = publicBlockOf(A);
    const tr = armorV1(['trust', 'cell-host', blockA, '--identity-dir', V]);
    check('v1 store trusts A', tr.code === 0, tr.err.slice(0, 150));
    const vf = path.join(T, 'echohash-v1.mjs');
    fs.copyFileSync(echoFile, vf);
    let w = armorV1(['wrap', vf, '--to', 'cell-host', '--socket', dA.socket, '--identity-dir', V]);
    // Look the v1 issuance up by ITS canary (case 1 wrapped the same
    // fixture bytes under v2, so a sha lookup would find that entry).
    const v1Canary = (w.err.match(/canary:\s+(\S+)/) || [])[1] || null;
    if (v1Canary && !registryOf(A).entries[v1Canary]) {
      // v1 registration may have gone to its outbox instead: relay the
      // issuance exactly as issued (v1 entries carry no origin/tier).
      const outbox = path.join(V, 'registry-outbox.jsonl');
      if (fs.existsSync(outbox)) {
        const entries = fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        await ownerRpc(dA.socket, { cmd: 'register', entries });
      } else {
        // Phase 4 (FIX 1): a v2 daemon refuses the v1 tool's unsigned
        // socket registration — the issuance is NOT recorded by the
        // wrap. The OWNER relays it over the owner channel, exactly
        // as issued (v1 frame fields; the digest is its legacy hash).
        const parsed = parseScriptureFile(fs.readFileSync(`${vf}.scripture`, 'utf8'));
        await ownerRpc(dA.socket, {
          cmd: 'register',
          entries: [{
            canary: parsed.frame.canary, digest: parsed.frame.sha256, digest_kind: 'sha256',
            recipient_seal_fp: parsed.frame.recipient_seal_fp,
            sender_sign_fp: parsed.frame.sender_sign_fp,
            expiry: parsed.frame.expiry ?? null, origin: 'egress',
          }],
        });
      }
    }
    const rec = v1Canary ? registryOf(A).entries[v1Canary] : entryForPkg(A, `${echoFile}.scripture`);
    check('v1 issuance registered at the v2 daemon', !!rec, `wrap code=${w.code} err=${w.err.slice(0, 150)}`);
    check('v1 issuance classifies UNTIERED (tier null) and non-activation origin',
      rec?.tier == null && (rec?.origin || 'egress') !== 'activation-store', JSON.stringify(rec).slice(0, 200));
    const r = await activateBare(dA.socket, `${vf}.scripture`);
    check('v1 package activation refused', r.last?.ok === false && /not-activatable/.test(r.last?.error || ''),
      JSON.stringify(r.last).slice(0, 220));
    check('nothing ran for the v1 package', (rec?.activations || []).length === 0);
  }

  // ================= Deferred 26: repo activation ======================
  console.log('\n[D26] repo activation: untiered part ⇒ refusal naming the part; tiered repo activates whole');
  {
    const srcDir = path.join(T, 'repo-src'); fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'prog.mjs'),
      "import fs from 'node:fs';\nimport path from 'node:path';\nconst data = fs.readFileSync(path.join(process.env.SA_IMAGE, 'data.txt'), 'utf8');\nconsole.log(`repo-ran data:${data.trim()}`);\n");
    fs.writeFileSync(path.join(srcDir, 'data.txt'), 'repo-data-7\n');
    // Craft an UNTIERED repo by hand: v2-format packages sealed with no
    // scan block (armor_tier null), manifest registered activation-store.
    const me = loadIdentity(A);
    const wrappedDir = path.join(T, 'repo-untiered'); fs.mkdirSync(path.join(wrappedDir, 'files'), { recursive: true });
    const manifestFiles = [];
    const regEntries = [];
    for (const rel of ['prog.mjs', 'data.txt']) {
      const bytes = fs.readFileSync(path.join(srcDir, rel));
      const sealed = sealPlaintext(bytes, me, me, {});
      const pkgRel = `files/${rel}.part-0.scripture`;
      fs.writeFileSync(path.join(wrappedDir, pkgRel), sealed.text);
      manifestFiles.push({
        path: rel, sha256: sha256Hex(bytes), size: bytes.length, mode: 0o100644,
        parts: [{ package: pkgRel, sha256: sha256Hex(bytes), size: bytes.length, canary: sealed.frame.canary }],
      });
      regEntries.push({
        canary: sealed.frame.canary, digest: frameDigest(sealed.frame), digest_kind: 'commit',
        recipient_seal_fp: me.sealFp, sender_sign_fp: me.signFp, expiry: null, origin: 'egress',
      });
    }
    const manifest = { format: 'scripture-armor-repo/2', created: new Date().toISOString(), files: manifestFiles, fileCount: 2, partCount: 2, totalBytes: manifestFiles.reduce((a, f) => a + f.size, 0) };
    const sealedManifest = sealPlaintext(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), me, me, {});
    fs.writeFileSync(path.join(wrappedDir, 'MANIFEST.scripture'), sealedManifest.text);
    regEntries.push({
      canary: sealedManifest.frame.canary, digest: frameDigest(sealedManifest.frame), digest_kind: 'commit',
      recipient_seal_fp: me.sealFp, sender_sign_fp: me.signFp, expiry: null, origin: 'activation-store',
    });
    // Registration of hand-crafted issuances is an owner act (FIX 1):
    // the battery registers over the owner channel, as the owner.
    const regRes = await ownerRpc(dA.socket, { cmd: 'register', entries: regEntries });
    check('crafted untiered repo registered', regRes?.ok === true, JSON.stringify(regRes).slice(0, 150));
    const r = await activateBare(dA.socket, path.join(wrappedDir, 'MANIFEST.scripture'), { entry: 'prog.mjs' });
    check('untiered repo activation refused', r.last?.ok === false && /untiered part/.test(r.last?.error || ''),
      JSON.stringify(r.last).slice(0, 220));
    check('the refusal NAMES the untiered part', /prog\.mjs/.test(r.last?.error || ''), r.last?.error || '');
    if (!refusalOnly) {
    // The same tree wrapped properly (every part tiered) activates whole.
    const outDir = path.join(T, 'repo-wrapped');
    const wr = armor(['wrap-repo', srcDir, '--to', 'cell-host', '--for-activation', '--out', outDir, '--socket', dA.socket, '--identity-dir', A]);
    check('repo wraps with --for-activation', wr.code === 0, wr.err.slice(0, 250));
    const rr = await activateAndApprove(dA.socket, path.join(outDir, 'MANIFEST.scripture'), { entry: 'prog.mjs' });
    check('tiered repo activation pends then completes', rr.last?.state === 'activation-complete' && rr.last?.exit === 0,
      JSON.stringify(rr.last).slice(0, 250));
    check('repo program ran with its sibling file staged', /repo-ran data:repo-data-7/.test(rr.last?.stdout_tail || ''),
      (rr.last?.stdout_tail || '').slice(0, 150));
  }

    }
  stopDaemon(dA); stopDaemon(dB);
  console.log('\n[16] v1 regression — the full v1 suite is run separately (test/run-tests.mjs); it must stay 53/53.');
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(refusalOnly ? 'RUNNABLE REFUSAL CHECKS PASSED; positive cell execution remains BLOCKED' : 'ALL CELL BATTERY CHECKS PASSED');
  }
}

main().catch((e) => { console.error('battery error:', e); process.exitCode = 1; });
