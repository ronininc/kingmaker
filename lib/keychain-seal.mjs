// Kingmaker's own sealer for the owner voiceprint. The engine's owner-print store
// (desktop/owner-voice/owner-print-store.mjs) is written against Electron safeStorage, which does not exist
// under ELECTRON_RUN_AS_NODE. This is the same interface (isEncryptionAvailable / encryptString /
// decryptString), backed by Kingmaker's own login-Keychain item.
//
// Key: 32 random bytes held in a generic-password item (service "Sol Ghost Owner Voice": the name from before the rename, kept so an enrolled print still opens; account
// "owner-print-key"), created on the first seal through /usr/bin/security with the secret written to its
// stdin, never its argv. An existing key is never replaced: replacing it would orphan the sealed print.
// Seal: AES-256-GCM, a fresh 12-byte IV per seal, the purpose bound as AAD.
//   'sgv1' | iv (12) | tag (16) | ciphertext
// No Keychain, a locked Keychain, a missing key or a seal that does not authenticate → it throws, and the
// store turns that into SEALING_UNAVAILABLE or `corrupt`. There is no plaintext fallback.
//
// Scope, honestly: the key never sits on disk beside the sealed file, so a copied Library folder or a backup
// does not carry it, and destroyKey() (on forget) crypto-shreds every old copy of the file. But `security`
// is the item's trusted reader, so any program running as you can ask it for the key, the same reach such a
// program already has over the rest of your account. Narrowing that to Kingmaker's own code signature needs
// a Developer-ID-signed helper with a Keychain access group.

import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SEAL_SERVICE = 'Sol Ghost Owner Voice';
export const SEAL_ACCOUNT = 'owner-print-key';
const SECURITY = '/usr/bin/security';
const MAGIC = Buffer.from('sgv1', 'ascii');
const AAD = Buffer.from('sol-ghost/owner-voice/v1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NOT_FOUND = 44; // security(1): "The specified item could not be found in the keychain."

export class SealError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'SealError'; }
}

/** /usr/bin/security, synchronously (safeStorage is synchronous). {status, stdout}. */
export function runSecurity(args, input) {
  const r = spawnSync(SECURITY, args, { input, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
  return { status: r.error ? -1 : r.status, stdout: String(r.stdout ?? '') };
}

const quote = (s) => `"${String(s).replace(/["\\]/g, '')}"`;

/**
 * @param {{ service?: string, account?: string, run?: (args: string[], input?: string) => {status: number, stdout: string},
 *           random?: (n: number) => Buffer }} [opts]
 */
export function createKeychainSafeStorage({ service = SEAL_SERVICE, account = SEAL_ACCOUNT, run = runSecurity, random = randomBytes } = {}) {
  let key = null; // the 32-byte key, in memory only, zero-filled by dispose()

  function readKey() {
    const r = run(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (r.status === NOT_FOUND) return null;
    if (r.status !== 0) throw new SealError('KEYCHAIN_UNAVAILABLE');
    const hex = r.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new SealError('SEAL_KEY_MALFORMED');
    return Buffer.from(hex, 'hex');
  }

  function loadKey({ create }) {
    if (key) return key;
    key = readKey();
    if (key || !create) return key;
    const fresh = random(32);
    if (!Buffer.isBuffer(fresh) || fresh.length !== 32) throw new SealError('SEAL_KEY_RANDOM');
    // -i: security reads the command, and so the secret, from stdin. No -U: never overwrite a key.
    run(['-i'], `add-generic-password -s ${quote(service)} -a ${quote(account)} -l ${quote(service)} -w ${fresh.toString('hex')}\n`);
    fresh.fill(0);
    // Read back what the Keychain holds (another process may have created it first): that is the key.
    key = readKey();
    if (!key) throw new SealError('KEYCHAIN_UNAVAILABLE');
    return key;
  }

  return {
    /** True when a key is held or the login Keychain answers (the key is then created on the first seal). */
    isEncryptionAvailable() {
      try {
        if (loadKey({ create: false })) return true;
        return run(['show-keychain-info']).status === 0;
      } catch { return false; }
    },
    encryptString(plain) {
      const k = loadKey({ create: true });
      const iv = random(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', k, iv);
      cipher.setAAD(AAD);
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },
    decryptString(sealed) {
      const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed ?? '');
      if (buf.length < MAGIC.length + IV_BYTES + TAG_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealError('SEAL_FORMAT');
      const k = loadKey({ create: false });
      if (!k) throw new SealError('SEAL_KEY_MISSING');
      const at = MAGIC.length;
      const decipher = createDecipheriv('aes-256-gcm', k, buf.subarray(at, at + IV_BYTES));
      decipher.setAAD(AAD);
      decipher.setAuthTag(buf.subarray(at + IV_BYTES, at + IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(buf.subarray(at + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    },
    /** Delete the Keychain key: every sealed copy anywhere (backups included) becomes unreadable. */
    destroyKey() {
      if (key) key.fill(0);
      key = null;
      const r = run(['delete-generic-password', '-s', service, '-a', account]);
      return { ok: r.status === 0 || r.status === NOT_FOUND, removed: r.status === 0 };
    },
    dispose() { if (key) key.fill(0); key = null; },
  };
}
