// B2 — Attempts feed port (SPEC §3.2): scripture-armor.attempts/1, ported
// from the v2 tree's vaultd.mjs implementation (owner ruling 2026-10-29;
// contract in scripture-armor-v2/ATTEMPTS-FEED.md). This is a port of proven
// code into a standalone module for the post-release line: same entry shape,
// same family vocabulary, same verbatim reason_class handling, same folding
// (identical canary+family+reason_class+anomalySet+source within the window),
// same retention cap, same durable write (tmp+rename+fsync, 0600), no HMAC —
// testimony, never a trust input. The owner-channel read of the daemon
// ({"cmd":"attempts"}) is represented by attemptsFeed(), which returns the
// exact response document the daemon's owner channel returns.
import fs from 'node:fs';
import path from 'node:path';

export const ATTEMPTS_SCHEMA = 'scripture-armor.attempts/1';

function writeDurableSync(file, data) {
  const fd = fs.openSync(file, 'w', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function fsyncDirQuiet(dir) {
  try { const fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch {}
}

// The owner's headline families (verbatim from v2 vaultd.mjs attemptFamily).
export function attemptFamily(rc) {
  switch (rc) {
    case 'never-issued': return 'never-issued';
    case 'superseded': return 'superseded';
    case 'expired': case 'expiry-mismatch': return 'expired';
    case 'revoked-sender': case 'register-revoked': return 'revoked';
    case 'store-integrity': return 'store-integrity';
    case 'anomaly-hold': case 'anomaly-set': return 'anomaly-held';
    case 'replay-consumed': case 'replay-claimed': return 'replay';
    case 'hash-mismatch': case 'sender-mismatch': case 'scan-mismatch':
    case 'tier-mismatch': case 'bad-frame-signature': case 'image-mismatch':
    case 'armor-corrupt': case 'airlock-scan': return 'tamper-evidence';
    case 'quarantined': case 'reseal-overdue': case 'not-activatable':
    case 'scan-critical': return 'policy-hold';
    case 'recipient-mismatch': case 'recipient-kem-mismatch': return 'recipient-mismatch';
    default: return 'other';
  }
}

// Nature lines (verbatim from v2 attemptNature).
export function attemptNature(rc, ctx = {}) {
  const c = ctx.canary ? `canary ${String(ctx.canary).slice(0, 8)}…` : 'a package';
  switch (rc) {
    case 'never-issued': return `presented ${c} this daemon never issued — the canary is not in the registry`;
    case 'superseded': return `presented a superseded copy of ${c}${ctx.superseded_by ? ` — it was re-sealed as ${String(ctx.superseded_by).slice(0, 8)}…` : ''}`;
    case 'replay-consumed': return `presented ${c} whose one-shot return was already consumed${ctx.returned_at ? ` at ${ctx.returned_at}` : ''}`;
    case 'replay-claimed': return `presented ${c} while another return of it is already pending approval`;
    case 'hash-mismatch': return `the presented bytes of ${c} do not match the issuance record (hash mismatch)`;
    case 'expiry-mismatch': return `the presented expiry of ${c} differs from the issuance record`;
    case 'sender-mismatch': return `the presented sender of ${c} differs from the issuing sender`;
    case 'revoked-sender': return `the sender of ${c} was revoked${ctx.revoked_at ? ` at ${ctx.revoked_at}` : ''} and the package was issued after the revocation`;
    case 'register-revoked': return `a revoked sender attempted to register new issuances${ctx.canary ? ` (${c})` : ''}`;
    case 'scan-mismatch': return `the scan block of ${c} differs from the issuance record`;
    case 'tier-mismatch': return `the armor tier of ${c} differs from the issuance record`;
    case 'bad-frame-signature': return `the frame signature of ${c} does not verify — a forgery-shaped presentation`;
    case 'image-mismatch': return `the plaintext of ${c} does not match its own frame digest`;
    case 'expired': return `presented an expired package (${c}${ctx.expiry ? `, expiry ${ctx.expiry}` : ''})`;
    case 'store-integrity': return 'refused while registry.json fails its integrity check — no entry is trusted until the store is repaired';
    case 'anomaly-hold': return `refused because an anomaly hold stands against ${c} (or its repo) until the owner clears it`;
    case 'anomaly-set': return `an anomaly hold was placed on ${c}${ctx.trigger ? ` by a ${ctx.trigger} event` : ''} — further presentations refuse until the owner clears it`;
    case 'quarantined': return `${c} is quarantined in the registry — owner release required`;
    case 'reseal-overdue': return `${c} is past its re-seal deadline — it must be re-sealed before it can open`;
    case 'recipient-mismatch': return 'the package was not sealed to this copy (recipient mismatch)';
    case 'recipient-kem-mismatch': return 'the v4 package was not KEM-sealed to this copy (recipient mismatch)';
    case 'not-activatable': return `${c} did not originate in the activation store — activation refused`;
    case 'scan-critical': return `the bound scan verdict for ${c} is critical — activation refused`;
    case 'armor-corrupt': return `the sealed body of ${c} does not decode`;
    case 'unparseable': return 'presented a file that does not parse as a Scripture Armor package';
    case 'airlock-scan': return `an airlock scan quarantined a crossing naming ${c}`;
    default: return `refused presentation of ${c} (${rc})`;
  }
}

export function refuseReasonClass(reason) {
  const r = String(reason || '');
  if (r === 'expired' || r === 'package expired') return 'expired';
  if (r.startsWith('anomaly:') || r.startsWith('anomaly-hold')) return 'anomaly-hold';
  const m = /^([a-z][a-z0-9-]{1,40}):/.exec(r);
  if (m) return m[1];
  if (/^[a-z][a-z0-9-]{1,40}$/.test(r)) return r;
  return 'refused';
}

function sameAttemptSource(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'network') return (a.ip ?? null) === (b.ip ?? null) && (a.peer ?? null) === (b.peer ?? null);
  if (a.kind === 'local') return (a.channel ?? null) === (b.channel ?? null) && (a.peer ?? null) === (b.peer ?? null);
  return true;
}

// A feed instance bound to an identity dir. cap/window mirror the daemon's
// --attempts-cap / --attempts-window-ms flags (defaults 500 / 600000).
export function openAttemptsFeed(identityDir, { cap = 500, windowMs = 600000 } = {}) {
  const ATTEMPTS_CAP = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 500;
  const ATTEMPTS_WINDOW_MS = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : 600000;
  const attemptsFile = path.join(identityDir, 'attempts.json');
  let attemptEntries = [];
  try {
    const doc = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
    if (doc && Array.isArray(doc.entries)) {
      attemptEntries = doc.entries.filter((e) => e && typeof e.at === 'string' && typeof e.reason_class === 'string');
      if (attemptEntries.length > ATTEMPTS_CAP) attemptEntries = attemptEntries.slice(-ATTEMPTS_CAP);
    }
  } catch { attemptEntries = []; }

  function saveAttempts() {
    try {
      const tmp = `${attemptsFile}.tmp-${process.pid}`;
      writeDurableSync(tmp, JSON.stringify({ schema: ATTEMPTS_SCHEMA, entries: attemptEntries }, null, 2));
      fs.renameSync(tmp, attemptsFile);
      fsyncDirQuiet(identityDir);
      try { fs.chmodSync(attemptsFile, 0o600); } catch {}
    } catch {}
  }

  // Verbatim port of v2 recordAttempt: recording never throws into a
  // refusal path; identical attempts inside the window fold.
  function recordAttempt({ canary = null, reason_class, source, nature = null, anomalySet = false }) {
    try {
      const now = Date.now();
      const at = new Date(now).toISOString();
      const fam = attemptFamily(reason_class);
      const src = source && typeof source === 'object' ? source : { kind: 'unknown' };
      for (let i = attemptEntries.length - 1; i >= 0; i--) {
        const e = attemptEntries[i];
        if (e.canaryId === (canary ?? null) && e.class === fam && e.reason_class === reason_class
          && !!e.anomalySet === !!anomalySet && sameAttemptSource(e.source, src)) {
          if (now - Date.parse(e.lastSeen) <= ATTEMPTS_WINDOW_MS) {
            e.count += 1; e.lastSeen = at;
            saveAttempts();
            return e;
          }
          break;
        }
      }
      const entry = {
        at, lastSeen: at, count: 1,
        canaryId: canary ?? null,
        class: fam, reason_class,
        nature: String(nature || attemptNature(reason_class, { canary })).slice(0, 300),
        source: src,
        ...(anomalySet ? { anomalySet: true } : {}),
      };
      attemptEntries.push(entry);
      if (attemptEntries.length > ATTEMPTS_CAP) attemptEntries = attemptEntries.slice(-ATTEMPTS_CAP);
      saveAttempts();
      return entry;
    } catch { return null; }
  }

  // The owner-channel read ({"cmd":"attempts"}) response document.
  function attemptsFeed(req = {}) {
    let limit = Number(req.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = ATTEMPTS_CAP;
    limit = Math.min(Math.floor(limit), ATTEMPTS_CAP);
    return {
      ok: true, schema: ATTEMPTS_SCHEMA, generated_at: new Date().toISOString(),
      window_ms: ATTEMPTS_WINDOW_MS, cap: ATTEMPTS_CAP,
      total: attemptEntries.length,
      attempts: attemptEntries.slice(-limit).reverse(),
    };
  }

  return { recordAttempt, attemptsFeed, file: attemptsFile, cap: ATTEMPTS_CAP, windowMs: ATTEMPTS_WINDOW_MS,
           entries: () => attemptEntries.slice() };
}
