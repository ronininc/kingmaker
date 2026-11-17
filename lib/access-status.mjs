// lib/access-status.mjs — what an install may SAY about its free / paid / fleet abilities (2026-11-16).
//
// The rule: nothing paid or fleet is ever described as active unless it was VERIFIED just now.
//   own methods     always on: the free tier creates, stores and runs the user's own methods with no entitlement.
//   curated library active only when the membership check (lib/paid-access.mjs: ES256 signature against the pinned key,
//                   sku, expiry, revocation with its offline grace) says ok for `library.methods`. A cache on disk, or an
//                   entitlement file that does not verify, is reported as such — never as an active membership.
//   fleet abilities active only when the install is ELIGIBLE (the owner's policy flag, or a verified membership —
//                   lib/corpus-guard.mjs fleetPolicy) AND at least one item in the fleet store matches an owner-approval
//                   receipt (<state>/fleet/accepted.jsonl: same sha256, signed by the pinned owner ability key). A file
//                   dropped into the fleet store without a receipt, or edited after acceptance, is listed as unverified.
// Pure reads of the install's own state; the membership check is injected (tests use a test-key verifier; the default
// is the real verifier, which may ask the update host's revocation endpoint).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetPolicy } from './corpus-guard.mjs';

const sha = (x) => createHash('sha256').update(x).digest('hex');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const indexed = (dir) => { const idx = readJson(join(dir, 'index.json')); return Array.isArray(idx?.methods) ? idx.methods.filter((m) => m?.id && typeof m.file === 'string' && /^[a-z0-9][a-z0-9._-]*\.method\.md$/i.test(m.file)) : []; };

/** Fleet-store items checked against this install's owner-approval receipts. dirs: the fleet stores (internal + drive). */
export function verifiedFleetAbilities(state, { dirs = [join(state, 'fleet', 'abilities', 'methods')] } = {}) {
  const trust = readJson(join(state, 'fleet', 'owner-trust.json'));
  const keyId = trust?.ability?.keyId ?? null;
  let receipts = [];
  try { receipts = readFileSync(join(state, 'fleet', 'accepted.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { receipts = []; }
  const verified = [], unverified = [];
  for (const dir of dirs) for (const m of indexed(dir)) {
    let text; try { text = readFileSync(join(dir, m.file)); } catch { unverified.push({ id: m.id, dir, reason: 'listed but the file is missing' }); continue; }
    const last = receipts.filter((r) => r.id === m.id).at(-1);
    if (!last) { unverified.push({ id: m.id, dir, reason: 'no owner-approval receipt on this install' }); continue; }
    if (!keyId || last.keyId !== keyId) { unverified.push({ id: m.id, dir, reason: 'its receipt is not from the pinned owner ability key' }); continue; }
    if (last.sha256 !== sha(text)) { unverified.push({ id: m.id, dir, reason: 'the file no longer matches the owner-approved content' }); continue; }
    verified.push({ id: m.id, version: last.version, dir, decisionId: last.decisionId, file: m.file, sha256: last.sha256 });
  }
  return { verified, unverified };
}

/**
 * The honest access status. verifyMembership: async () → { ok, reason? } for `library.methods` (default: the real
 * verifier). Returns { own, curated, fleet, lines } where `active` is true ONLY after verification.
 */
export async function abilityAccess(state, { verifyMembership = null, fleetDirs = undefined, armorState = null } = {}) {
  const check = verifyMembership ?? (async () => (await import('./paid-access.mjs')).createPaidAccess(state)('library.methods'));
  let membership; try { membership = await check(); } catch (e) { membership = { ok: false, reason: `the membership check failed: ${e.message}` }; }
  const member = membership?.ok === true;
  const hasEntitlementFile = existsSync(join(state, 'entitlements', 'library.methods.json'));
  const cached = indexed(join(state, 'brain-library', 'methods')).length;
  const policy = fleetPolicy(state);
  const eligible = policy.freeInstallsReceiveFleetAbilities || member;
  const fleetItems = verifiedFleetAbilities(state, fleetDirs ? { dirs: fleetDirs } : undefined);
  const fleetActive = eligible && fleetItems.verified.length > 0;
  const own = { active: true, line: 'Your own methods: on (free — no membership needed).' };
  const curated = { active: member, entitlementFile: hasEntitlementFile, cached,
    line: member ? `Curated library: active — membership verified${cached ? ` (${cached} item(s) cached)` : ''}.`
      : hasEntitlementFile ? `Curated library: not active — the membership could not be verified (${membership?.reason ?? 'no reason given'}).`
        : 'Curated library: not active — this install has no membership.' };
  if (!member && cached) curated.note = `${cached} curated item(s) are cached on this Mac from an earlier membership; they do not mean a membership is current.`;
  const fleet = { active: fleetActive, eligible, policy: policy.source, verified: fleetItems.verified, unverified: fleetItems.unverified,
    line: fleetActive ? `Fleet abilities: active — ${fleetItems.verified.length} owner-approved item(s), each matching its approval receipt.`
      : !eligible ? `Fleet abilities: not active — under the current policy they go to verified members only (${policy.source}).`
        : 'Fleet abilities: not active — no owner-approved item is installed.' };
  // Scripture Armor is a separate, paid product: Kingmaker only reports whether it can reach an INSTALLED, authenticated,
  // compatible Armor (lib/armor-connection.mjs). Whether the subscription is current is Armor's own entitlement check;
  // nothing here says it is.
  let conn; try { conn = armorState ? armorState() : (await import('./armor-connection.mjs')).armorConnectionState(); } catch (e) { conn = { ok: false, code: 'ARMOR_LOAD_FAILED', detail: e.message }; }
  const armor = { connected: conn.ok === true, version: conn.version ?? null, code: conn.code ?? null,
    line: conn.ok ? `Scripture Armor: connected — installed ${conn.version}, authenticated (${conn.auth?.method ?? 'unknown'}). Its subscription status is shown by Armor itself.`
      : `Scripture Armor: not connected (${conn.code}) — features that need Armor are refused; everything else works.` };
  const lines = [own.line, curated.line, ...(curated.note ? [curated.note] : []), fleet.line, armor.line,
    ...(fleetItems.unverified.length ? [`Not counted as fleet abilities (unverified): ${fleetItems.unverified.map((u) => `${u.id} — ${u.reason}`).join('; ')}.`] : [])];
  return { own, curated, fleet, armor, lines };
}
