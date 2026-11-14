// lib/brain-library-fleet-churn.mjs — Fleet Replication follow-on 3: the
// churn cycle that applies the fleet eviction planner to a live store.
//
// v1 shipped chooseEvictions() as a pure planner and named the background
// churn job that applies it a follow-on (DESIGN §6). This module is that
// job, run to the standing churn rules (the same rules the Armor streaming
// build's daily churn scan runs under):
//
//   VERIFY   — every resident is re-hashed against its receipt pin.
//              A resident whose bytes fail is TAMPERED: the cycle records
//              a loud verdict {id, expected, actual}, quarantines the
//              holding in the ledger, and NEVER touches the bytes — a
//              failed verification is a user-visible verdict, never
//              silently repaired. (The access layer already refuses to
//              serve an unverified resident; churn adds the verdict and
//              the quarantine record.)
//   REFRESH  — a resident whose receipt pin no longer matches the current
//              catalog descriptor is superseded: it is re-pulled through
//              the access layer's download(), which accepts the new bytes
//              only when they hash to the serving source's pin. A refused
//              refresh is a verdict too; the old resident stays.
//   EVICT    — holdings leave three ways, all logged with the reason:
//              'orphaned' (the catalog no longer publishes the item),
//              'stale' (unused for longer than staleAfterMs, 30 days by
//              default — the standing default), and 'budget' (the pure
//              planner's LRU set that brings the store under budgetBytes).
//              Protected kinds (catalog / method / knowledge-index) and
//              pinned and quarantined holdings are NEVER evicted, by any
//              reason; if the protected floor alone busts the budget the
//              cycle says `reachable: false` instead of pretending.
//
// Holdings are tracked in a ledger (holdings.json in the churn state dir):
// { id, kind, lastUsedAt, pinned, quarantined }. Callers record use with
// noteHolding(); a download the churn itself performs counts as use.
// Stream-cache artifacts carry no at-rest pin in the access layer, so
// churn verifies RESIDENTS and evicts cache bytes by age/budget only —
// stated here rather than implied.
//
// Every cycle writes its full record to the log dir and returns it. The
// record is the receipt: footprint before/after comes from the access
// layer's own diskState(), not from the ledger's bookkeeping.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseEvictions } from './brain-library-fleet.mjs';

export const FLEET_CHURN_SCHEMA = 'kingmaker.fleet-churn/1';
export const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — the standing churn default
const PROTECTED_KINDS = new Set(['catalog', 'method', 'knowledge-index']);

