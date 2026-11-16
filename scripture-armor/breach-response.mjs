// breach-response.mjs — Scripture Armor BREACH RESPONSE (SCAFFOLD, OFF BY DEFAULT).
//
// STATUS: design scaffold. NOT imported by vaultd.mjs, dashboard.mjs, or any
// live request path, and NOT listed in package.json "files" — so it cannot be
// packaged into a signed build or fire on the live install. The destructive
// delete + off-machine relocation are gated behind BREACH_AUTODELETE_ENABLED,
// which is false. Every network/delete side effect is dependency-injected
// (git target, owner public key) so the module references NO real repo, NO
// token, and NO real path unless a caller explicitly wires one in a test.
//
// Doctrine implemented (owner ask, 2026-11-16):
//   - ban-first: on an unregistered device dock, attempt a ban within a hard
//     deadline budget; only if the ban FAILS/TIMES OUT do we fall back to
//     wipe + encrypted relocation.
//   - failed-attempt auto-delete: after N failed breach/auth attempts, trigger
//     the same wipe + relocation.
//
// SAFEGUARDS baked in (see design risks in the writeup):
//   - delete is "relocate" not "destroy": an owner-recoverable ENCRYPTED backup
//     is produced and the off-machine copy is written BEFORE any local wipe;
//     wipe is skipped if backup/relocation did not succeed.
//   - encryption-before-upload is mandatory (plaintext never leaves the box).
//   - private-repo requirement flag for any real git target.
//   - attacker-vs-owner distinction hook (owner authenticated sessions do not
//     count toward the failed-attempt threshold).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// ---- named config (no magic numbers) ------------------------------------
export const BREACH_AUTODELETE_ENABLED = false;            // MASTER SWITCH — OFF.
export const BREACH_FAILED_ATTEMPT_THRESHOLD = 10;         // TBD/tunable (owner ruling pending).
export const BREACH_BAN_DEADLINE_MS = 1;                   // intended budget; see honesty note.
export const BREACH_RELOCATION_REQUIRE_ENCRYPTION = true;  // plaintext must never leave the box.
export const BREACH_RELOCATION_REQUIRE_PRIVATE_REPO = true;// any real git target must be private.
export const BREACH_OWNER_GITHUB_CONFIG = null;            // TBD: no install-time owner-GitHub vault config exists to reuse.

// ---- per-install failed-attempt tracking --------------------------------
const attempts = new Map(); // installKey -> count
export function recordFailedAttempt(installKey, { isOwnerSession = false } = {}) {
  // Attacker-vs-owner distinction: the owner's own authenticated session
  // typos must not march the owner toward self-destruction.
  if (isOwnerSession) return { count: attempts.get(installKey) || 0, triggered: false };
  const n = (attempts.get(installKey) || 0) + 1;
  attempts.set(installKey, n);
  return { count: n, triggered: n >= BREACH_FAILED_ATTEMPT_THRESHOLD };
}
export function resetAttempts(installKey) { attempts.delete(installKey); }

// ---- ban-first ----------------------------------------------------------
// Attempt to ban an unregistered device within a hard deadline. The injected
// `ban` fn is where a real mechanism plugs in (in-process dock/registry block,
// pf/anchor firewall rule, or Headscale node revoke). Returns measured latency.
export async function attemptBan(device, { deadlineMs = BREACH_BAN_DEADLINE_MS, ban } = {}) {
  const start = process.hrtime.bigint();
  let banned = false, mechanism = 'none', error = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => (ban ? ban(device) : { banned: false, mechanism: 'unimplemented-TBD' })),
      new Promise((resolve) => setTimeout(() => resolve({ banned: false, mechanism: 'timeout', timedOut: true }), deadlineMs)),
    ]);
    banned = Boolean(result?.banned);
    mechanism = result?.mechanism || mechanism;
  } catch (e) { error = e.message; }
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { banned, mechanism, latencyMs, withinDeadline: latencyMs <= deadlineMs, error };
}

