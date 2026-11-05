// terms.mjs — Scripture Armor activation terms (Robbie's ruling,
// 2026-10-24 00:57 MST): activation and setup are TERMINAL-ONLY; first
// activation presents these terms — what the armor is and the rules it
// operates under — and the operator must read and explicitly accept
// before the armor activates. No silent setup. Acceptance is an
// auditable event in the record.
//
// AGENTS ACCEPT IT TOO: any agent integrating with or operating under
// the armor is presented the same terms in agent-readable form (this
// module + the daemon's `terms` RPC) and must return an explicit
// acceptance (the daemon's `accept-terms` RPC), logged, before it may
// operate. No acceptance = no activation for that agent.
//
// Zero-dependency; imported by launch.mjs, armor.mjs and vaultd.mjs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TERMS_VERSION = 'terms/1';

// Writing rule (Robbie, 2026-10-24 00:59 MST) for ALL user-facing
// text in this build: simple terms first, with the technical
// explanation in parentheses right after it — a normal user reads
// the simple part and understands; the precision sits beside it.
export const TERMS_TEXT = `SCRIPTURE ARMOR — ACTIVATION TERMS (${TERMS_VERSION})

What this is. This program wraps your files and programs in a
protective shell before they go anywhere (a closed-loop containment
layer, invented by Robbie Glover / Ronin Inc). It works on code that
already exists — it does not rewrite your programs, host them, or
reach inside them (wrapping happens at the boundary only). The
scrambled-looking characters on the outside are meant to be
unreadable (a keyed glyph skin, reshuffled for every package — it is
camouflage, not the lock). The real lock is strong standard
encryption (ChaCha20-Poly1305 AEAD, with each file's key sealed to
the receiving machine via X25519, and every package signed with
Ed25519 so tampering shows).

The rules it runs by:
1. Every package gets a fingerprint the moment it leaves (the
   plaintext SHA-256 is registered with the receiving vault daemon
   at wrap time). A package is only opened if it comes back exactly
   as it was sent (the return-match checks hash, expiry, and sender
   against the registry), and only when the owner says yes (the
   pending/approve gate).
2. Nothing gets wrapped or run without being checked first (every
   code-class wrap and activation passes the scan layer). Compiled
   programs get a deep inspection (Ghidra headless analysis);
   plain-text code gets a simpler check that is honestly labeled as
   simpler (the source-lane pattern scan in scan.mjs). If the check
   finds something seriously wrong, the wrap is refused (a critical
   verdict blocks sealing). The owner can overrule a refusal — and
   the overrule is written into the package forever, where everyone
   can see it (the override is recorded inside the signed frame).
3. The riskiest parts get the strongest protection (armor weight is
   allocated by the scan's risk score — tiers 0/1/2). Everything else
   still gets the standard protection (baseline wrap). Nothing is
   left bare: every file ends up protected, left out with its reason
   written down (exclusions are named in the sealed manifest), or
   empty (zero-byte files are vouched for by the manifest).
4. If something shows up that doesn't match, the armor raises a
   flag and writes down the evidence — it never fights back (a
   mismatch becomes a beacon event in the log; sight, not strike,
   and nothing ever calls out or retaliates).
5. Bad software is judged by what it DOES, never by who made it
   (the behavior classes: remote activation, silent persistence,
   sensor access, covert exfiltration, resistance to removal).
   Software that came pre-installed gets no free pass (provenance,
   signer, and vendor are never exculpatory inputs).
6. Outside influence is kept out by default (the Strip Outside
   Influence gate). If the owner asks for an exception, the item is
   checked inside a throwaway sandbox before it may come in (scan
   inside the amnesic execution cell at the airlock).
7. Your keys are made on this device and never leave it (each
   endpoint generates its own identity; no key material is copied
   between machines, ever).
8. Agents keep their hands. An AI working under this armor keeps
   all of its abilities (full tool calling, plugins, and CLIs).
   The armor watches and protects the crossings those tools make
   (it governs, wraps, inspects, and logs boundary crossings) — it
   never takes a capability away (amputating a tool is a defect,
   not a feature).
9. Saying yes is written down (acceptance of ${TERMS_VERSION}, by
   content hash, is appended to this installation's audit record —
   for the owner at first activation, and for every agent before
   it may operate).

Type ACCEPT only if you have read this and agree to run the armor
under these rules.
`;

export function termsSha256() {
  return crypto.createHash('sha256').update(TERMS_TEXT, 'utf8').digest('hex');
}

// Acceptance records: an append-only audit log (acceptance.log, 0600)
// plus a summary (acceptance.json) the launch path and daemon consult.
function acceptanceLogPath(dir) { return path.join(dir, 'acceptance.log'); }
function acceptanceJsonPath(dir) { return path.join(dir, 'acceptance.json'); }

export function loadAcceptances(dir) {
  try {
    return fs.readFileSync(acceptanceLogPath(dir), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

export function hasCurrentAcceptance(dir, subject) {
  const sha = termsSha256();
  return loadAcceptances(dir).some(
    (r) => r.subject === subject && r.terms_sha256 === sha && r.terms_version === TERMS_VERSION);
}

export function recordAcceptance(dir, subject) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rec = {
    subject, // 'owner' or 'agent:<label>'
    terms_version: TERMS_VERSION,
    terms_sha256: termsSha256(),
    accepted_at: new Date().toISOString(),
  };
  fs.appendFileSync(acceptanceLogPath(dir), JSON.stringify(rec) + '\n', { mode: 0o600 });
  try { fs.chmodSync(acceptanceLogPath(dir), 0o600); } catch {}
  const summary = { owner: null, agents: {} };
  for (const r of loadAcceptances(dir)) {
    if (r.subject === 'owner') summary.owner = r;
    else if (r.subject.startsWith('agent:')) summary.agents[r.subject.slice(6)] = r;
  }
  const tmp = `${acceptanceJsonPath(dir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(summary, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, acceptanceJsonPath(dir));
  try { fs.chmodSync(acceptanceJsonPath(dir), 0o600); } catch {}
  return rec;
}
