#!/usr/bin/env node
// airlock.mjs — Scripture Armor v2, Closure 3: the docking airlock.
//
// ONE PROCESS PER SESSION, spawned and supervised by vaultd. This
// process holds NO identity keys, NO registry handle, and NO path into
// the daemon's store — it knows only its own session directory. Its
// whole authority is mechanical: frame peer traffic, enforce the
// crossing gates (size / class / scan), stage inbound bytes in the
// chamber, and report events to the daemon, which alone performs
// cryptography, registration, and testimony.
//
// THE CHAMBER: inbound bytes land in chamber scratch inside the session
// dir, never in daemon memory beyond frame handling. On this host the
// chamber is the named degraded form — a 0700 scratch directory —
// because no cell substrate is available to the airlock child; the
// session record says so ("chamber: dir (degraded)"), never silently.
//
// STRIP OUTSIDE INFLUENCE (Addendum A.3): the airlock exists only while
// the owner has opened this dock under a declared profile. Everything
// outside the profile's classes, over its limits, or failing its scan
// gate is stripped (dropped) — violations 1–2 drop and the session
// continues; the third violation, or any critical scan, closes the
// airlock. The shell is never the thing that closes.
//
// Zero dependencies: node: builtins only.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyBuffer, scanFile } from './scan.mjs';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function frame(payload) {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(payload.length, 0);
  return Buffer.concat([h, payload]);
}

const args = process.argv.slice(2);
if (args[0] !== 'serve') {
  console.error('usage: airlock.mjs serve --session-dir <dir>');
  process.exit(2);
}
const sIdx = args.indexOf('--session-dir');
if (sIdx < 0 || !args[sIdx + 1]) {
  console.error('airlock: --session-dir required');
  process.exit(2);
}
const SDIR = path.resolve(args[sIdx + 1]);
const config = JSON.parse(fs.readFileSync(path.join(SDIR, 'config.json'), 'utf8'));
const PROFILE = config.profile || {};
const LIMITS = {
  max_message_bytes: 1024 * 1024,
  max_session_bytes: 64 * 1024 * 1024,
  max_messages: 10000,
  idle_s: 300,
  max_violations: 3,
  ...(config.limits || {}),
};
const CHAMBER_DIR = path.join(SDIR, 'chamber');
const PEER_SOCK = path.join(SDIR, 'peer.sock');
const CTRL_SOCK = path.join(SDIR, 'ctrl.sock');
const CHAMBER_KIND = 'dir (degraded)';

let ctrl = null;
let peerConn = null;
let closed = false;
let violations = 0;
let bytesIn = 0;
let bytesOut = 0;
let messageCount = 0;
let stagedSeq = 0;
let idleTimer = null;

function ctrlSend(obj) {
  try { ctrl?.write(JSON.stringify(obj) + '\n'); } catch {}
}

function wipeChamber() {
  try {
    for (const f of fs.readdirSync(CHAMBER_DIR)) {
      fs.rmSync(path.join(CHAMBER_DIR, f), { recursive: true, force: true });
    }
  } catch {}
}

function closeSession(reason) {
  if (closed) return;
  closed = true;
  wipeChamber();
  try { peerConn?.destroy(); } catch {}
  try { peerServer.close(); } catch {}
  ctrlSend({ type: 'closed', reason });
  // Give the daemon a beat to record the close, then exit: a dead
  // airlock is the failure mode, by construction.
  setTimeout(() => process.exit(0), 150);
}

function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeSession('idle'), LIMITS.idle_s * 1000);
}

function violation(reasonClass, detail = {}) {
  violations += 1;
  ctrlSend({ type: 'violation', reason_class: reasonClass, ...detail });
  if (reasonClass === 'airlock-scan' || violations >= LIMITS.max_violations) {
    closeSession(reasonClass === 'airlock-scan' ? 'violations-scan' : 'violations');
  }
}

