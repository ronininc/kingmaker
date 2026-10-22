/**
 * lib/slash-buckets.mjs (kingmaker-stack)
 *
 * Slash-command job buckets — the Kingmaker command layer (Robbie's
 * directive 2026-10-20; spec: kingmaker-v042/slash-command-buckets.md).
 *
 * A bucket is a MANIFEST, not a copy: name, skill references into the one
 * skill tree, tool references, the router lane, a context pack, and a
 * governance class. Invoking `/crm draft the follow-up` assembles the
 * working set from the manifest and routes the order through it. Nothing
 * loads or runs until a command asks (capability on request only), and
 * assembling a bucket grants NOTHING — the gates inside the bucket
 * (outreach taps, TCPA, the Cage's Stage 4) apply exactly as before.
 * A slash command is an order, not a permission slip.
 *
 * Tool resolution for a tool a bucket names but Kingmaker lacks, in the
 * founder's order: use → find → absorb (the Cage) → recreate (the remake
 * belt; LittleBrother harvests HOW from the public record first) →
 * report the gap. The stages are injected by the host; this module owns
 * the order, the preference rules (already-governed beats new, local
 * beats remote, license-clean beats questionable), and the audit trail.
 *
 * Surfaces: the private-side buckets (surface: 'kingmaker-only') are
 * physically absent from any Solomon-facing listing — the same
 * separation discipline as LittleBrother's full methods.
 */

import { openAuditLog } from '../../lib/audit-chain.mjs';

/**
 * The first buckets. Skill/tool entries are REFERENCES (names in the one
 * tree), never copies. governance.class names the rule set the bucket
 * runs under; it inherits, never resets.
 */
export const BUCKETS = Object.freeze([
  {
    command: 'codegen', name: 'Code generation', surface: 'shared',
    skills: ['local-app-remake-belt', 'local-open-harness', 'github-tool-belt'],
    tools: ['router', 'harness2', 'weight-synthesis'],
    lane: 'deep', contextPack: ['repo-under-work', 'stack-manifest'],
    governance: { class: 'standard', notes: 'Commits carry no Co-Authored-By; Kingmaker is the quality gate.' },
  },
  {
    command: 'crm', name: 'CRM + client work', surface: 'shared',
    skills: ['legal-doc-kit'],
    tools: ['router', 'desk'],
    lane: 'standard', contextPack: ['crm-schema', 'client-definition'],
    governance: { class: 'crm', notes: 'Outreach needs the per-batch tap; the TCPA attestation is the founder\'s alone; client work invoices are drafted for his approval, never sent first.' },
  },
  {
    command: 'createmedia', name: 'Media creation', surface: 'shared',
    skills: ['founder-metric-reel'],
    tools: ['router', 'kuroko-voice', 'wordcraft', 'stop-slop', 'humanizer'],
    lane: 'standard', contextPack: ['jester-format', 'reel-format-spec', 'headline-doctrine'],
    governance: { class: 'content', notes: 'Nothing posts without the founder\'s tap; no money reels; other people\'s private messages never go public.' },
  },
  {
    command: 'videogame', name: 'Game building', surface: 'shared',
    skills: ['local-app-remake-belt'],
    tools: ['router', 'solidcraft'],
    lane: 'deep', contextPack: ['godot-project'],
    governance: { class: 'standard', notes: 'Clean-room rules for any studied title: methods, never assets.' },
  },
  {
    command: 'fabrication', name: 'Fabrication + design', surface: 'shared',
    skills: [],
    tools: ['router', 'solidcraft', 'anatomy'],
    lane: 'standard', contextPack: ['freecad-notes'],
    governance: { class: 'standard', notes: 'Anatomy renders, never diagnoses.' },
  },
  {
    command: 'godseye', name: 'PRIVATE-SIDE — observation class', surface: 'kingmaker-only',
    skills: [],
    tools: ['littlebrother'],
    lane: 'deep', contextPack: [],
    governance: { class: 'private-side', notes: 'Kingmaker-side only. Full methods are tap-gated stubs; wiring a live non-public source is a founder act. Never surfaces in Solomon, never named in public material.' },
  },
  {
    command: 'osiris', name: 'PRIVATE-SIDE — deep research class', surface: 'kingmaker-only',
    skills: [],
    tools: ['littlebrother', 'darkweb-search', 'obscura'],
    lane: 'deep', contextPack: [],
    governance: { class: 'private-side', notes: 'Kingmaker-side only. The dark-web lane doctrine applies in full: Tor-only, bounded sandbox, device seal, instant tripwire, text only.' },
  },
]);

