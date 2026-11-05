#!/usr/bin/env node
// vaultd.mjs — the Scripture Armor vault daemon (the matching copy).
// Zero-dependency Node >= 22 (node:crypto only).
//
// This daemon holds ONE installation's identity and is the only thing that
// can open files sealed to that identity. It listens on a Unix domain socket.
//
// Scripture Armor is a CLOSED LOOP: this daemon is the loop's boundary
// keeper. When a package is issued for this loop, its hash is REGISTERED
// with the daemon at egress (`register` command, sent by armor.mjs at wrap
// time; see registry.json in the identity dir). When a package comes back,
// the daemon performs the RETURN-MATCH before anything else: the presented
// frame's canary, plaintext SHA-256, expiry, and sender must equal what
// this machine issued. A packet this loop never issued, a packet whose
// frame no longer matches its issuance, and a packet that was already
// returned once (replay) are all refused as BEACON EVENTS — a distinct
// record in the testimony log naming the canary, the reason class, the
// presented path, and this receiving surface. Sight, not strike.
//
// Only a package that passes the return-match reaches the second gate: the
// daemon validates it (frame signature valid, not expired) and HOLDS the
// request as pending until the owner approves locally with:
//
//     node vaultd.mjs approve [--socket <path>] [--id <request-id>]
//
// Pending is a CLAIM, not just a state: the moment a package pends, its
// registry entry is atomically marked claimed by that pending request, so
// a second presentation of the same canary — even concurrently, on
// another connection — beacon-refuses (replay-claimed) instead of pending
// a twin. No approval inside the window (default 120 s) and the request
// dies AND the claim is released: a released claim is not a consumption —
// the package has not returned until an unwrap succeeds, and may pend
// again. A successful unwrap consumes the registry entry and clears the
// claim in the same write (one-shot return). Every attempt — registered,
// matched, claimed, beaconed, approved, unwrapped, refused, timed out,
// failed — is written to the log. The log testifies.
//
// Approval here is a LOCAL owner action on the host. Any fleet-scale consent
// mechanism belongs to the deployment, not to this public tool.
//
// Run:    node vaultd.mjs serve [--identity-dir <dir>]
//                 [--socket <path>] [--out-dir <dir>] [--approval-window-ms <n>]
// Client: node vaultd.mjs <status|pending|approve|recovery|unwrap> …

import net from 'node:net';
import { assertProductIdentityDir } from './product-paths.mjs';
import { openAttemptsFeed } from './shield-attempts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadIdentity, defaultIdentityDir, parseScriptureFile, verifyFrameSignature,
  armorDecode, unsealFileKey, openSealedFile, loadAddressBook, sealPlaintext,
  sha256Hex, signPayload, verifyPayload, meshRpc, fingerprintOfRaw,
  frameDigestKind, storeIntegrityKey, outboxSummary,
  loadRevocations, saveRevocations, signRevocation, revocationFor,
  verifyRevocation, loadEstateState, saveEstateState, appendIssuedLog, loadIssuedLog,
  commitFor, frameDigest, verifyLocalRegister, signLocalRegister,
  ownerDirFor, ownerSocketFor, ownerTokenPathFor, ownerConfirmPathFor, readOwnerConfirm,
} from './armor.mjs';
import { loadPolicy, classifyBuffer, scanDigestOf, scanFile, tierParams } from './scan.mjs';
import {
  probeCells, createStaging, stagePayload, writeMarker, readMarker,
  listCellMarkers, destroyStaging, runSoftCell, runHardCell,
} from './cell.mjs';
import {
  TERMS_TEXT, TERMS_VERSION, termsSha256, recordAcceptance, hasCurrentAcceptance,
} from './terms.mjs';

function parseFlags(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    } else pos.push(args[i]);
  }
  return { flags, pos };
}

// ---------------------------------------------------------------------------
// Client modes (status / pending / approve / unwrap)
// ---------------------------------------------------------------------------

function rpc(socketPath, obj, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    const lines = [];
    conn.on('connect', () => conn.write(JSON.stringify(obj) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        lines.push(msg);
        console.log(JSON.stringify(msg));
        if (!stream) { conn.end(); resolve(lines); return; }
        if (msg.state === 'unwrapped' || msg.state === 'activation-complete'
          || msg.state === 'session-open' || msg.ok === false) { conn.end(); resolve(lines); return; }
      }
    });
    conn.on('error', reject);
    conn.on('close', () => resolve(lines));
  });
}

async function clientMain(cmd, flags, pos) {
  const dir = assertProductIdentityDir(flags['identity-dir'] ? path.resolve(flags['identity-dir']) : defaultIdentityDir());
  const socketPath = flags.socket ? path.resolve(flags.socket) : path.join(dir, 'vaultd.sock');
  // Owner acts ride the OWNER channel (FIX 1): this CLI reads the
  // per-daemon owner token from beside the owner socket and presents
  // it there. The requester socket refuses every one of these.
  const orpc = (obj, opts) => {
    let token = null;
    try { token = fs.readFileSync(ownerTokenPathFor(socketPath), 'utf8').trim(); } catch {}
    if (!token) throw new Error(`owner channel unavailable: no owner token beside ${socketPath} — is the daemon running?`);
    return rpc(ownerSocketFor(socketPath), { ...obj, owner_token: token }, opts);
  };
  if (cmd === 'log-verify') {
    // M.26 owner act: verify the live log's hash chain + HMAC seals.
    // Names the exact line where the chain first breaks; a clean chain
    // proves no line was altered, inserted, reordered, or truncated
    // after the fact. Sealed history lives in log-segments/ as v4
    // packages and opens through the ordinary owner unwrap flow.
    const idv = loadIdentity(dir);
    if (!idv) { console.error('no identity in ' + dir); process.exit(1); }
    const key = Buffer.from(crypto.hkdfSync('sha256',
      Buffer.from(idv.seal_priv, 'base64url'), Buffer.from('scripture-armor/log'),
      Buffer.from('scripture-armor/log/v1'), 32));
    const lf = path.join(dir, 'vaultd.log');
    const lines = fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').split('\n').filter(Boolean) : [];
    let prevHash = null;
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { console.log(`CHAIN BREAK at line ${i + 1}: unparseable`); process.exit(1); }
      if (!rec.mac || !rec.prev) { console.log(`CHAIN BREAK at line ${i + 1}: unsealed record (pre-M.26 or forged)`); process.exit(1); }
      if (i > 0 && rec.prev !== prevHash) { console.log(`CHAIN BREAK at line ${i + 1}: prev does not match the previous line's hash`); process.exit(1); }
      const { mac, ...rest } = rec;
      const expect = crypto.createHmac('sha256', key).update(JSON.stringify(rest)).digest('hex');
      if (expect !== mac) { console.log(`CHAIN BREAK at line ${i + 1}: HMAC mismatch — this record was altered after writing`); process.exit(1); }
      prevHash = crypto.createHash('sha256').update(lines[i]).digest('hex');
    }
    const segDir = path.join(dir, 'log-segments');
    const segs = fs.existsSync(segDir) ? fs.readdirSync(segDir).filter((f) => f.endsWith('.scripture')).length : 0;
    console.log(`log chain OK: ${lines.length} live record(s) verified, 0 breaks; ${segs} sealed history segment(s) in log-segments/`);
    return;
  }
  if (cmd === 'status') await orpc({ cmd: 'status' });
  else if (cmd === 'attempts') await orpc({ cmd: 'attempts' });
  else if (cmd === 'pending') await orpc({ cmd: 'pending' });
  else if (cmd === 'recovery') {
    await orpc({ cmd: 'recovery' });
  }
  else if (cmd === 'approve') {
    const lines = await orpc({ cmd: 'approve', id: flags.id || pos[0] || null, confirm: flags.confirm || null });
    const stage1 = lines.find((m) => m.approved_stage === 1);
    if (stage1) {
      // The code never travels a socket: the owner's own CLI reads it
      // from the owner channel state and shows it on the owner's
      // terminal; the owner enters it for stage 2.
      const rec = readOwnerConfirm(socketPath, stage1.id);
      if (rec?.code) {
        console.log(`dual approval: stage 1 recorded. One-time confirmation code (from the owner channel): ${rec.code}`);
        console.log(`  stage 2: vaultd.mjs approve --id ${stage1.id} --confirm ${rec.code}`);
      }
    }
  }
  else if (cmd === 'clear-anomaly') await orpc({ cmd: 'clear-anomaly', canary: flags.canary || pos[0] || null });
  else if (cmd === 'terms') await rpc(socketPath, { cmd: 'terms' });
  else if (cmd === 'accept-terms') {
    // The agent acceptance handshake (Robbie's ruling, 2026-10-24):
    // the agent is presented the terms (above), reads them, and
    // returns an explicit acceptance bound to the terms' content
    // hash. No acceptance = no activation for that agent. The
    // acceptance itself is recorded over the owner channel (FIX 1) —
    // an agent's acceptance is an owner-domain act.
    if (!flags.agent) throw new Error('usage: accept-terms --agent <label>');
    const t = await rpc(socketPath, { cmd: 'terms' });
    const termsMsg = t.find((m) => m.terms_sha256);
    if (!termsMsg) throw new Error('daemon did not present terms');
    await orpc({
      cmd: 'accept-terms', agent: String(flags.agent),
      terms_sha256: termsMsg.terms_sha256, accept: true,
    });
  }
  else if (cmd === 'unwrap') {
    if (!pos[0]) throw new Error('usage: unwrap <file.scripture> [out-name]');
    await rpc(socketPath, { cmd: 'unwrap', path: path.resolve(pos[0]), out: pos[1] || null }, { stream: true });
  }
  else if (cmd === 'activate') {
    if (!pos[0]) throw new Error('usage: activate <file.scripture> [--entry <relpath>]');
    await rpc(socketPath, {
      cmd: 'activate', path: path.resolve(pos[0]),
      entry: flags.entry || null,
    }, { stream: true });
  }
  else if (cmd === 'revoke-grant') {
    await orpc({ cmd: 'revoke-grant', canary: flags.canary || pos[0] || null });
  }
  else if (cmd === 'revoke') {
    // The estate-wide owner act (SPEC §4.5): create a signed revocation
    // record for a member and distribute it over the mesh.
    if (!pos[0]) throw new Error('usage: revoke <label> [--reason <text>]');
    await orpc({ cmd: 'revoke', label: pos[0], reason: flags.reason || null });
  }
  else if (cmd === 'mesh-sync') {
    if (!flags.to) throw new Error('usage: mesh-sync --to <label>');
    await orpc({ cmd: 'mesh-sync', to: String(flags.to) });
  }
  else if (cmd === 'estate-status') {
    await orpc({ cmd: 'estate-status' });
  }
  else if (cmd === 'dock-open') {
    if (!flags.profile) throw new Error('usage: dock-open --profile <name>');
    await rpc(socketPath, { cmd: 'dock-open', profile: String(flags.profile) }, { stream: true });
  }
  else if (cmd === 'dock-send') {
    if (!flags.session || !pos[0]) throw new Error('usage: dock-send --session <id> <file>');
    await rpc(socketPath, { cmd: 'dock-send', session: String(flags.session), path: path.resolve(pos[0]) });
  }
  else if (cmd === 'dock-close') {
    await rpc(socketPath, { cmd: 'dock-close', session: flags.session || pos[0] || null });
  }
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

