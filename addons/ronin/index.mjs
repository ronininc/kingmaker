// addons/ronin/index.mjs — the Ronin office add-on (ronin.addon/1, id ronin-office): Ronin CRM pairing and desks,
// delegated approvals, the inbound DM bridge, CRM jobs and skills, the overnight CRM loop, owner calls and the
// one-company CRM lock. Kingmaker loads it like any paid add-on (lib/addons.mjs loadAddons) and calls register(host): the
// add-on binds the core modules it was handed (./core.mjs) and exposes itself to the core as `ronin`.
export * from './agent-offices.mjs';
export * from './app-profile.mjs';
export * from './approvals.mjs';
export * from './brain-desks.mjs';
export * from './crm-jobs.mjs';
export * from './crm-lock.mjs';
export * from './crm-skills.mjs';
export * from './dms.mjs';
export * from './memory-retire.mjs';
export * from './muse-office.mjs';
export * from './owner-call.mjs';
export * from './text-watch.mjs';
export * from './ronin-desk-dock.mjs';
export * from './ronin-pairing.mjs';
export * from './cli.mjs';
export * from './office.mjs';
export * from './nightly.mjs';
export * from './commands.mjs';
export { bind, NEEDS } from './core.mjs';

import * as self from './index.mjs';
import { bind } from './core.mjs';

/** ronin.addon/1 entry: take the core Kingmaker hands over, then offer the add-on to it. */
export async function register(host) {
  bind(host.services?.lib);
  host.expose?.('ronin', self);
  host.log?.('ronin_office_ready', { version: host.version, api: host.apiVersion });
}
