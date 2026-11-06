// submit-transport-guard.mjs — the safeguard on Scripture Armor's submit-request
// transport seam: the one egress moment of the "Submit a request to Ronin Inc" item
// (submit-request.mjs) is the POST toward the CRM intake, and it runs through this
// guard or not at all.
//
// The pattern is ported from the Kingmaker lane's G7 guard
// (kingmaker-sockets-build/lib/submit-transport-guard.mjs) — the same standard,
// implemented natively in this tree (no shared import across the line; Armor's own
// vault daemon makes the liveness leg native here):
//
//   1. DESTINATION BINDING — the transport is constructed for ONE endpoint, the CRM
//      intake route on Ronin Inc's own origin. A guarded transport cannot even be
//      CONSTRUCTED for another host; the binding is the item's shape, not a policy
//      preference.
//   2. EGRESS POLICY — the endpoint is checked against an egress policy at every
//      send. The default policy allowlists the CRM host for this item only; a
//      tor-only policy still refuses the clearnet CRM endpoint. Refused → the
//      record stays in the local queue, the sender is never called.
//   3. VAULT-DAEMON LIVENESS — probed before every send (a unix-socket connect to
//      Armor's own vaultd socket: $ARMOR_VAULTD_SOCKET, else <identityDir>/vaultd.sock
//      — this tree's convention, armor.mjs / launch.mjs / protection-status.mjs).
//      The data-egress doctrine is absolute: if the vault daemon is down, outward
//      movement fails CLOSED. Down → queued, send never called.
//   4. SEND ERRORS QUEUE TOO — a sender that throws resolves as 'queued-local'
//      with the reason recorded as delivery state. The guarded transport never
//      throws: the submission is already durable in the local queue (the
//      submitter writes it first), and its gate status is untouchable either way.
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { productPaths } from './product-paths.mjs';

/** The CRM intake route the item posts to, on the CRM origin Armor's account
 *  session already talks to (account-session.mjs: https://www.ronininc.org). */
export const CRM_INTAKE_ORIGIN = 'https://www.ronininc.org';
export const CRM_INTAKE_PATH = '/api/requests';
export const CRM_INTAKE_URL = `${CRM_INTAKE_ORIGIN}${CRM_INTAKE_PATH}`;

/** The only origin family this item may ever send to: Ronin Inc's own CRM. */
export const CRM_INTAKE_HOST = 'ronininc.org';
export const isCrmIntakeHost = (host) => {
  const h = String(host || '').toLowerCase();
  return h === CRM_INTAKE_HOST || h.endsWith(`.${CRM_INTAKE_HOST}`);
};

// ---------------------------------------------------------------------------
// Egress policy (this tree carries no egress-guard module; the policy the
// guard needs is small and lives here, shaped like the reference's):
// an allowlist of hosts + an optional tor-only stance. checkSubmitEgress is
// pure and returns the refusal as data — the caller turns it into queueing.
// ---------------------------------------------------------------------------

export function createSubmitEgressPolicy({ torOnly = false, allowHosts = [] } = {}) {
  return { torOnly: Boolean(torOnly), allowHosts: new Set(allowHosts.map((h) => String(h).toLowerCase())) };
}

export function allowSubmitHost(policy, host) {
  policy.allowHosts.add(String(host).toLowerCase());
  return policy;
}

