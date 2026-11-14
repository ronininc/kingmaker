// CRM LOCK: one Kingmaker, one company (operator 2026-10-13). Until one machine can carry both companies
// (the planned Spark + M5 setup), each company's Kingmaker is a separate program bound to exactly one CRM. A Ronin
// install (it docks to Ronin's office: ronin-desk.json crm=ronininc, or an explicit crm-lock.json) may link only to the
// Ronin CRM; nothing on that Mac may connect it to OroSolu, whose Kingmaker runs separately on its own machine
// with its own credentials and data. An install with neither file keeps the product default: no CRM attached.
//
// Enforced in three places: the core's "my CRM" is pinned to the locked CRM (an environment pin beats any CRM
// someone "connects" by voice), an override toward another CRM is dropped, and the other company's apps are left
// out of the apps Kingmaker can drive (the device map), so it cannot reach their CRM through a browser either.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CRM_LOCKS = Object.freeze({
  ronininc: Object.freeze({ tenant: 'ronininc', url: 'https://www.ronininc.org', hosts: Object.freeze(['www.ronininc.org', 'ronininc.org']), otherTenantApps: /oro\s*solu/i }),
});

export const crmLockPath = (paths) => join(paths.state, 'crm-lock.json');

/** Lock state is launcher input and cannot be applied to an already-running backend. Injectable for tests. */
export function crmLockChangeBlocked(paths, { readDaemonState, pidAlive }) {
  const daemon = readDaemonState(paths);
  return Boolean(daemon?.pid && pidAlive(daemon.pid));
}

/** The lock for this install, from its own state: an explicit crm-lock.json, or a Ronin office desk (ronin-desk.json
 *  crm=ronininc, enabled). null = no lock (the product default: no CRM attached unless the owner connects one). */
export function activeCrmLock(paths, read = (p) => readFileSync(p, 'utf8')) {
  if (!paths?.state) return null;
  const json = (file) => { try { return JSON.parse(read(join(paths.state, file))); } catch { return null; } };
  const explicit = json('crm-lock.json');
  if (explicit?.schema === 1 && CRM_LOCKS[explicit.tenant]) return CRM_LOCKS[explicit.tenant];
  const desk = json('ronin-desk.json');
  if (desk?.schema === 1 && desk.crm === 'ronininc' && desk.enabled === true) return CRM_LOCKS.ronininc;
  return null;
}

/** The owner binds this install to one CRM (`kingmaker crm-lock ronininc`). */
export function setCrmLock(paths, tenant) {
  if (!CRM_LOCKS[tenant]) throw new Error(`unknown CRM: ${tenant} (this build knows: ${Object.keys(CRM_LOCKS).join(', ')})`);
  const file = crmLockPath(paths);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify({ schema: 1, tenant, set_at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return CRM_LOCKS[tenant];
}

/** True when `url` is the locked CRM (https, on one of its hosts). */
export function isLockedCrmUrl(url, lock = CRM_LOCKS.ronininc) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && lock.hosts.includes(u.hostname.toLowerCase()); } catch { return false; }
}

/** True when an app belongs to the other company (name, bundle id or path), so Kingmaker must not drive it. */
export function isOtherTenantApp({ name = '', bundleId = '', path = '' } = {}, lock = CRM_LOCKS.ronininc) {
  return [name, bundleId, path].some((s) => lock.otherTenantApps.test(String(s)));
}

const lockedMcpUrl = (lock) => new URL('/mcp/solomon', lock.url).toString();

/**
 * The Ronin add-on's part of the engine's environment (lib/profile.mjs ghostBackendEnv calls it): Kingmaker's seats on
 * the owner's CRM, and, on a locked install, the one CRM it may use. Pure.
 */