// Classification for the gates. classifyBuffer judges by magic and
// by NAME — an inbound frame has no name, so extensionless source
// text would fall to 'data' and cross UNSCANNED. That is a gate
// bypass: a payload that smells like source is scanned as source.
// Phase 4 (FIX 4): classifyBuffer itself now sniffs content (strong
// code tokens classify as source regardless of any name), and the
// staged name below carries the SNIFFED language — the red team
// crossed a shell payload staged as .mjs (shell rules never ran)
// and keyword-less Python staged as data (nothing ran at all).
function classifyForGate(payload) {
  const cls = classifyBuffer(payload, '');
  if (cls !== 'data') return cls;
  let text = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); } catch {}
  if (text && !text.includes('\0')
    && /(^|\n)\s*(import\s|export\s|const\s|let\s|var\s|function\s|console\.|require\(|#!)/.test(text)) {
    return 'source';
  }
  return 'data';
}

// The staged file's extension follows the CONTENT's language, never
// a default: scan lanes and the record's language label key off it.
function stagedExtFor(cls, payload) {
  if (cls === 'binary') return 'bin';
  if (cls !== 'source') return 'txt';
  const head = payload.subarray(0, 4096).toString('utf8');
  if (/^#!.*\b(?:sh|bash|zsh)\b/.test(head)) return 'sh';
  if (/^#!.*\bpython/.test(head)) return 'py';
  if (/\b(?:os\.|subprocess\.|__import__)\b|\bdef\s+\w+\s*\(/.test(head)) return 'py';
  if (/\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(head)) return 'sh';
  return 'mjs';
}

// Class admission: the profile declares content classes. classifyBuffer
// yields binary|source|data; 'text' is admitted when the payload is
// data-class and clean UTF-8 (the profile language for prose payloads).
function classAdmitted(cls, payload) {
  const classes = PROFILE.classes || [];
  if (classes.includes(cls)) return true;
  if (cls === 'data' && classes.includes('text')) {
    if (payload.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(payload); return true; }
    catch { return false; }
  }
  return false;
}

async function handleInbound(payload) {
  if (closed) return;
  messageCount += 1;
  if (messageCount > LIMITS.max_messages) { closeSession('budget'); return; }
  // (1) SIZE gate — over the frame cap is a violation, dropped whole.
  if (payload.length > LIMITS.max_message_bytes) {
    violation('airlock-oversize', { bytes: payload.length, sha256: sha256Hex(payload) });
    return;
  }
  if (bytesIn + payload.length > LIMITS.max_session_bytes) {
    closeSession('budget');
    return;
  }
  const cls = classifyForGate(payload);
  // (1b) TYPE gate — outside the profile's declared classes.
  if (!classAdmitted(cls, payload)) {
    violation('airlock-type', { bytes: payload.length, sha256: sha256Hex(payload) });
    return;
  }
  bytesIn += payload.length;
  const id = ++stagedSeq;
  // The staged name carries the gated class: scanFile classifies by
  // name+content, and a source payload staged as ".bin" would be
  // scanned (and missed) as data.
  const stagedPath = path.join(CHAMBER_DIR, `in-${id}.${stagedExtFor(cls, payload)}`);
  fs.writeFileSync(stagedPath, payload, { mode: 0o600 });
  let record = null;
  // (2) SCAN gate — executable-class content is scanned on the CHAMBER
  // copy (Closure 1's lanes) before anything crosses (SPEC §3.2, A.3).
  if (cls === 'binary' || cls === 'source') {
    try {
      record = (await scanFile(stagedPath, { storeDir: SDIR })).record;
    } catch (e) {
      fs.rmSync(stagedPath, { force: true });
      violation('airlock-protocol', { bytes: payload.length, detail: `scan failed: ${e.message}` });
      return;
    }
    if (record.verdict === 'critical') {
      // First strike: the bytes go no further as data — the daemon
      // seals them into quarantine custody, and the session closes.
      ctrlSend({
        type: 'quarantine-request', id, path: stagedPath,
        bytes: payload.length, sha256: sha256Hex(payload), record,
      });
      return; // the daemon's 'quarantined' reply wipes + closes
    }
  } else {
    // Data-class: the canonical data record (digestible, tier 0) so the
    // crossing still carries a sealed scan block (SPEC §1.4).
    record = (await scanFile(stagedPath, { storeDir: SDIR })).record;
  }
  // (3) WRAP-ON-ENTRY happens in the daemon (it holds the keys): hand
  // over the staged bytes; the daemon seals, registers, testifies, and
  // only then is the chamber copy wiped.
  ctrlSend({
    type: 'in-staged', id, path: stagedPath,
    bytes: payload.length, sha256: sha256Hex(payload), cls, record,
  });
}

const peerServer = net.createServer((c) => {
  if (peerConn) { c.destroy(); return; } // one peer per session
  peerConn = c;
  bumpIdle();
  let buf = Buffer.alloc(0);
  c.on('data', (d) => {
    bumpIdle();
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > LIMITS.max_message_bytes * 2 && buf.length < 4 + len) {
        // A frame header already beyond any legal message: count the
        // violation from the header alone, drop the connection state.
        violation('airlock-oversize', { bytes: len });
        buf = Buffer.alloc(0);
        return;
      }
      if (buf.length < 4 + len) return;
      const payload = Buffer.from(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
      handleInbound(payload).catch((e) => {
        violation('airlock-protocol', { detail: e.message });
      });
      if (closed) return;
    }
  });
  c.on('close', () => {
    // Peer died — possibly mid-frame. The partial frame in `buf` is
    // discarded by construction (it never reached a gate).
    if (!closed) closeSession('peer-gone');
  });
  c.on('error', () => {});
});

const ctrlServer = net.createServer((c) => {
  if (ctrl) { c.destroy(); return; }
  ctrl = c;
  let buf = '';
  c.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleCtrl(msg);
    }
  });
  c.on('error', () => {});
  ctrlSend({ type: 'ready', session: config.session, peer_socket: PEER_SOCK, chamber: CHAMBER_KIND });
});

