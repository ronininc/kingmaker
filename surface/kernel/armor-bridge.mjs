#!/usr/bin/env node
// armor-bridge — Scripture Armor on the kernel lane (Linux).
//
// The kernel lane's own premise (kernel-probe.mjs): on Linux the
// product has kernel access by default, so the armor can wrap the
// kernel boundary and the governance spine can see below userspace.
// This bridge is that wrap, at the depth this tree can prove:
//
//   1. WITNESS. The lane's load events already land in a hash-chained
//      log (kernel-event.mjs). The bridge VERIFIES the chain and
//      mirrors each event into the armor's estate-event log, signed
//      territory: the armor becomes the kernel lane's witness, and a
//      quietly rewritten kernel log fails verification by name.
//
//   2. ACCOUNTING. The armor's egress ledger (provenance) is the
//      record of what Kingmaker sent, wrapped. The bridge audits
//      observed outbound connects against that ledger: a connect
//      with no corresponding armor egress record is a BEACON —
//      egress that crossed the boundary without the wrap is named,
//      in the open, in the armor's own testimony.
//
// What this bridge is NOT: it is not BPF-LSM enforcement. The lane's
// program (km_observe) counts execve/connect; it does not block.
// Kernel-level DENIAL of unarmored egress is the designed next step
// and is named as a residual in BUILD-REPORT.md — this file provides
// the policy seam (decide()) an LSM program would enforce, and the
// detection + testimony that exists today. Nothing here claims a
// block that did not happen.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as armor from '../../scripture-armor/armor.mjs';
import { readProvenance, recordBeacon, identityDir } from '../../lib/armor-native.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Verify the hash chain of a kernel-events.jsonl written by kernel-event.mjs. */
export function verifyKernelChain(logFile) {
  if (!existsSync(logFile)) return { ok: false, records: 0, error: 'log-absent' };
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  let prev = 'GENESIS';
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { return { ok: false, records: i, brokenAt: i, error: 'line-unparseable' }; }
    if (rec.prev !== prev) return { ok: false, records: i, brokenAt: i, error: `chain-broken: record ${i} names prev ${rec.prev}, expected ${prev}` };
    prev = sha256Hex(Buffer.from(lines[i], 'utf8'));
  }
  return { ok: true, records: lines.length, head: prev };
}

/** Mirror unverified-count kernel load events into the armor estate log (idempotent by watermark). */
export function attestKernelLog(state, logFile) {
  const v = verifyKernelChain(logFile);
  if (!v.ok) {
    recordBeacon(state, { event: 'kernel-chain-unverifiable', source: logFile, detail: v.error });
    return { ok: false, ...v };
  }
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const wmFile = join(state, 'armor', 'kernel-attest.json');
  let wm = { count: 0 };
  try { wm = JSON.parse(readFileSync(wmFile, 'utf8')); } catch { /* first attestation */ }
  let attested = 0;
  for (let i = wm.count; i < lines.length; i++) {
    const r = lines[i];
    armor.appendEstateEvent(identityDir(state), {
      kind: 'kernel-load-attested',
      kernel_event: r.event, kernel: r.kernel, at: r.at,
      object_sha256: r.objectSha256, loader_sha256: r.loaderSha256,
      verdict_ok: r.verdict?.ok === true, chain_prev: r.prev,
    });
    attested++;
  }
  writeFileSync(wmFile, JSON.stringify({ count: lines.length, attested_at: new Date().toISOString() }), { mode: 0o600 });
  return { ok: true, records: lines.length, attested_now: attested, chain_head: v.head };
}

const WRAPPED_MODES = new Set(['package', 'flow', 'relay', 'local']);

/**
 * The policy seam: is this outbound connect accounted for by the
 * armor? A connect is accounted when a wrapped (or local) egress
 * record names its host. Anything else is unaccounted egress.
 */
export function decide(state, host, { windowMs = 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  const hit = readProvenance(state).find((r) =>
    r.kind === 'egress' &&
    typeof r.target === 'string' && r.target.includes(host) &&
    WRAPPED_MODES.has(r.mode) &&
    now - Date.parse(r.at) <= windowMs);
  return hit ? { accounted: true, by: hit.mode, canary: hit.canary || null } : { accounted: false };
}

/** Audit a list of observed connects ([{host, port?}]) against the armor ledger. */
export function auditConnects(state, connects) {
  const out = [];
  for (const c of connects) {
    const d = decide(state, c.host);
    if (!d.accounted) {
      recordBeacon(state, { event: 'kernel-egress-unaccounted', host: c.host, port: c.port ?? null, detail: 'observed connect with no armor egress record — crossed the boundary without the wrap' });
      out.push({ host: c.host, accounted: false, beacon: true });
    } else {
      out.push({ host: c.host, accounted: true, by: d.by });
    }
  }
  return out;
}

// CLI: node armor-bridge.mjs verify <log> | attest <state> <log> | audit <state> <connects-json>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'verify') console.log(JSON.stringify(verifyKernelChain(a)));
  else if (cmd === 'attest') console.log(JSON.stringify(attestKernelLog(a, b)));
  else if (cmd === 'audit') console.log(JSON.stringify(auditConnects(a, JSON.parse(readFileSync(b, 'utf8')))));
  else { console.error('usage: armor-bridge.mjs verify <log> | attest <state> <log> | audit <state> <connects.json>'); process.exit(2); }
}
