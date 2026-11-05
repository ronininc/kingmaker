// lib/merchant.mjs — Kingmaker's handle on the engine's Clover merchant write-lane (merchant-ops.ts).
//
// Only Clover is wired here; the engine's merchant-ops router is Clover-only (Shopify/Stripe write lanes live
// elsewhere and are a later, separate mapping). Two lanes:
//   • dry-run (propose): POST /clover/dry-run returns a validated target + a dry-run diff; applyEnabled is always
//     false. No owner nonce — it changes nothing, so `say`/MCP may run it.
//   • apply (the live register WRITE): POST /clover/apply. The engine fails closed (409 CLOVER_APPLY_FAIL_CLOSED)
//     unless operatorConfirmed:true, and the write runs only for an owner/operator-role principal; with no live
//     connector it returns CLOVER_WRITE_CONFIG_REQUIRED (never a fabricated success). So Kingmaker only ever applies
//     as the owner (the launch nonce, via client.ownerCall), after reading the diff back — never from `say`/MCP.
//
// Snapshot source: `--fixture` drives the engine's built-in Donatita fixture so the governed path is exercisable
// without a live connector; a live snapshot is not wired through this CLI yet (the engine refuses honestly without one).

/** Build the Clover intent body from parsed flags. `fixture` sends fixtureMode (the engine's Donatita fixture). */
export function cloverIntentBody({ fixture = false, merchant = null, item = null, modifierGroup = null, maxSelections = null } = {}) {
  const body = {};
  if (fixture) body.fixtureMode = true;
  if (merchant) body.merchantName = merchant;
  if (item) body.targetItemLabel = item;
  if (modifierGroup) body.targetModifierGroupLabel = modifierGroup;
  if (Number.isInteger(maxSelections) && maxSelections > 0) body.requestedMaxSelections = maxSelections;
  return body;
}

/** The apply body: operatorConfirmed plus the validated target + diff a prior dry-run produced, so the engine
 *  consumes the same validated diff rather than re-deriving one. Carries the snapshot source through unchanged. */
export function cloverApplyBody(intent = {}, dryRun = {}) {
  const body = { operatorConfirmed: true, ...intent };
  if (dryRun.validatedTarget) body.validatedTarget = dryRun.validatedTarget;
  if (dryRun.dryRunDiff) body.validatedDryRunDiff = dryRun.dryRunDiff;
  return body;
}

/** One-line summary of a dry-run response (stable fields only; never invents one). */
export function diffLines(data = {}) {
  const t = data.validatedTarget ?? {};
  const d = data.dryRunDiff ?? {};
  const out = [`Clover dry-run: ${data.status ?? '?'} (apply ${data.applyEnabled ? 'enabled' : 'disabled'}, execution ${data.executionAllowed ? 'allowed' : 'not allowed'})`];
  if (d.operation || d.merchantName) out.push(`  diff ${data.validatedDryRunDiffId ?? d.diffId ?? '?'}: ${d.operation ?? 'change'}${d.merchantName ? ` for ${d.merchantName}` : ''}`);
  if (t.validationStatus) out.push(`  target: ${t.validationStatus}`);
  return out;
}

/** Interpret an apply response into a plain outcome the owner can act on. Never reports a write that did not happen. */
export function applyOutcome(status, data = {}) {
  const applied = data.applied === true;
  if (applied) return { applied: true, line: `Applied. ledger ${data.missionActionLedgerId ?? '?'} (${data.missionActionState ?? 'EXECUTED'}).` };
  const code = data.error ?? data.status ?? `HTTP ${status}`;
  if (/CONFIG_REQUIRED/.test(String(code))) return { applied: false, line: 'Not applied: no live Clover connector (CLOVER_WRITE_CONFIG_REQUIRED). The register was not touched; connect Clover first.' };
  if (/FAIL_CLOSED|BLOCKED/.test(String(code))) return { applied: false, line: `Not applied: ${code}. The register was not touched.` };
  return { applied: false, line: `Not applied: ${code}.` };
}
