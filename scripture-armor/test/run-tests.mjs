#!/usr/bin/env node
// run-tests.mjs — end-to-end tests for Scripture Armor standalone.
// Zero-dependency; uses only node builtins and the tools in this repo.
//
// Coverage: the original 21 checks (identity/trust, single-file parity,
// wrap-repo -> verify -> unwrap-repo through per-package owner approvals,
// byte-for-byte restoration, tamper detection, wrong-recipient refusal)
// PLUS the closed-loop fix battery: egress registration with the daemon,
// return-match (never-issued / hash-mismatch / expiry-mismatch /
// replay-consumed all refused as beacon events), the outbox queue when the
// daemon is unreachable at wrap time, registry persistence across daemon
// restarts, claim-at-pend one-shot enforcement under concurrent
// presentation (the re-scan's F1: replay-claimed beacon, approve-both,
// claim release on window expiry and on requester disconnect), sender +
// registry status on the approval surface, raw-socket
// abuse handling (oversized frames, approve-after-window, double-approve),
// restore hardening (symlink components, setuid stripping, part.package
// containment, manifest count validation, restore scale in the approval
// prompt, the 20,000-zero-byte-file flood), trust refusing garbage key
// material, identity-store permissions, and the dns-profiles templates.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  parseScriptureFile, frameSignData, loadIdentity, loadAddressBook, sealPlaintext,
} from '../armor.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const ARMOR = path.join(ROOT, 'armor.mjs');
const VAULTD = path.join(ROOT, 'vaultd.mjs');
const NODE = process.execPath;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fpOfX = (x) => sha(Buffer.from(x, 'base64url'));
const modeOf = (p) => fs.statSync(p).mode & 0o7777;

async function run(file, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}
const armor = (args) => run(NODE, [ARMOR, ...args]);
const vaultd = (args) => run(NODE, [VAULTD, ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Approve every pending daemon request (by id) until `child` exits.
// Returns the number of approvals performed — the closed-loop receipt.
async function approveUntilDone(child, sockArgs) {
  const seen = new Set();
  let approvals = 0;
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
          approvals++;
        }
      }
    } catch { /* daemon momentarily unreachable mid-startup */ }
    await sleep(120);
  }
  return approvals;
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

// Re-sign a package's frame under a different identity's key (the A1/A2
// attack shape: frame fields edited, body + sealed key untouched).
function craftResigned(pkgPath, outPath, mutate, signerIdJson) {
  const { frame, body } = parseScriptureFile(fs.readFileSync(pkgPath, 'utf8'));
  mutate(frame);
  frame.sender_sign_pub = signerIdJson.sign_pub;
  frame.sender_sign_fp = fpOfX(signerIdJson.sign_pub);
  const priv = crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: signerIdJson.sign_pub, d: signerIdJson.sign_priv },
    format: 'jwk',
  });
  frame.sig = crypto.sign(null, frameSignData(frame, body), priv).toString('base64');
  fs.writeFileSync(outPath, `SCRIPTURE-ARMOR v1\n${JSON.stringify(frame)}\n${body}\n`);
  return frame;
}

function treeHashes(root) {
  const map = new Map();
  const walk = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(childRel);
      else if (ent.isFile()) {
        const data = fs.readFileSync(path.join(root, childRel));
        map.set(childRel.split(path.sep).join('/'), { size: data.length, sha256: sha(data) });
      }
    }
  };
  walk('');
  return map;
}