export function createFleetChurn({ stateDir, logDir } = {}) {
  if (!stateDir || !logDir) throw new Error('brain-library-fleet-churn: stateDir and logDir are required');
  const ledgerPath = join(stateDir, 'holdings.json');

  async function readLedger() {
    try { return JSON.parse(await readFile(ledgerPath, 'utf8')); } catch { return {}; }
  }
  async function writeLedger(ledger) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  }

  /** Record (or update) a holding. `bytes` is bookkeeping only — the cycle
   *  measures real footprint from the access layer. */
  async function noteHolding({ id, kind = null, lastUsedAt = Date.now(), pinned = false } = {}) {
    if (!id) throw new Error('brain-library-fleet-churn: noteHolding needs an id');
    const ledger = await readLedger();
    ledger[id] = { ...(ledger[id] ?? {}), id, kind: kind ?? ledger[id]?.kind ?? null, lastUsedAt, pinned };
    await writeLedger(ledger);
    return ledger[id];
  }

  async function holdings() { return readLedger(); }

  /**
   * One churn cycle over a live access instance.
   * `catalog` — the current published descriptors (Map or object, id →
   * descriptor), e.g. loadFleetCatalog()'s items. `budgetBytes` — the store
   * budget the planner leg enforces. Returns the cycle record.
   */
  async function runCycle({ access, catalog, budgetBytes = Number.POSITIVE_INFINITY, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = Date.now() } = {}) {
    if (!access) throw new Error('brain-library-fleet-churn: runCycle needs an access instance');
    const descriptors = catalog instanceof Map ? catalog : new Map(Object.entries(catalog ?? {}));
    const ledger = await readLedger();
    const items = new Map((await access.listItems()).map((i) => [i.id, i]));
    const diskBefore = await access.diskState();
    const record = {
      schema: FLEET_CHURN_SCHEMA, at: new Date(now).toISOString(), budgetBytes,
      heldBytesBefore: diskBefore.storeBytes + diskBefore.cacheBytes,
      heldBytesAfter: null, verifiedOk: [], verdicts: [], refreshed: [], evicted: [], reachable: true,
    };
    const quarantined = new Set();

    // ---- VERIFY + REFRESH -------------------------------------------------
    for (const holding of Object.values(ledger)) {
      const item = items.get(holding.id);
      if (!item) { record.verdicts.push({ id: holding.id, verdict: 'LEDGER-ORPHAN', detail: 'the ledger names an item the access layer does not carry' }); continue; }
      if (!item.resident) continue; // cache-only holding: nothing at rest to verify
      const v = await access.verifyResident(holding.id);
      if (!v) continue;
      if (!v.ok) {
        quarantined.add(holding.id);
        holding.quarantined = true;
        record.verdicts.push({ id: holding.id, verdict: 'TAMPERED', expected: v.sha256, actual: v.actualSha256, detail: 'resident bytes fail their receipt pin — quarantined, bytes untouched, never silently repaired' });
        continue;
      }
      record.verifiedOk.push(holding.id);
      const descriptor = descriptors.get(holding.id);
      if (!descriptor) {
        record.verdicts.push({ id: holding.id, verdict: PROTECTED_KINDS.has(item.kind) ? 'ORPHANED-PROTECTED' : 'ORPHANED', detail: 'the current catalog carries no descriptor for this held item' });
        continue;
      }
      if (descriptor.sha256 !== v.sha256) {
        try {
          const r = await access.download(holding.id);
          holding.lastUsedAt = now;
          record.refreshed.push({ id: holding.id, from: v.sha256, to: r.sha256, bytes: r.bytes });
        } catch (e) {
          record.verdicts.push({ id: holding.id, verdict: 'REFRESH-REFUSED', detail: String(e?.message ?? e).slice(0, 200) });
        }
      }
    }

    // ---- EVICT ------------------------------------------------------------
    const itemsAfter = new Map((await access.listItems()).map((i) => [i.id, i]));
    const bytesOf = (item) => (item?.residentBytes ?? 0) + (item?.cacheBytes ?? 0);
    const evict = new Map(); // id -> reason
    for (const holding of Object.values(ledger)) {
      const item = itemsAfter.get(holding.id);
      if (!item || quarantined.has(holding.id) || holding.pinned || PROTECTED_KINDS.has(item.kind)) continue;
      if (!item.resident && !item.cacheBytes) continue;
      const descriptor = descriptors.get(holding.id);
      if (item.resident && !descriptor) evict.set(holding.id, 'orphaned');
      else if ((holding.lastUsedAt ?? 0) < now - staleAfterMs) evict.set(holding.id, 'stale');
    }
    const rows = Object.values(ledger)
      .filter((h) => !quarantined.has(h.id) && !evict.has(h.id))
      .map((h) => ({ id: h.id, kind: itemsAfter.get(h.id)?.kind ?? h.kind, bytes: bytesOf(itemsAfter.get(h.id)), lastUsedAt: h.lastUsedAt ?? 0, pinned: h.pinned ?? false }))
      .filter((r) => r.bytes > 0);
    // No finite budget = no planner leg: stale/orphan evictions still run,
    // and the cycle does not pretend a budget verdict exists.
    const plan = Number.isFinite(budgetBytes) ? chooseEvictions(rows, { budgetBytes }) : null;
    record.evictionPlan = plan;
    record.reachable = plan ? plan.reachable : true;
    for (const id of plan?.evict ?? []) if (!evict.has(id)) evict.set(id, 'budget');

    for (const [id, reason] of evict) {
      const item = itemsAfter.get(id);
      const bytes = bytesOf(item);
      await access.forget(id);
      delete ledger[id];
      record.evicted.push({ id, reason, bytes });
    }

    await writeLedger(ledger);
    const diskAfter = await access.diskState();
    record.heldBytesAfter = diskAfter.storeBytes + diskAfter.cacheBytes;

    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `cycle-${record.at.replace(/[:.]/g, '-')}.json`);
    await writeFile(logPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    return { ...record, logPath };
  }

  return { noteHolding, holdings, runCycle, ledgerPath };
}