export function backendDefaults(crmLock) {
  return {
    // ...unless this install is bound to one company's CRM (operator 2026-10-13: the owner's Ronin Mac). Then the
    // environment pin beats any CRM "connected" by voice, so it can never be linked to the other company's.
    ...(crmLock ? {
      SOLOMON_HOME_CRM_URL: crmLock.url,
      SOLOMON_CRM_LOCK_TENANT: crmLock.tenant,
      SOLOMON_CRM_LOCK_HOSTS: crmLock.hosts.join(','),
      SOLOMON_CRM_LOCK_MCP_URL: lockedMcpUrl(crmLock),
      // The dev/headless token remains usable, but it is paired only with this exact locked transport.
      RONIN_CRM_MCP_URL: lockedMcpUrl(crmLock),
    } : {}),
    // Kingmaker's seats on the owner's CRM (core runtime/kingmaker-approver.ts): the capital heartbeat beats, team_status
    // reads the Seeker MCP, and the delegated approval loop is available. Each seat is inert until its own token is in the
    // vault (:key ronin-approver / ronin-seeker / ronin-local), or the CRM's master key is in the ronin-crm slot (:key ronin-crm,
    // one key for every seat); approvals stay off until the owner types :approvals on.
    SOLOMON_KINGMAKER_SEATS: '1',
    // The inbound DM bridge (core runtime/crm-dm-bridge.ts) forwards every inbound DM to the CRM, tagged; off until :dms on.
    // The one-line switch: 'business' forwards prospects only (skips likely_personal). 'all' is the owner's choice (2026-10-09).
    SOLOMON_DM_FORWARD_SCOPE: 'all',
    // When this installation has its own Seeker token, dock its read-only answer loop and keep the CRM lease alive.
    // With no token the seat remains inert. Each CRM installation uses its own runtime home, base URL, token and vault
    // slot; one company's pairing never stands in for another's.
    SOLOMON_SEEKER_DOCK: '1',
  };
}

/** The lock is not the operator's to override: another CRM's address goes back to the locked one, a Seeker check-in
 *  off the locked CRM is dropped, and a generic CRM binding can't open a second tenant transport. Mutates `merged`. */
export function enforceLock(merged, crmLock, dropped) {
  if (!isLockedCrmUrl(merged.SOLOMON_HOME_CRM_URL, crmLock)) merged.SOLOMON_HOME_CRM_URL = crmLock.url;
  if (merged.SOLOMON_SEEKER_CHECKIN_URL !== undefined && !isLockedCrmUrl(merged.SOLOMON_SEEKER_CHECKIN_URL, crmLock)) { delete merged.SOLOMON_SEEKER_CHECKIN_URL; dropped.push('SOLOMON_SEEKER_CHECKIN_URL'); }
  merged.SOLOMON_CRM_LOCK_TENANT = crmLock.tenant;
  merged.SOLOMON_CRM_LOCK_HOSTS = crmLock.hosts.join(',');
  merged.SOLOMON_CRM_LOCK_MCP_URL = lockedMcpUrl(crmLock);
  merged.RONIN_CRM_MCP_URL = lockedMcpUrl(crmLock);
  // A generic CRM binding is an independent bearer+URL lane. The locked runtime uses the pinned
  // Ronin client instead; inherited generic configs must not create a second tenant transport.
  if (merged.SOLOMON_CRM_MCP_CONFIG !== undefined) { delete merged.SOLOMON_CRM_MCP_CONFIG; dropped.push('SOLOMON_CRM_MCP_CONFIG'); }
}

/** The Ronin CRM's keys, for the device scan's key classes and the engine's one-at-a-time key handoff (lib/device-keys.mjs). */
export const KEY_PROVIDERS = Object.freeze([[/^RONIN_CRM_(?:MCP_)?TOKEN$|^SOLOMON_CRM_TOKEN$/, 'ronin-crm', 'Ronin CRM']]);
export const HANDOFF_PROVIDERS = Object.freeze({ 'ronin-crm': 'ronin-crm' });

/** Learning stores an owner's install made before the core's 'owner' store, kept in use (lib/learning.mjs defaultTenant). */
export const LEARNING_TENANTS = Object.freeze(['orosolu']);