function serve(flags) {
  const dir = assertProductIdentityDir(flags['identity-dir'] ? path.resolve(flags['identity-dir']) : defaultIdentityDir());
  const socketPath = flags.socket ? path.resolve(flags.socket) : path.join(dir, 'vaultd.sock');
  const outDir = flags['out-dir'] ? path.resolve(flags['out-dir']) : path.join(dir, 'out');
  const windowMs = flags['approval-window-ms'] ? Number(flags['approval-window-ms']) : 120000;

  // Socket placement (FIX 1 rider): the default socket lives inside
  // the 0700 identity store. A socket path whose parent directory is
  // group/world-accessible exposes the requester API to every local
  // user who can guess the path — the daemon refuses to serve there.
  {
    const socketDir = path.dirname(socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const mode = fs.statSync(socketDir).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(`error: refusing to serve: the daemon socket directory ${socketDir} is not private (mode ${mode.toString(8)}).`);
      console.error('  A daemon socket outside a private (0700) directory exposes the API to other local users.');
      console.error('  Serve from the identity store (the default) or another 0700 directory.');
      // Exit 78 (EX_CONFIG): a configuration-class refusal that
      // restarting cannot fix — the systemd units carry
      // RestartPreventExitStatus=78 for exactly this exit and the
      // no-identity exit below.
      process.exit(78);
    }
  }

  const id = loadIdentity(dir);
  if (!id) {
    console.error(`error: no identity in ${dir} — run armor.mjs identity first`);
    // Exit 78 (EX_CONFIG): see the socket-directory refusal above.
    process.exit(78);
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // Shield-Builder B2 — the attempts feed (scripture-armor.attempts/1):
  // daemon refusals persist as testimony in <identityDir>/attempts.json
  // (folded, capped, durable). Recording never throws into a refusal
  // path and the feed is never a trust input. Owner read: {"cmd":"attempts"}.
  const attemptsFeed = openAttemptsFeed(dir, {
    cap: flags['attempts-cap'] ? Number(flags['attempts-cap']) : 500,
    windowMs: flags['attempts-window-ms'] ? Number(flags['attempts-window-ms']) : 600000,
  });
  const logFile = path.join(dir, 'vaultd.log');
  const startedAt = Date.now();
  const pending = new Map();
  // M.19 budgets: defenses fire only on evidence, and abuse burns only
  // the abuser's budget. Pendings per origin are capped (excess is shed
  // and counted, never shown to the owner as individual approvals), and
  // registrations per sender per hour are capped (registry bloat is a
  // cost imposed on the store, so it is budgeted like everything else).
  const PENDING_CAP_PER_ORIGIN = 32;
  const REGISTER_BUDGET_PER_SENDER_HOUR = 10000;
  let shedPendings = 0;

  // Recovery candidates (Gemini fix 1): a presented package whose
  // canary this loop never registered beacons never-issued — that
  // testimony never changes. But when the frame's signature verifies,
  // the sender is this copy or an enrolled peer, and the store's
  // integrity stands, the daemon ALSO records a recovery candidate:
  // the owner may approve it on the owner channel, and only that
  // approval derives the issuance from the package itself and
  // registers it (the outbox-desync loop-hole, closed by the owner's
  // act instead of a dead end). Candidates are bounded, expire with
  // the approval window's horizon, and vanish the moment their canary
  // registers or is consumed through any ordinary path.
  // Verify grants (Gemini fix 3): an owner-approved verify-open arms
  // the package's one-shot return for the approval window — the
  // consuming unwrap that follows immediately (unwrap-repo verifying
  // a manifest against its sidecar before spending the return) runs
  // every return-match gate again and executes under the SAME owner
  // decision: digest-bound, single-use, window-bound. The verify
  // itself never consumes; a grant that is never used just expires.
  const verifyGrants = new Map(); // canary -> {digest, expiresAt}
  const recoveryCandidates = new Map(); // id -> {id, canary, filePath, outName, sender_sign_fp, digest, createdAt}
  const RECOVERY_CANDIDATE_CAP = 32;
  function dropRecoveryCandidates(canaries) {
    const set = new Set(canaries);
    for (const [cid, cand] of recoveryCandidates) {
      if (set.has(cand.canary)) recoveryCandidates.delete(cid);
    }
  }
  function pruneRecoveryCandidates() {
    const horizon = Date.now() - Math.max(windowMs, 3600_000);
    for (const [cid, cand] of recoveryCandidates) {
      if (cand.createdAt < horizon) recoveryCandidates.delete(cid);
    }
  }
  // The issuance a package testifies about itself — the same
  // derivation `armor register` performs from a package's frame.
  function issuanceFromFrame(frame) {
    return {
      canary: frame.canary,
      digest: frameDigest(frame),
      digest_kind: frameDigestKind(frame),
      recipient_seal_fp: frame.recipient_seal_fp,
      sender_sign_fp: frame.sender_sign_fp,
      expiry: frame.expiry ?? null,
      issued_at: frame.created || new Date().toISOString(),
      origin: 'egress',
      scan: frame.scan_verdict != null
        ? { verdict: frame.scan_verdict, digest: frame.scan_digest ?? null, report_canary: frame.scan_report ?? null }
        : null,
      tier: frame.armor_tier != null ? { tier: frame.armor_tier, params: null } : null,
      repo: null, report_for: null, report_only: false, estate: null,
    };
  }

  // M.26 — the armor's logs get the armor's discipline. Every record is
  // a link in an append-only hash chain, HMAC-sealed under a key derived
  // from this identity: alter, insert, reorder, or truncate any line and
  // verification names the exact line where the chain breaks. On daemon
  // start, a non-empty previous log is rotated into log-segments/ and
  // SEALED as an ordinary v4 package to this same identity — at rest,
  // history is ciphertext; the live segment is chained and confesses
  // tampering (verify with: vaultd.mjs log-verify --identity-dir <dir>).
  const logKey = Buffer.from(crypto.hkdfSync('sha256',
    Buffer.from(id.seal_priv, 'base64url'), Buffer.from('scripture-armor/log'),
    Buffer.from('scripture-armor/log/v1'), 32));
  let logPrev = 'GENESIS';
  function log(event) {
    const rec = { ts: new Date().toISOString(), ...event, prev: logPrev };
    const mac = crypto.createHmac('sha256', logKey).update(JSON.stringify(rec)).digest('hex');
    const line = JSON.stringify({ ...rec, mac });
    logPrev = crypto.createHash('sha256').update(line).digest('hex');
    fs.appendFileSync(logFile, line + '\n', { mode: 0o600 });
  }
  function rotateLogSegment() {
    try {
      if (!fs.existsSync(logFile) || fs.statSync(logFile).size === 0) return;
      const segDir = path.join(dir, 'log-segments');
      fs.mkdirSync(segDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const raw = fs.readFileSync(logFile);
      const sealed = sealPlaintext(raw, id, id, {});
      const segPath = path.join(segDir, `vaultd-${stamp}.scripture`);
      fs.writeFileSync(segPath, sealed.text, { mode: 0o600 });
      fs.rmSync(logFile);
      logPrev = crypto.createHash('sha256').update(raw).digest('hex');
    } catch { /* testimony is never destroyed by a failed rotation */ }
  }
  rotateLogSegment();

  // --- Issued-hash registry (the loop's memory of what it sent out) -------
  // registry.json in the identity dir, mode 0600, rewritten atomically on
  // every mutation and re-read on every operation, so it survives daemon
  // restarts and stays consistent if more than one local daemon serves the
  // same identity. Entry: {canary, sha256, recipient_seal_fp, sender_sign_fp,
  // expiry, issued_at, returned_at, claim?} — returned_at null until the
  // one successful return consumes it; claim {id, at} present only while a
  // pending request holds the entry (claim-at-pend, see handleUnwrap).
  const registryFile = path.join(dir, 'registry.json');

  // Store integrity + read cache (Gemini fixes 2b/5; register #1).
  // The registry carries an HMAC tag keyed from this identity (the
  // M.26 pattern, via armor's store key), verified on every load.
  // Loads are cached on (mtime, size): an untouched file is parsed
  // once, not once per request — and an external edit invalidates the
  // cache and is re-verified, never silently trusted (the estate
  // battery edits this file on disk mid-run and the daemon must SEE
  // those edits: forged entries surfacing as sync conflicts, deleted
  // entries beaconing never-issued and being repaired by sync).
  // A tag mismatch therefore does NOT brick the store: it is logged
  // loudly, surfaced on the owner status, and fails closed exactly
  // where the registry would be TRUSTED — a package whose entry sits
  // in a tampered registry never opens — while registration and the
  // estate sync/repair machinery keep running, and saveRegistry
  // re-tags (heals) the store on the next legitimate write. This is
  // tamper-EVIDENCE, not the M.1 countersigned store (designed,
  // unbuilt).
  const registryKey = storeIntegrityKey(id.seal_priv);
  let registryCache = null; // {mtimeMs, size, doc (integrity field stripped), integrityOk}
  let registryIntegrityState = 'ok';
  // Whether a tagged store has been seen or written this run. A file
  // that arrives UNTAGGED before that is a pre-tag (legacy) store and
  // migrates; a file that arrives untagged AFTER it was externally
  // rewritten — the tag was stripped — and that is tamper, not legacy.
  let registryWasTagged = false;
  function registryCanonical(doc) {
    const copy = { ...doc };
    delete copy.integrity;
    return JSON.stringify(copy);
  }
  function noteRegistryIntegrity(ok, why) {
    const state = ok ? 'ok' : 'failed';
    if (state === registryIntegrityState) return;
    registryIntegrityState = state;
    if (!ok) {
      console.error(`store-integrity: registry.json failed its integrity check (${why}) — entries will not be trusted for opening until the store is repaired`);
      log({ event: 'store-integrity', result: 'failed: registry.json HMAC mismatch', detail: why });
    } else {
      log({ event: 'store-integrity', result: 'ok: registry.json integrity restored' });
    }
  }
  function writeRegistryFile(doc) {
    const out = { ...doc };
    delete out.integrity;
    out.integrity = crypto.createHmac('sha256', registryKey).update(registryCanonical(out), 'utf8').digest('hex');
    const tmp = `${registryFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, registryFile);
    try { fs.chmodSync(registryFile, 0o600); } catch {}
    registryWasTagged = true;
    try {
      const st = fs.statSync(registryFile);
      const cachedDoc = { ...out };
      delete cachedDoc.integrity;
      registryCache = { mtimeMs: st.mtimeMs, size: st.size, doc: cachedDoc, integrityOk: true };
    } catch { registryCache = null; }
    noteRegistryIntegrity(true);
  }
  function loadRegistry() {
    let st = null;
    try { st = fs.statSync(registryFile); } catch {}
    if (st && registryCache && registryCache.mtimeMs === st.mtimeMs && registryCache.size === st.size) {
      return structuredClone(registryCache.doc);
    }
    if (!st) {
      // No store file. Fresh installs live here; a store that existed
      // tagged and then vanished was removed outside the daemon.
      registryCache = null;
      if (registryWasTagged) noteRegistryIntegrity(false, 'registry.json disappeared — the store was removed outside the daemon');
      return { v: 1, entries: {} };
    }
    let doc = null;
    for (let attempt = 0; attempt < 2 && !doc; attempt++) {
      try {
        const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.entries) doc = parsed;
      } catch {}
    }
    if (!doc) {
      registryCache = null;
      if (registryWasTagged) noteRegistryIntegrity(false, 'registry.json is unparseable — the store was altered outside the daemon');
      return { v: 1, entries: {} };
    }
    if (doc.integrity === undefined) {
      if (registryWasTagged) {
        // The tag was stripped by an external rewrite: tamper, not
        // legacy. Entries still load (sync/repair must see them);
        // trust decisions fail closed via registryIntegrityOk().
        const clean = { ...doc };
        registryCache = { mtimeMs: st.mtimeMs, size: st.size, doc: clean, integrityOk: false };
        noteRegistryIntegrity(false, 'integrity tag missing — the registry was rewritten outside the daemon');
        return structuredClone(clean);
      }
      // Pre-tag store: migrate in place (tag added; entries untouched).
      const clean = { ...doc };
      try { writeRegistryFile(clean); } catch { return clean; }
      return structuredClone(clean);
    }
    registryWasTagged = true;
    const expect = crypto.createHmac('sha256', registryKey).update(registryCanonical(doc), 'utf8').digest('hex');
    const integrityOk = expect === doc.integrity;
    const clean = { ...doc };
    delete clean.integrity;
    registryCache = { mtimeMs: st.mtimeMs, size: st.size, doc: clean, integrityOk };
    noteRegistryIntegrity(integrityOk, 'HMAC mismatch — the registry was altered outside the daemon');
    return structuredClone(clean);
  }
  // Fail-closed read for trust decisions: false whenever the store's
  // integrity state stands failed — tag mismatch, stripped tag,
  // unparseable, or vanished-after-tagged. (A store that never
  // existed is an empty store, not a tampered one.)
  function registryIntegrityOk() {
    loadRegistry();
    if (registryIntegrityState !== 'ok') return false;
    return registryCache ? registryCache.integrityOk !== false : true;
  }
  function saveRegistry(reg) {
    writeRegistryFile(reg);
  }
  // Verify once at startup so a tampered store is loud from boot,
  // not discovered at the first presentation.
  loadRegistry();
  if (registryIntegrityState !== 'ok') {
    console.error('store-integrity: registry.json FAILED its integrity check at startup — entries will not be trusted for opening until the store is repaired (see vaultd.log)');
  }

  // Release a pending request's claim on a registry entry. Only the claim
  // holder (matching pending id) can release; a release is NOT a
  // consumption — returned_at is untouched, so the package may pend again.
  // Returns true if a claim was actually released.
  function releaseClaim(canary, pendingId) {
    const reg = loadRegistry();
    const e = reg.entries[canary];
    if (e && e.claim && e.claim.id === pendingId) {
      delete e.claim;
      saveRegistry(reg);
      return true;
    }
    return false;
  }

  // --- Closure 4 state (SPEC §4) -----------------------------------------
  // Revocations + estate view live in store files (revocations.json,
  // estate.json), re-read per operation like the registry. Enforcement
  // knows identities by FINGERPRINT, never by label; a revocation
  // record counts only when its signature verifies against a known key
  // for its signer (this identity, or an address-book member).
  function resolveSignPub(fp) {
    if (fp === id.signFp) return id.sign_pub;
    const book = loadAddressBook(dir);
    for (const p of Object.values(book)) {
      if (p.sign_pub && fingerprintOfRaw(Buffer.from(p.sign_pub, 'base64url')) === fp) return p.sign_pub;
    }
    return null;
  }
  function revocationInForce(signFp) {
    if (!signFp || signFp === id.signFp) return null;
    return revocationFor(loadRevocations(dir), signFp, resolveSignPub);
  }
  function peerByLabel(label) {
    const peer = loadAddressBook(dir)[label];
    return peer ? { label, peer } : null;
  }
  function peerBySignFp(fp) {
    const book = loadAddressBook(dir);
    for (const [label, peer] of Object.entries(book)) {
      if (peer.sign_pub && fingerprintOfRaw(Buffer.from(peer.sign_pub, 'base64url')) === fp) return { label, peer };
    }
    return null;
  }
  function peerBySealFp(fp) {
    const book = loadAddressBook(dir);
    for (const [label, peer] of Object.entries(book)) {
      if (peer.seal_pub && fingerprintOfRaw(Buffer.from(peer.seal_pub, 'base64url')) === fp) return { label, peer };
    }
    return null;
  }
  function estateConfigured() {
    return !!(pol().estate?.mesh_listen
      || fs.existsSync(path.join(dir, 'estate.json'))
      || loadRevocations(dir).records.length);
  }
  // Staleness (SPEC §4.5): the estate's revocation knowledge is only as
  // fresh as the last completed sync-registry. A daemon that has never
  // synced starts fresh at daemon start (its revocations.json is the
  // owner's local act) and goes stale revocation_max_stale later if it
  // never syncs — the bound is on silence, not on birth.
  function estateStale() {
    const max = pol().estate?.revocation_max_stale;
    if (max == null) return false;
    const st = loadEstateState(dir);
    const base = st.last_sync_any ? Date.parse(st.last_sync_any) : startedAt;
    return Date.now() - base > max * 1000;
  }
  function estateView() {
    const st = loadEstateState(dir);
    const revs = loadRevocations(dir);
    const members = Object.values(st.members).map((m) => ({
      label: m.label, seal_fp: m.seal_fp, sign_fp: m.sign_fp, tier: m.tier ?? 1,
      state: m.state ?? 'verified',
      last_sync: st.last_sync[m.sign_fp] ?? null,
      revocation_pending: Object.entries(st.revocation_acks)
        .filter(([, acks]) => !acks[m.sign_fp]).map(([rid]) => rid),
    }));
    // The owner is always a member of their own estate view.
    if (!members.some((m) => m.sign_fp === id.signFp)) {
      members.unshift({
        label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp,
        tier: st.self_tier ?? 1, state: 'self', last_sync: null, revocation_pending: [],
      });
    }
    const tier3ByLabel = new Map();
    for (const t of pol().estate?.tier3 || []) {
      tier3ByLabel.set(t.label, {
        label: t.label, tier: 3, keys: false, can_open: false,
        coverage: 'mesh-governed (routing/DNS/exit via the mesh host) + on-device posture (dns-profiles/)',
        note: t.note ?? null,
      });
    }
    for (const t of st.tier3 || []) tier3ByLabel.set(t.label, t);
    return {
      self: { label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp, tier: st.self_tier ?? 1 },
      members,
      mesh_host: st.mesh_host ?? null,
      tier3: [...tier3ByLabel.values()],
      revocations: revs.records.length,
      stale: estateStale(),
      last_sync_any: st.last_sync_any ?? null,
      mesh_listen: pol().estate?.mesh_listen ?? null,
    };
  }

  // --- Closure 2/3 state ---------------------------------------------------
  // Policy is re-read per operation, like the registry (SPEC §0.4).
  const pol = () => loadPolicy(dir);
  const substrates = probeCells();
  const cellsRoot = path.join(dir, 'cells');
  fs.mkdirSync(cellsRoot, { recursive: true, mode: 0o700 });
  const activations = new Map(); // activationId -> live run state
  const docks = new Map(); // sessionId -> airlock session state
  const airlockLogFile = path.join(dir, 'airlock.jsonl');
  function airlockRecord(rec) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
    try { fs.appendFileSync(airlockLogFile, line + '\n', { mode: 0o600 }); } catch {}
  }
  // Orphan reaper (SPEC §2.4 step 8): a cell whose daemon died keeps its
  // staging + marker. On start, any marker whose heartbeat is older than
  // the lease window is reaped — child killed, staging destroyed — and
  // the reap is testified. A live daemon heartbeats its markers, so a
  // fresh marker is left strictly alone.
  {
    const leaseMs = (pol().cell?.lease_s ?? 30) * 1000;
    for (const m of listCellMarkers(cellsRoot)) {
      const hb = Date.parse(m.marker.heartbeat_at || m.marker.started_at || 0);
      if (Number.isFinite(hb) && Date.now() - hb > leaseMs) {
        if (m.marker.pid) {
          try { process.kill(-m.marker.pid, 'SIGKILL'); } catch {}
          try { process.kill(m.marker.pid, 'SIGKILL'); } catch {}
        }
        const destroyed = destroyStaging(m.root);
        log({
          event: 'cell-orphan-reaped', activation: m.activationId,
          canary: m.marker.canary ?? null, cell_class: m.marker.cell_class ?? null,
          destroyed,
        });
      }
    }
  }

  // The one open operation, shared by unwrap and by cell materialization
  // (SPEC §2.4 step 4): AEAD open + digest re-verification. The digest
  // equality IS the "verified image" — the bytes about to run are
  // provably the bytes that were issued, scanned, and granted.
  function openPackage(frame, payload) {
    const fileKey = unsealFileKey(id, frame);
    const plaintext = openSealedFile(fileKey, frame, payload);
    // Content integrity (Phase 4, FIX 3): a v3 frame verifies its
    // keyed commitment — recomputable only here, where the file key
    // exists; a v1/v2 frame verifies its legacy cleartext hash.
    if (frame.commit != null) {
      if (commitFor(fileKey, plaintext) !== frame.commit) throw new Error('plaintext-commit-mismatch');
    } else {
      const digest = crypto.createHash('sha256').update(plaintext).digest('hex');
      if (digest !== frame.sha256) throw new Error('plaintext-hash-mismatch');
    }
    return plaintext;
  }

  // The digest a registry entry answers to: the keyed commitment for
  // v3 issuances, the legacy plaintext hash for v1/v2 (normalized at
  // insert; the fallback keeps pre-Phase-4 registry files readable).
  function entryDigestOf(e) {
    return e ? (e.digest ?? e.sha256 ?? null) : null;
  }

  // Insert issuance entries into a loaded registry (the same field
  // discipline as handleRegister). `via` names the authenticated path
  // the entries arrived by — owner channel, sender signature, estate
  // mesh, estate sync, or a daemon-internal origin (egress/airlock) —
  // and is recorded on the entry as provenance (FIX 1): the approval
  // surface names it, and "issued" claims are only ever made for
  // entries that arrived over an authenticated path. Returns
  // {registered, refused}.
  function insertIssuances(reg, entries, via = 'owner', fromSignFp = null) {
    const registered = [];
    const refused = [];
    for (const e of entries) {
      const eDigest = entryDigestOf(e);
      if (!e || !e.canary || !eDigest || !e.recipient_seal_fp) {
        refused.push({ canary: e?.canary ?? null, error: 'register: entry missing canary/digest/recipient_seal_fp' });
        continue;
      }
      if (e.recipient_seal_fp !== id.sealFp) {
        refused.push({ canary: e.canary, error: 'register-recipient-mismatch: entry is not sealed to this copy' });
        continue;
      }
      const prior = reg.entries[e.canary];
      if (prior) {
        if (entryDigestOf(prior) !== eDigest || (prior.expiry ?? null) !== (e.expiry ?? null)
          || (prior.scan?.digest ?? null) !== (e.scan?.digest ?? null)
          || (prior.tier?.tier ?? null) !== (e.tier?.tier ?? null)) {
          refused.push({ canary: e.canary, error: 'register-conflict: canary already issued with different digest/expiry/scan/tier' });
          continue;
        }
        registered.push(e.canary);
        continue;
      }
      {
        const senderKey = fromSignFp ?? e.sender_sign_fp ?? 'unknown';
        const hourAgo = Date.now() - 3600_000;
        let recent = 0;
        for (const x of Object.values(reg.entries)) {
          if ((x.registered_from ?? x.sender_sign_fp) === senderKey && Date.parse(x.issued_at || 0) > hourAgo) recent++;
        }
        if (recent >= REGISTER_BUDGET_PER_SENDER_HOUR) {
          refused.push({ canary: e.canary, error: 'register-budget-exceeded: per-sender registration budget for this epoch is exhausted (M.19)' });
          continue;
        }
      }
      reg.entries[e.canary] = {
        canary: e.canary,
        digest: eDigest,
        digest_kind: e.digest_kind ?? (e.digest != null ? 'commit' : 'sha256'),
        registered_via: via,
        registered_from: fromSignFp ?? e.sender_sign_fp ?? null,
        recipient_seal_fp: e.recipient_seal_fp,
        sender_sign_fp: e.sender_sign_fp ?? null,
        expiry: e.expiry ?? null,
        issued_at: e.issued_at || new Date().toISOString(),
        returned_at: null,
        origin: e.origin || 'egress',
        scan: e.scan ?? null,
        tier: e.tier ?? null,
        repo: e.repo ?? null,
        report_for: e.report_for ?? null,
        report_only: e.report_only ?? false,
        superseded_by: null,
        anomaly: null,
        estate: e.estate ?? null,
        quarantined: e.quarantined ?? null,
        grants: null,
        activations: [],
        lease: null,
        candidate: e.candidate ?? false,
      };
      registered.push(e.canary);
    }
    return { registered, refused };
  }

  // Per-access report re-verification (SPEC §1.6/§1.7.2, battery case
  // 22b): open the bound scan-report package, recompute its digest over
  // the canonical record, and compare against the registry's bound
  // digest. A tampered, swapped, or missing report fails here — before
  // any cell is involved.
  function verifyReport(frame, issued, pkgPath, plaintextSha256Hex = null) {
    const digestBound = issued?.scan?.digest ?? null;
    const reportCanary = issued?.scan?.report_canary ?? null;
    if (!digestBound || !reportCanary) {
      return { ok: false, reason: 'report-missing: no scan report is bound to this issuance' };
    }
    const reportPath = pkgPath.replace(/\.scripture$/, '.scan-report.scripture');
    let parsed;
    try { parsed = parseScriptureFile(fs.readFileSync(reportPath, 'utf8')); }
    catch { return { ok: false, reason: `report-missing: no report package beside the target (${path.basename(reportPath)})` }; }
    const rf = parsed.frame;
    if (rf.canary !== reportCanary) return { ok: false, reason: 'report-mismatch: sibling report canary differs from the bound report' };
    if (rf.recipient_seal_fp !== id.sealFp) return { ok: false, reason: 'report-mismatch: report was not sealed to this copy' };
    if (!verifyFrameSignature(rf, parsed.body)) return { ok: false, reason: 'report-mismatch: report frame signature invalid' };
    let record;
    try {
      const payload = armorDecode(parsed.body, Buffer.from(rf.armor_seed, 'base64'));
      record = JSON.parse(openPackage(rf, payload).toString('utf8'));
    } catch (e) {
      return { ok: false, reason: `report-mismatch: report does not open (${e.message})` };
    }
    if (scanDigestOf(record) !== digestBound) {
      return { ok: false, reason: 'report-mismatch: recomputed report digest differs from the bound digest' };
    }
    // The report names its target by plaintext SHA-256 — inside the
    // sealed report, where it is not an oracle. A v3 frame no longer
    // carries that hash in the clear, so a caller that has opened the
    // package passes the hash of the opened bytes (4th argument);
    // legacy frames compare against the frame's own field.
    const targetHash = plaintextSha256Hex ?? frame.sha256 ?? null;
    if (targetHash && record.target_sha256 !== targetHash) {
      return { ok: false, reason: 'report-mismatch: report describes different bytes than this package' };
    }
    return { ok: true, record };
  }

  // --- v2 helpers --------------------------------------------------------
  // Re-seal due instant for a tiered entry (from the params snapshot
  // recorded at registration — the daemon enforces numbers).
  function resealDueAt(entry) {
    const h = entry?.tier?.params?.reseal_hours;
    if (h == null || !entry?.issued_at) return null; // 0 hours is a real value: due immediately
    return Date.parse(entry.issued_at) + h * 3600 * 1000;
  }
  function resealOverdue(entry) {
    const due = resealDueAt(entry);
    return due != null && Date.now() > due && !entry.returned_at;
  }
  // Anomaly hold (SPEC §1.7.2): a beacon naming a Tier-2 canary sets
  // `anomaly` on its entry; the entry — and every entry of its repo —
  // refuses further unwraps/activations until the owner clears it.
  function anomalyBlocked(reg, entry) {
    if (!entry) return false;
    if (entry.anomaly) return true;
    if (entry.repo) {
      return Object.values(reg.entries).some((e) => e.repo === entry.repo && e.anomaly);
    }
    return false;
  }
  // Revoked sender (SPEC §4.5): a key revoked for compromise at time T
  // taints what it issued AFTER T — those issuances beacon-refuse as
  // `revoked-sender`. What it issued BEFORE T is history: still
  // returnable, with the fact in front of the owner at the prompt
  // (REVOKED SENDER notice via buildNotices). Returns the revocation
  // record when this issuance is post-revocation, else null.
  function revokedSenderBeacon(issued) {
    if (!issued || !issued.sender_sign_fp) return null;
    const rev = revocationInForce(issued.sender_sign_fp);
    if (!rev) return null;
    return Date.parse(issued.issued_at || 0) > Date.parse(rev.at) ? rev : null;
  }
  function buildNotices(issued, frame) {
    const notices = [];
    if (issued) {
      const rev = issued.sender_sign_fp ? revocationInForce(issued.sender_sign_fp) : null;
      if (rev && !revokedSenderBeacon(issued)) {
        notices.push(`REVOKED SENDER: this identity was revoked at ${rev.at}${rev.reason ? ` — "${rev.reason}"` : ''}. This package was issued BEFORE the revocation, so it may still return — adjudicate it yourself, with that fact in front of you.`);
      }
      if (issued.scan) {
        notices.push(`scan: verdict ${issued.scan.verdict}${issued.scan.digest ? ` (report digest ${String(issued.scan.digest).slice(0, 16)}…)` : ''}`);
        if (frame && frame.scan_override) notices.push(`scan override by owner: "${frame.scan_override.reason}"`);
      } else if (frame && frame.v >= 2) {
        notices.push('scan: no scan record bound to this package (unscanned)');
      } else {
        notices.push('scan: v1 package — no scan record (unscanned, untiered)');
      }
      if (issued.tier) {
        notices.push(`armor tier ${issued.tier.tier}${issued.tier.params?.dual_approval ? ' — DUAL approval required' : ''}`);
        const due = resealDueAt(issued);
        if (due != null) {
          notices.push(resealOverdue(issued)
            ? `re-seal OVERDUE since ${new Date(due).toISOString()}`
            : `re-seal due ${new Date(due).toISOString()}`);
        }
      }
      if (issued.report_only) notices.push('scan report package (testimony for a target issuance)');
    }
    return notices;
  }

  // A beacon event: the homing-beacon record. A packet surfaced at this
  // boundary that does not match what this machine issued. Distinct event
  // type in the testimony log, with the receiving surface identified.
  function beacon(conn, { frame, filePath, reason_class, expected = {} }) {
    // Tier-2 beacon sensitivity (§1.7.2): quarantine-on-anomaly.
    if (frame?.canary) {
      try {
        const reg = loadRegistry();
        const e = reg.entries[frame.canary];
        if (e && e.tier?.tier === 2 && e.tier?.params?.beacon_anomaly && !e.anomaly) {
          e.anomaly = { at: new Date().toISOString(), reason_class };
          saveRegistry(reg);
          log({ event: 'anomaly', result: 'set', canary: frame.canary, reason_class });
        }
      } catch {}
    }
    log({
      event: 'beacon',
      canary: frame?.canary ?? null,
      sha256: frame?.sha256 ?? null,
      reason_class,
      presented_path: filePath ?? null,
      surface: { daemon_label: id.label, seal_fp: id.sealFp, socket: socketPath },
      ...expected,
    });
    // B2: every beacon refusal is also attempts-feed testimony — the
    // beacon chokepoint is where the daemon's refusal classes surface.
    attemptsFeed.recordAttempt({
      canary: frame?.canary ?? null, reason_class,
      source: { kind: 'local', channel: 'socket', socket: socketPath },
    });
    send(conn, {
      ok: false, error: `beacon: ${reason_class}`, beacon: true, reason_class,
      canary: frame?.canary ?? null, sha256: frame?.sha256 ?? null,
      ...expected,
    });
  }

  // The one register path, both transports (local socket + mesh RPC).
  // Entries whose SENDER stands revoked are refused register-revoked
  // before anything is recorded (SPEC §4.5) — a revoked identity gains
  // no new memory anywhere in the estate.
  function registerEntries(entries, via, fromSignFp = null) {
    const accepted = [];
    const refused = [];
    for (const e of entries) {
      const rev = e && e.sender_sign_fp ? revocationInForce(e.sender_sign_fp) : null;
      if (rev) {
        refused.push({ canary: e.canary ?? null, error: `register-revoked: sender revoked at ${rev.at}` });
        log({ event: 'register', result: 'refused: register-revoked', via, canary: e.canary ?? null, sender_sign_fp: e.sender_sign_fp, revoked_at: rev.at });
        attemptsFeed.recordAttempt({
          canary: e.canary ?? null, reason_class: 'register-revoked',
          source: { kind: 'local', channel: via ?? 'register', socket: socketPath },
        });
        continue;
      }
      accepted.push(e);
    }
    const reg = loadRegistry();
    const res = insertIssuances(reg, accepted, via, fromSignFp);
    if (res.registered.length) saveRegistry(reg);
    log({
      event: 'register', result: 'recorded', via,
      count: res.registered.length, canaries: res.registered,
      refused: [...refused, ...res.refused].length ? [...refused, ...res.refused] : undefined,
    });
    if (res.registered.length) dropRecoveryCandidates(res.registered);
    return { registered: res.registered, refused: [...refused, ...res.refused] };
  }

  // Owner-approved recovery (Gemini fix 1): re-read the package as it
  // stands NOW, re-verify everything the candidate was recorded on,
  // derive the issuance from the package itself, register it, and
  // open the package in the same act. Any divergence since the
  // presentation refuses closed; a registration conflict refuses
  // without overwriting anything; a successful registration whose
  // open fails leaves the package registered and presentable through
  // the ordinary flow (reported, not hidden).
  function executeRecoveryApproval(conn, cand) {
    recoveryCandidates.delete(cand.id);
    let parsed;
    try {
      parsed = parseScriptureFile(fs.readFileSync(cand.filePath, 'utf8'));
    } catch (err) {
      log({ event: 'recovery', result: `refused: package unreadable (${err.message})`, canary: cand.canary, candidate: cand.id });
      send(conn, { ok: false, error: `recovery-refused: the package at ${cand.filePath} can no longer be read (${err.message})`, canary: cand.canary });
      return;
    }
    const { frame, body } = parsed;
    const refuseRec = (why) => {
      log({ event: 'recovery', result: `refused: ${why}`, canary: cand.canary, candidate: cand.id });
      send(conn, { ok: false, error: `recovery-refused: ${why}`, canary: cand.canary });
    };
    if (frame.canary !== cand.canary) return refuseRec('the package at the recorded path carries a different canary now');
    if (frame.recipient_seal_fp !== id.sealFp) return refuseRec('the package is not sealed to this copy');
    if (frame.v >= 4 && frame.recipient_kem_fp !== id.kemFp) return refuseRec('recipient-kem-mismatch: this v4 package was not KEM-sealed to this copy');
    if (!verifyFrameSignature(frame, body)) return refuseRec('the frame signature no longer verifies');
    if (frame.expiry && Date.parse(frame.expiry) < Date.now()) return refuseRec('the package has expired');
    if (revocationInForce(frame.sender_sign_fp)) return refuseRec('the sender stands revoked');
    if (loadRegistry().entries[frame.canary]) return refuseRec('the canary registered through an ordinary path meanwhile — recovery is moot');
    const res = registerEntries([issuanceFromFrame(frame)], 'owner-recovery', id.signFp);
    if (!res.registered.length) {
      log({ event: 'recovery', result: 'refused: registration-conflict', canary: frame.canary, candidate: cand.id, refused: res.refused });
      send(conn, { ok: false, error: 'recovery-registration-refused: the derived issuance conflicts with the registry as it now stands', canary: frame.canary });
      return;
    }
    log({ event: 'register', result: 'recovered-issuance', canary: frame.canary, candidate: cand.id });
    try {
      const payload = armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
      const plaintext = openPackage(frame, payload);
      const outName = path.basename(cand.outName || `recovered-${frame.canary.slice(0, 8)}.bin`);
      const dest = path.join(outDir, outName);
      fs.writeFileSync(dest, plaintext, { mode: 0o600 });
      try { fs.chmodSync(dest, 0o600); } catch {}
      const reg = loadRegistry();
      if (reg.entries[frame.canary]) {
        reg.entries[frame.canary].returned_at = new Date().toISOString();
        delete reg.entries[frame.canary].claim;
        saveRegistry(reg);
      }
      log({ event: 'unwrap', result: 'unwrapped', canary: frame.canary, digest: frameDigest(frame), out: dest, registry: 'returned', via: 'owner-recovery' });
      send(conn, { ok: true, approved: cand.id, recovered: frame.canary, state: 'unwrapped', out: dest, digest: frameDigest(frame), canary: frame.canary });
    } catch (err) {
      log({ event: 'recovery', result: `registered-open-failed: ${err.message}`, canary: frame.canary, candidate: cand.id });
      send(conn, { ok: true, approved: cand.id, recovered: frame.canary, state: 'registered', canary: frame.canary, note: `issuance recovered and registered; the open failed (${err.message}) — the package now presents through the ordinary unwrap flow` });
    }
  }

  // OWNER-channel registration: unsigned — the channel itself (0700
  // directory, 0600 socket, per-daemon token) is the authentication,
  // and the owner vouches for what they register.
  function handleRegister(conn, req) {
    const entries = Array.isArray(req.entries) ? req.entries : [];
    if (!entries.length) { send(conn, { ok: false, error: 'register: no entries' }); return; }
    const { registered, refused } = registerEntries(entries, 'owner', id.signFp);
    send(conn, { ok: true, registered: registered.length, canaries: registered, refused });
  }

  // REQUESTER-channel registration (FIX 1): the red team registered a
  // foreign package with one raw unsigned socket line and the daemon
  // recorded it as its own issuance. That door is closed: a
  // registration on this channel must be SIGNED by the issuing
  // identity (canonicalLocalRegister), the signer must be this copy or
  // a trusted peer, every entry must name the signer as its sender,
  // and a peer's signature may only create egress issuances —
  // activation-store / airlock-in origins are owner-channel or
  // daemon-internal facts, never a socket claim. Self-signed
  // registrations (this endpoint's own armor/daemon registering its
  // own issuances) bind to this copy's identity the same way.
  const registerNonces = new Map();
  function handleRegisterSigned(conn, req) {
    if (!verifyLocalRegister(req)) {
      send(conn, { ok: false, error: 'register-unauthenticated: requester-channel registration must be signed by the issuing identity (unsigned registration lives on the owner channel only)' });
      return;
    }
    const fp = req.from_sign_fp;
    const isSelf = fp === id.signFp;
    const sender = isSelf ? { label: id.label } : peerBySignFp(fp);
    if (!sender) {
      send(conn, { ok: false, error: 'register-untrusted-sender: the signing identity is not this copy and not in the address book' });
      return;
    }
    const atMs = Date.parse(req.at || '');
    if (!Number.isFinite(atMs) || Math.abs(Date.now() - atMs) > 300000) {
      send(conn, { ok: false, error: 'register-stale: signed registration outside the 5-minute freshness window' });
      return;
    }
    if (!req.nonce) { send(conn, { ok: false, error: 'register: a nonce is required' }); return; }
    const nonceKey = `${fp}:${req.nonce}`;
    if (registerNonces.has(nonceKey)) {
      send(conn, { ok: true, registered: 0, canaries: [], refused: [], replay: 'idempotent-retry (nonce already recorded)' });
      return;
    }
    const entries = Array.isArray(req.entries) ? req.entries : [];
    if (!entries.length) { send(conn, { ok: false, error: 'register: no entries' }); return; }
    const mine = [];
    const refused = [];
    for (const e of entries) {
      if (!e || e.sender_sign_fp !== fp) {
        refused.push({ canary: e?.canary ?? null, error: 'register-sender-mismatch: a signed registration carries only the signer\'s own issuances' });
        continue;
      }
      const origin = e.origin || 'egress';
      if (!isSelf && origin !== 'egress') {
        refused.push({ canary: e.canary ?? null, error: `register-origin-refused: a peer-signed registration may not create '${origin}' issuances (owner channel / daemon-internal only)` });
        continue;
      }
      mine.push(e);
    }
    const res = registerEntries(mine, isSelf ? 'local-self' : 'sender-signed', fp);
    registerNonces.set(nonceKey, Date.now());
    for (const [k, t] of registerNonces) if (Date.now() - t > 600000) registerNonces.delete(k);
    send(conn, { ok: true, registered: res.registered.length, canaries: res.registered, refused: [...refused, ...res.refused] });
  }

  function send(conn, obj) {
    try { conn.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  function refuse(conn, entry, reason) {
    log({
      event: 'unwrap', result: `refused: ${reason}`,
      canary: entry?.frame?.canary ?? null, sha256: entry?.frame?.sha256 ?? null,
      file: entry?.filePath ?? null,
    });
    send(conn, { ok: false, error: reason });
  }

  // Enrollment openings (SPEC §4.3): when a package whose issuance
  // carries an estate marker is opened here, the opening itself is the
  // estate act. A DESCRIPTOR opening installs the roster + verified
  // revocation records it carries — the new owner's approval of that
  // package WAS the act of joining. A PROBE opening is the proof
  // round-trip landing: the probe return-matched from a cross-
  // registered issuance, so the enrollment is verified on this side;
  // the proof is recorded and reported back over the next sync.
  function onEnrollmentOpened(frame, plaintext) {
    const e = loadRegistry().entries[frame.canary];
    const marker = e?.estate;
    if (!marker || typeof marker !== 'object') return;
    if (marker.kind === 'descriptor') {
      let descriptor;
      try { descriptor = JSON.parse(plaintext.toString('utf8')); } catch { return; }
      if (!descriptor || descriptor.format !== 'scripture-armor-estate/1') return;
      const st = loadEstateState(dir);
      for (const m of descriptor.members || []) {
        if (!m.sign_fp) continue;
        const isSelf = m.sign_fp === id.signFp;
        st.members[m.sign_fp] = {
          label: m.label, seal_fp: m.seal_fp, sign_fp: m.sign_fp, tier: m.tier ?? 1,
          state: isSelf ? 'self' : (st.members[m.sign_fp]?.state === 'revoked' ? 'revoked' : 'verified'),
        };
      }
      // The descriptor's coverage map installs with the roster: the
      // Tier-3 posture members and the mesh host it names are estate
      // facts this endpoint now holds (its own policy may name more).
      if (Array.isArray(descriptor.tier3)) {
        st.tier3 = descriptor.tier3.map((t) => ({
          label: t.label, tier: 3, keys: false, can_open: false,
          coverage: t.coverage ?? 'mesh-governed + on-device posture (dns-profiles/)',
          note: t.note ?? null,
        }));
      }
      if (descriptor.mesh_host) st.mesh_host = descriptor.mesh_host;
      const revs = loadRevocations(dir);
      let merged = 0;
      let unverified = 0;
      for (const rec of descriptor.revocations || []) {
        if (revs.records.some((r) => r.id === rec.id)) continue;
        if (verifyRevocation(rec, resolveSignPub)) { revs.records.push(rec); merged++; } else unverified++;
      }
      if (merged) saveRevocations(dir, revs);
      saveEstateState(dir, st);
      log({
        event: 'enrolled', result: 'descriptor-installed', canary: frame.canary,
        by_sign_fp: descriptor.by?.sign_fp ?? null,
        members: (descriptor.members || []).length, tier3: (descriptor.tier3 || []).length,
        revocations_merged: merged, revocations_unverified: unverified,
      });
    } else if (marker.kind === 'probe') {
      const st = loadEstateState(dir);
      st.proofs = st.proofs || [];
      if (!st.proofs.some((p) => p.canary === frame.canary)) {
        st.proofs.push({
          canary: frame.canary, kind: 'enroll-probe',
          with_sign_fp: marker.enroll_with ?? frame.sender_sign_fp, at: new Date().toISOString(),
        });
      }
      const other = marker.enroll_with ?? frame.sender_sign_fp;
      if (other && st.members[other] && st.members[other].state !== 'revoked') {
        st.members[other].state = 'verified';
      }
      saveEstateState(dir, st);
      log({ event: 'enroll-verified', canary: frame.canary, with_sign_fp: other ?? null, side: 'new-endpoint' });
    }
  }

  function executeUnwrap(entry) {
    const { frame, conn } = entry;
    try {
      const plaintext = openPackage(frame, entry.payload);
      const digest = frameDigest(frame);
      const outName = path.basename(entry.outName || `unwrapped-${frame.canary.slice(0, 8)}.bin`);
      const dest = path.join(outDir, outName);
      fs.writeFileSync(dest, plaintext, { mode: 0o600 });
      try { fs.chmodSync(dest, 0o600); } catch {}
      // One-shot return: a successful unwrap consumes the registry entry
      // and clears the claim in the same registry write. The same packet
      // presented again is a replay — a beacon event.
      const reg = loadRegistry();
      let resealToken = null;
      if (reg.entries[frame.canary]) {
        reg.entries[frame.canary].returned_at = new Date().toISOString();
        delete reg.entries[frame.canary].claim;
        // A governed RESEAL opening mints the lineage token the later
        // supersede must present (FIX 3 fallout): two v3 packages of the
        // same bytes carry different keyed commitments by design, so
        // content-identity across a re-seal is proven by this one-time
        // token — issued only when THIS daemon opened the old package
        // for re-seal — never by comparing digests. Only its hash is
        // kept, on the consumed entry.
        if (entry.purpose === 'reseal') {
          resealToken = crypto.randomBytes(24).toString('hex');
          reg.entries[frame.canary].reseal_token_hash = crypto.createHash('sha256').update(resealToken).digest('hex');
          reg.entries[frame.canary].reseal_opened_at = new Date().toISOString();
        }
        saveRegistry(reg);
      }
      // Estate openings (enrollment descriptor / probe) act here, on
      // the verified plaintext, as part of the same governed opening.
      try { onEnrollmentOpened(frame, plaintext); } catch (e) {
        log({ event: 'enrolled', result: `error: ${e.message}`, canary: frame.canary });
      }
      log({ event: 'unwrap', result: 'unwrapped', canary: frame.canary, digest, out: dest, registry: 'returned' });
      send(conn, { ok: true, state: 'unwrapped', out: dest, digest, canary: frame.canary, digest_verified: true, ...(resealToken ? { reseal_token: resealToken } : {}) });
    } catch (err) {
      // The unwrap failed, so the package has NOT returned: release the
      // claim (not a consumption) so a later presentation can pend again.
      if (entry.id) releaseClaim(frame.canary, entry.id);
      log({
        event: 'unwrap', result: `failed: ${err.message}`,
        canary: frame.canary, sha256: frame.sha256, file: entry.filePath,
      });
      send(conn, { ok: false, error: `unwrap-failed: ${err.message}` });
    }
  }

  // Verify-only open (Gemini fix 3): the package opens and the
  // plaintext is handed back, but the return is NOT consumed —
  // returned_at stays null and the claim is simply released, so the
  // package can still be presented for its real unwrap afterwards.
  function executeVerifyOpen(entry) {
    const { frame, conn } = entry;
    try {
      const plaintext = openPackage(frame, entry.payload);
      const digest = frameDigest(frame);
      const outName = path.basename(entry.outName || `verified-${frame.canary.slice(0, 8)}.bin`);
      const dest = path.join(outDir, outName);
      fs.writeFileSync(dest, plaintext, { mode: 0o600 });
      try { fs.chmodSync(dest, 0o600); } catch {}
      if (entry.id) releaseClaim(frame.canary, entry.id);
      // Arm the return under this same owner decision (see
      // verifyGrants): the consuming unwrap re-runs every gate and
      // needs no second approval for the same package.
      verifyGrants.set(frame.canary, { digest, expiresAt: Date.now() + windowMs });
      log({ event: 'verify-open', result: 'verified-open', canary: frame.canary, digest, out: dest, registry: 'not-consumed' });
      send(conn, { ok: true, state: 'verified-open', out: dest, digest, canary: frame.canary, digest_verified: true });
    } catch (err) {
      if (entry.id) releaseClaim(frame.canary, entry.id);
      log({
        event: 'verify-open', result: `failed: ${err.message}`,
        canary: frame.canary, sha256: frame.sha256, file: entry.filePath,
      });
      send(conn, { ok: false, error: `verify-open-failed: ${err.message}` });
    }
  }

  // The approval window, (re)armable: Tier-2 dual approval restarts it
  // after stage 1 so the second decision gets its own full window.
  function armApprovalWindow(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(entry.id);
      try { fs.unlinkSync(ownerConfirmPathFor(socketPath, entry.id)); } catch {}
      // The window closed unapproved: release the claim. A release is not
      // a consumption — the package may pend again on a later presentation.
      if (entry.claimCanary) releaseClaim(entry.claimCanary, entry.id);
      log({
        event: entry.kind || 'unwrap', result: 'refused: approval-timeout',
        canary: entry.frame?.canary ?? null, sha256: entry.frame?.sha256 ?? null, file: entry.filePath ?? null,
      });
      send(entry.conn, { ok: false, error: 'approval-timeout', canary: entry.frame?.canary ?? null });
    }, windowMs);
  }

  // handleUnwrap serves two requester commands: `unwrap` (the
  // consuming one-shot return) and `verify-open` (Gemini fix 3: the
  // same gate sequence and owner approval, plaintext handed back,
  // but the registry entry is NOT consumed — restore flows verify a
  // manifest against its sidecar before spending the return).
  function handleUnwrap(conn, req, verifyOnly = false) {
    const filePath = req.path;
    let parsed;
    try {
      parsed = parseScriptureFile(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      log({ event: 'unwrap', result: `refused: unparseable (${err.message})`, canary: null, sha256: null, file: filePath });
      send(conn, { ok: false, error: `unparseable: ${err.message}` });
      return;
    }
    const { frame, body } = parsed;
    const entry = {
      kind: verifyOnly ? 'verify-open' : 'unwrap', claimCanary: frame.canary,
      frame, filePath, outName: req.out, conn, payload: null,
      context: typeof req.context === 'string' ? req.context.slice(0, 300) : null,
      purpose: typeof req.purpose === 'string' ? req.purpose : null,
      registryStatus: null,
    };
    if (frame.recipient_seal_fp !== id.sealFp) {
      refuse(conn, entry, 'recipient-mismatch: this package was not sealed to this copy');
      return;
    }
    if (frame.v >= 4 && frame.recipient_kem_fp !== id.kemFp) {
      refuse(conn, entry, 'recipient-kem-mismatch: this v4 package was not KEM-sealed to this copy');
      return;
    }
    // RETURN-MATCH — the closed loop's core check, before approval exists.
    // The presented frame must equal what this machine issued under this
    // canary: same plaintext hash, same expiry, same sender. Divergence in
    // any of them — or no issuance at all, or an issuance already consumed
    // by a successful return — is a beacon event, never a routine approval.
    const issued = loadRegistry().entries[frame.canary];
    if (!issued) {
      // The beacon is the testimony and it never changes: this loop
      // never issued this canary.
      beacon(conn, { frame, filePath, reason_class: 'never-issued' });
      // RECOVERY CANDIDATE (Gemini fix 1) — the beacon used to be a
      // dead end, and that dead end is where an honest package lands
      // when its issuance sat in the sender's offline outbox and the
      // queue never synced (register #27: the recipient locked out of
      // a package addressed to them). The owner is the loop's court
      // of last resort: when the frame's signature VERIFIES, the
      // sender is this copy or an enrolled peer, the frame is
      // unexpired and unrevoked, and the registry's own integrity
      // stands, the daemon records a recovery candidate. NOTHING is
      // registered by the presentation itself — only the owner's
      // explicit approval on the owner channel derives the issuance
      // from the package and records it (handleApprove). An
      // unenrolled sender, a bad signature, a tampered store, or a
      // verify-open leaves the beacon as the whole story, exactly as
      // before.
      if (!verifyOnly
        && registryIntegrityOk()
        && (frame.sender_sign_fp === id.signFp || peerBySignFp(frame.sender_sign_fp))
        && verifyFrameSignature(frame, body)
        && !(frame.expiry && Date.parse(frame.expiry) < Date.now())
        && !revocationInForce(frame.sender_sign_fp)) {
        pruneRecoveryCandidates();
        let already = null;
        for (const cand of recoveryCandidates.values()) if (cand.canary === frame.canary) already = cand;
        if (!already && recoveryCandidates.size < RECOVERY_CANDIDATE_CAP) {
          const cand = {
            id: crypto.randomUUID(), canary: frame.canary, filePath,
            outName: req.out || null, sender_sign_fp: frame.sender_sign_fp,
            digest: frameDigest(frame), createdAt: Date.now(),
          };
          recoveryCandidates.set(cand.id, cand);
          log({
            event: 'recovery', result: 'candidate-recorded', canary: frame.canary,
            candidate: cand.id, sender_sign_fp: frame.sender_sign_fp, file: filePath,
            note: 'owner may approve on the owner channel: vaultd.mjs approve --id <candidate> (see vaultd.mjs recovery)',
          });
        }
      }
      return;
    }
    // STORE INTEGRITY GATE (Gemini fix 5): an entry that exists is
    // only worth trusting if the store holding it verified. When the
    // registry's tag has failed, NO presentation opens — the refusal
    // is precise and the tamper record is already in the log.
    if (!registryIntegrityOk()) {
      log({ event: 'unwrap', result: 'refused: store-integrity (registry.json HMAC mismatch)', canary: frame.canary, file: filePath });
      refuse(conn, entry, 'store-integrity: registry.json failed its integrity check — refusing to trust its entries until the store is repaired');
      return;
    }
    if (issued.returned_at) {
      // A superseded entry was consumed by its own re-seal maintenance;
      // presenting the stale copy again is a SUPERSEDED event (it names
      // the successor), which is more informative than replay-consumed.
      if (issued.superseded_by) {
        beacon(conn, { frame, filePath, reason_class: 'superseded', expected: { superseded_by: issued.superseded_by } });
        return;
      }
      beacon(conn, { frame, filePath, reason_class: 'replay-consumed', expected: { returned_at: issued.returned_at } });
      return;
    }
    if (entryDigestOf(issued) !== frameDigest(frame)) {
      beacon(conn, { frame, filePath, reason_class: 'hash-mismatch', expected: { expected_digest: entryDigestOf(issued) } });
      return;
    }
    if ((issued.expiry ?? null) !== (frame.expiry ?? null)) {
      beacon(conn, { frame, filePath, reason_class: 'expiry-mismatch', expected: { expected_expiry: issued.expiry ?? null } });
      return;
    }
    if (issued.sender_sign_fp && issued.sender_sign_fp !== frame.sender_sign_fp) {
      beacon(conn, { frame, filePath, reason_class: 'sender-mismatch', expected: { expected_sender_sign_fp: issued.sender_sign_fp } });
      return;
    }
    {
      const rev = revokedSenderBeacon(issued);
      if (rev) {
        beacon(conn, { frame, filePath, reason_class: 'revoked-sender', expected: { revoked_at: rev.at, revocation_id: rev.id } });
        return;
      }
    }
    entry.registryStatus = 'issued-by-this-machine';
    // Provenance (FIX 1): the approval surface names the authenticated
    // path this issuance actually arrived by — owner channel, sender
    // signature, estate mesh/sync, or a daemon-internal origin. The
    // status string above is only ever set for entries that arrived
    // over one of those paths; unauthenticated registration no longer
    // exists, so no entry can borrow this machine's name.
    entry.provenance = {
      via: issued.registered_via ?? 'pre-phase4-registry',
      from: issued.registered_from ?? issued.sender_sign_fp ?? null,
    };
    // ---- v2 gates (SPEC §0.2/§1.6/§1.7) — after return-match, before
    // the approval gate. A superseded stale copy, a transplanted scan
    // verdict, or a quietly lowered tier are beacon events; quarantine
    // and anomaly holds are refusals the owner adjudicates.
    if (issued.superseded_by) {
      beacon(conn, { frame, filePath, reason_class: 'superseded', expected: { superseded_by: issued.superseded_by } });
      return;
    }
    {
      const a = issued.scan || { verdict: null, digest: null, report_canary: null };
      const b = frame.v >= 2
        ? { verdict: frame.scan_verdict ?? null, digest: frame.scan_digest ?? null, report_canary: frame.scan_report ?? null }
        : { verdict: null, digest: null, report_canary: null };
      if (a.verdict !== b.verdict || a.digest !== b.digest || a.report_canary !== b.report_canary) {
        beacon(conn, { frame, filePath, reason_class: 'scan-mismatch', expected: { expected_scan: a } });
        return;
      }
      const regTier = issued.tier?.tier ?? null;
      const frameTier = frame.v >= 2 ? (frame.armor_tier ?? null) : null;
      if (regTier !== frameTier) {
        beacon(conn, { frame, filePath, reason_class: 'tier-mismatch', expected: { expected_tier: regTier } });
        return;
      }
    }
    if (issued.quarantined) {
      refuse(conn, entry, `quarantined: ${issued.quarantined.reason || 'held by policy'} — owner release required`);
      return;
    }
    if (anomalyBlocked(loadRegistry(), issued)) {
      refuse(conn, entry, 'anomaly-hold: a beacon named this Tier-2 entry (or its repo); the owner clears it with `vaultd.mjs clear-anomaly --canary <c>`');
      return;
    }
    if (issued.tier?.tier === 2 && resealOverdue(issued) && entry.purpose !== 'reseal') {
      refuse(conn, entry, 'reseal-overdue: this Tier-2 part is past its re-seal deadline — re-seal it (armor.mjs reseal) before it can be opened');
      return;
    }
    entry.tierSnapshot = issued.tier ?? null;
    entry.notices = buildNotices(issued, frame);
    if (!verifyFrameSignature(frame, body)) {
      // A registered canary presented with an invalid frame signature
      // is a forgery-shaped event: beacon it (doctrine: mismatches at
      // this boundary are beacon events), then refuse.
      beacon(conn, { frame, filePath, reason_class: 'bad-frame-signature' });
      refuse(conn, entry, 'bad-frame-signature');
      return;
    }
    if (frame.expiry && Date.parse(frame.expiry) < Date.now()) {
      refuse(conn, entry, 'expired');
      return;
    }
    try {
      entry.payload = armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
    } catch (err) {
      refuse(conn, entry, `armor-corrupt: ${err.message}`);
      return;
    }
    const reqId = crypto.randomUUID();
    // CLAIM-AT-PEND — one-shot return is claimed here, not merely checked
    // at presentation and consumed later. In one synchronous read-check-
    // write against the registry (no awaits, so no other request on this
    // daemon can interleave): re-validate the entry's live state and mark
    // it claimed by THIS pending request. A second presentation of the
    // same canary while the claim is live — sequential or concurrent —
    // beacon-refuses (replay-claimed) and never creates a twin pending,
    // so two approvals can never both unwrap the same package.
    {
      const reg = loadRegistry();
      const regEntry = reg.entries[frame.canary];
      if (!regEntry) {
        beacon(conn, { frame, filePath, reason_class: 'never-issued' });
        return;
      }
      if (regEntry.returned_at) {
        beacon(conn, { frame, filePath, reason_class: 'replay-consumed', expected: { returned_at: regEntry.returned_at } });
        return;
      }
      if (regEntry.claim) {
        beacon(conn, {
          frame, filePath, reason_class: 'replay-claimed',
          expected: { claimed_pending: regEntry.claim.id, claimed_at: regEntry.claim.at },
        });
        return;
      }
      regEntry.claim = { id: reqId, at: new Date().toISOString() };
      saveRegistry(reg);
    }
    // VERIFY GRANT (Gemini fix 3): a verify-open the owner approved
    // within the window arms this package's return. Every gate above
    // has re-run for THIS presentation (return-match, scan/tier,
    // signature, expiry, claim); the grant only waives the second
    // interactive approval for the same package under the same owner
    // decision. Digest-bound and single-use; a stale or mismatched
    // grant is dropped, never honored.
    if (!verifyOnly) {
      const grant = verifyGrants.get(frame.canary);
      if (grant) {
        verifyGrants.delete(frame.canary);
        if (grant.digest === frameDigest(frame) && grant.expiresAt > Date.now()) {
          entry.id = reqId;
          log({
            event: 'unwrap', result: 'verify-grant: executing under the verify-open approval', canary: frame.canary,
            digest: frameDigest(frame), file: filePath, claim: reqId,
          });
          executeUnwrap(entry);
          return;
        }
      }
    }
    {
      let sameOrigin = 0;
      for (const p of pending.values()) if (p.frame?.sender_sign_fp === frame.sender_sign_fp) sameOrigin++;
      if (sameOrigin >= PENDING_CAP_PER_ORIGIN) {
        releaseClaim(frame.canary, reqId);
        shedPendings++;
        log({ event: 'unwrap', result: 'pending-shed-budget', canary: frame.canary, sender_sign_fp: frame.sender_sign_fp, shed_total: shedPendings });
        send(conn, { ok: false, error: 'pending budget for this origin is exhausted — the owner sees a count, not a flood (M.19)', canary: frame.canary });
        return;
      }
    }
    entry.id = reqId;
    entry.createdAt = Date.now();
    entry.requiredApprovals = entry.tierSnapshot?.params?.dual_approval ? 2 : 1;
    entry.approvalStage = 0;
    entry.confirmCode = null;
    armApprovalWindow(entry);
    pending.set(reqId, entry);
    log({
      event: 'unwrap', result: 'pending-approval', canary: frame.canary, digest: frameDigest(frame),
      file: filePath, sender_sign_fp: frame.sender_sign_fp, registry_status: entry.registryStatus,
      provenance: entry.provenance,
      context: entry.context, claim: reqId,
      tier: entry.tierSnapshot?.tier ?? null, notices: entry.notices,
    });
    send(conn, {
      ok: true, state: 'pending-approval', id: reqId, canary: frame.canary,
      digest: frameDigest(frame), window_s: Math.round(windowMs / 1000),
      sender_sign_fp: frame.sender_sign_fp, registry_status: entry.registryStatus,
      provenance: entry.provenance,
      context: entry.context,
      tier: entry.tierSnapshot?.tier ?? null,
      notices: entry.notices,
      approvals_required: entry.requiredApprovals,
      note: 'owner approval required: vaultd.mjs approve',
    });
  }

  function handleApprove(conn, req) {
    // Recovery candidates are approved by id on this same channel
    // (Gemini fix 1) — checked before pendings; ids never collide.
    if (req.id && recoveryCandidates.has(req.id)) {
      executeRecoveryApproval(conn, recoveryCandidates.get(req.id));
      return;
    }
    let entry = null;
    if (req.id) entry = pending.get(req.id) || null;
    else if (pending.size === 1) entry = [...pending.values()][0];
    if (!entry) {
      // Covers approve-with-no-pending, double-approve, and
      // approve-after-window (the timer already removed the entry).
      log({ event: 'approve', result: 'refused: no-matching-pending-request', id: req.id ?? null });
      send(conn, { ok: false, error: 'no-matching-pending-request' });
      return;
    }
    // CLAIM RE-VALIDATION — an approval may only execute for the pending
    // that holds the registry claim. A stale approval (entry consumed by
    // another path) or a foreign one (claim held by a different pending)
    // can never consume someone else's claim: refuse, drop this pending,
    // and leave the registry exactly as it stands. (Dock pendings hold
    // no registry claim — there is nothing to re-validate.)
    if (entry.claimCanary) {
      const regEntry = loadRegistry().entries[entry.frame.canary];
      if (!regEntry || regEntry.returned_at || !regEntry.claim || regEntry.claim.id !== entry.id) {
        pending.delete(entry.id);
        clearTimeout(entry.timer);
        log({
          event: 'approve', result: 'refused: claim-not-held', id: entry.id,
          canary: entry.frame.canary, sha256: entry.frame.sha256,
          registry_status: !regEntry ? 'never-issued' : regEntry.returned_at ? 'replay-consumed' : 'claimed-by-other',
        });
        send(conn, { ok: false, error: 'claim-not-held: this pending does not hold the registry claim', canary: entry.frame.canary });
        send(entry.conn, { ok: false, error: 'approval-refused: claim-not-held', canary: entry.frame.canary });
        return;
      }
    }
    // DUAL APPROVAL (Tier 2, SPEC §1.7.4) — two separate, deliberate
    // owner acts on the same claim: stage 1 restarts the window and
    // issues a one-time confirmation code WITH the scan findings, so
    // the second decision is made looking at them; stage 2 must
    // present the code. (Single-owner tool: this is a forced second
    // decision, not two-person integrity — stated, not dressed up.)
    if ((entry.requiredApprovals || 1) > 1 && entry.approvalStage === 0) {
      entry.approvalStage = 1;
      entry.confirmCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      armApprovalWindow(entry);
      // FIX 1: the confirmation code is NEVER returned over any
      // socket — the red team approved stage 1 and stage 2 from one
      // unauthenticated connection because the code rode the stage-1
      // response. The code is written to the owner channel's state
      // (0600, beside the owner socket); the owner reads it there and
      // enters it out-of-band for stage 2. The approving connection
      // learns only that a code exists and where the OWNER finds it.
      try {
        fs.writeFileSync(ownerConfirmPathFor(socketPath, entry.id), JSON.stringify({
          id: entry.id, canary: entry.frame.canary, kind: entry.kind || 'unwrap',
          code: entry.confirmCode, notices: entry.notices,
          created: new Date().toISOString(),
        }, null, 2), { mode: 0o600 });
        try { fs.chmodSync(ownerConfirmPathFor(socketPath, entry.id), 0o600); } catch {}
      } catch (e) {
        log({ event: 'approve', result: `confirm-state-write-failed: ${e.message}`, id: entry.id });
      }
      log({ event: 'approve', result: 'stage-1 (dual approval)', id: entry.id, canary: entry.frame.canary, digest: frameDigest(entry.frame) });
      send(conn, {
        ok: true, approved_stage: 1, id: entry.id, canary: entry.frame.canary,
        notices: entry.notices,
        confirm_delivery: 'owner-channel-state (0600 file beside the owner socket; never transmitted over a socket)',
        note: 'Tier-2 dual approval: stage 1 recorded — the owner reads the one-time code from the owner channel state and approves again with it',
      });
      return;
    }
    if ((entry.requiredApprovals || 1) > 1 && entry.approvalStage === 1) {
      if (!req.confirm || String(req.confirm) !== entry.confirmCode) {
        log({ event: 'approve', result: 'refused: dual-confirm-mismatch', id: entry.id, canary: entry.frame.canary });
        send(conn, { ok: false, error: 'dual-confirm-mismatch: the second approval needs the stage-1 confirmation code (--confirm <code>)', canary: entry.frame.canary });
        return;
      }
      log({ event: 'approve', result: 'stage-2 confirmed (dual approval)', id: entry.id, canary: entry.frame.canary });
    }
    pending.delete(entry.id);
    clearTimeout(entry.timer);
    try { fs.unlinkSync(ownerConfirmPathFor(socketPath, entry.id)); } catch {}
    log({ event: 'approve', result: 'approved', canary: entry.frame?.canary ?? null, digest: frameDigest(entry.frame), kind: entry.kind || 'unwrap' });
    send(conn, { ok: true, approved: entry.id, canary: entry.frame?.canary ?? null });
    if (entry.kind === 'activation') {
      if (entry.createGrant) {
        const reg = loadRegistry();
        const e = reg.entries[entry.frame.canary];
        if (e) {
          e.grants = {
            granted_at: new Date().toISOString(), by_sign_fp: id.signFp,
            min_cell: entry.requiredCell, max_instances: entry.maxInstances || 1,
            expires: null,
          };
          saveRegistry(reg);
          log({ event: 'activate', result: 'grant-written', canary: entry.frame.canary, min_cell: entry.requiredCell });
        }
      }
      launchActivation(entry);
    } else if (entry.kind === 'dock') {
      openAirlockSession(entry);
    } else if (entry.kind === 'verify-open') {
      executeVerifyOpen(entry);
    } else {
      executeUnwrap(entry);
    }
  }

  // -----------------------------------------------------------------------
  // CLOSURE 2 — activation inside the shell (SPEC §2). A program is
  // materialized in daemon memory only, staged into a disposable cell,
  // and every byte it emits crosses the egress handler below. The
  // program holds no keys, mounts no network, and leaves nothing behind.
  // -----------------------------------------------------------------------

  function refuseActivation(conn, frame, filePath, reason, eventResult) {
    log({
      event: 'activate', result: eventResult || `refused: ${reason}`,
      canary: frame?.canary ?? null, sha256: frame?.sha256 ?? null, file: filePath,
    });
    send(conn, { ok: false, error: reason, canary: frame?.canary ?? null });
  }

  // Scan-gate policy shared by activation paths (§1.6 activation time):
  // returns {refuse: reason} or {pend: {reason, notes}} or {} (clear).
  function activationScanGate(frame, issued) {
    const policy = pol();
    if ((frame.scan_verdict ?? null) !== (issued?.scan?.verdict ?? null)
      || (frame.scan_digest ?? null) !== (issued?.scan?.digest ?? null)
      || (frame.armor_tier ?? null) !== (issued?.tier?.tier ?? null)) {
      return { beacon: 'scan-mismatch' };
    }
    const scan = issued?.scan ?? null;
    const override = frame.scan_override || null;
    if (override) {
      const notices = [`scan override on record (by ${override.by_sign_fp}, at ${override.at}): "${override.reason}" — the owner accepted this scan verdict at wrap time`];
      if (scan?.verdict === 'critical') return { pendCritical: { reason: 'scan-critical-overridden', notes: notices } };
      return { pendEvery: { reason: 'scan-override', notes: notices } };
    }
    if (scan?.verdict === 'critical') {
      return { refuse: 'scan-critical: the bound scan verdict is critical — activation refused' };
    }
    if (!scan) return { unscanned: true };
    if (scan.verdict === 'warn') return { pendEvery: { reason: 'scan-warn', notes: [] } };
    return { clear: true, notes: [] };
  }

  async function handleActivate(conn, req) {
    let raw;
    try { raw = fs.readFileSync(req.path, 'utf8'); }
    catch { send(conn, { ok: false, error: `cannot read ${req.path}` }); return; }
    let parsed;
    try { parsed = parseScriptureFile(raw); } catch (e) { send(conn, { ok: false, error: e.message }); return; }
    const { frame } = parsed;
    if (frame.recipient_seal_fp !== id.sealFp) {
      send(conn, { ok: false, error: 'package was sealed to a different copy', canary: frame.canary });
      return;
    }
    if (frame.v >= 4 && frame.recipient_kem_fp !== id.kemFp) {
      send(conn, { ok: false, error: 'v4 package was KEM-sealed to a different copy', canary: frame.canary });
      return;
    }
    if (path.basename(req.path) === 'MANIFEST.scripture') {
      handleActivateRepo(conn, req, parsed);
      return;
    }
    // RETURN-MATCH, activation's own testimony: a package this machine
    // never issued, or one already consumed, is not activated — it is
    // beacon evidence, exactly as on presentation.
    const reg = loadRegistry();
    const issued = reg.entries[frame.canary];
    if (!issued) { beacon(conn, { frame, filePath: req.path, reason_class: 'never-issued' }); return; }
    if (issued.returned_at) { beacon(conn, { frame, filePath: req.path, reason_class: 'replay-consumed' }); return; }
    if (issued.superseded_by) { beacon(conn, { frame, filePath: req.path, reason_class: 'superseded', expected: issued.superseded_by }); return; }
    if (entryDigestOf(issued) !== frameDigest(frame)) { beacon(conn, { frame, filePath: req.path, reason_class: 'hash-mismatch', expected: entryDigestOf(issued) }); return; }
    if ((issued.expiry ?? null) !== (frame.expiry ?? null)) { beacon(conn, { frame, filePath: req.path, reason_class: 'expiry-mismatch', expected: issued.expiry }); return; }
    if ((issued.sender_sign_fp ?? null) !== (frame.sender_sign_fp ?? null)) { beacon(conn, { frame, filePath: req.path, reason_class: 'sender-mismatch', expected: issued.sender_sign_fp }); return; }
    {
      const rev = revokedSenderBeacon(issued);
      if (rev) { beacon(conn, { frame, filePath: req.path, reason_class: 'revoked-sender', expected: { revoked_at: rev.at, revocation_id: rev.id } }); return; }
    }

    // ORIGIN: only packages sealed INTO the activation store activate.
    // An egress package returning for activation is refused outright —
    // arrival confers custody, not trust (§2.3, §3.2).
    if ((issued.origin || 'egress') !== 'activation-store') {
      refuseActivation(conn, frame, req.path,
        `not-activatable: package origin is '${issued.origin || 'egress'}' — only packages sealed into the activation store (wrap --for-activation) may activate`);
      return;
    }
    if (issued.quarantined) {
      refuseActivation(conn, frame, req.path, 'quarantined: this package is quarantined in the registry');
      return;
    }
    if (anomalyBlocked(reg, issued)) {
      refuseActivation(conn, frame, req.path,
        'anomaly: an anomaly is standing against this package (or its repo) — activation refuses until the owner clears it (vaultd.mjs clear-anomaly --canary <c>)');
      return;
    }
    const tierSnap = issued.tier ?? null;
    const params = tierSnap?.params ?? null;
    if (params?.reseal_hours != null && resealOverdue(issued)) {
      refuseActivation(conn, frame, req.path,
        `reseal-overdue: reseal due ${resealDueAt(issued)} has passed for this tier — re-seal the package before it activates again (armor.mjs reseal)`);
      return;
    }
    if (frame.expiry && Date.now() > Date.parse(frame.expiry)) {
      refuseActivation(conn, frame, req.path, 'package expired');
      return;
    }
    if (!verifyFrameSignature(frame, parsed.body)) {
      beacon(conn, { frame, filePath: req.path, reason_class: 'bad-frame-signature' });
      return;
    }
    let payload;
    try { payload = armorDecode(parsed.body, Buffer.from(frame.armor_seed, 'base64')); }
    catch (e) { send(conn, { ok: false, error: `body does not decode: ${e.message}` }); return; }
    // OPEN ONCE, HERE: the digest equality is the verified image
    // (§2.4 step 4). A package whose plaintext does not match its own
    // frame digest is an image-mismatch beacon — before any gate that
    // would trust its contents (including classification below, which
    // must judge the PLAINTEXT, never the sealed bytes).
    let plaintext;
    try { plaintext = openPackage(frame, payload); }
    catch (e) { beacon(conn, { frame, filePath: req.path, reason_class: 'image-mismatch', expected: frameDigest(frame) }); return; }

    // SCAN GATE (§1.6): the frame's scan block must equal the registry's;
    // the verdict then decides refuse / pend / clear.
    const gate = activationScanGate(frame, issued);
    if (gate.beacon) { beacon(conn, { frame, filePath: req.path, reason_class: gate.beacon }); return; }
    if (gate.refuse) { refuseActivation(conn, frame, req.path, gate.refuse); return; }

    // CLASS: what kind of thing is this? (data never activates).
    // Judged on the verified plaintext. Extensionless text payloads
    // (e.g. promoted candidates, whose package name is a canary) fall
    // back to a source sniff so a real program is not misread as data.
    const name = path.basename(req.path).replace(/\.scripture$/, '');
    let targetClass = classifyBuffer(plaintext, name);
    if (targetClass === 'data') {
      let text = null;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext); } catch {}
      if (text && !text.includes('\0')
        && /(^|\n)\s*(import\s|export\s|const\s|let\s|var\s|function\s|console\.|require\(|#!)/.test(text)) {
        targetClass = 'source';
      }
    }
    if (targetClass === 'data') {
      refuseActivation(conn, frame, req.path, 'not-a-program: this package holds data, not an executable');
      return;
    }

    const policy = pol();
    const pendReasons = [];
    const notices = buildNotices(issued, frame);
    if (gate.pendCritical) pendReasons.push(gate.pendCritical.reason), notices.push(...gate.pendCritical.notes);
    if (gate.pendEvery) pendReasons.push(gate.pendEvery.reason), notices.push(...gate.pendEvery.notes);
    let scanMissingTap = false;
    if (gate.unscanned) {
      // Executable with no scan record: refused UNLESS the owner taps a
      // one-time override at the prompt (logged; never grants) (§1.6).
      pendReasons.push('scan-missing');
      scanMissingTap = true;
      notices.push('no scan record is bound to this package — approving is a ONE-TIME activation override, written to the record; it grants nothing');
    }

    // PER-ACCESS REPORT RE-VERIFICATION (case 22b): Tier 1/2 re-verify
    // every activation; Tier 0 at registration + first activation.
    const reverify = params?.reverify || 'registration+first';
    const activationCount = (issued.activations || []).length;
    if (issued.scan && (reverify !== 'registration+first' || activationCount === 0)) {
      const vr = verifyReport(frame, issued, req.path, sha256Hex(plaintext));
      if (!vr.ok) { refuseActivation(conn, frame, req.path, vr.reason); return; }
      log({ event: 'activate', result: 'report-reverified', canary: frame.canary, reverify });
      // Tier-2 freshness: a report older than scan_max_age_hours is
      // re-scanned from the materialized bytes and must reproduce the
      // bound digest, or activation refuses (§1.7.2). Phase 4 (FIX 5):
      // the record's timestamp field is `started` — the gate used to
      // test a `generated_at` field that exists nowhere, so it never
      // fired; and the digest it compares is now timestamp-free
      // (scanDigestOf), so a genuine re-scan of identical bytes CAN
      // reproduce it. Both branches are battery-proven.
      if (params?.scan_max_age_hours != null && vr.record?.started) {
        const ageH = (Date.now() - Date.parse(vr.record.started)) / 3600000;
        if (ageH > params.scan_max_age_hours) {
          let fresh;
          try {
            const pt = openPackage(frame, payload);
            const tmpDir = fs.mkdtempSync(path.join(cellsRoot, 'rescan-'));
            const tmpFile = path.join(tmpDir, name);
            fs.writeFileSync(tmpFile, pt, { mode: 0o600 });
            fresh = await scanFile(tmpFile, { policy, storeDir: dir });
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (e) {
            refuseActivation(conn, frame, req.path, `scan-stale: freshness re-scan failed (${e.message})`);
            return;
          }
          if (scanDigestOf(fresh.record) !== (issued.scan?.digest ?? null)) {
            refuseActivation(conn, frame, req.path,
              'scan-stale: the bound scan report is older than scan_max_age_hours and a fresh scan does not reproduce its digest — re-wrap or re-seal through the scan layer');
            return;
          }
          log({ event: 'activate', result: 'scan-freshness-reverified', canary: frame.canary, report_age_hours: Math.round(ageH * 10) / 10 });
        }
      }
    }

    // CELL DECISION (§2.2): meet the required class or refuse; a
    // downgrade exists only where the tier allows it, and only as an
    // owner tap at the prompt — never silent.
    let required = 'hard';
    if (params && params.min_cell && params.min_cell !== 'policy-default') required = params.min_cell;
    else if (targetClass === 'source' && policy.cell?.soft_for_source) required = 'soft';
    let cellClass = required;
    let downgraded = false;
    if (required === 'hard' && !substrates.hard.available) {
      const downgradeAllowed = params ? params.downgrade_allowed !== false : true;
      if (!downgradeAllowed) {
        refuseActivation(conn, frame, req.path,
          `cell-unavailable: this tier requires a HARD cell (Firecracker microVM) and forbids downgrade; this host cannot provide one (missing: ${substrates.hard.missing.join(', ')})`);
        return;
      }
      if (!substrates.soft.available) {
        refuseActivation(conn, frame, req.path,
          `cell-unavailable: no cell substrate on this host (HARD missing: ${substrates.hard.missing.join(', ')}; SOFT unavailable)`);
        return;
      }
      cellClass = 'soft';
      downgraded = true;
      pendReasons.push('cell-downgrade');
      notices.push(`cell: SOFT (${substrates.soft.kind}) — the required HARD cell is unavailable on this host (missing: ${substrates.hard.missing.join(', ')}); approving accepts the downgrade and the record will say so`);
    }
    if (cellClass === 'soft' && !substrates.soft.available) {
      refuseActivation(conn, frame, req.path, 'cell-unavailable: SOFT substrate unavailable on this host');
      return;
    }

    // GRANT + LEASE GATE (§2.3): a live grant launches tap-free; the
    // first activation pends. Leases bound concurrency.
    const maxInstances = issued.grants?.max_instances ?? 1;
    const liveRuns = [...activations.values()].filter((r) => r.canary === frame.canary).length;
    if (liveRuns >= maxInstances) {
      refuseActivation(conn, frame, req.path,
        `activation-busy: ${liveRuns} live run(s) already hold this package's lease(s) (max_instances ${maxInstances})`);
      return;
    }
    const grantLive = issued.grants && (!issued.grants.expires || Date.now() < Date.parse(issued.grants.expires));
    if (grantLive && pendReasons.length === 0) {
      log({ event: 'activate', result: 'grant-launch', canary: frame.canary, cell_class: cellClass });
      launchActivation({
        kind: 'activation', frame, payload, plaintext, filePath: req.path, conn,
        targetClass, cellClass, downgraded: false, tierSnapshot: tierSnap,
        entryRelpath: null, repo: false,
      });
      return;
    }

    // PEND — first activation, or a per-activation gate (warn / override
    // / scan-missing / downgrade) demands the owner's tap this time.
    {
      const reg2 = loadRegistry();
      const cur = reg2.entries[frame.canary];
      if (cur?.claim) {
        beacon(conn, {
          frame, filePath: req.path, reason_class: 'replay-claimed',
          expected: { claimed_pending: cur.claim.id, claimed_at: cur.claim.at },
        });
        return;
      }
    }
    const entry = {
      kind: 'activation', claimCanary: frame.canary,
      frame, filePath: req.path, conn, payload, plaintext,
      context: typeof req.context === 'string' ? req.context.slice(0, 300) : null,
      purpose: null, registryStatus: 'activation-store',
      targetClass, cellClass, downgraded, tierSnapshot: tierSnap,
      entryRelpath: null, repo: false,
      // A scan-missing override is one-time and never grants (§1.6); a
      // warn/override/downgrade pend rides on an existing grant or
      // creates one at approval (first activation).
      createGrant: !scanMissingTap,
      maxInstances: 1,
      notices,
      requiredApprovals: params?.dual_approval ? 2 : 1,
      approvalStage: 0, confirmCode: null,
      createdAt: Date.now(), id: crypto.randomUUID(),
    };
    {
      const reg3 = loadRegistry();
      const cur = reg3.entries[frame.canary];
      cur.claim = { id: entry.id, at: new Date().toISOString() };
      saveRegistry(reg3);
    }
    pending.set(entry.id, entry);
    armApprovalWindow(entry);
    log({
      event: 'activate', result: 'pending-approval', id: entry.id, canary: frame.canary,
      reasons: pendReasons, cell_class: cellClass, downgraded,
    });
    send(conn, {
      ok: true, state: 'pending-approval', id: entry.id, canary: frame.canary,
      reasons: pendReasons, notices, cell_class: cellClass, downgraded,
      approvals_required: entry.requiredApprovals,
      note: 'owner approval required: vaultd.mjs approve (the streaming activate call stays open)',
    });
  }

  // Repo activation (case 26 lives here): the manifest package is the
  // activation subject; every part must carry a tier, or activation
  // refuses NAMING the untiered parts — an untiered part is below
  // Tier 0 and below Tier 0 does not run (§1.7.5).
  function handleActivateRepo(conn, req, parsed) {
    const { frame } = parsed;
    const reg = loadRegistry();
    const issued = reg.entries[frame.canary];
    if (!issued) { beacon(conn, { frame, filePath: req.path, reason_class: 'never-issued' }); return; }
    if (issued.returned_at) { beacon(conn, { frame, filePath: req.path, reason_class: 'replay-consumed' }); return; }
    if ((issued.origin || 'egress') !== 'activation-store') {
      refuseActivation(conn, frame, req.path,
        `not-activatable: repo origin is '${issued.origin || 'egress'}' — only repos sealed into the activation store (wrap-repo --for-activation) may activate`);
      return;
    }
    if (issued.quarantined) { refuseActivation(conn, frame, req.path, 'quarantined: this repo is quarantined in the registry'); return; }
    if (anomalyBlocked(reg, issued)) { refuseActivation(conn, frame, req.path, 'anomaly: an anomaly is standing against this repo — activation refuses until the owner clears it'); return; }
    {
      const rev = revokedSenderBeacon(issued);
      if (rev) { beacon(conn, { frame, filePath: req.path, reason_class: 'revoked-sender', expected: { revoked_at: rev.at, revocation_id: rev.id } }); return; }
    }
    if (!verifyFrameSignature(frame, parsed.body)) { beacon(conn, { frame, filePath: req.path, reason_class: 'bad-frame-signature' }); return; }
    let manifest;
    try {
      const payload = armorDecode(parsed.body, Buffer.from(frame.armor_seed, 'base64'));
      manifest = JSON.parse(openPackage(frame, payload).toString('utf8'));
    } catch (e) { send(conn, { ok: false, error: `manifest does not open: ${e.message}` }); return; }
    if (!manifest || !Array.isArray(manifest.files)) { send(conn, { ok: false, error: 'not a repo manifest' }); return; }
    const wrappedDir = path.dirname(req.path);
    const partsMeta = [];
    const untiered = [];
    for (const f of manifest.files) {
      const parts = [];
      for (const p of f.parts || []) {
        let pp;
        try { pp = parseScriptureFile(fs.readFileSync(path.join(wrappedDir, p.package), 'utf8')); }
        catch { send(conn, { ok: false, error: `repo part ${p.package} unreadable` }); return; }
        if (pp.frame.recipient_seal_fp !== id.sealFp) { send(conn, { ok: false, error: `repo part ${p.package} sealed to a different copy` }); return; }
        if (pp.frame.v >= 4 && pp.frame.recipient_kem_fp !== id.kemFp) { send(conn, { ok: false, error: `repo part ${p.package} KEM-sealed to a different copy` }); return; }
        if ((pp.frame.armor_tier ?? null) == null) untiered.push(f.path);
        let pdata;
        try { pdata = armorDecode(pp.body, Buffer.from(pp.frame.armor_seed, 'base64')); }
        catch { send(conn, { ok: false, error: `repo part ${p.package} does not decode` }); return; }
        parts.push({ frame: pp.frame, payload: pdata, sha256: p.sha256 });
      }
      partsMeta.push({ relpath: f.path, mode: f.mode ?? 0o100644, sha256: f.sha256, parts });
    }
    if (untiered.length) {
      const names = [...new Set(untiered)];
      refuseActivation(conn, frame, req.path,
        `untiered part: ${names.join(', ')} — activation requires every part of a repo to carry an armor tier; re-wrap the repo through the scan layer`,
        'refused: untiered-part');
      return;
    }
    const entryRelpath = req.entry || pol().cell?.repo_entry || null;
    if (!entryRelpath) {
      refuseActivation(conn, frame, req.path, 'repo-entry-required: name the program to run inside the repo (--entry <relpath>) or set cell.repo_entry');
      return;
    }
    const entryPart = partsMeta.find((p) => p.relpath === entryRelpath);
    if (!entryPart) { refuseActivation(conn, frame, req.path, `repo-entry-missing: ${entryRelpath} is not in this repo`); return; }
    const targetClass = /\.m?js$/.test(entryRelpath) ? 'source' : 'binary';
    // Repos run under the manifest's own tier gates + grant machinery.
    const tierSnap = issued.tier ?? null;
    const params = tierSnap?.params ?? null;
    const policy = pol();
    let required = 'hard';
    if (params && params.min_cell && params.min_cell !== 'policy-default') required = params.min_cell;
    else if (targetClass === 'source' && policy.cell?.soft_for_source) required = 'soft';
    let cellClass = required;
    let downgraded = false;
    const pendReasons = [];
    const notices = buildNotices(issued, frame);
    if (required === 'hard' && !substrates.hard.available) {
      const downgradeAllowed = params ? params.downgrade_allowed !== false : true;
      if (!downgradeAllowed) {
        refuseActivation(conn, frame, req.path,
          `cell-unavailable: this tier requires a HARD cell and forbids downgrade; this host cannot provide one (missing: ${substrates.hard.missing.join(', ')})`);
        return;
      }
      if (!substrates.soft.available) { refuseActivation(conn, frame, req.path, 'cell-unavailable: no cell substrate on this host'); return; }
      cellClass = 'soft'; downgraded = true; pendReasons.push('cell-downgrade');
      notices.push(`cell: SOFT (${substrates.soft.kind}) — the required HARD cell is unavailable on this host (missing: ${substrates.hard.missing.join(', ')}); approving accepts the downgrade and the record will say so`);
    }
    const grantLive = issued.grants && (!issued.grants.expires || Date.now() < Date.parse(issued.grants.expires));
    if (grantLive && pendReasons.length === 0) {
      log({ event: 'activate', result: 'grant-launch', canary: frame.canary, cell_class: cellClass, repo: true });
      launchActivation({
        kind: 'activation', frame, payload: null, filePath: req.path, conn,
        targetClass, cellClass, downgraded: false, tierSnapshot: tierSnap,
        entryRelpath, repo: true, partsMeta,
      });
      return;
    }
    const entry = {
      kind: 'activation', claimCanary: frame.canary,
      frame, filePath: req.path, conn, payload: null,
      context: null, purpose: null, registryStatus: 'activation-store',
      targetClass, cellClass, downgraded, tierSnapshot: tierSnap,
      entryRelpath, repo: true, partsMeta,
      createGrant: true, maxInstances: 1,
      notices, requiredApprovals: params?.dual_approval ? 2 : 1,
      approvalStage: 0, confirmCode: null,
      createdAt: Date.now(), id: crypto.randomUUID(),
    };
    {
      const reg2 = loadRegistry();
      const cur = reg2.entries[frame.canary];
      if (cur?.claim) {
        beacon(conn, {
          frame, filePath: req.path, reason_class: 'replay-claimed',
          expected: { claimed_pending: cur.claim.id, claimed_at: cur.claim.at },
        });
        return;
      }
      cur.claim = { id: entry.id, at: new Date().toISOString() };
      saveRegistry(reg2);
    }
    pending.set(entry.id, entry);
    armApprovalWindow(entry);
    log({ event: 'activate', result: 'pending-approval', id: entry.id, canary: frame.canary, reasons: pendReasons, repo: true });
    send(conn, {
      ok: true, state: 'pending-approval', id: entry.id, canary: frame.canary,
      reasons: pendReasons, notices, cell_class: cellClass, downgraded,
      approvals_required: entry.requiredApprovals,
      note: 'owner approval required: vaultd.mjs approve (the streaming activate call stays open)',
    });
  }

  function handleRevokeGrant(conn, req) {
    const canary = req.canary || null;
    const reg = loadRegistry();
    const e = canary ? reg.entries[canary] : null;
    if (!e) { send(conn, { ok: false, error: 'unknown canary' }); return; }
    const had = !!e.grants;
    e.grants = null;
    saveRegistry(reg);
    log({ event: 'activate', result: 'grant-revoked', canary, had_grant: had });
    send(conn, { ok: true, canary, revoked: had });
  }

  // --- the run itself -------------------------------------------------------

  function materializeParts(entry) {
    if (!entry.repo) {
      // Prefer the plaintext opened (and digest-verified) at the gate;
      // re-open only when it was not carried through (defensive).
      const pt = entry.plaintext || openPackage(entry.frame, entry.payload);
      const name = path.basename(entry.filePath).replace(/\.scripture$/, '');
      return {
        parts: [{ relpath: name, bytes: pt, executable: entry.targetClass === 'binary' }],
        entryRelpath: name,
      };
    }
    const parts = [];
    for (const f of entry.partsMeta) {
      const chunks = f.parts.map((p) => openPackage(p.frame, p.payload));
      const whole = Buffer.concat(chunks);
      if (sha256Hex(whole) !== f.sha256) throw new Error('image-mismatch');
      parts.push({ relpath: f.relpath, bytes: whole, executable: (f.mode & 0o111) !== 0 });
    }
    return { parts, entryRelpath: entry.entryRelpath };
  }

  async function launchActivation(entry) {
    const frame = entry.frame;
    const policy = pol();
    const activationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const staging = createStaging(cellsRoot, activationId);
    const record = {
      id: activationId, canary: frame.canary, at: startedAt,
      cell_class: entry.cellClass, downgraded: !!entry.downgraded,
      target_class: entry.targetClass, repo: !!entry.repo,
      ended_at: null, exit: null, emissions: [], artifacts: [], destroyed: false,
    };
    const run = {
      id: activationId, canary: frame.canary, staging, record, conn: entry.conn,
      tierSnapshot: entry.tierSnapshot, cell: null, egressServer: null,
      heartbeat: null, emissionCount: 0, finished: false,
      egressInFlight: new Set(), egressConns: new Set(), egressClosed: false,
    };
    activations.set(activationId, run);
    {
      const reg = loadRegistry();
      const e = reg.entries[frame.canary];
      if (e) {
        e.lease = { activation: activationId, at: startedAt, expires: new Date(Date.now() + (policy.cell?.lease_s ?? 30) * 1000).toISOString() };
        saveRegistry(reg);
      }
    }
    const finish = (outcome) => {
      if (run.finished) return;
      run.finished = true;
      if (run.heartbeat) clearInterval(run.heartbeat);
      try { run.egressServer?.close(); } catch {}
      const destroyed = destroyStaging(staging.root);
      record.destroyed = destroyed;
      if (!destroyed) log({ event: 'cell-destroy-unconfirmed', activation: activationId, canary: frame.canary, staging: staging.root });
      record.ended_at = new Date().toISOString();
      Object.assign(record, outcome);
      const reg = loadRegistry();
      const e = reg.entries[frame.canary];
      if (e) {
        e.activations = [...(e.activations || []), record];
        if (e.lease?.activation === activationId) e.lease = null;
        // The pend that launched this run held the claim; the run is
        // over, so the claim is released (a release is not a
        // consumption — the package may pend or launch again).
        if (e.claim && entry.id && e.claim.id === entry.id) delete e.claim;
        saveRegistry(reg);
      }
      activations.delete(activationId);
      log({ event: 'activation-complete', activation: activationId, canary: frame.canary, ...outcome, destroyed });
      send(entry.conn, {
        ok: true, state: 'activation-complete', id: activationId, canary: frame.canary,
        cell_class: entry.cellClass, downgraded: !!entry.downgraded, destroyed,
        exit: record.exit ?? null, killed: record.killed ?? null,
        boot_failed: record.boot_failed ?? null, refused: record.refused ?? null,
        emissions: record.emissions, artifacts: record.artifacts,
        stdout_tail: record.stdout_tail ?? null, stderr_tail: record.stderr_tail ?? null,
      });
    };
    try {
      // MATERIALIZE — the verified image, in memory only. A digest
      // mismatch here is the image-mismatch refusal (§2.6): no boot.
      let parts, entryRelpath;
      try { ({ parts, entryRelpath } = materializeParts(entry)); }
      catch (e) {
        log({ event: 'beacon', canary: frame.canary, sha256: frame.sha256, reason_class: 'image-mismatch', surface: { label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp } });
        finish({ refused: `image-mismatch: ${e.message}` });
        return;
      }
      for (const p of parts) stagePayload(staging, p.relpath, p.bytes, { executable: p.executable });
      const imagePath = path.join(staging.image, entryRelpath);
      const argv = entry.targetClass === 'source' ? [process.execPath, imagePath] : [imagePath];
      // The marker object lives on the run and is mutated in place —
      // a read-modify-write here would race the heartbeat below and
      // could clobber the pid (or the heartbeat) with a stale copy.
      const markerObj = {
        activation_id: activationId, canary: frame.canary, pid: null,
        cell_class: entry.cellClass, started_at: startedAt, heartbeat_at: startedAt,
        lease_expires: new Date(Date.now() + (policy.cell?.lease_s ?? 30) * 1000).toISOString(),
      };
      run.markerObj = markerObj;
      writeMarker(staging, markerObj);
      run.heartbeat = setInterval(() => {
        try {
          markerObj.heartbeat_at = new Date().toISOString();
          writeMarker(staging, markerObj);
        } catch {}
      }, 2000);
      await startEgressServer(run);
      if (entry.cellClass === 'hard') {
        try { runHardCell(); } catch (e) { finish({ boot_failed: e.message }); return; }
      }
      const cell = runSoftCell({
        staging, argv,
        scratchMb: policy.cell?.scratch_mb ?? 256,
        cpuSeconds: policy.cell?.cpu_seconds ?? 60,
        wallMs: (policy.cell?.max_seconds ?? 300) * 1000,
      });
      run.cell = cell;
      try {
        markerObj.pid = cell.pid;
        writeMarker(staging, markerObj);
      } catch {}
      log({ event: 'activate', result: 'launched', activation: activationId, canary: frame.canary, cell_class: entry.cellClass, downgraded: !!entry.downgraded, pid: cell.pid });
      send(entry.conn, {
        ok: true, state: 'activated', id: activationId, canary: frame.canary,
        cell_class: entry.cellClass, downgraded: !!entry.downgraded, pid: cell.pid,
      });
      const res = await cell.done;
      // The cell is dead; its emissions may not be. Egress frames are
      // handled asynchronously (a promotion scans, seals, registers),
      // and a fast-exiting cell otherwise outruns its own emissions:
      // the record would close over work that lands afterwards,
      // unrecorded (the case-11 defect — a clean promotion existed in
      // the store but the activation record showed no artifact). An
      // activation is not finished until every frame it sent has
      // been fully handled and every egress connection has closed.
      const drain = await drainEgress(run);
      // The record is final from here: frames arriving now are
      // refused at the handler (egress-late-drop) and handlers still
      // in flight complete under testimony — neither may silently
      // merge into a closed record (F-06c).
      run.egressClosed = true;
      finish({
        exit: res.exit, signal: res.signal, killed: res.killedBy,
        stdout_tail: res.stdout.toString('utf8').slice(-2000) || null,
        stderr_tail: res.stderr.toString('utf8').slice(-2000) || null,
        egress_drained: drain.drained,
        ...(drain.drained ? {} : { egress_unresolved: { in_flight: drain.in_flight, open_conns: drain.open_conns } }),
      });
    } catch (e) {
      finish({ boot_failed: e.message });
    }
  }

  // --- egress: the only way a byte leaves a cell (§2.5) ---------------------

  // Framing bounds (F-06a): the header is small JSON and a payload can
  // never legitimately exceed the policy emission cap — the handler
  // enforces that cap only AFTER a frame has been fully buffered, so
  // without framing bounds a faulty or compromised cell could make the
  // daemon accumulate unbounded memory waiting for a frame that can
  // never complete, or desync the stream with a wrapped length (the
  // old code coerced header.bytes with `| 0`: >= 2^31 wraps negative,
  // non-integers truncate silently). A frame that breaks the bounds is
  // refused and its connection destroyed; the refusal is testified.
  const EGRESS_MAX_HEADER_BYTES = 64 * 1024;
  const EGRESS_IDLE_MS = 600000; // aligned with the drain cap below

  function startEgressServer(run) {
    return new Promise((resolve) => {
      const srv = net.createServer((c) => {
        run.egressConns.add(c);
        c.on('close', () => run.egressConns.delete(c));
        c.setTimeout(EGRESS_IDLE_MS, () => {
          log({ event: 'egress-frame-refused', activation: run.id, reason: 'idle-timeout' });
          c.destroy();
        });
        let buf = Buffer.alloc(0);
        c.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          const maxPayload = pol().cell?.max_emission_bytes ?? 16 * 1024 * 1024;
          const maxBuffered = 4 + EGRESS_MAX_HEADER_BYTES + maxPayload;
          for (;;) {
            if (buf.length > maxBuffered) {
              log({ event: 'egress-frame-refused', activation: run.id, reason: 'buffer-overrun', buffered: buf.length, cap: maxBuffered });
              c.destroy(); return;
            }
            if (buf.length < 4) return;
            const hlen = buf.readUInt32BE(0);
            if (hlen === 0 || hlen > EGRESS_MAX_HEADER_BYTES) {
              log({ event: 'egress-frame-refused', activation: run.id, reason: 'header-length', hlen });
              c.destroy(); return;
            }
            if (buf.length < 4 + hlen) return;
            let header;
            try { header = JSON.parse(buf.subarray(4, 4 + hlen).toString('utf8')); } catch { c.destroy(); return; }
            const declared = header.bytes === undefined ? 0 : header.bytes;
            if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxPayload) {
              log({ event: 'egress-frame-refused', activation: run.id, reason: 'payload-length', declared: String(header.bytes) });
              c.destroy(); return;
            }
            const total = 4 + hlen + declared;
            if (buf.length < total) return;
            const payload = buf.subarray(4 + hlen, total);
            buf = buf.subarray(total);
            // Track every frame's handling so launchActivation can
            // drain egress before finalizing the activation record
            // (see drainEgress). The .catch keeps this promise from
            // ever rejecting, so the Set holds only live work.
            const handled = handleEgressFrame(run, header, Buffer.from(payload)).catch((e) => {
              log({ event: 'egress-error', activation: run.id, error: e.message });
            }).then(() => {
              // A handler that completes after the activation record
              // was finalized (drain cap expired — see F-06c) lands
              // outside the record by construction; testify the late
              // completion so it is never a silent landing.
              if (run.egressClosed) log({ event: 'egress-completed-after-finalize', activation: run.id, canary: run.canary, kind: header.kind ?? null });
            });
            run.egressInFlight.add(handled);
            handled.finally(() => run.egressInFlight.delete(handled));
          }
        });
        c.on('error', () => {});
      });
      srv.on('error', () => resolve());
      run.egressServer = srv;
      srv.listen(run.staging.egressSock, () => resolve());
    });
  }

  // Wait until every egress frame the cell sent has been fully
  // handled and every egress connection has closed. The empty
  // condition must hold across 3 consecutive polls (~25 ms apart) so
  // socket events already queued — a final frame, a close — land
  // before the drain is called done. The cap is generous on purpose:
  // promoting a binary emission runs a full Ghidra scan (measured
  // ~28 s on a small VM, slower under load). If the cap ever expires,
  // the timeout is testified in the log AND the activation record is
  // finalized as explicitly indeterminate (egress_drained: false +
  // egress_unresolved counts — F-06c) instead of reading as complete;
  // frames arriving afterwards are refused at the handler and late
  // completions are testified, never silently merged.
  async function drainEgress(run) {
    const CAP_MS = pol().cell?.egress_drain_cap_ms ?? 600000;
    const started = Date.now();
    let quietPolls = 0;
    while (Date.now() - started < CAP_MS) {
      if (run.egressInFlight.size === 0 && run.egressConns.size === 0) {
        quietPolls += 1;
        if (quietPolls >= 3) return { drained: true };
      } else {
        quietPolls = 0;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    log({ event: 'egress-drain-timeout', activation: run.id, canary: run.canary, in_flight: run.egressInFlight.size, open_conns: run.egressConns.size });
    return { drained: false, in_flight: run.egressInFlight.size, open_conns: run.egressConns.size };
  }

  function queueOutbox(issuance) {
    try {
      fs.appendFileSync(path.join(dir, 'registry-outbox.jsonl'), JSON.stringify(issuance) + '\n', { mode: 0o600 });
    } catch {}
  }

  function rpcToDaemon(socketPath, obj) {
    return new Promise((resolve) => {
      const c = net.connect(socketPath);
      let buf = '';
      const done = (v) => { try { c.end(); } catch {} resolve(v); };
      c.on('connect', () => c.write(JSON.stringify(obj) + '\n'));
      c.on('data', (d) => {
        buf += d.toString('utf8');
        const i = buf.indexOf('\n');
        if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); } }
      });
      c.on('error', () => done(null));
      setTimeout(() => done(null), 5000);
    });
  }

  async function handleEgressFrame(run, header, payload) {
    if (run.egressClosed) {
      // The activation record has been finalized (its drain returned,
      // drained or not). A frame arriving now can never be part of
      // that record — refuse it, testified, never process it into a
      // late landing (F-06c).
      log({ event: 'egress-late-drop', activation: run.id, canary: run.canary, kind: header.kind ?? null, bytes: payload.length });
      return;
    }
    const policy = pol();
    if (header.kind === 'log') {
      log({ event: 'cell-log', activation: run.id, canary: run.canary, text: payload.toString('utf8').slice(0, 2000) });
      return;
    }
    if (header.kind !== 'emit') {
      log({ event: 'egress-drop', activation: run.id, reason: `unknown frame kind: ${header.kind}` });
      return;
    }
    run.emissionCount += 1;
    if (run.emissionCount > (policy.cell?.max_emissions ?? 1000)) {
      log({ event: 'activate', result: 'killed: emission-flood', activation: run.id, canary: run.canary });
      run.cell?.kill('emission-flood');
      return;
    }
    if (payload.length > (policy.cell?.max_emission_bytes ?? 16 * 1024 * 1024)) {
      log({ event: 'activate', result: 'killed: emission-cap', activation: run.id, canary: run.canary, bytes: payload.length });
      run.cell?.kill('emission-cap');
      return;
    }
    const to = typeof header.to === 'string' ? header.to : '';
    const params = run.tierSnapshot?.params ?? null;
    // Tier binding (§2.5): Tier 2 emits to the airlock ONLY.
    if (params?.egress === 'airlock-only' && !to.startsWith('airlock:')) {
      log({ event: 'egress-tier-restricted', activation: run.id, canary: run.canary, to, bytes: payload.length });
      run.record.emissions.push({ to, bytes: payload.length, dropped: 'egress-tier-restricted' });
      return;
    }
    // An emitted PROGRAM is never delivered as a program (§2.5 mantrap
    // door): it re-enters only as an activation-store candidate, behind
    // the scan and a future owner grant.
    const cls = classifyBuffer(payload, '');
    const isProgram = cls === 'binary' || payload.subarray(0, 2).toString('latin1') === '#!' || header.program === true;
    if (isProgram) {
      await promoteCandidate(run, payload);
      return;
    }
    if (to.startsWith('airlock:')) {
      const ok = await dockSendInternal(to.slice('airlock:'.length), payload, { program: false, fromCanary: run.canary });
      run.record.emissions.push({ to, bytes: payload.length, via: 'airlock', delivered: ok });
      if (!ok) log({ event: 'egress-drop', activation: run.id, to, reason: 'dock-closed-or-unknown' });
      return;
    }
    const book = loadAddressBook(dir);
    const peer = to ? book[to] : null;
    if (!peer) {
      // Unresolvable destination: dropped and logged. There is no
      // fallback path — the cell has no other way out (§2.5).
      log({ event: 'egress-drop', activation: run.id, to: to || null, reason: 'unresolved-destination', bytes: payload.length });
      run.record.emissions.push({ to: to || null, bytes: payload.length, dropped: 'unresolved-destination' });
      return;
    }
    // Armored peer: the DAEMON seals (the program holds no keys) and the
    // issuance is registered — at the peer's daemon when it is
    // reachable, else queued into the offline outbox (v1 mechanism).
    const sealed = sealPlaintext(payload, id, peer, {});
    fs.mkdirSync(path.join(dir, 'emissions'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'emissions', `${sealed.frame.canary}.scripture`), sealed.text, { mode: 0o600 });
    const issuance = {
      canary: sealed.frame.canary, digest: frameDigest(sealed.frame), digest_kind: 'commit',
      recipient_seal_fp: sealed.frame.recipient_seal_fp, sender_sign_fp: id.signFp,
      expiry: sealed.frame.expiry ?? null, issued_at: new Date().toISOString(), origin: 'egress',
    };
    // Issuer-side memory (SPEC §4.6): daemon-sealed emissions are this
    // endpoint's issuances too — sync judges held-claims against them.
    appendIssuedLog(dir, [issuance]);
    let registeredAt = 'outbox';
    if (peer.daemon_socket) {
      // Daemon-to-daemon registration is SIGNED like any other
      // requester-socket registration (FIX 1) — the peer daemon binds
      // the entries to this daemon's identity, never to the channel.
      const res = await rpcToDaemon(peer.daemon_socket, signLocalRegister(id, [issuance]));
      if (res?.ok) registeredAt = 'peer-daemon';
      else queueOutbox(issuance);
    } else {
      queueOutbox(issuance);
    }
    run.record.emissions.push({ to, canary: sealed.frame.canary, bytes: payload.length, registered: registeredAt });
    log({ event: 'egress', activation: run.id, canary: run.canary, to, emission_canary: sealed.frame.canary, bytes: payload.length, registered: registeredAt });
  }

  async function promoteCandidate(run, payload) {
    const policy = pol();
    const tmpDir = fs.mkdtempSync(path.join(cellsRoot, 'promote-'));
    // The scan lane is chosen by classification + name: a text payload
    // named .bin would be thrown into the (synchronous) binary lane.
    // Name the staging file for the lane the payload actually belongs
    // to — binary magic ⇒ .bin; anything else arriving here was
    // declared a program ⇒ source lane (.mjs).
    const tmpFile = path.join(tmpDir,
      classifyBuffer(payload, '') === 'binary' ? 'candidate.bin' : 'candidate.mjs');
    let record;
    try {
      fs.writeFileSync(tmpFile, payload, { mode: 0o600 });
      record = (await scanFile(tmpFile, { policy, storeDir: dir })).record;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    // The exact-sample-hash rule lives in the binary lane
    // (normalizeBinaryFindings); a source-lane promotion would never
    // consult the owner's list. The daemon consults it directly here —
    // a listed sample is refused promotion whatever its lane.
    let listedHash = false;
    try {
      const list = fs.readFileSync(path.join(dir, 'badhashes.txt'), 'utf8')
        .split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
      listedHash = list.includes(sha256Hex(payload));
    } catch {}
    if (record.verdict === 'critical' || listedHash) {
      log({ event: 'promotion-refused', activation: run.id, canary: run.canary, verdict: 'critical', rule: listedHash ? 'exact-sample-hash' : 'scan', digest: scanDigestOf(record) });
      run.record.emissions.push({ program: true, refused: 'scan-critical', bytes: payload.length });
      return;
    }
    const digest = scanDigestOf(record);
    const reportSealed = sealPlaintext(Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8'), id, id, {});
    const tier = record.risk?.tier ?? 0;
    const sealed = sealPlaintext(payload, id, id, {
      scan: { verdict: record.verdict, digest, reportCanary: reportSealed.frame.canary, tier },
    });
    fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true, mode: 0o700 });
    // The report rides BESIDE the candidate under the name the
    // activation-time re-verification looks for (<pkg>.scan-report).
    fs.writeFileSync(path.join(dir, 'candidates', `${sealed.frame.canary}.scan-report.scripture`), reportSealed.text, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'candidates', `${sealed.frame.canary}.scripture`), sealed.text, { mode: 0o600 });
    const reg = loadRegistry();
    insertIssuances(reg, [
      {
        canary: reportSealed.frame.canary, digest: frameDigest(reportSealed.frame), digest_kind: 'commit',
        recipient_seal_fp: id.sealFp, sender_sign_fp: id.signFp, expiry: null,
        origin: 'activation-store', report_for: sealed.frame.canary, report_only: true,
      },
      {
        canary: sealed.frame.canary, digest: frameDigest(sealed.frame), digest_kind: 'commit',
        recipient_seal_fp: id.sealFp, sender_sign_fp: id.signFp, expiry: sealed.frame.expiry ?? null,
        origin: 'activation-store', candidate: true,
        scan: { verdict: record.verdict, digest, report_canary: reportSealed.frame.canary },
        tier: { tier, params: tierParams(tier, policy) },
      },
    ], 'daemon-candidate', id.signFp);
    saveRegistry(reg);
    run.record.artifacts.push(sealed.frame.canary);
    run.record.emissions.push({ program: true, candidate: sealed.frame.canary, verdict: record.verdict, bytes: payload.length });
    log({ event: 'promotion-candidate', activation: run.id, canary: run.canary, candidate: sealed.frame.canary, verdict: record.verdict, tier });
  }

  // -----------------------------------------------------------------------
  // CLOSURE 3 — the docking airlock (SPEC §3) + Addendum A.3 (Strip
  // Outside Influence Unless Requested). vaultd supervises one airlock
  // PROCESS per session; the child never holds keys, a registry handle,
  // or a path into this store. Crossings are recorded BEFORE data moves.
  // -----------------------------------------------------------------------

  function handleDockOpen(conn, req) {
    const policy = pol();
    const profiles = policy.airlock?.profiles || {};
    const profile = profiles[req.profile];
    if (!profile) {
      send(conn, { ok: false, error: `unknown-profile: ${req.profile} — dock profiles are declared by the owner in policy.json (airlock.profiles)` });
      return;
    }
    const notices = [
      `dock profile "${req.profile}": content classes allowed inbound — ${(profile.classes || []).join(', ') || '(none declared)'}`,
      profile.plaintext_code
        ? 'PLAINTEXT CODE: this profile ALLOWS programs to cross OUT as plaintext code (the owner declared it)'
        : 'programs crossing OUT travel as .scripture packages, never plaintext code',
      'inbound executable-class content is scanned inside the chamber before it crosses; everything that crosses IN exists inside the shell only as an armored package (origin airlock-in)',
      'Strip Outside Influence: nothing crosses unless this dock is opened and its profile allows it — approval opens exactly this profile, not a class of future docks',
    ];
    const entry = {
      kind: 'dock', claimCanary: null, frame: null, filePath: null,
      profileName: String(req.profile), profile, conn,
      notices, requiredApprovals: 1, approvalStage: 0, confirmCode: null,
      context: null, purpose: null, registryStatus: null, tierSnapshot: null,
      createdAt: Date.now(), id: crypto.randomUUID(),
    };
    pending.set(entry.id, entry);
    armApprovalWindow(entry);
    log({ event: 'dock', result: 'pending-approval', id: entry.id, profile: entry.profileName });
    send(conn, {
      ok: true, state: 'pending-approval', id: entry.id, profile: entry.profileName,
      notices, note: 'owner approval required: vaultd.mjs approve (the streaming dock-open call stays open)',
    });
  }

  function openAirlockSession(entry) {
    const policy = pol();
    const HERE = path.dirname(path.resolve(process.argv[1]));
    const sessionId = crypto.randomUUID();
    const root = path.join(os.tmpdir(), 'sa-airlocks');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const sdir = path.join(root, sessionId);
    fs.mkdirSync(path.join(sdir, 'chamber'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(sdir, 'xfer'), { recursive: true, mode: 0o700 });
    const limits = { ...(policy.airlock || {}) };
    delete limits.profiles;
    fs.writeFileSync(path.join(sdir, 'config.json'), JSON.stringify({
      session: sessionId, profile: entry.profile, profile_name: entry.profileName, limits,
      scan: { timeout_s: policy.scan?.timeout_s ?? 120, ghidra_home: policy.scan?.ghidra_home ?? null, jdk_home: policy.scan?.jdk_home ?? null },
    }, null, 2), { mode: 0o600 });
    // The child runs the scan layer from its own session dir: hand it a
    // scan-only policy + the bad-hash LIST CONTENTS (never a store path).
    fs.writeFileSync(path.join(sdir, 'policy.json'), JSON.stringify({
      scan: { timeout_s: policy.scan?.timeout_s ?? 120, ghidra_home: policy.scan?.ghidra_home ?? null, jdk_home: policy.scan?.jdk_home ?? null },
    }, null, 2), { mode: 0o600 });
    try {
      const bh = path.join(dir, 'badhashes.txt');
      if (fs.existsSync(bh)) fs.writeFileSync(path.join(sdir, 'badhashes.txt'), fs.readFileSync(bh), { mode: 0o600 });
    } catch {}
    const proc = spawn(process.execPath, [path.join(HERE, 'airlock.mjs'), 'serve', '--session-dir', sdir], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: sdir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const dock = {
      id: sessionId, dir: sdir, proc, profile: entry.profile, profileName: entry.profileName,
      conn: entry.conn, ctrl: null, closed: false, deliverSeq: 0,
      pendingDeliver: new Map(),
      peerDesc: entry.profile.peer || { kind: 'local-process', descriptor: entry.profileName },
      serves: entry.profile.serves || null,
    };
    docks.set(sessionId, dock);
    proc.stderr.on('data', (d) => log({ event: 'airlock-stderr', session: sessionId, text: d.toString('utf8').slice(0, 500) }));
    proc.on('exit', (code, signal) => {
      if (!dock.closed) {
        dock.closed = true;
        docks.delete(sessionId);
        airlockRecord({ event: 'close', session: sessionId, profile: dock.profileName, reason: 'airlock-fault', peer: dock.peerDesc });
        log({ event: 'incident', kind: 'airlock-fault', session: sessionId, code, signal });
        reconcileCustodyTestimony(dock);
        fs.rmSync(sdir, { recursive: true, force: true });
      }
    });
    // Connect to the child's control socket once it exists.
    const ctrlPath = path.join(sdir, 'ctrl.sock');
    const tryConnect = (attempts) => {
      if (dock.closed) return;
      if (fs.existsSync(ctrlPath)) {
        const c = net.connect(ctrlPath);
        let buf = '';
        c.on('connect', () => { dock.ctrl = c; });
        c.on('data', (d) => {
          buf += d.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            handleAirlockEvent(dock, msg).catch((e) => log({ event: 'airlock-event-error', session: sessionId, error: e.message }));
          }
        });
        c.on('error', () => {});
        return;
      }
      if (attempts > 0) setTimeout(() => tryConnect(attempts - 1), 50);
      else log({ event: 'incident', kind: 'airlock-no-control', session: sessionId });
    };
    tryConnect(100);
    log({ event: 'dock', result: 'session-spawning', session: sessionId, profile: entry.profileName });
  }

  function ctrlSend(dock, obj) {
    try { dock.ctrl?.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  // F-06b: before a dock's session dir is removed, reconcile any
  // custody testimony the airlock persisted locally at close (its
  // control channel is best-effort; the file is the durable copy).
  // Each stranded item receives the same record + beacon the live
  // violation path produces, so a lost ctrl write can no longer mean
  // silent custody loss.
  function reconcileCustodyTestimony(dock) {
    let lines;
    try { lines = fs.readFileSync(path.join(dock.dir, 'custody-testimony.jsonl'), 'utf8').split('\n').filter((l) => l.trim()); }
    catch { return; }
    for (const line of lines) {
      let item; try { item = JSON.parse(line); } catch { continue; }
      airlockRecord({
        event: 'custody-unsettled', session: dock.id, profile: dock.profileName, dir: 'in',
        bytes: item.bytes ?? null, sha256: item.sha256 ?? null, canary: null,
        verdict: null, peer: dock.peerDesc, reason_class: 'airlock-protocol',
      });
      log({ event: 'beacon', canary: dock.serves, sha256: item.sha256 ?? null, reason_class: 'airlock-protocol', session: dock.id, surface: { label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp } });
    }
  }

  async function handleAirlockEvent(dock, msg) {
    const policy = pol();
    if (msg.type === 'ready') {
      airlockRecord({ event: 'open', session: dock.id, profile: dock.profileName, peer: dock.peerDesc, chamber: msg.chamber });
      log({ event: 'dock', result: 'session-open', session: dock.id, profile: dock.profileName, chamber: msg.chamber, socket: msg.peer_socket });
      send(dock.conn, {
        ok: true, state: 'session-open', session: dock.id, profile: dock.profileName,
        socket: msg.peer_socket, chamber: msg.chamber,
      });
      return;
    }
    if (msg.type === 'in-staged' || msg.type === 'quarantine-request') {
      const bytes = fs.readFileSync(msg.path);
      if (sha256Hex(bytes) !== msg.sha256 || bytes.length !== msg.bytes) {
        log({ event: 'incident', kind: 'airlock-handoff-mismatch', session: dock.id });
        ctrlSend(dock, { type: 'drop', id: msg.id });
        return;
      }
      const record = msg.record || null;
      const scanBlock = record ? {
        verdict: record.verdict,
        digest: scanDigestOf(record),
        reportCanary: null,
        tier: record.risk?.tier ?? null,
      } : null;
      const sealed = sealPlaintext(bytes, id, id, scanBlock ? { scan: scanBlock } : {});
      const tier = record?.risk?.tier ?? null;
      const quarantined = msg.type === 'quarantine-request';
      const destDir = quarantined ? path.join(dir, 'quarantine') : path.join(dir, 'inbound');
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(destDir, `${sealed.frame.canary}.scripture`), sealed.text, { mode: 0o600 });
      const reg = loadRegistry();
      insertIssuances(reg, [{
        canary: sealed.frame.canary, digest: frameDigest(sealed.frame), digest_kind: 'commit',
        recipient_seal_fp: id.sealFp, sender_sign_fp: id.signFp, expiry: null,
        origin: 'airlock-in',
        scan: record ? { verdict: record.verdict, digest: scanDigestOf(record), report_canary: null } : null,
        tier: tier != null ? { tier, params: tierParams(tier, policy) } : null,
        quarantined: quarantined ? { at: new Date().toISOString(), reason: `airlock-scan: ${(record?.findings || []).find((f) => f.severity === 'critical')?.rule || 'critical finding'}` } : null,
      }], 'daemon-airlock', id.signFp);
      saveRegistry(reg);
      // The crossing record: written as the data completes its move
      // INTO the shell (the chamber copy is wiped by the child next).
      airlockRecord({
        event: 'crossing', session: dock.id, profile: dock.profileName, dir: 'in',
        bytes: bytes.length, sha256: msg.sha256, canary: sealed.frame.canary,
        verdict: record?.verdict ?? null, peer: dock.peerDesc,
        reason_class: quarantined ? 'airlock-scan' : null,
      });
      if (quarantined) {
        log({ event: 'beacon', canary: null, sha256: msg.sha256, reason_class: 'airlock-scan', session: dock.id, surface: { label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp } });
        setTierAnomaly(dock, 'airlock-scan');
      }
      ctrlSend(dock, { type: quarantined ? 'quarantined' : 'in-crossed', id: msg.id, canary: sealed.frame.canary });
      return;
    }
    if (msg.type === 'violation') {
      airlockRecord({
        event: 'violation', session: dock.id, profile: dock.profileName, dir: msg.dir || 'in',
        bytes: msg.bytes ?? null, sha256: msg.sha256 ?? null, canary: null,
        verdict: null, peer: dock.peerDesc, reason_class: msg.reason_class,
      });
      log({ event: 'beacon', canary: dock.serves, sha256: msg.sha256 ?? null, reason_class: msg.reason_class, session: dock.id, surface: { label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp } });
      setTierAnomaly(dock, msg.reason_class);
      return;
    }
    if (msg.type === 'delivered' || msg.type === 'deliver-failed') {
      const res = dock.pendingDeliver.get(msg.id);
      if (res) { dock.pendingDeliver.delete(msg.id); res(msg.type === 'delivered'); }
      return;
    }
    if (msg.type === 'closed') {
      dock.closed = true;
      docks.delete(dock.id);
      airlockRecord({ event: 'close', session: dock.id, profile: dock.profileName, reason: msg.reason, peer: dock.peerDesc });
      log({ event: 'dock', result: `closed: ${msg.reason}`, session: dock.id });
      reconcileCustodyTestimony(dock);
      try { dock.proc.kill('SIGTERM'); } catch {}
      setTimeout(() => fs.rmSync(dock.dir, { recursive: true, force: true }), 250);
      return;
    }
  }

  // A violation in a session serving a Tier-2 program sets that
  // program's anomaly (§3.3/§1.7.2) — its next activation refuses.
  function setTierAnomaly(dock, reasonClass) {
    if (!dock.serves) return;
    const reg = loadRegistry();
    const e = reg.entries[dock.serves];
    if (e?.tier?.params?.beacon_anomaly && !e.anomaly) {
      e.anomaly = { at: new Date().toISOString(), reason_class: reasonClass, via: 'airlock', session: dock.id };
      saveRegistry(reg);
      log({ event: 'anomaly', result: 'set', canary: dock.serves, reason_class: reasonClass, via: 'airlock' });
    }
  }

  // OUT crossing, daemon side: the record is appended BEFORE the bytes
  // move (§3.2) — hash first, testimony first, delivery second.
  function dockSendInternal(sessionId, payload, { program = false } = {}) {
    const dock = docks.get(sessionId);
    if (!dock || dock.closed || !dock.ctrl) return Promise.resolve(false);
    let delivered = payload;
    let wrapped = false;
    if (program && !dock.profile.plaintext_code) {
      delivered = Buffer.from(sealPlaintext(payload, id, id, {}).text, 'utf8');
      wrapped = true;
    }
    airlockRecord({
      event: 'crossing', session: sessionId, profile: dock.profileName, dir: 'out',
      bytes: delivered.length, sha256: sha256Hex(delivered), canary: null,
      verdict: null, peer: dock.peerDesc, program_wrapped: wrapped || undefined,
    });
    const idNum = ++dock.deliverSeq;
    const xferPath = path.join(dock.dir, 'xfer', `out-${idNum}.bin`);
    fs.writeFileSync(xferPath, delivered, { mode: 0o600 });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { dock.pendingDeliver.delete(idNum); resolve(false); }, 10000);
      dock.pendingDeliver.set(idNum, (ok) => { clearTimeout(timer); resolve(ok); });
      ctrlSend(dock, { type: 'deliver-out', id: idNum, path: xferPath });
    });
  }

  async function handleDockSend(conn, req) {
    const dock = docks.get(req.session);
    if (!dock) { send(conn, { ok: false, error: 'unknown-session' }); return; }
    let payload;
    try { payload = fs.readFileSync(req.path); }
    catch { send(conn, { ok: false, error: `cannot read ${req.path}` }); return; }
    const cls = classifyBuffer(payload, path.basename(req.path));
    const ok = await dockSendInternal(req.session, payload, { program: cls === 'binary' || cls === 'source' });
    send(conn, { ok, delivered: ok, session: req.session });
  }

  function handleDockClose(conn, req) {
    const dock = docks.get(req.session);
    if (!dock) { send(conn, { ok: false, error: 'unknown-session' }); return; }
    ctrlSend(dock, { type: 'close' });
    send(conn, { ok: true, closing: req.session });
  }

  function handleSupersede(conn, req) {
    const reg = loadRegistry();
    const oldE = reg.entries[req.old_canary];
    const newE = reg.entries[req.new_canary];
    if (!oldE || !newE) {
      send(conn, { ok: false, error: 'supersede: both canaries must be registered issuances' });
      return;
    }
    if (oldE.sender_sign_fp !== newE.sender_sign_fp
      || oldE.recipient_seal_fp !== newE.recipient_seal_fp) {
      log({ event: 'supersede', result: 'refused: issuance mismatch', old_canary: req.old_canary, new_canary: req.new_canary });
      send(conn, { ok: false, error: 'supersede: the two issuances do not describe the same content/sender/recipient' });
      return;
    }
    // Content binding. Legacy pairs (both digests are raw plaintext
    // hashes) prove sameness by digest equality, as they always did.
    // A v3 issuance's commitment is keyed per-package, so two wraps of
    // the same bytes NEVER share a digest (FIX 3) — sameness is proven
    // instead by the one-time reseal token this daemon minted when it
    // opened the OLD package for re-seal (see executeUnwrap).
    const legacyPair = (oldE.digest_kind ?? 'sha256') === 'sha256' && (newE.digest_kind ?? 'sha256') === 'sha256';
    if (legacyPair) {
      if (entryDigestOf(oldE) !== entryDigestOf(newE)) {
        log({ event: 'supersede', result: 'refused: issuance mismatch', old_canary: req.old_canary, new_canary: req.new_canary });
        send(conn, { ok: false, error: 'supersede: the two issuances do not describe the same content/sender/recipient' });
        return;
      }
    } else {
      const tokenHash = req.reseal_token
        ? crypto.createHash('sha256').update(String(req.reseal_token)).digest('hex') : null;
      if (!oldE.reseal_token_hash || tokenHash !== oldE.reseal_token_hash) {
        log({ event: 'supersede', result: 'refused: no reseal lineage token', old_canary: req.old_canary, new_canary: req.new_canary });
        send(conn, { ok: false, error: 'supersede: no reseal lineage — the old issuance must be opened for re-seal by this daemon and its one-time token presented' });
        return;
      }
      delete oldE.reseal_token_hash; // one-time: spent by this marking
    }
    // Note: the old issuance being returned is the NORMAL case — a
    // re-seal consumes the old issuance through the governed unwrap
    // and then marks it superseded by its replacement.
    oldE.superseded_by = req.new_canary;
    saveRegistry(reg);
    log({ event: 'supersede', result: 'marked', old_canary: req.old_canary, new_canary: req.new_canary });
    send(conn, { ok: true, superseded: req.old_canary, superseded_by: req.new_canary });
  }

  function handleClearAnomaly(conn, req) {
    const reg = loadRegistry();
    const target = reg.entries[req.canary];
    if (!target) { send(conn, { ok: false, error: 'clear-anomaly: unknown canary' }); return; }
    let cleared = 0;
    for (const e of Object.values(reg.entries)) {
      if (e.anomaly && (e.canary === req.canary || (target.repo && e.repo === target.repo))) {
        e.anomaly = null;
        cleared++;
      }
    }
    if (cleared) saveRegistry(reg);
    log({ event: 'clear-anomaly', result: 'cleared', canary: req.canary, entries_cleared: cleared });
    send(conn, { ok: true, cleared, canary: req.canary });
  }

  // -----------------------------------------------------------------------
  // CLOSURE 4 — the estate on the mesh (SPEC §4). The daemon gains an
  // OPTIONAL mesh listener (policy estate.mesh_listen), bound ONLY to
  // the configured address. The RPC set is register / sync-registry /
  // revoke / status — the mesh forms of existing semantics. unwrap /
  // approve / activate are NEVER mesh-callable: opening stays a local
  // act at the daemon the package is sealed to, under its owner's
  // hand. The estate moves MEMORY (issuances, revocations), never keys
  // and never authority over another endpoint's vault.
  // -----------------------------------------------------------------------

  function heldDigestsFor(peerSignFp) {
    return Object.values(loadRegistry().entries)
      .filter((e) => e.sender_sign_fp === peerSignFp)
      .map((e) => ({
        canary: e.canary, digest: entryDigestOf(e),
        scan_digest: e.scan?.digest ?? null, issued_at: e.issued_at,
      }));
  }
  function issuedEntriesFor(peerSealFp) {
    const byCanary = new Map();
    for (const e of loadIssuedLog(dir)) {
      if (e.recipient_seal_fp === peerSealFp) byCanary.set(e.canary, e);
    }
    return [...byCanary.values()];
  }
  function buildSyncView(peerSignFp, peerSealFp, st) {
    return {
      held: heldDigestsFor(peerSignFp),
      issued: issuedEntriesFor(peerSealFp).map((e) => ({
        canary: e.canary, digest: entryDigestOf(e), issued_at: e.issued_at,
      })),
      revocations: (loadRevocations(dir).records)
        .filter((r) => !(st.revocation_acks[r.id] || {})[peerSignFp]),
      // Every record id I hold, acked or not: the counterparty marks
      // my holding in ITS ack table from this list alone, so a record
      // that arrived via a response side still converges in one
      // exchange instead of waiting for a re-send that the filtered
      // list above would (correctly) never make.
      revocation_ids: (loadRevocations(dir).records).map((r) => r.id),
      proofs: (st.proofs || []).filter((p) => p.with_sign_fp === peerSignFp),
    };
  }

  // Process ONE side of a sync exchange (the exchange is symmetric: the
  // receiver processes the request view, the initiator processes the
  // response view). Mutates `st` (caller saves). Returns what this side
  // found: conflicts (detection ONLY — nothing is overwritten, ever),
  // the canaries this side is missing (want), and the revocation ids
  // from the view this side now holds (ackIds).
  function processSyncView(st, fromSignFp, view) {
    const conflicts = [];
    const reg = loadRegistry();
    const myIssued = new Map();
    for (const e of loadIssuedLog(dir)) myIssued.set(e.canary, e);
    // Their held-claims about MY issuances vs my issuer memory.
    for (const h of view.held || []) {
      const mine = myIssued.get(h.canary);
      if (!mine) conflicts.push({ canary: h.canary, kind: 'counterparty-never-issued' });
      else if (entryDigestOf(mine) !== (h.digest ?? h.sha256 ?? null)) conflicts.push({ canary: h.canary, kind: 'digest-mismatch' });
    }
    // My held entries FROM them vs their claimed issuer memory.
    const theirIssued = new Map((view.issued || []).map((e) => [e.canary, e]));
    for (const e of Object.values(reg.entries)) {
      if (e.sender_sign_fp !== fromSignFp) continue;
      const t = theirIssued.get(e.canary);
      if (!t) conflicts.push({ canary: e.canary, kind: 'counterparty-never-issued' });
      else if ((t.digest ?? t.sha256 ?? null) !== entryDigestOf(e)) conflicts.push({ canary: e.canary, kind: 'digest-mismatch' });
    }
    const want = [];
    for (const t of view.issued || []) if (!reg.entries[t.canary]) want.push(t.canary);
    const seen = new Set();
    for (const c of conflicts) {
      const k = `${c.canary}:${c.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      log({ event: 'sync-conflict', canary: c.canary, kind: c.kind, with_sign_fp: fromSignFp });
    }
    // Revocations: merge the verified, never overwrite. Sending a
    // record is proof of holding it — the sender is acked in my table.
    const revs = loadRevocations(dir);
    let merged = 0;
    const ackIds = [];
    for (const rec of view.revocations || []) {
      if (!revs.records.some((r) => r.id === rec.id) && verifyRevocation(rec, resolveSignPub)) {
        revs.records.push(rec);
        merged++;
        if (st.members[rec.sign_fp]) st.members[rec.sign_fp].state = 'revoked';
        log({ event: 'revocation', result: 'merged-via-sync', revocation_id: rec.id, sign_fp: rec.sign_fp });
      }
      if (revs.records.some((r) => r.id === rec.id)) {
        ackIds.push(rec.id);
        st.revocation_acks[rec.id] = st.revocation_acks[rec.id] || {};
        st.revocation_acks[rec.id][fromSignFp] = new Date().toISOString();
      }
    }
    if (merged) saveRevocations(dir, revs);
    // Their holding list: every record id they demonstrably hold is
    // acked in my table under their fingerprint.
    for (const rid of view.revocation_ids || []) {
      if (revs.records.some((r) => r.id === rid)) {
        st.revocation_acks[rid] = st.revocation_acks[rid] || {};
        st.revocation_acks[rid][fromSignFp] = new Date().toISOString();
      }
    }
    // Enrollment proofs the counterparty completed.
    for (const p of view.proofs || []) {
      for (const m of Object.values(st.members)) {
        if (m.probe_canary === p.canary && m.state === 'pending') {
          m.state = 'verified';
          log({ event: 'enroll-verified', canary: p.canary, with_sign_fp: fromSignFp, side: 'enrolling-endpoint' });
        }
      }
    }
    return { conflicts, want, ackIds, merged };
  }

  async function meshCall(peer, type, body) {
    if (!peer || !peer.mesh) return null;
    const toSealFp = fingerprintOfRaw(Buffer.from(peer.seal_pub, 'base64url'));
    const doc = signPayload(id, { type, to_seal_fp: toSealFp, body });
    const resp = await meshRpc(peer.mesh, doc);
    if (!resp) return null;
    const expectSignFp = fingerprintOfRaw(Buffer.from(peer.sign_pub, 'base64url'));
    if (resp.from_sign_fp !== expectSignFp || !verifyPayload(resp)) return null;
    return resp;
  }

  // Push full entries (from this endpoint's issuer memory) to a peer
  // that reported missing them at sync. Attribution is intrinsic: the
  // entries' sender is this identity, the register is signed as such.
  async function fulfillWant(peer, canaries) {
    const wanted = new Set(canaries);
    const entries = loadIssuedLog(dir).filter((e) => wanted.has(e.canary));
    // Full entries, latest record per canary.
    const byCanary = new Map();
    for (const e of entries) byCanary.set(e.canary, e);
    const list = [...byCanary.values()];
    if (!list.length) return 0;
    const resp = await meshCall(peer, 'register', { entries: list });
    return resp && resp.body?.ok ? (resp.body.registered ?? 0) : 0;
  }

  async function runMeshSync(conn, req) {
    const found = req.to ? peerByLabel(String(req.to)) : null;
    if (!found) { send(conn, { ok: false, error: `mesh-sync: unknown peer "${req.to}"` }); return; }
    const { label, peer } = found;
    if (!peer.mesh) { send(conn, { ok: false, error: `mesh-sync: peer "${label}" has no mesh address in the address book` }); return; }
    const peerSignFp = fingerprintOfRaw(Buffer.from(peer.sign_pub, 'base64url'));
    const peerSealFp = fingerprintOfRaw(Buffer.from(peer.seal_pub, 'base64url'));
    const st = loadEstateState(dir);
    const resp = await meshCall(peer, 'sync-registry', buildSyncView(peerSignFp, peerSealFp, st));
    if (!resp || resp.body?.ok !== true) {
      log({ event: 'mesh-sync', result: 'failed: no valid response', with: label });
      send(conn, { ok: false, error: 'mesh-sync: no (valid) response from the peer daemon' });
      return;
    }
    const body = resp.body || {};
    const st2 = loadEstateState(dir);
    const r = processSyncView(st2, peerSignFp, body);
    for (const c of body.conflicts || []) {
      log({ event: 'sync-conflict', canary: c.canary, kind: c.kind, with_sign_fp: peerSignFp, reported: true });
    }
    st2.last_sync[peerSignFp] = new Date().toISOString();
    st2.last_sync_any = new Date().toISOString();
    saveEstateState(dir, st2);
    // Their want: issuances of mine they are missing — push in full.
    let fulfilled = 0;
    if (Array.isArray(body.want) && body.want.length) fulfilled = await fulfillWant(peer, body.want);
    // My want: ask them to push theirs (they hold the full entries).
    let received = 0;
    if (r.want.length) {
      const fr = await meshCall(peer, 'sync-registry', { fulfill_request: r.want });
      if (fr && fr.ok) received = fr.body?.fulfilled ?? 0;
    }
    log({
      event: 'mesh-sync', result: 'completed', with: label,
      conflicts: r.conflicts.length + (body.conflicts || []).length,
      want_fulfilled: fulfilled, want_received: received, revocations_merged: r.merged,
    });
    send(conn, {
      ok: true, with: label, conflicts: [...r.conflicts, ...(body.conflicts || [])],
      want_fulfilled: fulfilled, want_received: received, revocations_merged: r.merged,
    });
  }

  function handleMeshSync(doc) {
    const fromSignFp = doc.from_sign_fp;
    const fromSealFp = doc.from_seal_fp;
    const body = doc.body || {};
    if (Array.isArray(body.fulfill_request) && body.fulfill_request.length) {
      // The requester is missing issuances of mine; push them in full
      // (async — the caller of THIS handler awaits it before replying,
      // so the register lands before the fulfill response returns).
      return fulfillWant(peerBySignFp(fromSignFp)?.peer, body.fulfill_request)
        .then((fulfilled) => ({ ok: true, fulfilled }));
    }
    const st = loadEstateState(dir);
    const r = processSyncView(st, fromSignFp, body);
    st.last_sync[fromSignFp] = new Date().toISOString();
    st.last_sync_any = new Date().toISOString();
    saveEstateState(dir, st);
    const view = buildSyncView(fromSignFp, fromSealFp, loadEstateState(dir));
    log({
      event: 'mesh-sync', result: 'completed', with: fromSignFp,
      conflicts: r.conflicts.length, revocations_merged: r.merged,
    });
    return Promise.resolve({ ok: true, ...view, conflicts: r.conflicts, want: r.want, acks: r.ackIds });
  }

  function handleMeshRegister(doc) {
    if (estateStale()) {
      log({ event: 'mesh-register', result: 'refused: estate-stale', from_sign_fp: doc.from_sign_fp });
      return { ok: false, error: 'estate-stale: this endpoint has not completed a sync-registry within estate.revocation_max_stale — mesh registrations queue/refuse until it syncs' };
    }
    const entries = Array.isArray(doc.body?.entries) ? doc.body.entries : [];
    if (!entries.length) return { ok: false, error: 'register: no entries' };
    // Attribution is intrinsic to the signed document: a member cannot
    // register issuances in another identity's name.
    const mine = [];
    const refused = [];
    for (const e of entries) {
      if (!e || e.sender_sign_fp !== doc.from_sign_fp) {
        refused.push({ canary: e?.canary ?? null, error: 'register-sender-mismatch: mesh registrations must be the sender\'s own issuances' });
        continue;
      }
      mine.push(e);
    }
    const res = registerEntries(mine, 'mesh', doc.from_sign_fp);
    return { ok: true, registered: res.registered.length, canaries: res.registered, refused: [...refused, ...res.refused] };
  }

  function handleMeshRevoke(doc) {
    const rec = doc.body?.record;
    if (!rec || typeof rec !== 'object') return { ok: false, error: 'revoke: no record' };
    if (!verifyRevocation(rec, resolveSignPub)) {
      log({ event: 'revocation', result: 'refused: unverifiable record', revocation_id: rec.id ?? null });
      return { ok: false, error: 'revocation-unverifiable: the record does not verify against a known member key' };
    }
    const revs = loadRevocations(dir);
    // The newest owner act for an identity wins; an older record for
    // the same identity never resurrects a superseded taint instant.
    const existing = revs.records.filter((r) => r.sign_fp === rec.sign_fp);
    if (!existing.some((r) => r.id === rec.id)) {
      if (!existing.length || Math.max(...existing.map((r) => Date.parse(r.at))) <= Date.parse(rec.at)) {
        revs.records = revs.records.filter((r) => r.sign_fp !== rec.sign_fp);
        revs.records.push(rec);
        saveRevocations(dir, revs);
      }
    }
    const st = loadEstateState(dir);
    if (st.members[rec.sign_fp]) { st.members[rec.sign_fp].state = 'revoked'; saveEstateState(dir, st); }
    log({ event: 'revocation', result: 'received', revocation_id: rec.id, sign_fp: rec.sign_fp, by_sign_fp: rec.by_sign_fp });
    return { ok: true, ack: rec.id };
  }

  async function handleRevoke(conn, req) {
    const label = String(req.label || '');
    const found = peerByLabel(label);
    if (!found) { send(conn, { ok: false, error: `revoke: no trusted peer "${label}"` }); return; }
    const { peer } = found;
    const sealFp = fingerprintOfRaw(Buffer.from(peer.seal_pub, 'base64url'));
    const signFp = fingerprintOfRaw(Buffer.from(peer.sign_pub, 'base64url'));
    const rec = signRevocation(id, {
      label, seal_fp: sealFp, sign_fp: signFp,
      at: new Date().toISOString(),
      by_sign_fp: id.signFp, by_label: id.label,
      reason: typeof req.reason === 'string' ? req.reason.slice(0, 300) : null,
    });
    const revs = loadRevocations(dir);
    revs.records = revs.records.filter((r) => r.sign_fp !== signFp);
    revs.records.push(rec);
    saveRevocations(dir, revs);
    const st = loadEstateState(dir);
    if (st.members[signFp]) st.members[signFp].state = 'revoked';
    st.revocation_acks[rec.id] = { [id.signFp]: rec.at };
    saveEstateState(dir, st);
    log({ event: 'revocation', result: 'created', label, sign_fp: signFp, revocation_id: rec.id, reason: rec.reason });
    // Distribute at once to every other reachable member (best-effort):
    // whoever does not ack shows as revocation-pending in the estate
    // view and receives the record piggybacked on the next sync.
    const ackedBy = [];
    const pendingAcks = [];
    for (const [l2, p2] of Object.entries(loadAddressBook(dir))) {
      const fp2 = p2.sign_pub ? fingerprintOfRaw(Buffer.from(p2.sign_pub, 'base64url')) : null;
      if (!fp2 || fp2 === signFp || fp2 === id.signFp || !p2.mesh) continue;
      const resp = await meshCall(p2, 'revoke', { record: rec });
      if (resp && resp.ok && resp.body?.ack === rec.id) {
        ackedBy.push(l2);
        const st2 = loadEstateState(dir);
        st2.revocation_acks[rec.id] = st2.revocation_acks[rec.id] || {};
        st2.revocation_acks[rec.id][fp2] = new Date().toISOString();
        saveEstateState(dir, st2);
      } else pendingAcks.push(l2);
    }
    send(conn, { ok: true, record: rec, acked_by: ackedBy, revocation_pending: pendingAcks });
  }

  const MESH_TYPES = new Set(['register', 'sync-registry', 'revoke', 'status']);
  const meshNonces = new Map(); // FIX 6: `${from_sign_fp}:${nonce}` -> {at, response}
  let meshServer = null;
  async function handleMeshLine(conn, line) {
    let doc = null;
    try { doc = JSON.parse(line); } catch {}
    const refuse = (error, extra = {}) => {
      log({
        event: 'mesh', result: `refused: ${error}`,
        type: doc?.type ?? null, from_sign_fp: doc?.from_sign_fp ?? null, ...extra,
      });
      // Signed like every mesh response (see below): a definitive
      // refusal must be distinguishable from silence. An unparseable
      // line gets the only unsigned answer there is.
      if (doc) {
        send(conn, signPayload(id, {
          type: `${doc.type}-result`, to_seal_fp: doc.from_seal_fp ?? null,
          body: { ok: false, error },
        }));
      } else send(conn, { ok: false, error });
    };
    if (!doc || doc.mesh !== 1 || typeof doc.type !== 'string') { refuse('bad-mesh-doc'); return; }
    // Opening is never a mesh act: anything outside the memory RPC set
    // is refused as an unknown command, signed or not.
    if (!MESH_TYPES.has(doc.type)) { refuse(`unknown-command: ${doc.type}`); return; }
    const sender = peerBySignFp(doc.from_sign_fp);
    if (!sender) { refuse('untrusted-sender'); return; }
    if (doc.from_sign_pub !== sender.peer.sign_pub
      || doc.from_seal_fp !== fingerprintOfRaw(Buffer.from(sender.peer.seal_pub, 'base64url'))) {
      refuse('sender-key-mismatch');
      return;
    }
    if (!verifyPayload(doc)) { refuse('bad-signature'); return; }
    if (doc.to_seal_fp !== id.sealFp) { refuse('wrong-recipient'); return; }
    const rev = revocationInForce(doc.from_sign_fp);
    if (rev) {
      refuse(doc.type === 'register' ? `register-revoked: sender revoked at ${rev.at}` : 'revoked-sender', { revoked_at: rev.at });
      return;
    }
    // FRESHNESS (Phase 4, FIX 6): a captured mesh document used to be
    // replayable verbatim forever — the signature stayed valid because
    // nothing bounded WHEN it spoke. Now: `at` must sit inside the
    // acceptance window (policy estate.mesh_skew_s, default 300 s),
    // and a nonce seen inside the window returns the CACHED response
    // without re-executing — a legitimate retry is idempotent (a
    // replayed registration inserts nothing twice, a replayed sync
    // merges nothing twice, and consumption state is never touched by
    // either), while a replay after the window dies on `at` alone.
    const skewS = pol().estate?.mesh_skew_s ?? 300;
    const atMs = Date.parse(doc.at || '');
    if (!doc.nonce || !Number.isFinite(atMs) || Math.abs(Date.now() - atMs) > skewS * 1000) {
      refuse('mesh-stale: document outside the freshness window (or missing at/nonce)');
      return;
    }
    for (const [k, v] of meshNonces) if (Date.now() - v.at > skewS * 1000) meshNonces.delete(k);
    const nonceKey = `${doc.from_sign_fp}:${doc.nonce}`;
    const cached = meshNonces.get(nonceKey);
    if (cached) {
      log({ event: 'mesh', result: 'replay-cached (nonce seen; response re-sent, not re-executed)', type: doc.type, from_sign_fp: doc.from_sign_fp });
      send(conn, cached.response);
      return;
    }
    let body;
    try {
      if (doc.type === 'register') body = handleMeshRegister(doc);
      else if (doc.type === 'revoke') body = handleMeshRevoke(doc);
      else if (doc.type === 'status') body = { ok: true, ...estateView(), pending: pending.size };
      else body = await handleMeshSync(doc);
    } catch (e) {
      log({ event: 'mesh', result: `error: ${e.message}`, type: doc.type, from_sign_fp: doc.from_sign_fp });
      send(conn, { ok: false, error: `mesh-error: ${e.message}` });
      return;
    }
    if (body && body.ok === false) {
      log({ event: 'mesh', result: `refused: ${body.error}`, type: doc.type, from_sign_fp: doc.from_sign_fp });
    }
    // Responses are mesh documents too — signed, so a well-behaved
    // client can tell a definitive refusal (signed, ok:false) from an
    // unreachable daemon (silence) and queue only for the latter.
    const responseDoc = signPayload(id, { type: `${doc.type}-result`, to_seal_fp: doc.from_seal_fp, body });
    meshNonces.set(nonceKey, { at: Date.now(), response: responseDoc });
    send(conn, responseDoc);
  }

  const MAX_FRAME_BYTES = 1024 * 1024; // one request line; packages travel by path, not by socket

  // OWNER CHANNEL (Phase 4, FIX 1) — set up before any server listens.
  // Owner acts are served ONLY here: a second socket in a 0700 owner/
  // directory beside the requester socket, the socket itself 0600, and
  // every owner request must carry the per-daemon token written (0600)
  // beside it at serve time. A process that can merely reach the
  // requester socket can present packages and read public status —
  // it cannot approve, register unsigned, revoke, clear, supersede,
  // or accept terms. The token rotates every serve.
  const ownerDir = ownerDirFor(socketPath);
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ownerDir, 0o700); } catch {}
  const ownerSocketPath = ownerSocketFor(socketPath);
  const ownerToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(ownerTokenPathFor(socketPath), `${ownerToken}\n`, { mode: 0o600 });
  try { fs.chmodSync(ownerTokenPathFor(socketPath), 0o600); } catch {}
  const OWNER_CMDS = new Set(['approve', 'revoke', 'revoke-grant', 'clear-anomaly', 'supersede', 'accept-terms', 'mesh-sync', 'estate-status']);
  function ownerGate(conn, req, channel) {
    if (channel !== 'owner') {
      send(conn, { ok: false, error: 'owner-channel-required: this is an owner act — it is served only on the owner socket (the owner/ directory beside the requester socket), never on the requester channel' });
      return false;
    }
    if (req.owner_token !== ownerToken) {
      send(conn, { ok: false, error: 'owner-auth-required: missing or wrong owner token' });
      return false;
    }
    return true;
  }

  // Socket budgets (Gemini fix 2a) — M.19's discipline at the socket
  // layer: concurrent connections and per-connection frames are
  // capped PER CHANNEL, so a malformed flood on the requester socket
  // cannot starve the owner channel (the owner budget is separate).
  // Excess is shed and counted, and the count rides the owner status.
  // Legitimate clients — one connection, a handful of frames — never
  // come near these ceilings. (The mesh listener carries its own
  // frame discipline and signed frames; it is untouched.)
  const SOCKET_BUDGETS = {
    requester: { maxConns: 64, maxFrames: 512, live: 0, shed: 0 },
    owner: { maxConns: 16, maxFrames: 512, live: 0, shed: 0 },
  };
  function shedSocket(channel, why) {
    const b = SOCKET_BUDGETS[channel];
    b.shed++;
    if (b.shed === 1 || b.shed % 100 === 0) {
      log({ event: 'connection', result: `socket-budget-shed: ${why}`, channel, shed_total: b.shed });
    }
  }
  function admitSocket(conn, channel) {
    const b = SOCKET_BUDGETS[channel];
    if (b.live >= b.maxConns) {
      shedSocket(channel, 'connection budget exhausted');
      conn.destroy();
      return false;
    }
    b.live++;
    conn.on('close', () => { b.live--; });
    return true;
  }

  function attachHandlers(conn, channel) {
    let buf = '';
    let frames = 0;
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_FRAME_BYTES && !buf.includes('\n')) {
        // Unterminated oversized frame: refuse, testify, drop the connection.
        log({ event: 'connection', result: 'refused: oversized-frame', bytes: buf.length });
        conn.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        frames++;
        if (frames > SOCKET_BUDGETS[channel].maxFrames) {
          shedSocket(channel, 'per-connection frame budget exhausted');
          conn.destroy();
          return;
        }
        let req;
        try { req = JSON.parse(line); } catch { send(conn, { ok: false, error: 'bad-json' }); continue; }
        if (req.cmd === 'status') {
          const regEntries = Object.values(loadRegistry().entries);
          if (channel === 'owner') {
            const ob = outboxSummary(dir);
            send(conn, {
              ok: true, label: id.label, seal_fp: id.sealFp, sign_fp: id.signFp,
              uptime_s: Math.round((Date.now() - startedAt) / 1000), pending: pending.size,
              registry_issued: regEntries.filter((e) => !e.returned_at).length,
              registry_returned: regEntries.filter((e) => e.returned_at).length,
              registry_integrity: registryIntegrityState,
              recovery_candidates: recoveryCandidates.size,
              outbox_pending: ob.count,
              outbox_oldest_age_s: ob.count ? ob.age_s : null,
              socket_shed: { requester: SOCKET_BUDGETS.requester.shed, owner: SOCKET_BUDGETS.owner.shed },
              anomalies: regEntries.filter((e) => e.anomaly).length,
              activations_running: activations.size,
              airlock_sessions: docks.size,
              cells: substrates,
              reseal_overdue: regEntries.filter((e) => resealOverdue(e)).map((e) => e.canary),
              terms_version: TERMS_VERSION,
              terms_accepted_by_owner: hasCurrentAcceptance(dir, 'owner'),
              // Closure 4: the estate view rides status ONLY when an
              // estate is configured — a daemon with no estate policy is
              // byte-identical to v1 here (JSON drops undefined).
              estate: estateConfigured() ? estateView() : undefined,
            });
          } else {
            // PUBLIC status (FIX 1): counts and liveness only. The
            // red team read fingerprints, the estate roster, pending
            // canaries and store paths off the bare socket — identity
            // material and estate detail are owner-channel reads now.
            send(conn, {
              ok: true, label: id.label,
              uptime_s: Math.round((Date.now() - startedAt) / 1000), pending: pending.size,
              registry_issued: regEntries.filter((e) => !e.returned_at).length,
              registry_returned: regEntries.filter((e) => e.returned_at).length,
              anomalies: regEntries.filter((e) => e.anomaly).length,
              activations_running: activations.size,
              airlock_sessions: docks.size,
              cells: substrates,
              terms_version: TERMS_VERSION,
              terms_accepted_by_owner: hasCurrentAcceptance(dir, 'owner'),
            });
          }
        } else if (req.cmd === 'estate-status') {
          if (ownerGate(conn, req, channel)) send(conn, { ok: true, ...estateView(), pending: pending.size });
        } else if (req.cmd === 'revoke') {
          if (ownerGate(conn, req, channel)) {
            handleRevoke(conn, req).catch((e) => {
              log({ event: 'revocation', result: `error: ${e.message}` });
              send(conn, { ok: false, error: `revoke: ${e.message}` });
            });
          }
        } else if (req.cmd === 'mesh-sync') {
          if (ownerGate(conn, req, channel)) {
            runMeshSync(conn, req).catch((e) => {
              log({ event: 'mesh-sync', result: `error: ${e.message}` });
              send(conn, { ok: false, error: `mesh-sync: ${e.message}` });
            });
          }
        } else if (req.cmd === 'attempts') {
          send(conn, attemptsFeed.attemptsFeed(req));
        } else if (req.cmd === 'pending') {
          send(conn, {
            ok: true,
            pending: [...pending.values()].map((e) => ({
              id: e.id, kind: e.kind || 'unwrap',
              canary: e.frame?.canary ?? null, digest: frameDigest(e.frame),
              file: e.filePath ?? null, profile: e.profileName ?? null,
              age_s: Math.round((Date.now() - e.createdAt) / 1000),
              sender_sign_fp: e.frame?.sender_sign_fp ?? null, registry_status: e.registryStatus ?? null,
              provenance: e.provenance ?? null,
              context: e.context ?? null,
              tier: e.tierSnapshot?.tier ?? null, notices: e.notices ?? [],
              approvals_required: e.requiredApprovals ?? 1, approval_stage: e.approvalStage ?? 0,
            })),
          });
        } else if (req.cmd === 'approve') {
          if (ownerGate(conn, req, channel)) handleApprove(conn, req);
        } else if (req.cmd === 'recovery') {
          if (ownerGate(conn, req, channel)) {
            pruneRecoveryCandidates();
            send(conn, {
              ok: true,
              recovery_candidates: [...recoveryCandidates.values()].map((c) => ({
                id: c.id, canary: c.canary, file: c.filePath, out: c.outName,
                sender_sign_fp: c.sender_sign_fp, digest: c.digest,
                age_s: Math.round((Date.now() - c.createdAt) / 1000),
              })),
            });
          }
        }
        else if (req.cmd === 'register') {
          if (channel === 'owner') { if (ownerGate(conn, req, channel)) handleRegister(conn, req); }
          else handleRegisterSigned(conn, req);
        }
        else if (req.cmd === 'unwrap') handleUnwrap(conn, req);
        else if (req.cmd === 'verify-open') handleUnwrap(conn, req, true);
        else if (req.cmd === 'activate') {
          handleActivate(conn, req).catch((e) => {
            log({ event: 'activate', result: `error: ${e.message}` });
            send(conn, { ok: false, error: `activation error: ${e.message}` });
          });
        }
        else if (req.cmd === 'revoke-grant') { if (ownerGate(conn, req, channel)) handleRevokeGrant(conn, req); }
        else if (req.cmd === 'dock-open') handleDockOpen(conn, req);
        else if (req.cmd === 'dock-send') handleDockSend(conn, req);
        else if (req.cmd === 'dock-close') handleDockClose(conn, req);
        else if (req.cmd === 'supersede') { if (ownerGate(conn, req, channel)) handleSupersede(conn, req); }
        else if (req.cmd === 'clear-anomaly') { if (ownerGate(conn, req, channel)) handleClearAnomaly(conn, req); }
        else if (req.cmd === 'terms') {
          send(conn, {
            ok: true, terms_version: TERMS_VERSION, terms_sha256: termsSha256(), terms: TERMS_TEXT,
            note: 'read these terms; an agent accepts with accept-terms (acceptance bound to the terms content hash). No acceptance = no activation for that agent.',
          });
        } else if (req.cmd === 'accept-terms') {
          if (!ownerGate(conn, req, channel)) { /* refusal already sent by the gate */ }
          else if (req.accept !== true || !req.agent) {
            send(conn, { ok: false, error: 'accept-terms: an explicit accept:true and an agent label are required' });
          } else if (req.terms_sha256 !== termsSha256()) {
            log({ event: 'terms-accept', result: 'refused: stale terms', agent: String(req.agent), terms_version: TERMS_VERSION });
            send(conn, { ok: false, error: 'terms-stale: the terms you accepted are not the current terms — fetch `terms` and re-accept' });
          } else {
            const rec = recordAcceptance(dir, `agent:${String(req.agent).slice(0, 120)}`);
            log({ event: 'terms-accept', result: 'accepted', agent: rec.subject, terms_version: rec.terms_version, terms_sha256: rec.terms_sha256 });
            send(conn, { ok: true, accepted: rec.subject, terms_version: rec.terms_version, terms_sha256: rec.terms_sha256, at: rec.accepted_at });
          }
        }
        else send(conn, { ok: false, error: `unknown command: ${req.cmd}` });
      }
    });
    conn.on('close', () => {
      for (const [reqId, entry] of pending) {
        if (entry.conn === conn) {
          clearTimeout(entry.timer);
          pending.delete(reqId);
          // The requester went away unapproved: release the claim so the
          // package can pend again (a release is not a consumption).
          if (entry.claimCanary) releaseClaim(entry.claimCanary, reqId);
          log({
            event: entry.kind || 'unwrap', result: 'refused: requester-disconnected',
            canary: entry.frame?.canary ?? null, sha256: entry.frame?.sha256 ?? null, file: entry.filePath ?? null,
          });
        }
      }
    });
    conn.on('error', () => {});
  }

  const server = net.createServer((conn) => { if (admitSocket(conn, 'requester')) attachHandlers(conn, 'requester'); });
  const ownerServer = net.createServer((conn) => { if (admitSocket(conn, 'owner')) attachHandlers(conn, 'owner'); });
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(ownerSocketPath); } catch {}
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
    log({ event: 'daemon', result: 'started', seal_fp: id.sealFp, socket: socketPath });
    console.log(`vaultd listening on ${socketPath}`);
    console.log(`identity: ${id.label}  seal fp ${id.sealFp}`);
    console.log(`out dir: ${outDir}  approval window: ${Math.round(windowMs / 1000)}s`);
  });
  ownerServer.listen(ownerSocketPath, () => {
    try { fs.chmodSync(ownerSocketPath, 0o600); } catch {}
    log({ event: 'daemon', result: 'owner-channel-started', socket: ownerSocketPath });
    console.log(`vaultd owner channel on ${ownerSocketPath} (owner acts only; per-daemon token required)`);
  });
  // The mesh listener exists ONLY when policy configures it (absent =
  // v1 behavior exactly), and binds ONLY the configured address —
  // a tailnet IP in production, loopback in the harness; never 0.0.0.0.
  {
    const listen = pol().estate?.mesh_listen;
    if (listen) {
      const i = String(listen).lastIndexOf(':');
      const host = String(listen).slice(0, i);
      const port = Number(String(listen).slice(i + 1));
      meshServer = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.length > MAX_FRAME_BYTES && !buf.includes('\n')) {
            log({ event: 'mesh', result: 'refused: oversized-frame', bytes: buf.length });
            conn.destroy();
            return;
          }
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            handleMeshLine(conn, line).catch((e) => {
              log({ event: 'mesh', result: `error: ${e.message}` });
            });
          }
        });
        conn.on('error', () => {});
      });
      meshServer.on('error', (e) => log({ event: 'mesh', result: `listen-failed: ${e.message}`, listen }));
      meshServer.listen(port, host, () => {
        log({ event: 'mesh', result: 'listening', listen: String(listen) });
        console.log(`vaultd mesh listening on ${listen} (estate RPC — signed; register/sync-registry/revoke/status only)`);
      });
    }
  }
  const shutdown = () => {
    // Shutdown cleanup: release every live pending's claim before exit, so
    // a restart never inherits claims whose pendings no longer exist. A
    // release is not a consumption — those packages may pend again.
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (entry.claimCanary) releaseClaim(entry.claimCanary, entry.id);
    }
    pending.clear();
    // Cells and airlocks die with the daemon: cells by their process
    // groups (staging is reaped as orphans on next start), airlocks by
    // SIGTERM to the supervised children.
    for (const run of activations.values()) { try { run.cell?.kill('daemon-shutdown'); } catch {} }
    for (const dock of docks.values()) { try { dock.proc.kill('SIGTERM'); } catch {} }
    try { meshServer?.close(); } catch {}
    try { ownerServer?.close(); } catch {}
    try { fs.unlinkSync(socketPath); } catch {}
    try { fs.unlinkSync(ownerSocketPath); } catch {}
    try { fs.unlinkSync(ownerTokenPathFor(socketPath)); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  const clientCmds = ['status', 'pending', 'approve', 'unwrap', 'clear-anomaly', 'terms', 'accept-terms',
    'activate', 'revoke-grant', 'dock-open', 'dock-send', 'dock-close',
    'revoke', 'mesh-sync', 'estate-status'];
  try {
    if (!cmd || cmd === 'serve') serve(flags);
    else if (clientCmds.includes(cmd)) {
      clientMain(cmd, flags, pos).catch((err) => {
        console.error(`error: ${err.message}`);
        process.exit(1);
      });
    } else {
      console.error('usage: vaultd.mjs <serve|status|pending|approve|unwrap|activate|revoke-grant|dock-open|dock-send|dock-close|clear-anomaly|terms|accept-terms|revoke|mesh-sync|estate-status> …');
      process.exit(2);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

main();