/** Pure: parse a command line. Only a LEADING /name counts; the rest of
 *  the line is the order, verbatim. Returns { command, order } or null. */
export function parseCommand(text) {
  const m = /^\s*\/([a-z][a-z0-9-]*)\s+([\s\S]+)$/.exec(String(text ?? ''));
  if (!m) {
    const bare = /^\s*\/([a-z][a-z0-9-]*)\s*$/.exec(String(text ?? ''));
    return bare ? { command: bare[1], order: '' } : null;
  }
  return { command: m[1], order: m[2].trim() };
}

/**
 * createBucketRegistry({ buckets, auditLog, auditPath })
 *   list({ surface })  — 'solomon' listings physically exclude
 *                        kingmaker-only buckets; 'kingmaker' sees all.
 *   assemble(command)  — the working set for an order, audit-logged.
 */
export function createBucketRegistry({ buckets = BUCKETS, auditLog, auditPath } = {}) {
  const audit = auditLog ?? (auditPath ? openAuditLog(auditPath) : null);
  const byCommand = new Map(buckets.map((b) => [b.command, b]));
  const log = (action, detail, meta) => { if (audit) audit.append({ actor: 'slash-buckets', action, detail, meta }); };

  function list({ surface = 'kingmaker' } = {}) {
    return buckets
      .filter((b) => surface === 'kingmaker' || b.surface !== 'kingmaker-only')
      .map((b) => ({ command: b.command, name: b.name, surface: b.surface, lane: b.lane }));
  }

  function assemble(command) {
    const bucket = byCommand.get(String(command ?? '').toLowerCase());
    if (!bucket) {
      log('bucket-refused', `unknown bucket /${command}`);
      return { ok: false, refused: true, reason: `no bucket named /${command}` };
    }
    log('bucket-assemble', `/${bucket.command} lane=${bucket.lane} governance=${bucket.governance.class}`, {
      command: bucket.command, skills: bucket.skills.length, tools: bucket.tools.length,
    });
    return {
      ok: true,
      bucket: bucket.command,
      name: bucket.name,
      surface: bucket.surface,
      skills: [...bucket.skills],
      tools: [...bucket.tools],
      lane: bucket.lane,
      contextPack: [...bucket.contextPack],
      governance: { ...bucket.governance },
      grants: [],
      note: 'Assembly grants nothing: the gates inside this bucket apply to the order exactly as if it had been given without the slash command.',
    };
  }

  return { list, assemble, verifyAudit: () => (audit ? audit.verify() : null) };
}

/**
 * resolveTool(name, stages) — the founder's resolution order.
 *   stages: { have(name), find(name), absorb(name), recreate(name) }
 *   each async (or sync) → a resolution object or null.
 * Returns { ok, via, resolution } or { ok: false, via: 'gap', reason }.
 * Every step taken is audit-logged through the optional registry audit.
 */
export async function resolveTool(name, stages = {}, { audit } = {}) {
  const log = (action, detail) => { if (audit) audit.append({ actor: 'slash-buckets', action, detail }); };
  const order = [
    ['use', stages.have],
    ['find', stages.find],
    ['absorb', stages.absorb],
    ['recreate', stages.recreate],
  ];
  for (const [via, stage] of order) {
    if (typeof stage !== 'function') continue;
    const resolution = await stage(name);
    if (resolution) {
      log('tool-resolved', `${name} via ${via}`);
      return { ok: true, via, resolution };
    }
    log('tool-miss', `${name} not resolved via ${via}`);
  }
  log('tool-gap', `${name} unresolved through use/find/absorb/recreate`);
  return { ok: false, via: 'gap', reason: `no route to "${name}": not held, not found, not absorbable, not recreatable — the gap is reported, never papered over` };
}
