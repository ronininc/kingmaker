// Credentials for the Brain Library. The library repo is public, so the default
// provider is none: no API key, token, or other credential is read from the
// app bundle, source, config, logs, or the environment.
//
// A future credential lives only in the Ronin Launcher's closed vault, keyed
// to this device's Kingmaker install (the Launcher keychain item
// `kingmaker-install-cert`). Kingmaker would receive it over the same-device
// tether and nowhere else. The tether is a Unix socket plus a token file, the
// Scripture Armor owner-channel shape. `tetherCredentialProvider` is the stub
// for that provider. It does not open a socket, read a token file, or return
// a credential.

/** A provider that always returns no credential. */
export function createCredentialProvider({ get } = {}) {
  const read = typeof get === 'function' ? get : async () => null;
  return {
    kind: 'injectable',
    async credential() {
      const got = await read();
      if (got == null || got === '') return null;
      if (typeof got === 'string') return seal(got);
      if (typeof got === 'object' && typeof got.value === 'string' && got.value.trim()) return seal(got.value, got.header);
      return null;
    },
  };
}

export const noCredentials = createCredentialProvider();

/**
 * Stub for the Launcher tether. `socketPath` and `tokenPath` name the future
 * endpoint (Unix socket + token file beside it). They are not opened.
 */
export function tetherCredentialProvider({ socketPath = null, tokenPath = null } = {}) {
  return {
    kind: 'launcher-tether',
    wired: false,
    endpoint: socketPath ? String(socketPath) : null,
    tokenFile: tokenPath ? String(tokenPath) : null,
    async credential() {
      return null;
    },
  };
}

function seal(value, header = 'authorization') {
  const name = String(header || 'authorization').toLowerCase();
  if (name !== 'authorization') return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return { header: 'authorization', value: /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}` };
}

/** Attach a credential only to api.github.com. Other hosts, including the
 *  release CDN the asset API redirects to, stay anonymous. */
export function headersFor(url, baseHeaders = {}, credential = null) {
  const headers = { ...baseHeaders };
  if (!credential?.value || credential.header !== 'authorization') return headers;
  let host = '';
  try { host = new URL(url).host; } catch { return headers; }
  if (host !== 'api.github.com') return headers;
  headers.authorization = credential.value;
  return headers;
}

/** Drop anything that could echo a credential into a log or an error. */
export function redactError(error) {
  const raw = String(error?.message || error || 'library fetch failed');
  const message = raw
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[redacted]');
  const out = new Error(message);
  if (error?.code) out.code = error.code;
  if (error?.status) out.status = error.status;
  if (error?.retryAt) out.retryAt = error.retryAt;
  return out;
}
