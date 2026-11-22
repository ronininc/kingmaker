// lb-host.mjs — host wiring for the Little Brother bridge
// (littlebrother-integration.mjs), per INTEGRATION-NOTE-item-09-10.md
// Part A. The bridge ships inert by design: it loads only when the host
// names a module, injects a transport, and scopes the audit log. This
// module is that host side — the dashboard constructs the bridge
// through here and nowhere else.
//
// Configuration, following the tree's existing conventions:
//   * SCRIPTURE_ARMOR_LB_MODULE (the one env name the bridge itself
//     designates, read via its own lbModulePathFromEnv) names the
//     installed Little Brother module. Unset = the bridge returns its
//     named not-wired refusal object and Armor behaves exactly as it
//     did before this wiring existed: no enrichment, no audit file,
//     no behavior change.
//   * State is identity-dir-scoped, like the dashboard feed and the
//     device audit: the LB hash-chained audit log lives at
//     <identityDir>/littlebrother-audit.jsonl (LB owns the chain; this
//     host only names the path), and the local transport's data file
//     lives at <identityDir>/littlebrother-transport.json.
//
// Transport: LB ships no network code and the integration note leaves
// the transport decision to the host. Armor's host transport is a
// LOCAL FILE transport — it answers the bridge's documented transport
// calls ({ kind, target, params }) from a host-maintained JSON dataset
// of public-source records in the identity dir, and adds no network
// code of its own. Dataset shape, keyed by kind then target:
//   { "domain":   { "example.com":   { registrar, created, expires,
//                                      nameservers, status } },
//     "ip":       { "203.0.113.7":   { country, region, city, asn,
//                                      organization, reputation } },
//     "username": { "some-name":     { profiles: [{ platform, url,
//                                      exists, displayName }] } },
//     "web":      { "https://…":     { title, text } } }
// A missing dataset file fails closed: the transport throws and every
// network method returns LB's fail-closed refusal (which LB still
// audit-logs). An unknown target returns an empty payload, which the
// methods report as unverified evidence — never as fact.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArmorLittleBrother, lbModulePathFromEnv } from './littlebrother-integration.mjs';

export function lbAuditPath(identityDir) {
  return path.join(identityDir, 'littlebrother-audit.jsonl');
}

export function lbTransportDataPath(identityDir) {
  return path.join(identityDir, 'littlebrother-transport.json');
}

export function createLocalFileTransport(file) {
  return async ({ kind, target }) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`little brother local transport data unavailable at ${file} — fail-closed`);
    }
    const entry = data?.[kind]?.[target];
    if (entry !== undefined) return entry;
    if (kind === 'username') return { profiles: [] };
    if (kind === 'web') return { title: null, text: '' };
    return {};
  };
}

// Resolve the configured module reference the way a host should: an
// existing filesystem path becomes a file URL (so relative paths mean
// what the operator means, relative to the working directory); URLs
// and bare specifiers pass through untouched for the bridge's import.
function resolveModuleReference(value) {
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value; // URL or scheme
  if (fs.existsSync(value)) return pathToFileURL(path.resolve(value)).href;
  return value; // let the bridge's import fail closed with its named refusal
}

/**
 * createHostLittleBrother({ identityDir, env, transport })
 * Builds the bridge exactly as the integration note prescribes: module
 * path from the environment, host transport injected, audit log scoped
 * to the identity dir. With no module configured this resolves to the
 * bridge's inert not-wired object. A configured module whose factory
 * throws (e.g. LB's audit log refusing a corrupted persisted chain at
 * open) rejects — the host entry point catches that and degrades to
 * "no enrichment" loudly, never to a corrupted product flow.
 */
export function createHostLittleBrother({ identityDir, env = process.env, transport } = {}) {
  if (!identityDir) throw new Error('lb-host: identityDir is required');
  return createArmorLittleBrother({
    lbModulePath: resolveModuleReference(lbModulePathFromEnv(env)),
    transport: transport ?? createLocalFileTransport(lbTransportDataPath(identityDir)),
    auditPath: lbAuditPath(identityDir),
  });
}

/**
 * Run the bridge's enrichment over a review result's findings and
 * return the enrichment block ({ wired, results, findings, audit }) —
 * or null when there is nothing to present (bridge unwired, no
 * findings, or enrichment failed). NEVER throws: enrichment is
 * presentation-only and must not break the flow that produced the
 * review. The original findings array is not mutated; the caller
 * attaches the returned findings to the presentation layer only.
 */
export async function enrichFindings(lb, findings) {
  try {
    if (!lb || !lb.wired || !Array.isArray(findings) || !findings.length) return null;
    const { enrichment } = await lb.enrichScanRecord({ findings });
    if (!enrichment?.findings?.length) return null;
    return enrichment;
  } catch {
    return null;
  }
}
