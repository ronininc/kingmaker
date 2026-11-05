import { verifyArmorEntitlement } from './entitlement-client.mjs';
const ORIGIN = 'https://www.ronininc.org';
const BASE = `${ORIGIN}/api/armor/auth/`;
const INSTALLATIONS_URL = `${ORIGIN}/api/armor/license/installations/`;
const HEALTH_URL = `${ORIGIN}/api/armor/account/installations/health`;
const LIMIT = 32 * 1024;
const REQUEST_LIMIT = 64 * 1024;
async function readJson(response) {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Account service returned an invalid response.');
  if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('Account response was too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Account service returned an invalid response.');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > LIMIT) throw new Error('Account response was too large.'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function email(value) {
  const result = String(value || '').trim().toLowerCase();
  if (result.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new Error('Enter a valid account email.');
  return result;
}
function password(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('Enter your account password.');
  return value;
}
function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  const matches = values.filter((value) => /^ronin_armor=/.test(value));
  if (matches.length !== 1 || !/;\s*HttpOnly(?:;|$)/i.test(matches[0]) || !/;\s*Secure(?:;|$)/i.test(matches[0])) return null;
  const token = matches[0].match(/^ronin_armor=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? `ronin_armor=${token}` : null;
}
function remoteAccountError(status, body) {
  const message = typeof body?.error === 'string' ? body.error.trim() : '';
  const allowed = new Set([
    'Wrong email or password.',
    'An account already uses that email. Sign in instead.',
    'Enter a valid email and password (8–256 characters).',
    'Too many sign-in attempts. Please wait.',
    'Too many code requests. Please wait before retrying.',
    'Too many verification attempts. Please wait.',
    'The verification email could not be sent. Access remains locked. Please retry later.',
    'Code expired, incorrect, replaced or already used. Request a new code.',
    'This code request expired or was replaced. Request another code.',
    'Your account changed. Please sign in again.',
    'This account cannot sign in.',
    'Customer sign-in is unavailable. Access remains locked.',
    'Verification could not be confirmed. Access remains locked.',
  ]);
  if (allowed.has(message)) return message;
  return status === 401 || status === 403
    ? 'Account verification failed or the session expired. Access remains locked.'
    : 'Account request failed. Access remains locked.';
}
/** Passwords are transient arguments. The remote cookie never leaves this private closure. */
export function createArmorAccountSession({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, entitlementVerifier = verifyArmorEntitlement, installationProvider = null, sessionStore = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  let cookie = null, pending = null, authenticatedEmail = null, sessionExpiresAt = 0;
  let restoreAttempted = false;
  const clear = () => { cookie = null; authenticatedEmail = null; sessionExpiresAt = 0; sessionStore?.clear(); };
  const state = () => {
    if (sessionExpiresAt && sessionExpiresAt <= now()) clear();
    return { authenticated: Boolean(cookie && authenticatedEmail), email: authenticatedEmail || pending?.email || null, challengePending: Boolean(pending), purpose: pending?.purpose || null };
  };
  async function request(action, data, requestCookie = cookie) {
    const encodedBody = action === 'me' ? undefined : JSON.stringify(data || {});
    if (encodedBody !== undefined && Buffer.byteLength(encodedBody, 'utf8') > REQUEST_LIMIT) throw new Error('Account request exceeds the 64 KiB encoded payload limit. Access remains locked.');
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Account service timed out. Access remains locked.')); }, Math.max(1, Math.min(timeoutMs, 10_000))); });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(action === 'health' ? HEALTH_URL : action.endsWith('-installation') ? INSTALLATIONS_URL + action.split('-')[0] : `${BASE}${action}`, { method: action === 'me' ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
          headers: { origin: ORIGIN, accept: 'application/json', ...(action === 'me' ? {} : { 'content-type': 'application/json' }), ...(requestCookie ? { cookie: requestCookie } : {}) },
          ...(action === 'me' ? {} : { body: encodedBody }) });
        // An installation /check revocation is authentication revocation, not a
        // billing/capacity refusal: read the body first, and only for that exact
        // body clear the session (see verifyEntitlement's doctrine comment).
        // Every other installation 403/503 keeps the saved login.
        const body = await readJson(response).catch((error) => {
          if (response.status === 401 || (response.status === 403 && !action.endsWith('-installation'))) clear();
          throw error;
        });
        if (response.status === 401 || (response.status === 403 && (!action.endsWith('-installation') || (action === 'check-installation' && body?.error === 'revoked')))) clear();
        if (response.status >= 300 && response.status < 400) throw new Error('Account redirects are refused. Access remains locked.');
        if (action === 'reserve-installation' && response.status === 409) throw Object.assign(new Error('Installation limit reached. Book an enterprise appointment for additional capacity.'), { status: 409 });
        if (![200, 202, ...(action === 'reserve-installation' ? [201] : [])].includes(response.status)) throw new Error(remoteAccountError(response.status, body));
        if (!action.endsWith('-installation') && body?.ok !== true) throw new Error('Account verification failed. Access remains locked.');
        return { status: response.status, body, receivedCookie: sessionCookie(response.headers), receivedAnyCookie: Boolean(response.headers.get('set-cookie')) };
      })(), timeout]);
    } catch (error) {
      if (error?.status === 409 && error.message === 'Installation limit reached. Book an enterprise appointment for additional capacity.') throw error;
      const safeErrors = new Set(['Account redirects are refused. Access remains locked.', 'Account response was too large.', 'Account service timed out. Access remains locked.', 'Account verification failed or the session expired. Access remains locked.', 'Account verification failed. Access remains locked.', 'Account request failed. Access remains locked.', 'Wrong email or password.', 'An account already uses that email. Sign in instead.', 'Enter a valid email and password (8–256 characters).', 'Too many sign-in attempts. Please wait.', 'Too many code requests. Please wait before retrying.', 'Too many verification attempts. Please wait.', 'The verification email could not be sent. Access remains locked. Please retry later.', 'Code expired, incorrect, replaced or already used. Request a new code.', 'This code request expired or was replaced. Request another code.', 'Your account changed. Please sign in again.', 'This account cannot sign in.', 'Customer sign-in is unavailable. Access remains locked.', 'Verification could not be confirmed. Access remains locked.']);
      if (safeErrors.has(error?.message)) throw error;
      throw new Error('Account service is unavailable. Access remains locked.');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  function takeChallenge(result, accountEmail, purpose, allowExistingAccount = false) {
    const resolvedPurpose = allowExistingAccount && purpose === 'register' && result.body.purpose === 'login' && result.body.existingAccount === true ? 'login' : purpose;
    if (result.status !== 202 || result.receivedAnyCookie || result.body.emailCodeRequired !== true || result.body.email !== accountEmail || result.body.purpose !== resolvedPurpose
      || typeof result.body.challengeId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(result.body.challengeId)
      || !Number.isInteger(result.body.expiresAt) || result.body.expiresAt <= now()) throw new Error('An email verification challenge is required. Access remains locked.');
    pending = { email: accountEmail, purpose: resolvedPurpose, challengeId: result.body.challengeId };
    return state();
  }
  async function challenge(action, input) {
    clear(); pending = null;
    const accountEmail = email(input.email), secret = password(input.password);
    const payload = { email: accountEmail, password: secret };
    if (action === 'register') {
      const name = String(input.name || '').trim(); if (!name || name.length > 100) throw new Error('Enter your account name.'); payload.name = name;
    }
    return takeChallenge(await request(action, payload, null), accountEmail, action, action === 'register');
  }
  async function resume() {
    if (cookie || restoreAttempted || !sessionStore) return state();
    restoreAttempted = true;
    const saved = sessionStore.load();
    if (!saved) return state();
    if (saved.schema !== 'ronin.customer-session/v1' || !/^ronin_armor=[a-f0-9]{64}$/.test(saved.cookie || '')
      || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= now() || saved.expiresAt > now() + 30 * 86400
      || email(saved.email) !== saved.email) { clear(); return state(); }
    cookie = saved.cookie; authenticatedEmail = saved.email; sessionExpiresAt = saved.expiresAt;
    try { return await ensureAuthenticated(); } catch (error) { clear(); throw error; }
  }
  async function ensureAuthenticated() {
    if (!cookie && !restoreAttempted) await resume();
    if (!cookie || !authenticatedEmail) throw new Error('Sign in and verify the email code first.');
    try {
      const result = await request('me');
      const verifiedAt = result.body.member?.mfa_verified_at;
      const expiresAt = result.body.sessionExpiresAt;
      const authoritativeExpiry = Number.isSafeInteger(expiresAt) && expiresAt > now() && expiresAt <= now() + 30 * 86400 && expiresAt > verifiedAt;
      if (result.status !== 200 || result.body.mfaVerified !== true || result.body.member?.email !== authenticatedEmail || !Number.isInteger(verifiedAt)
        || verifiedAt <= 0 || verifiedAt > now() + 300 || (expiresAt !== undefined ? !authoritativeExpiry : now() - verifiedAt > 43200)) throw new Error('Account session expired. Sign in again.');
      sessionExpiresAt = authoritativeExpiry ? expiresAt : verifiedAt + 43200;
      if (authoritativeExpiry) sessionStore?.save({ schema: 'ronin.customer-session/v1', cookie, email: authenticatedEmail, expiresAt: sessionExpiresAt });
      return state();
    } catch (error) { clear(); throw error; }
  }
  async function installationRequest(action) {
    await ensureAuthenticated();
    const metadata = installationProvider?.();
    const installationId = metadata?.installationId, installationEvidenceRef = metadata?.installationEvidenceRef;
    if (!/^[a-f0-9]{64}$/.test(installationId || '') || !/^local-metadata-sha256:[a-f0-9]{64}$/.test(installationEvidenceRef || '')) throw new Error('Trusted local installation metadata is required.');
    const result = await request(action + '-installation', { installationId, installationEvidenceRef });
    if (result.status !== 200 && !(action === 'reserve' && result.status === 201)) throw new Error('Installation capacity could not be confirmed. Access remains locked.');
    if (result.body?.installationId !== installationId || result.body?.quotaReservationOnly !== true || result.body?.deviceAdmissionGranted !== false
      || (action === 'check' && (result.body?.ok !== true || result.body?.active !== true || result.body?.installationId !== installationId))
      || (['reserve', 'resume'].includes(action) && result.body?.reserved !== true)
      || (action === 'revoke' && (result.body?.ok !== true || result.body?.active !== false))) throw new Error('Installation capacity could not be confirmed. Access remains locked.');
    return action === 'reserve' ? { reserved: true, quotaReservationOnly: true, deviceAdmissionGranted: false } : result.body;
  }
  return Object.freeze({
    state, resume,
    async reportHealth(input) {
      if (input?.consent !== true) throw new Error('Explicit installation health reporting consent is required.');
      if (!['scripture-armor','kingmaker','launcher'].includes(input.product) || !['macos','windows','linux'].includes(input.platform)
        || typeof input.version !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(input.version) || !['healthy','degraded'].includes(input.state)) throw new Error('An observed installation health sample is required.');
      await ensureAuthenticated();
      const installationId = installationProvider?.()?.installationId;
      if (!/^[a-f0-9]{64}$/.test(installationId || '')) throw new Error('Trusted local installation metadata is required.');
      const result = await request('health',{ installationId, product: input.product, platform: input.platform, version: input.version, state: input.state });
      const receipt = result.body;
      if (result.status !== 200 || receipt.ok !== true || receipt.installationId !== installationId || receipt.telemetryOnly !== true || receipt.deviceAdmissionGranted !== false
        || !Number.isSafeInteger(receipt.receivedAt) || Math.abs(receipt.receivedAt - now()) > 300) throw new Error('Installation health receipt could not be confirmed.');
      return { ok: true, receivedAt: receipt.receivedAt, installationId, telemetryOnly: true, deviceAdmissionGranted: false };
    },
    async reserveInstallation() { return installationRequest('reserve'); },
    async revokeInstallation() { return installationRequest('revoke'); },
    async resumeInstallation() { return installationRequest('resume'); },
    login: (input) => challenge('login', input), register: (input) => challenge('register', input),
    async verify(input) {
      clear();
      if (!pending || !/^\d{8}$/.test(String(input.code || ''))) throw new Error('Enter the eight-digit email verification code.');
      const result = await request('verify', { ...pending, code: String(input.code) }, null);
      if (result.status !== 200 || !result.receivedCookie || result.body.mfaVerified !== true || result.body.member?.email !== pending.email) throw new Error('Email verification did not establish a session. Access remains locked.');
      cookie = result.receivedCookie; authenticatedEmail = pending.email;
      try { await ensureAuthenticated(); pending = null; return state(); } catch (error) { clear(); throw error; }
    },
    async resend(input) {
      if (!pending) throw new Error('Start sign-in or registration first.');
      const previous = { ...pending }; clear(); pending = null;
      return takeChallenge(await request('resend', { email: previous.email, purpose: previous.purpose, password: password(input.password) }, null), previous.email, previous.purpose);
    },
    ensureAuthenticated,
    async verifyEntitlement() {
      await ensureAuthenticated();
      // Billing/capacity availability is not authentication revocation. Keep
      // the verified login while refusing the licensed action on any failure.
      await installationRequest('check');
      return await entitlementVerifier({}, { fetchImpl, requestCookie: cookie, requireAccountSession: true });
    },
    async logout() { try { if (cookie) await request('logout', {}); } finally { clear(); pending = null; } return state(); },
  });
}