function readLog(idDir) {
  try { return fs.readFileSync(path.join(idDir, 'vaultd.log'), 'utf8'); } catch { return ''; }
}
function beaconLines(idDir, canary) {
  return readLog(idDir).split('\n').filter((l) => l.includes('"event":"beacon"') && (!canary || l.includes(canary)));
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('TIMEOUT: test suite exceeded 900 s — treating as failure');
    process.exit(2);
  }, 900_000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scripture-armor-test-'));
  console.log(`test dir: ${tmp}`);
  const idA = path.join(tmp, 'id-a');
  const idB = path.join(tmp, 'id-b');
  const idC = path.join(tmp, 'id-c');
  const sock = path.join(tmp, 'vaultd.sock');
  const daemonOut = path.join(tmp, 'daemon-out');
  const sockArgs = ['--socket', sock, '--identity-dir', idB];
  let daemon = null;
  let daemon2 = null;

  try {
    // ---- identities & trust ---------------------------------------------
    const a = await armor(['identity', '--label', 'sender-a', '--identity-dir', idA]);
    const b = await armor(['identity', '--label', 'vault-b', '--identity-dir', idB]);
    const c = await armor(['identity', '--label', 'other-c', '--identity-dir', idC]);
    check('identities created (A, B, C)', a.code === 0 && b.code === 0 && c.code === 0);
    const blockA = a.stdout.trim(), blockB = b.stdout.trim(), blockC = c.stdout.trim();
    const t1 = await armor(['trust', 'vault-b', blockB, '--identity-dir', idA]);
    const t2 = await armor(['trust', 'other-c', blockC, '--identity-dir', idA]);
    const t3 = await armor(['trust', 'sender-a', blockA, '--identity-dir', idB]);
    check('trust recorded (A->B, A->C, B->A)', t1.code === 0 && t2.code === 0 && t3.code === 0);
    const idAJson = JSON.parse(fs.readFileSync(path.join(idA, 'identity.json'), 'utf8'));
    const idCJson = JSON.parse(fs.readFileSync(path.join(idC, 'identity.json'), 'utf8'));
    const fpA = fpOfX(idAJson.sign_pub);

    // ---- fixture repo -----------------------------------------------------
    const src = path.join(tmp, 'fixture-repo');
    const files = new Map();
    const put = (rel, data) => {
      const abs = path.join(src, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      files.set(rel, data);
    };
    put('README.md', Buffer.from('# Fixture\nA tiny repo for armor tests.\n'));
    put('docs/read me.md', Buffer.from('path with a space in it\n'));
    put('src/app.js', Buffer.from('export const answer = 42;\nconsole.log(answer);\n'));
    put('src/deep/deeper/note.txt', Buffer.from('nested three levels down\n'));
    put('big.bin', crypto.randomBytes(10 * 1024 * 1024 + 123)); // >2 chunks at 4 MiB
    const binCycle = Buffer.alloc(256 * 40);
    for (let i = 0; i < binCycle.length; i++) binCycle[i] = i % 256;
    put('assets/blob.bin', Buffer.concat([binCycle, crypto.randomBytes(777)]));
    put('empty.txt', Buffer.alloc(0));
    fs.mkdirSync(path.join(src, 'assets/empty-dir'), { recursive: true });
    check('fixture built', files.size === 7, `${files.size} files incl. 10 MiB big.bin, binary blob, empty file, empty dir`);

    // ---- daemon up FIRST: egress registration needs it at wrap time -------
    daemon = await startDaemon(sock, daemonOut, idB);
    check('vaultd (identity B) serving', daemon.up);

    // ---- wrap-repo (registers every part + the manifest) ------------------
    const wrapped = path.join(tmp, 'wrapped');
    const wr = await armor(['wrap-repo', src, '--to', 'vault-b', '--out', wrapped,
      '--identity-dir', idA, '--register-socket', sock]);
    check('wrap-repo exits 0', wr.code === 0, wr.stderr.trim().split('\n')[0] || '');
    check('MANIFEST.scripture written', fs.existsSync(path.join(wrapped, 'MANIFEST.scripture')));
    const bigParts = [0, 1, 2].map((i) => path.join(wrapped, 'files', `big.bin.part000${i}.scripture`));
    check('big.bin split into 3 chunk packages', bigParts.every((p) => fs.existsSync(p)));
    check('wrap-repo registers its issuances with the daemon',
      wr.stderr.includes('registered:') && fs.existsSync(path.join(idB, 'registry.json')),
      wr.stderr.trim().split('\n').find((l) => l.includes('registered')) || '');
    const insp = await armor(['inspect', path.join(wrapped, 'MANIFEST.scripture'), '--identity-dir', idA]);
    check('manifest package signature VALID (inspect)', /signature:\s+VALID/.test(insp.stdout));

    // ---- verify (clean) -----------------------------------------------------
    const vOk = await armor(['verify', wrapped]);
    check('verify clean tree exits 0', vOk.code === 0, vOk.stdout.trim().split('\n').pop());
    check('verify reports big.bin OK in 3 parts', vOk.stdout.includes('big.bin') && vOk.stdout.includes('3 parts'));

    // ---- verify (tampered: one glyph flipped) -------------------------------
    const tampered = path.join(tmp, 'wrapped-tampered');
    fs.cpSync(wrapped, tampered, { recursive: true });
    const victimPkg = path.join(tampered, 'files', 'src', 'app.js.part0000.scripture');
    const vlines = fs.readFileSync(victimPkg, 'utf8').split('\n');
    const firstGlyph = [...vlines[2]][0];
    const replacement = firstGlyph === '\u{12000}' ? '\u{E000}' : '\u{12000}';
    vlines[2] = replacement + [...vlines[2]].slice(1).join('');
    fs.writeFileSync(victimPkg, vlines.join('\n'));
    const vBad = await armor(['verify', tampered]);
    check('verify tampered tree exits 1', vBad.code === 1);
    check('verify names tampered file as FAIL', vBad.stdout.includes('FAIL') && vBad.stdout.includes('src/app.js'),
      vBad.stdout.split('\n').find((l) => l.includes('app.js')) || '');

    // ---- wrong recipient: package sealed to C, daemon is B -------------------
    const secretPath = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secretPath, 'sealed for C only\n');
    const wC = await armor(['wrap', secretPath, '--to', 'other-c', '--identity-dir', idA]);
    check('single wrap to C exits 0', wC.code === 0);
    const wrong = await vaultd(['unwrap', `${secretPath}.scripture`, 'nope.bin', ...sockArgs]);
    check('daemon B refuses package sealed to C', wrong.stdout.includes('recipient-mismatch'),
      wrong.stdout.trim().split('\n').pop() || '');

    // ---- single-file roundtrip (v1 parity) + registry consumption -----------
    const notePath = path.join(tmp, 'note.txt');
    const noteData = Buffer.from('single-file parity check — unicode ✓ and glyphs stay outside\n');
    fs.writeFileSync(notePath, noteData);
    const wNote = await armor(['wrap', notePath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const noteCanary = (wNote.stderr.match(/canary:\s+(\S+)/) || [])[1];
    const unwrapChild = spawn(NODE, [VAULTD, 'unwrap', `${notePath}.scripture`, 'note-back.txt', ...sockArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let childOut = '';
    unwrapChild.stdout.on('data', (d) => { childOut += d; });
    const singleApprovals = await approveUntilDone(unwrapChild, sockArgs);
    const noteBack = fs.readFileSync(path.join(daemonOut, 'note-back.txt'));
    check('single-file roundtrip byte-identical', sha(noteBack) === sha(noteData),
      `approvals used: ${singleApprovals}, daemon said unwrapped: ${childOut.includes('"unwrapped"')}`);
    const regAfterNote = JSON.parse(fs.readFileSync(path.join(idB, 'registry.json'), 'utf8'));
    check('registry recorded the issuance and consumed it on return',
      !!regAfterNote.entries[noteCanary] && !!regAfterNote.entries[noteCanary].returned_at &&
      modeOf(path.join(idB, 'registry.json')) === 0o600,
      `canary ${String(noteCanary).slice(0, 8)}… returned_at set, registry mode 0600`);
    const replay = await vaultd(['unwrap', `${notePath}.scripture`, 'note-again.txt', ...sockArgs]);
    check('replay of a consumed package is a beacon refusal (replay-consumed)',
      replay.stdout.includes('beacon') && replay.stdout.includes('replay-consumed') &&
      beaconLines(idB, noteCanary).some((l) => l.includes('replay-consumed')),
      replay.stdout.trim().split('\n').pop() || '');

    // ---- unwrap-repo (the whole tree, per-package approvals) -----------------
    const restored = path.join(tmp, 'restored');
    const unwrapRepoChild = spawn(NODE, [ARMOR, 'unwrap-repo', wrapped, '--into', restored,
      '--socket', sock, '--daemon-out-dir', daemonOut, '--identity-dir', idB],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const urExit = new Promise((r) => unwrapRepoChild.on('exit', r));
    let urErr = '';
    unwrapRepoChild.stderr.on('data', (d) => { urErr += d; });
    const repoApprovals = await approveUntilDone(unwrapRepoChild, sockArgs);
    const urCode = await urExit;
    check('unwrap-repo exits 0', urCode === 0, urErr.trim().split('\n').pop() || '');
    check('every package individually owner-approved', repoApprovals === 9, `${repoApprovals} approvals for 1 manifest + 8 parts`);

    // ---- byte-for-byte tree comparison ----------------------------------------
    const before = treeHashes(src);
    const after = treeHashes(restored);
    let allMatch = before.size === after.size;
    for (const [rel, h] of before) {
      const a = after.get(rel);
      if (!a || a.sha256 !== h.sha256 || a.size !== h.size) allMatch = false;
    }
    check('restored tree byte-for-byte identical', allMatch, `${after.size}/${before.size} files, hashes compared per file`);
    check('empty file restored', fs.existsSync(path.join(restored, 'empty.txt')) && fs.statSync(path.join(restored, 'empty.txt')).size === 0);
    check('empty dir restored', fs.existsSync(path.join(restored, 'assets/empty-dir')));

    // ---- the log testifies ------------------------------------------------------
    const logNow = readLog(idB);
    check('daemon log testifies (refusal + unwraps recorded)',
      logNow.includes('recipient-mismatch') && (logNow.match(/"unwrapped"/g) || []).length >= 10,
      `${(logNow.match(/"unwrapped"/g) || []).length} unwrapped entries`);

    // ---- approval surface: sender fp + registry status ---------------------
    const pendPath = path.join(tmp, 'pend.txt');
    fs.writeFileSync(pendPath, 'pending-surface probe\n');
    await armor(['wrap', pendPath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const pendChild = spawn(NODE, [VAULTD, 'unwrap', `${pendPath}.scripture`, 'pend-back.txt', ...sockArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const pendExit = new Promise((r) => pendChild.on('exit', r));
    let pendEntry = null;
    for (let i = 0; i < 60 && !pendEntry; i++) {
      const p = await vaultd(['pending', ...sockArgs]);
      try {
        const msg = JSON.parse(p.stdout.trim().split('\n').pop());
        pendEntry = (msg.pending || []).find((e) => e.file === `${pendPath}.scripture`) || null;
      } catch {}
      if (!pendEntry) await sleep(120);
    }
    check('pending entry shows sender sign fingerprint + registry status',
      !!pendEntry && pendEntry.sender_sign_fp === fpA &&
      pendEntry.registry_status === 'issued-by-this-machine',
      pendEntry ? `sender ${String(pendEntry.sender_sign_fp).slice(0, 12)}… status ${pendEntry.registry_status}` : 'no pending entry seen');
    if (pendEntry) await vaultd(['approve', '--id', pendEntry.id, ...sockArgs]);
    await pendExit;
    const doubleApprove = pendEntry
      ? await vaultd(['approve', '--id', pendEntry.id, ...sockArgs]) : { stdout: '' };
    const noPending = await vaultd(['approve', '--id', '00000000-0000-0000-0000-000000000000', ...sockArgs]);
    check('double-approve and approve-with-no-pending are refused and logged',
      doubleApprove.stdout.includes('no-matching-pending-request') &&
      noPending.stdout.includes('no-matching-pending-request') &&
      readLog(idB).includes('refused: no-matching-pending-request'),
      '');

    // ---- A1: expiry edited + frame re-signed under an attacker key ---------
    const oldPath = path.join(tmp, 'old.txt');
    fs.writeFileSync(oldPath, 'this package expired in 2020\n');
    const wOld = await armor(['wrap', oldPath, '--to', 'vault-b', '--expires', '2020-01-01',
      '--identity-dir', idA, '--register-socket', sock]);
    const oldCanary = (wOld.stderr.match(/canary:\s+(\S+)/) || [])[1];
    const honestExpired = await vaultd(['unwrap', `${oldPath}.scripture`, 'old-back.txt', ...sockArgs]);
    check('honest expired package is refused as expired (registry matched first)',
      honestExpired.stdout.includes('"expired"') || honestExpired.stdout.includes('error":"expired'),
      honestExpired.stdout.trim().split('\n').pop() || '');
    const oldTampered = path.join(tmp, 'old-tampered.scripture');
    craftResigned(`${oldPath}.scripture`, oldTampered,
      (f) => { f.expiry = '2099-01-01T00:00:00.000Z'; }, idCJson);
    const a1 = await vaultd(['unwrap', oldTampered, 'old-stolen.txt', ...sockArgs]);
    const a1Beacon = beaconLines(idB, oldCanary).find((l) => l.includes('expiry-mismatch'));
    check('A1 re-signed expiry extension is a beacon refusal (expiry-mismatch), never unwrapped',
      a1.stdout.includes('beacon') && a1.stdout.includes('expiry-mismatch') && !!a1Beacon &&
      a1Beacon.includes('"surface"') && !fs.existsSync(path.join(daemonOut, 'old-stolen.txt')),
      a1.stdout.trim().split('\n').pop() || '');

    // ---- hash-mismatch: content-digest field edited + re-signed ------------
    // (Phase 4: v3 frames carry the keyed `commit`, not a cleartext
    // sha256 — the attack edits whichever digest field the frame has.)
    const victimPath = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victimPath, 'hash-mismatch victim\n');
    const wVictim = await armor(['wrap', victimPath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const victimCanary = (wVictim.stderr.match(/canary:\s+(\S+)/) || [])[1];
    const victimTampered = path.join(tmp, 'victim-tampered.scripture');
    craftResigned(`${victimPath}.scripture`, victimTampered,
      (f) => { if (f.commit != null) f.commit = sha(Buffer.from('forged plaintext')); else f.sha256 = sha(Buffer.from('forged plaintext')); }, idCJson);
    const hm = await vaultd(['unwrap', victimTampered, 'victim-stolen.txt', ...sockArgs]);
    check('edited content digest + re-signed frame is a beacon refusal (hash-mismatch)',
      hm.stdout.includes('beacon') && hm.stdout.includes('hash-mismatch') &&
      beaconLines(idB, victimCanary).some((l) => l.includes('hash-mismatch')) &&
      hm.stdout.includes('expected_digest'),
      hm.stdout.trim().split('\n').pop() || '');

    // ---- inspect emits a beacon record on signature invalid -----------------
    const inspLines = fs.readFileSync(`${oldPath}.scripture`, 'utf8').split('\n');
    const inspFrame = JSON.parse(inspLines[1]);
    inspFrame.expiry = '2099-01-01T00:00:00.000Z'; // edited, NOT re-signed
    inspLines[1] = JSON.stringify(inspFrame);
    const inspBadPath = path.join(tmp, 'old-inspect-bad.scripture');
    fs.writeFileSync(inspBadPath, inspLines.join('\n'));
    const inspBad = await armor(['inspect', inspBadPath, '--identity-dir', idA]);
    const beaconLogA = fs.existsSync(path.join(idA, 'beacon.log'))
      ? fs.readFileSync(path.join(idA, 'beacon.log'), 'utf8') : '';
    check('inspect beacons on signature-invalid (stderr + beacon.log)',
      /signature:\s+INVALID/.test(inspBad.stdout) && inspBad.stderr.includes('"event":"beacon"') &&
      inspBad.stderr.includes('signature-invalid') && beaconLogA.includes(oldCanary),
      '');

    // ---- outbox: daemon unreachable at wrap time ------------------------------
    const latePath = path.join(tmp, 'late.txt');
    const lateData = Buffer.from('wrapped before the restart\n');
    fs.writeFileSync(latePath, lateData);
    await armor(['wrap', latePath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    await stopDaemon(daemon); daemon = null;
    const ghostPath = path.join(tmp, 'ghost.txt');
    const ghostData = Buffer.from('wrapped while the daemon was down\n');
    fs.writeFileSync(ghostPath, ghostData);
    const wGhost = await armor(['wrap', ghostPath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const ghostCanary = (wGhost.stderr.match(/canary:\s+(\S+)/) || [])[1];
    const outboxFile = path.join(idA, 'registry-outbox.jsonl');
    check('daemon down at wrap time: issuance queued in the outbox, never silently skipped',
      wGhost.code === 0 && wGhost.stderr.includes('queued') && fs.existsSync(outboxFile) &&
      fs.readFileSync(outboxFile, 'utf8').includes(ghostCanary) && modeOf(outboxFile) === 0o600,
      '');
    daemon = await startDaemon(sock, daemonOut, idB);
    const neverIssued = await vaultd(['unwrap', `${ghostPath}.scripture`, 'ghost-back.txt', ...sockArgs]);
    check('A2 never-issued package is a beacon refusal (never-issued), not a routine approval',
      neverIssued.stdout.includes('beacon') && neverIssued.stdout.includes('never-issued') &&
      beaconLines(idB, ghostCanary).some((l) => l.includes('never-issued')) &&
      !fs.existsSync(path.join(daemonOut, 'ghost-back.txt')),
      neverIssued.stdout.trim().split('\n').pop() || '');
    const regSync = await armor(['register', `${ghostPath}.scripture`, '--socket', sock, '--identity-dir', idA]);
    check('outbox syncs on next daemon contact (register flushes the queue)',
      regSync.code === 0 && !fs.existsSync(outboxFile), regSync.stderr.trim().split('\n')[0] || '');
    const ghostChild = spawn(NODE, [VAULTD, 'unwrap', `${ghostPath}.scripture`, 'ghost-back.txt', ...sockArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const ghostExit = new Promise((r) => ghostChild.on('exit', r));
    await approveUntilDone(ghostChild, sockArgs);
    await ghostExit;
    check('synced package then unwraps normally, byte-identical',
      fs.existsSync(path.join(daemonOut, 'ghost-back.txt')) &&
      sha(fs.readFileSync(path.join(daemonOut, 'ghost-back.txt'))) === sha(ghostData), '');

    // ---- registry persistence across a daemon restart -------------------------
    await stopDaemon(daemon); daemon = null;
    daemon = await startDaemon(sock, daemonOut, idB);
    const replayAfterRestart = await vaultd(['unwrap', `${ghostPath}.scripture`, 'ghost-again.txt', ...sockArgs]);
    const lateChild = spawn(NODE, [VAULTD, 'unwrap', `${latePath}.scripture`, 'late-back.txt', ...sockArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const lateExit = new Promise((r) => lateChild.on('exit', r));
    await approveUntilDone(lateChild, sockArgs);
    await lateExit;
    check('registry persists across restart: consumed stays consumed, issued stays issuable',
      replayAfterRestart.stdout.includes('replay-consumed') &&
      fs.existsSync(path.join(daemonOut, 'late-back.txt')) &&
      sha(fs.readFileSync(path.join(daemonOut, 'late-back.txt'))) === sha(lateData),
      '');

    // ---- F1: claim-at-pend — one-shot return under concurrent presentation ----
    // The re-scan's gating finding: two concurrent presentations of one
    // issued package both pended, and approving both unwrapped both. Now a
    // pend atomically claims the registry entry; the twin beacon-refuses.
    const racePath = path.join(tmp, 'race.txt');
    const raceData = Buffer.from('one-shot race probe\n');
    fs.writeFileSync(racePath, raceData);
    const wRace = await armor(['wrap', racePath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const raceCanary = (wRace.stderr.match(/canary:\s+(\S+)/) || [])[1];
    const raceSpawn = (outName) => {
      const child = spawn(NODE, [VAULTD, 'unwrap', `${racePath}.scripture`, outName, ...sockArgs],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const state = { out: '', exited: false };
      child.stdout.on('data', (d) => { state.out += d; });
      child.on('exit', () => { state.exited = true; });
      return state;
    };
    const race1 = raceSpawn('race1.bin');
    const race2 = raceSpawn('race2.bin');
    for (let i = 0; i < 80 && !(race1.exited || race2.exited); i++) await sleep(100);
    const raceLoser = race1.exited ? race1 : race2;
    const raceWinner = race1.exited ? race2 : race1;
    check('F1 concurrent double-presentation: the second beacon-refuses replay-claimed, never pends a twin',
      (race1.exited !== race2.exited) && raceLoser.out.includes('replay-claimed') &&
      beaconLines(idB, raceCanary).some((l) => l.includes('replay-claimed')),
      raceLoser.out.trim().split('\n').pop() || '');
    let racePendId = null;
    for (let i = 0; i < 40 && !racePendId; i++) {
      const p = await vaultd(['pending', ...sockArgs]);
      try {
        const msg = JSON.parse(p.stdout.trim().split('\n').pop());
        const e = (msg.pending || []).find((x) => x.canary === raceCanary);
        if (e) racePendId = e.id;
      } catch {}
      if (!racePendId) await sleep(100);
    }
    const regClaimed = JSON.parse(fs.readFileSync(path.join(idB, 'registry.json'), 'utf8'));
    check('F1 the live pending holds the registry claim (claim.id == pending id, not yet returned)',
      !!racePendId && !!regClaimed.entries[raceCanary].claim &&
      regClaimed.entries[raceCanary].claim.id === racePendId &&
      !regClaimed.entries[raceCanary].returned_at, '');
    if (racePendId) await vaultd(['approve', '--id', racePendId, ...sockArgs]);
    for (let i = 0; i < 80 && !raceWinner.exited; i++) await sleep(100);
    const raceOutputs = ['race1.bin', 'race2.bin'].filter((n) => fs.existsSync(path.join(daemonOut, n)));
    const raceSecondApprove = racePendId
      ? await vaultd(['approve', '--id', racePendId, ...sockArgs]) : { stdout: '' };
    const regAfterRace = JSON.parse(fs.readFileSync(path.join(idB, 'registry.json'), 'utf8'));
    check('F1 approve-both attempt: exactly one output is ever produced; the second approval is refused; entry consumed, claim cleared',
      raceWinner.exited && raceWinner.out.includes('"unwrapped"') && raceOutputs.length === 1 &&
      sha(fs.readFileSync(path.join(daemonOut, raceOutputs[0]))) === sha(raceData) &&
      raceSecondApprove.stdout.includes('no-matching-pending-request') &&
      !!regAfterRace.entries[raceCanary].returned_at && !regAfterRace.entries[raceCanary].claim,
      `${raceOutputs.length} output(s) in the daemon out dir`);

    // F1: claim release when the requester goes away unapproved (refusal path)
    const discPath = path.join(tmp, 'disc.txt');
    const discData = Buffer.from('claim refusal probe\n');
    fs.writeFileSync(discPath, discData);
    const wDisc = await armor(['wrap', discPath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const discCanary = (wDisc.stderr.match(/canary:\s+(\S+)/) || [])[1];
    const discChild = spawn(NODE, [VAULTD, 'unwrap', `${discPath}.scripture`, 'disc-back.txt', ...sockArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let discOut = '';
    discChild.stdout.on('data', (d) => { discOut += d; });
    for (let i = 0; i < 60 && !discOut.includes('pending-approval'); i++) await sleep(100);
    const discClaimed = JSON.parse(fs.readFileSync(path.join(idB, 'registry.json'), 'utf8'));
    const discHeldClaim = !!discClaimed.entries[discCanary].claim;
    discChild.kill('SIGTERM'); // owner never approves; the requester goes away
    let discReg = null;
    for (let i = 0; i < 40; i++) {
      discReg = JSON.parse(fs.readFileSync(path.join(idB, 'registry.json'), 'utf8'));
      if (!discReg.entries[discCanary].claim) break;
      await sleep(100);
    }
    const discChild2 = spawn(NODE, [VAULTD, 'unwrap', `${discPath}.scripture`, 'disc-back.txt', ...sockArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const discExit2 = new Promise((r) => discChild2.on('exit', r));
    await approveUntilDone(discChild2, sockArgs);
    await discExit2;
    check('F1 claim released when the requester goes away unapproved: re-presentation pends and unwraps byte-identical',
      discHeldClaim && !!discReg && !discReg.entries[discCanary].claim &&
      !discReg.entries[discCanary].returned_at &&
      fs.existsSync(path.join(daemonOut, 'disc-back.txt')) &&
      sha(fs.readFileSync(path.join(daemonOut, 'disc-back.txt'))) === sha(discData), '');

    // F1: claim release on approval-window expiry (short-window daemon)
    const sock3 = path.join(tmp, 'vaultd3.sock');
    const daemonOut3 = path.join(tmp, 'daemon-out3');
    let daemon3 = null;
    try {
      daemon3 = await startDaemon(sock3, daemonOut3, idB, '800');
      const sock3Args = ['--socket', sock3, '--identity-dir', idB];
      const expPath = path.join(tmp, 'expire.txt');
      fs.writeFileSync(expPath, 'claim expiry probe\n');
      const wExp = await armor(['wrap', expPath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
      const expCanary = (wExp.stderr.match(/canary:\s+(\S+)/) || [])[1];
      const expChild = spawn(NODE, [VAULTD, 'unwrap', `${expPath}.scripture`, 'exp-back.txt', ...sock3Args],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let expOut = '';
      expChild.stdout.on('data', (d) => { expOut += d; });
      await new Promise((r) => expChild.on('exit', r));
      let expReg = null;
      for (let i = 0; i < 40; i++) {
        expReg = JSON.parse(fs.readFileSync(path.join(idB, 'registry.json'), 'utf8'));
        if (!expReg.entries[expCanary].claim) break;
        await sleep(100);
      }
      const expChild2 = spawn(NODE, [VAULTD, 'unwrap', `${expPath}.scripture`, 'exp-back.txt', ...sock3Args],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let expOut2 = '';
      expChild2.stdout.on('data', (d) => { expOut2 += d; });
      for (let i = 0; i < 60 && !expOut2.includes('pending-approval') && !expOut2.includes('beacon'); i++) await sleep(100);
      check('F1 claim released on window expiry (not consumed): re-presentation pends normally',
        expOut.includes('approval-timeout') && !!expReg && !expReg.entries[expCanary].claim &&
        !expReg.entries[expCanary].returned_at && expOut2.includes('pending-approval'),
        expOut2.trim().split('\n').pop() || '');
      expChild2.kill('SIGTERM');
      await sleep(300);
    } finally {
      if (daemon3) await stopDaemon(daemon3);
    }

    // ---- raw socket abuse ------------------------------------------------------
    const oversized = await new Promise((resolve) => {
      const conn = net.createConnection(sock);
      let closedByServer = false;
      const done = (v) => resolve(v);
      conn.on('connect', () => { try { conn.write('x'.repeat(2 * 1024 * 1024)); } catch {} });
      conn.on('close', () => { closedByServer = true; done(true); });
      conn.on('error', () => {});
      setTimeout(() => done(closedByServer), 4000);
    });
    const statusAfter = await vaultd(['status', ...sockArgs]);
    check('oversized unterminated frame: connection dropped, daemon alive, abuse logged',
      oversized && statusAfter.stdout.includes('"ok":true') &&
      readLog(idB).includes('oversized-frame'), '');
    // approve-after-window on a second daemon with a 400 ms window
    const sock2 = path.join(tmp, 'vaultd2.sock');
    const daemonOut2 = path.join(tmp, 'daemon-out2');
    daemon2 = await startDaemon(sock2, daemonOut2, idB, '400');
    const sock2Args = ['--socket', sock2, '--identity-dir', idB];
    const winPath = path.join(tmp, 'win.txt');
    fs.writeFileSync(winPath, 'window probe\n');
    await armor(['wrap', winPath, '--to', 'vault-b', '--identity-dir', idA, '--register-socket', sock]);
    const winChild = spawn(NODE, [VAULTD, 'unwrap', `${winPath}.scripture`, 'win-back.txt', ...sock2Args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let winOut = '';
    winChild.stdout.on('data', (d) => { winOut += d; });
    const winExit = new Promise((r) => winChild.on('exit', r));
    let winId = null;
    for (let i = 0; i < 40 && !winId; i++) {
      const m = winOut.match(/"id":"([0-9a-f-]{36})"/);
      if (m) winId = m[1]; else await sleep(100);
    }
    await sleep(700); // let the 400 ms window expire
    const lateApprove = winId ? await vaultd(['approve', '--id', winId, ...sock2Args]) : { stdout: '' };
    await winExit;
    check('approve-after-window refused; the request died on schedule',
      winOut.includes('approval-timeout') && lateApprove.stdout.includes('no-matching-pending-request'),
      '');
    await stopDaemon(daemon2); daemon2 = null;

    // ---- restore hardening ------------------------------------------------------
    const unwrapRepoRun = async (wrappedDir, intoDir) => {
      const child = spawn(NODE, [ARMOR, 'unwrap-repo', wrappedDir, '--into', intoDir,
        '--socket', sock, '--daemon-out-dir', daemonOut, '--identity-dir', idB],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const exitP = new Promise((r) => child.on('exit', r));
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      const approvals = await approveUntilDone(child, sockArgs);
      const code = await exitP;
      return { code, err, approvals };
    };

    // B3: setuid bit in the source mode must never survive a restore
    const srcSuid = path.join(tmp, 'fixture-suid');
    fs.mkdirSync(srcSuid, { recursive: true });
    const suidFile = path.join(srcSuid, 'suid.sh');
    fs.writeFileSync(suidFile, '#!/bin/sh\necho hi\n');
    fs.chmodSync(suidFile, 0o4755);
    const wrappedSuid = path.join(tmp, 'wrapped-suid');
    await armor(['wrap-repo', srcSuid, '--to', 'vault-b', '--out', wrappedSuid,
      '--identity-dir', idA, '--register-socket', sock]);
    const restoredSuid = path.join(tmp, 'restored-suid');
    const suidRun = await unwrapRepoRun(wrappedSuid, restoredSuid);
    const restoredSuidMode = fs.existsSync(path.join(restoredSuid, 'suid.sh'))
      ? modeOf(path.join(restoredSuid, 'suid.sh')) : -1;
    check('B3 manifest modes masked to 0o777 on restore (setuid planted file comes back 0755)',
      suidRun.code === 0 && restoredSuidMode === 0o755,
      `restored mode ${restoredSuidMode >= 0 ? '0' + restoredSuidMode.toString(8) : 'missing'}`);
    check('wrap-repo writes the RESTORE-INFO scale sidecar',
      fs.existsSync(path.join(wrappedSuid, 'RESTORE-INFO.json')) &&
      JSON.parse(fs.readFileSync(path.join(wrappedSuid, 'RESTORE-INFO.json'), 'utf8')).fileCount === 1, '');

    // B2: pre-existing symlink component inside the restore target
    const srcLink = path.join(tmp, 'fixture-link');
    fs.mkdirSync(path.join(srcLink, 'linkdir'), { recursive: true });
    fs.writeFileSync(path.join(srcLink, 'linkdir', 'x.txt'), 'must never land outside\n');
    const wrappedLink = path.join(tmp, 'wrapped-link');
    await armor(['wrap-repo', srcLink, '--to', 'vault-b', '--out', wrappedLink,
      '--identity-dir', idA, '--register-socket', sock]);
    const outsideDir = path.join(tmp, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    const restoredLink = path.join(tmp, 'restored-link');
    fs.mkdirSync(restoredLink, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(restoredLink, 'linkdir'));
    const linkRun = await unwrapRepoRun(wrappedLink, restoredLink);
    check('B2 restore refuses to cross a symlink component; nothing escapes',
      linkRun.code !== 0 && linkRun.err.includes('symlink') &&
      !fs.existsSync(path.join(outsideDir, 'x.txt')),
      linkRun.err.trim().split('\n').pop() || '');

    // B4 + counts: hand-crafted manifests via the real seal operation
    const meA = loadIdentity(idA);
    const peerB = loadAddressBook(idA)['vault-b'];
    const craftTree = async (wrappedDir, manifest, partPkgText, partRel) => {
      fs.mkdirSync(path.join(wrappedDir, 'files'), { recursive: true });
      if (partPkgText && partRel) {
        const p = path.join(wrappedDir, partRel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, partPkgText);
      }
      const mPkg = sealPlaintext(Buffer.from(JSON.stringify(manifest, null, 2)), meA, peerB);
      fs.writeFileSync(path.join(wrappedDir, 'MANIFEST.scripture'), mPkg.text);
      return mPkg;
    };
    const baseManifest = (over) => ({
      format: 'scripture-armor-repo/1', created: new Date().toISOString(), chunkSize: 4194304,
      sender_sign_fp: meA.signFp, recipient_seal_fp: JSON.parse(fs.readFileSync(path.join(idB, 'identity.json'), 'utf8')).seal_pub
        ? fpOfX(JSON.parse(fs.readFileSync(path.join(idB, 'identity.json'), 'utf8')).seal_pub) : null,
      expiry: null, dirs: [], files: [], skipped: [], fileCount: 0, totalBytes: 0, partCount: 0, ...over,
    });

    // B4: part.package points OUTSIDE the wrapped tree
    const loot = Buffer.from('loot contents\n');
    const lootPart = sealPlaintext(loot, meA, peerB);
    const outsidePkgs = path.join(tmp, 'outside-pkgs');
    fs.mkdirSync(outsidePkgs, { recursive: true });
    fs.writeFileSync(path.join(outsidePkgs, 'loot.part0000.scripture'), lootPart.text);
    const wrappedTrav = path.join(tmp, 'wrapped-trav');
    const travManifest = baseManifest({
      files: [{
        path: 'loot.txt', size: loot.length, sha256: sha(loot), mode: 0o644,
        parts: [{ package: '../outside-pkgs/loot.part0000.scripture', size: loot.length, sha256: sha(loot), canary: lootPart.frame.canary }],
      }],
      fileCount: 1, totalBytes: loot.length, partCount: 1,
    });
    const travMPkg = await craftTree(wrappedTrav, travManifest, null, null);
    await armor(['register', path.join(wrappedTrav, 'MANIFEST.scripture'),
      path.join(outsidePkgs, 'loot.part0000.scripture'), '--socket', sock, '--identity-dir', idA]);
    const restoredTrav = path.join(tmp, 'restored-trav');
    const travRun = await unwrapRepoRun(wrappedTrav, restoredTrav);
    check('B4 part.package escaping the wrapped tree is refused before any read',
      travRun.code !== 0 && travRun.err.includes('escapes the wrapped tree') &&
      !fs.existsSync(path.join(restoredTrav, 'loot.txt')),
      travRun.err.trim().split('\n').pop() || '');

    // counts: manifest declares 999 files, contains 1
    const wrappedCounts = path.join(tmp, 'wrapped-counts');
    const countsManifest = baseManifest({
      files: [{
        path: 'loot.txt', size: loot.length, sha256: sha(loot), mode: 0o644,
        parts: [{ package: 'files/loot.txt.part0000.scripture', size: loot.length, sha256: sha(loot), canary: lootPart.frame.canary }],
      }],
      fileCount: 999, totalBytes: loot.length, partCount: 1,
    });
    await craftTree(wrappedCounts, countsManifest, lootPart.text, 'files/loot.txt.part0000.scripture');
    // the same part package canary is already registered from the B4 tree;
    // register this tree's manifest package too
    await armor(['register', path.join(wrappedCounts, 'MANIFEST.scripture'), '--socket', sock, '--identity-dir', idA]);
    const countsRun = await unwrapRepoRun(wrappedCounts, path.join(tmp, 'restored-counts'));
    check('manifest count mismatch aborts the restore before anything is written',
      countsRun.code !== 0 && countsRun.err.includes('manifest count mismatch') &&
      !fs.existsSync(path.join(tmp, 'restored-counts', 'loot.txt')),
      countsRun.err.trim().split('\n').pop() || '');

    // C: the 20,000-zero-byte-file flood, with scale in the approval prompt
    const srcFlood = path.join(tmp, 'fixture-flood');
    fs.mkdirSync(srcFlood, { recursive: true });
    for (let i = 0; i < 20000; i++) {
      fs.writeFileSync(path.join(srcFlood, `f${String(i).padStart(5, '0')}.txt`), '');
    }
    const wrappedFlood = path.join(tmp, 'wrapped-flood');
    await armor(['wrap-repo', srcFlood, '--to', 'vault-b', '--out', wrappedFlood,
      '--identity-dir', idA, '--register-socket', sock]);
    const restoredFlood = path.join(tmp, 'restored-flood');
    const floodChild = spawn(NODE, [ARMOR, 'unwrap-repo', wrappedFlood, '--into', restoredFlood,
      '--socket', sock, '--daemon-out-dir', daemonOut, '--identity-dir', idB],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const floodExit = new Promise((r) => floodChild.on('exit', r));
    let floodErr = '';
    floodChild.stderr.on('data', (d) => { floodErr += d; });
    let floodContext = null;
    let floodApprovals = 0;
    {
      const seen = new Set();
      let exited = false;
      floodChild.on('exit', () => { exited = true; });
      while (!exited) {
        const p = await vaultd(['pending', ...sockArgs]);
        try {
          const msg = JSON.parse(p.stdout.trim().split('\n').pop());
          for (const entry of msg.pending || []) {
            if (entry.context && String(entry.context).includes('files')) floodContext = entry.context;
            if (!seen.has(entry.id)) {
              seen.add(entry.id);
              await vaultd(['approve', '--id', entry.id, ...sockArgs]);
              floodApprovals++;
            }
          }
        } catch {}
        await sleep(120);
      }
    }
    const floodCode = await floodExit;
    const floodCount = fs.existsSync(restoredFlood) ? fs.readdirSync(restoredFlood).length : 0;
    check('C flood: restore scale (file count + bytes) is stated in the manifest approval prompt',
      !!floodContext && floodContext.includes('20000 files'),
      floodContext || 'no context seen on the pending entry');
    check('C flood: 20,000 zero-byte files restore only under that informed single approval',
      floodCode === 0 && floodApprovals === 1 && floodCount === 20000,
      `${floodCount} files restored, ${floodApprovals} approval(s), exit ${floodCode}`);

    // ---- trust refuses garbage -----------------------------------------------
    const g1 = await armor(['trust', 'junk', '!!!not-a-real-block!!!', '--identity-dir', idA]);
    const fakeBlock = Buffer.from(JSON.stringify(
      { v: 1, seal_pub: 'AAAA', sign_pub: 'BBBB', label: 'fake' })).toString('base64');
    const g2 = await armor(['trust', 'fake', fakeBlock, '--identity-dir', idA]);
    check('trust refuses garbage blocks and fake key material (G)',
      g1.code !== 0 && g2.code !== 0 && g2.stderr.includes('invalid key material'),
      `garbage exit ${g1.code}, fake-key exit ${g2.code}`);

    // ---- identity-store permissions (G) ----------------------------------------
    check('identity store permissions: dir 0700, identity/registry/log/out files 0600',
      modeOf(idB) === 0o700 && modeOf(path.join(idB, 'identity.json')) === 0o600 &&
      modeOf(path.join(idB, 'registry.json')) === 0o600 &&
      modeOf(path.join(idB, 'vaultd.log')) === 0o600 &&
      modeOf(path.join(daemonOut, 'note-back.txt')) === 0o600, '');

    // ---- dns-profiles -------------------------------------------------------------
    const dnsDir = path.join(ROOT, 'dns-profiles');
    const mcPath = path.join(dnsDir, 'scripture-armor-dns.mobileconfig');
    const pyCheck = await run('python3', ['-c',
      'import plistlib,sys\n' +
      'd=plistlib.load(open(sys.argv[1],"rb"))\n' +
      'dns=d["PayloadContent"][0]["DNSSettings"]\n' +
      'assert dns["DNSProtocol"]=="HTTPS", dns\n' +
      'assert "example-loop.invalid" in dns["ServerURL"], dns["ServerURL"]\n' +
      'assert "DNS" in d["PayloadDisplayName"]\n' +
      'print("plist-ok")', mcPath]);
    check('dns mobileconfig parses (plistlib); DoH endpoint is the marked placeholder',
      pyCheck.code === 0 && pyCheck.stdout.includes('plist-ok'),
      (pyCheck.stderr || '').trim().split('\n').pop() || '');
    const dnsFiles = fs.readdirSync(dnsDir).filter((f) => fs.statSync(path.join(dnsDir, f)).isFile());
    let dnsAllPlaceholder = dnsFiles.length >= 5;
    let dnsNoRealHosts = true;
    for (const f of dnsFiles) {
      const t = fs.readFileSync(path.join(dnsDir, f), 'utf8');
      if (!t.includes('example-loop.invalid')) dnsAllPlaceholder = false;
      for (const m of t.matchAll(/https?:\/\/([^\s/"'<]+)/g)) {
        if (!m[1].includes('example-loop.invalid') && m[1] !== 'www.apple.com') dnsNoRealHosts = false;
      }
    }
    check('every dns profile carries the operator placeholder; no production address anywhere',
      dnsAllPlaceholder && dnsNoRealHosts, `${dnsFiles.length} files scanned`);
  } finally {
    if (daemon2) await stopDaemon(daemon2);
    if (daemon) await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.ok);
  clearTimeout(watchdog);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    console.log(`artifacts kept for inspection: ${tmp}`);
    process.exit(1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL TESTS PASSED');
}

main().catch((err) => {
  console.error(`test harness error: ${err.stack || err.message}`);
  process.exit(1);
});
