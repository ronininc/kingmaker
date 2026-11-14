// soak-refit.mjs — Addendum M endurance soak.
//
// The shipped v2 tree carries NO soak harness file (verified by
// grep: the Phase 4 soak was run ad hoc), so this runner implements
// the v2 soak profile fresh against the refit tree: 300
// wrap → register → present → approve → unwrap cycles against a
// refit daemon in ANCHORED mode (M.1 chain + live anchor), with the
// presenting side retrying while a fresh save's anchor round lands —
// anchoring lag is a designed refusal (fail closed), and a client
// that retries is the honest counterpart.
//
// Tamper probes run at the end against the soak store:
//   P1  byte-format edit of registry.json → consumption refuses
//       (anchor-divergence); exact bytes restored → works again.
//   P2  replayed older registry-anchor.json → consumption refuses
//       (unanchored tail / live-anchor divergence); the daemon's
//       anchor round re-anchors on the next save → works again.
//   P3  anchor daemon down → a fresh save cannot anchor →
//       consumption refuses; anchor back up → next save anchors →
//       consumption works.
//
// Cleanup contract: every daemon started here is stopped here, even
// on failure (finally). Prints a one-line JSON summary at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  loadIdentity, ownerSocketFor, ownerTokenPathFor,
} from '../armor.mjs';
import {
  verifyAnchoredRegistry, loadAttestation, verifyChain, registryChainFile,
} from '../refit-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const NODE = process.execPath;
const CYCLES = Number(process.env.SOAK_CYCLES || 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: opts.timeout || 120000, env: { ...process.env } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const armor = (args) => run(NODE, [ARMOR, ...args]);
const BLOCKS = new Map();
function mkStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sa-soak-${label}-`));
  const r = armor(['identity', '--label', label, '--identity-dir', dir]);
  if (r.code !== 0) throw new Error(`identity ${label}: ${r.err}`);
  BLOCKS.set(dir, r.out.trim().split('\n').pop());
  return dir;
}
function trust(storeDir, label, otherDir, meshAddr = null) {
  const args = ['trust', label, BLOCKS.get(otherDir), '--identity-dir', storeDir];
  if (meshAddr) args.push('--mesh', meshAddr);
  const r = armor(args);
  if (r.code !== 0) throw new Error(`trust: ${r.err}`);
}
const DAEMONS = [];
async function startDaemon(storeDir, { mesh = false } = {}) {
  const socket = path.join(storeDir, 'vaultd.sock');
  const proc = spawn(NODE, [VAULTD, 'serve', '--identity-dir', storeDir, '--approval-window-ms', '120000'], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const d = { proc, socket, storeDir };
  DAEMONS.push(d);
  let out = '';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`daemon start timeout: ${out}`)), 25000);
    proc.stdout.on('data', (c) => {
      out += c;
      if (out.includes('vaultd listening') && (!mesh || out.includes('mesh listening'))) { clearTimeout(to); resolve(); }
    });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`daemon exited ${c}: ${out}`)); });
  });
  return d;
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
    conn.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { conn.end(); } catch {} resolve(JSON.parse(buf.slice(0, i))); }
    });
    conn.on('error', reject);
    setTimeout(() => { try { conn.destroy(); } catch {} reject(new Error('rpc timeout')); }, timeoutMs);
  });
}
function ownerRpc(socket, obj) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(socket), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(socket), { ...obj, owner_token: token });
}
// Present once. Returns {pended, msgs} — a gate refusal lands as a
// single ok:false message.
function presentOnce(socket, pkgPath, outName) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = ''; const msgs = [];
    // The conn must stay OPEN while pended: the daemon deletes the
    // pending (and releases the claim) the moment the requester
    // disconnects. Only non-pended resolutions close it here.
    const done = (v) => { if (!v.pended) { try { conn.end(); } catch {} } resolve(v); };
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'unwrap', path: pkgPath, out: outName }) + '\n'));
    conn.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'pending-approval') { done({ pended: true, pend: m, msgs, conn }); return; }
        if (m.state === 'unwrapped' || m.beacon || m.ok === false) { setTimeout(() => done({ pended: false, msgs }), 30); return; }
      }
    });
    conn.on('error', () => resolve({ pended: false, msgs }));
    setTimeout(() => resolve({ pended: false, msgs, timeout: true }), 30000);
  });
}
async function approveWithRetry(socket, id, deadlineMs = 30000) {
  // A gate refusal does not consume the pending; the claim save made
  // at present time may simply not be countersigned yet. Retry only
  // anchor refusals — anything else is a real answer.
  const t0 = Date.now();
  let retries = 0;
  for (;;) {
    const ap = await ownerRpc(socket, { cmd: 'approve', id });
    if (ap.ok || !/anchor/.test(ap.error || '') || Date.now() - t0 > deadlineMs) return { ap, retries };
    retries++;
    await sleep(250);
  }
}

function awaitFinal(conn, priorMsgs) {
  return new Promise((resolve) => {
    let buf = ''; const msgs = [...priorMsgs];
    const done = () => { try { conn.end(); } catch {} resolve(msgs); };
    conn.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'unwrapped' || m.ok === false) { setTimeout(done, 30); return; }
      }
    });
    conn.on('error', done);
    setTimeout(done, 30000);
  });
}
async function presentWithRetry(socket, pkgPath, outName, maxMs = 30000) {
  const t0 = Date.now();
  let retries = 0;
  for (;;) {
    const r = await presentOnce(socket, pkgPath, outName);
    if (r.pended) return { ...r, retries };
    const last = r.msgs[r.msgs.length - 1];
    const anchorLag = last && /anchor/.test(last.error || '');
    if (!anchorLag || Date.now() - t0 > maxMs) return { ...r, retries, failed: true, lastError: last?.error || 'no-pend' };
    retries++;
    await sleep(250);
  }
}

async function main() {
  const t0 = Date.now();
  const summary = { cycles_target: CYCLES, cycles_ok: 0, cycles_failed: 0, retries: 0, probes: {}, duration_s: 0 };
  const S = mkStore('soak-sender');
  const V = mkStore('soak-vault');
  const AN = mkStore('soak-anchor');
  const idV = loadIdentity(V); const idAN = loadIdentity(AN);
  const portAN = 25500 + Math.floor(Math.random() * 2000);
  const addrAN = `127.0.0.1:${portAN}`;
  fs.writeFileSync(path.join(AN, 'policy.json'), JSON.stringify({
    estate: { mesh_listen: addrAN }, refit: { enabled: true, anchor_vault_sign_fp: idV.signFp },
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(V, 'policy.json'), JSON.stringify({
    refit: { enabled: true, anchor_sign_fp: idAN.signFp },
  }, null, 2), { mode: 0o600 });
  trust(V, 'anchor', AN, addrAN);
  trust(AN, 'vault', V);
  trust(S, 'vault', V);
  trust(V, 'sender', S);
  const dAN = await startDaemon(AN, { mesh: true });
  const dV = await startDaemon(V);
  const regFile = path.join(V, 'registry.json');
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-soak-work-'));

  const failures = [];
  try {
    for (let i = 1; i <= CYCLES; i++) {
      const content = `soak cycle ${i} — ${Date.now()}\n`;
      const f = path.join(W, `cycle-${i}.txt`);
      fs.writeFileSync(f, content);
      const w = armor(['wrap', f, '--to', 'vault', '--identity-dir', S, '--register-socket', dV.socket]);
      if (w.code !== 0) { summary.cycles_failed++; failures.push(`cycle ${i}: wrap failed: ${w.err.slice(0, 120)}`); continue; }
      const p = await presentWithRetry(dV.socket, `${f}.scripture`, `cycle-${i}-back.txt`);
      summary.retries += p.retries || 0;
      if (!p.pended) { summary.cycles_failed++; failures.push(`cycle ${i}: no pend: ${p.lastError || 'timeout'}`); continue; }
      const { ap, retries: apRetries } = await approveWithRetry(dV.socket, p.pend.id);
      summary.retries += apRetries;
      if (!ap.ok) { summary.cycles_failed++; failures.push(`cycle ${i}: approve failed: ${JSON.stringify(ap).slice(0, 120)}`); try { p.conn.end(); } catch {} continue; }
      const msgs = await awaitFinal(p.conn, p.msgs);
      const last = msgs[msgs.length - 1];
      let contentOk = false;
      try { contentOk = fs.readFileSync(path.join(V, 'out', `cycle-${i}-back.txt`), 'utf8') === content; } catch {}
      if (last?.state === 'unwrapped' && contentOk) summary.cycles_ok++;
      else { summary.cycles_failed++; failures.push(`cycle ${i}: final=${JSON.stringify(last).slice(0, 120)} contentOk=${contentOk}`); }
      if (i % 50 === 0) console.log(`  soak: ${i}/${CYCLES} cycles (ok=${summary.cycles_ok}, retries=${summary.retries})`);
    }

    // ---- tamper probes ------------------------------------------------
    const probePkg = async (name) => {
      const f = path.join(W, name);
      fs.writeFileSync(f, `probe ${name}\n`);
      armor(['wrap', f, '--to', 'vault', '--identity-dir', S, '--register-socket', dV.socket]);
      return `${f}.scripture`;
    };
    // P1: byte-format edit.
    {
      const pkg = await probePkg('probe-p1.txt');
      const okP = await presentWithRetry(dV.socket, pkg, 'probe-p1-back.txt', 15000);
      if (okP.pended) { await approveWithRetry(dV.socket, okP.pend.id); await awaitFinal(okP.conn, okP.msgs); }
      const pkg2 = await probePkg('probe-p1b.txt');
      const rawReg = fs.readFileSync(regFile, 'utf8');
      fs.writeFileSync(regFile, JSON.stringify(JSON.parse(rawReg), null, 4));
      const refused = await presentOnce(dV.socket, pkg2, 'probe-p1b-back.txt');
      const lastR = refused.msgs[refused.msgs.length - 1];
      summary.probes.P1_edit_refused = refused.pended === false && /anchor-divergence/.test(lastR?.error || '');
      fs.writeFileSync(regFile, rawReg);
      const recovered = await presentWithRetry(dV.socket, pkg2, 'probe-p1b-back.txt', 20000);
      summary.probes.P1_recovery = !!recovered.pended;
      if (recovered.pended) { await approveWithRetry(dV.socket, recovered.pend.id); await awaitFinal(recovered.conn, recovered.msgs); }
    }
    // P2: replayed older attestation.
    {
      const attBefore = fs.readFileSync(path.join(V, 'registry-anchor.json'), 'utf8');
      const pkg = await probePkg('probe-p2.txt');
      // wait until the new save is anchored (attestation seq == chain seq)
      let anchored = false;
      for (let i = 0; i < 60 && !anchored; i++) {
        const att = loadAttestation(V);
        const chain = verifyChain(registryChainFile(V));
        anchored = !!att && chain.ok && att.body.seq === chain.seq;
        if (!anchored) await sleep(300);
      }
      summary.probes.P2_setup_anchored = anchored;
      fs.writeFileSync(path.join(V, 'registry-anchor.json'), attBefore);
      const refused = await presentOnce(dV.socket, pkg, 'probe-p2-back.txt');
      summary.probes.P2_replay_refused = refused.pended === false && /anchor/.test(refused.msgs[refused.msgs.length - 1]?.error || '');
      // recovery: a fresh save triggers an anchor round that refreshes
      const pkg2 = await probePkg('probe-p2b.txt');
      summary.probes.P2_recovery = !!(await presentWithRetry(dV.socket, pkg2, 'probe-p2b-back.txt', 25000).then(async (r) => {
        if (r.pended) { await approveWithRetry(dV.socket, r.pend.id); await awaitFinal(r.conn, r.msgs); }
        return r.pended;
      }));
    }
    // P3: anchor offline.
    {
      await stopDaemon(dAN);
      await sleep(11000); // outlive the daemon's 10 s live-anchor cache
      const pkg = await probePkg('probe-p3.txt');
      const refused = await presentOnce(dV.socket, pkg, 'probe-p3-back.txt');
      summary.probes.P3_anchor_down_refused = refused.pended === false && /anchor/.test(refused.msgs[refused.msgs.length - 1]?.error || '');
      const dAN2 = await startDaemon(AN, { mesh: true });
      const pkg2 = await probePkg('probe-p3b.txt');
      const recovered = await presentWithRetry(dV.socket, pkg2, 'probe-p3b-back.txt', 30000);
      summary.probes.P3_recovery = !!recovered.pended;
      if (recovered.pended) { await approveWithRetry(dV.socket, recovered.pend.id); await awaitFinal(recovered.conn, recovered.msgs); }
      void dAN2;
    }
  } finally {
    for (const d of DAEMONS) { try { await stopDaemon(d); } catch {} }
  }
  summary.duration_s = Math.round((Date.now() - t0) / 1000);
  summary.failures = failures.slice(0, 10);
  const probesOk = Object.values(summary.probes).every(Boolean);
  console.log(`SOAK-SUMMARY ${JSON.stringify(summary)}`);
  console.log(`soak: ${summary.cycles_ok}/${summary.cycles_target} cycles ok, probes ${probesOk ? 'all pass' : 'FAIL: ' + JSON.stringify(summary.probes)}`);
  process.exit(summary.cycles_failed === 0 && probesOk ? 0 : 1);
}

main().catch((e) => { console.error(`soak error: ${e.stack || e.message}`); process.exit(1); });
