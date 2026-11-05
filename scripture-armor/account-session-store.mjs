import { runSecurity } from '../lib/keychain-seal.mjs';

export const ACCOUNT_SESSION_KEYCHAIN = Object.freeze({ service: 'com.ronininc.ronin-launcher.customer-session.v1', account: 'ronin-armor' });
const valid = (record) => record?.schema === 'ronin.customer-session/v1'
  && Object.keys(record).sort().join(',') === 'cookie,email,expiresAt,schema'
  && /^ronin_armor=[a-f0-9]{64}$/.test(record.cookie || '')
  && typeof record.email === 'string' && record.email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)
  && Number.isSafeInteger(record.expiresAt) && record.expiresAt > 0;

/** Scoped OS secret storage only. No disk/environment fallback, password, or secret argv.
 * The existing security(1) adapter has same-OS-user reach; this is not hardware attestation.
 */
export function createAccountSessionStore({ platform = process.platform, run = runSecurity } = {}) {
  if (platform !== 'darwin') return null;
  const { service, account } = ACCOUNT_SESSION_KEYCHAIN;
  const clear = () => {
    const result = run(['delete-generic-password', '-s', service, '-a', account]);
    if (![0, 44].includes(result.status)) throw new Error('Private account session storage is unavailable.');
  };
  return Object.freeze({
    load() {
      const result = run(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (result.status === 44) return null;
      if (result.status !== 0) throw new Error('Private account session storage is unavailable.');
      try {
        if (result.stdout.length > 4096) throw new Error('oversize');
        const record = JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'));
        if (!valid(record)) throw new Error('invalid');
        return record;
      } catch { clear(); return null; }
    },
    save(record) {
      if (!valid(record)) throw new Error('Invalid private account session.');
      const encoded = Buffer.from(JSON.stringify(record)).toString('base64');
      const result = run(['-i'], `add-generic-password -U -s "${service}" -a "${account}" -w ${encoded}\n`);
      if (result.status !== 0) throw new Error('Private account session storage is unavailable.');
    },
    clear,
  });
}