function handleCtrl(msg) {
  bumpIdle();
  if (msg.type === 'deliver-out') {
    // OUT crossing: the daemon has already written the crossing record
    // (testimony BEFORE movement). Frame the bytes to the peer.
    let payload;
    try { payload = fs.readFileSync(msg.path); }
    catch { ctrlSend({ type: 'deliver-failed', id: msg.id }); return; }
    fs.rmSync(msg.path, { force: true });
    if (!peerConn || peerConn.destroyed) { ctrlSend({ type: 'deliver-failed', id: msg.id }); return; }
    bytesOut += payload.length;
    peerConn.write(frame(payload));
    ctrlSend({ type: 'delivered', id: msg.id });
    return;
  }
  if (msg.type === 'in-crossed' || msg.type === 'quarantined' || msg.type === 'drop') {
    // The daemon sealed + registered (or refused) the staged bytes;
    // wipe the chamber copy — inside the shell the data now exists
    // ONLY as the armored package (or as sealed quarantine custody).
    try {
      for (const f of fs.readdirSync(CHAMBER_DIR)) {
        if (f.startsWith(`in-${msg.id}.`)) fs.rmSync(path.join(CHAMBER_DIR, f), { force: true });
      }
    } catch {}
    if (msg.type === 'quarantined') closeSession('violations-scan');
    return;
  }
  if (msg.type === 'close') {
    closeSession('owner');
    return;
  }
}

peerServer.listen(PEER_SOCK, () => {
  try { fs.chmodSync(PEER_SOCK, 0o600); } catch {}
});
ctrlServer.listen(CTRL_SOCK, () => {
  try { fs.chmodSync(CTRL_SOCK, 0o600); } catch {}
});
bumpIdle();

// The supervisor's hammer: if the daemon vanishes, do not linger.
process.on('SIGTERM', () => closeSession('supervisor-gone'));
process.on('SIGINT', () => closeSession('supervisor-gone'));