export function checkSubmitEgress(policy, target) {
  let url;
  try { url = new URL(target); } catch { return { ok: false, reason: 'egress target is not a valid URL' }; }
  if (policy.torOnly) return { ok: false, reason: 'tor-only egress policy refuses the clearnet CRM endpoint' };
  if (url.protocol !== 'https:') return { ok: false, reason: `egress refused: scheme ${url.protocol} is not https` };
  const host = url.hostname.toLowerCase();
  if (!policy.allowHosts.has(host)) return { ok: false, reason: `egress refused: host ${host} is not allowlisted for this item` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Vault-daemon liveness — Armor's own vaultd is native to this lane.
// ---------------------------------------------------------------------------

/** The Armor vault daemon's socket: env override, else the identity dir convention. */
export function submitVaultSocketPath({ identityDir, env = process.env } = {}) {
  return env.ARMOR_VAULTD_SOCKET || join(identityDir || productPaths().identityDir, 'vaultd.sock');
}

/**
 * Default liveness: the socket file exists AND a unix-socket connect completes
 * within `timeoutMs`. Any failure is "down" (fail closed). Injectable in tests
 * and at wiring time.
 */
export function createVaultLiveness({ socketPath = submitVaultSocketPath(), timeoutMs = 750 } = {}) {
  return async function vaultAlive() {
    if (!existsSync(socketPath)) return false;
    return await new Promise((resolve) => {
      const sock = connect(socketPath);
      const done = (v) => { try { sock.destroy(); } catch { /* already gone */ } resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(timeoutMs, () => done(false));
    });
  };
}

// ---------------------------------------------------------------------------
// The guarded transport + the plain HTTP sender it guards.
// ---------------------------------------------------------------------------

/**
 * Build the guarded CRM transport.
 *   endpoint   — the full CRM intake URL this transport may send to (and no other).
 *   send       — the raw sender: async (record) => receipt. Called ONLY when both
 *                guards pass.
 *   policy     — an egress policy (default: a fresh instance with the CRM host
 *                allowlisted for this item; pass one to impose tor-only or a
 *                stricter stance).
 *   vaultAlive — async () => boolean (default: createVaultLiveness()).
 * Returns an async transport(record) that NEVER throws; its receipt's `delivery`
 * is 'queued-local' whenever a guard refuses or the send fails, with `guard`
 * naming why. A receipt is delivery state only — it never reaches the record,
 * so it cannot move the record's gate status.
 */
export function createGuardedSubmitTransport({ endpoint = CRM_INTAKE_URL, send, policy, vaultAlive } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('guarded submit transport: endpoint must be a valid URL'); }
  if (typeof send !== 'function') throw new Error('guarded submit transport: a send function is required');
  const host = url.hostname.toLowerCase();
  if (!isCrmIntakeHost(host)) throw new Error(`guarded submit transport: ${host} is not the Ronin Inc CRM origin — this item sends nowhere else`);
  const pol = policy ?? createSubmitEgressPolicy();
  if (!policy) allowSubmitHost(pol, host); // the CRM host, allowlisted for this item only
  const alive = vaultAlive ?? createVaultLiveness();
  const queued = (guard, reason) => ({ delivery: 'queued-local', guard, ...(reason ? { reason } : {}) });
  return async function guardedSubmitTransport(record) {
    const egress = checkSubmitEgress(pol, url.href);
    if (!egress.ok) return queued('egress-refused', egress.reason);
    let up = false;
    try { up = await alive(); } catch { up = false; }
    if (!up) return queued('vault-daemon-down', 'the vault daemon did not answer; outward movement fails closed into the local queue');
    try {
      const receipt = await send(record);
      return receipt ?? { delivery: 'sent-to-crm-intake' };
    } catch (e) {
      return queued('transport-error', String(e?.message ?? e));
    }
  };
}

/**
 * The plain HTTP sender the guard wraps at wiring time: POST the record as JSON
 * to the endpoint, redirects refused (a redirect is a different destination than
 * the bound one). A 2xx is delivery; anything else throws, which the guard turns
 * into queueing. In fixture environments this same sender is constructed against
 * a local stub intake — the guard above it still binds the CRM endpoint.
 */
export function createHttpSubmitSend({ endpoint = CRM_INTAKE_URL, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const url = new URL(endpoint);
  return async function httpSubmitSend(record) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 30_000)));
    try {
      const response = await fetchImpl(url.href, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(record),
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`CRM intake answered ${response.status}`);
      return { delivery: 'sent-to-crm-intake', status: response.status };
    } finally { clearTimeout(timer); }
  };
}