// ---- encrypted, owner-recoverable backup + relocation -------------------
function encryptDirToFile(srcDir, outFile, ownerPublicKeyPem) {
  // Tar the dir, then seal with a fresh symmetric key wrapped to the owner's
  // public key (hybrid, like the Armor package format). GitHub never sees
  // plaintext and only the owner's private key can recover it.
  const tar = execFileSync('tar', ['-C', srcDir, '-cf', '-', '.']);
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(tar), c.final()]);
  const tag = c.getAuthTag();
  const wrappedKey = crypto.publicEncrypt(ownerPublicKeyPem, dataKey);
  const env = { schema: 'scripture-armor.breach-relocation/1', alg: 'rsa-oaep+aes-256-gcm',
    iv: iv.toString('base64'), tag: tag.toString('base64'),
    wrappedKey: wrappedKey.toString('base64'), ct: ct.toString('base64'),
    at: new Date().toISOString() };
  fs.writeFileSync(outFile, JSON.stringify(env), { mode: 0o600 });
  return { bytesPlain: tar.length, bytesSealed: fs.statSync(outFile).size };
}

export async function relocateAndWipe({
  sensitiveDir, gitTarget, ownerPublicKeyPem, backupDir,
  enabled = BREACH_AUTODELETE_ENABLED, requirePrivateRepoConfirmed = false, reason = 'breach',
}) {
  if (!enabled) return { skipped: true, why: 'BREACH_AUTODELETE_ENABLED is false (live behavior off by default)' };
  if (!sensitiveDir || !fs.existsSync(sensitiveDir)) throw new Error('relocate: sensitiveDir missing');
  if (!gitTarget) throw new Error('relocate: no git target injected (owner-GitHub config is TBD; refusing to invent one)');
  if (BREACH_RELOCATION_REQUIRE_ENCRYPTION && !ownerPublicKeyPem) throw new Error('relocate: encryption required but no owner public key provided');
  if (BREACH_RELOCATION_REQUIRE_PRIVATE_REPO && !requirePrivateRepoConfirmed) throw new Error('relocate: private-repo requirement not confirmed for this target');

  // 1) owner-recoverable encrypted backup (local) — reversibility first.
  backupDir = backupDir || fs.mkdtempSync(path.join(os.tmpdir(), 'armor-breach-backup-'));
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const sealed = path.join(backupDir, `relocation-${Date.now()}.sabx`);
  const enc = encryptDirToFile(sensitiveDir, sealed, ownerPublicKeyPem);

  // 2) write the sealed blob into the (injected) git target and commit+push.
  // For tests this is a LOCAL bare repo; a real target would be a PRIVATE
  // owner GitHub repo (TBD config). Plaintext is never written here.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-breach-relocate-'));
  const git = (...a) => execFileSync('git', ['-C', work, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['clone', '--quiet', gitTarget, work]);
  fs.copyFileSync(sealed, path.join(work, path.basename(sealed)));
  git('add', '-A');
  git('-c', 'user.name=armor-breach', '-c', 'user.email=breach@localhost', 'commit', '-q', '-m', `breach relocation (${reason})`);
  git('push', '-q', 'origin', 'HEAD');
  const relocatedRef = git('rev-parse', 'HEAD').toString().trim();

  // 3) ONLY NOW wipe the local sensitive context (recoverable from the sealed backup).
  const wiped = [];
  for (const entry of fs.readdirSync(sensitiveDir)) {
    const p = path.join(sensitiveDir, entry);
    fs.rmSync(p, { recursive: true, force: true });
    wiped.push(entry);
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { skipped: false, reason, sealedBackup: sealed, encrypted: enc,
    relocatedRef, wiped, recoverable: true };
}

// ---- top-level flow: ban-first, wipe-and-relocate only on ban failure ---
export async function onUnregisteredDeviceDock(device, {
  isRegistered = false, ban, deadlineMs = BREACH_BAN_DEADLINE_MS, relocate = {},
} = {}) {
  if (isRegistered) return { action: 'none', why: 'registered device' };
  const banResult = await attemptBan(device, { deadlineMs, ban });
  if (banResult.banned) return { action: 'banned', ban: banResult };
  const relocation = await relocateAndWipe({ ...relocate, reason: 'ban-failed' });
  return { action: 'wipe-and-relocate', ban: banResult, relocation };
}
