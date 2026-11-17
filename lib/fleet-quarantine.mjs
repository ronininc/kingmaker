// lib/fleet-quarantine.mjs — the quarantine + review + publication path for FLEET submissions (2026-11-16).
//
// Where it sits: lib/ability-pipeline.mjs proposes (user side) and signs/accepts owner releases; lib/fleet-review.mjs
// queues proposals for the owner. This module is the separate QUARANTINE in front of publication to the canonical
// skills repository: a fleet contribution is never auto-trusted, mandatory fleet participation does not open any gate,
// and nothing here can reach a method store.
//
//   submit     a received proposal bundle → <root>/<sha256>/submission.json (JSON only: never a .method.md, never an
//              index.json, and <root> may not sit inside any method-store load path). Status 'quarantined'.
//   evaluate   provenance (schema, integrity, per-item consent, rights, injected submitter verification) · injected
//              Scripture Armor scan · privacy screen (credentials/PII/paths, paid corpus) · duplication vs incumbents
//              and other submissions · task-specific performance measured by an injected harness (the submitter's own
//              claims are recorded as claims, never as evidence) → verdict:
//                reject            any check found it unsafe, invalid, or an inferior duplicate
//                hold              anything uncertain (an unavailable check, unverified provenance, unmeasured or
//                                  insufficient performance evidence, no measurable improvement over the incumbent)
//                accept-candidate  every check passed — still NOT publishable: it only becomes a candidate bundle
//   bundle     accept-candidate only → a publication bundle naming its destination (repo + path) and the evaluation.
//   approve    the OWNER signs the exact bundle hash with the owner ability-approve key (lib/ability-pipeline.mjs).
//   verify     releasable ONLY when the approval verifies against the install's PINNED owner ability key, the bundle
//              hash recomputes to the approved hash (any edit after approval refuses), the verdict is accept-candidate,
//              no valid owner revocation names it, and a FRESH Armor check passes. Both gates, every time.
//   stage      a releasable bundle is written to an outbox directory for the transport (no network here).
//
// The user's local skill is never touched: this module reads only what it is handed and writes only under its own
// root / the stage directory. A rejection is a fleet-publication decision, not a local one.
//
// Injected interfaces (the coordinator wires the real ones):
//   armorCheck(artifact)  → { ok: boolean, findings: [], armorVersion: string }   (Scripture Armor)
//   verifySubmitter(bundle, submitter) → { ok: boolean, identity?, reason? }        (fleet enrollment)
//   measurePerformance({ task, candidate, incumbent }) → { metric, higherIsBetter, candidate: { score, samples },
//                                                          incumbent: { score, samples } | null }
//   incumbents() → [{ id, version, task, text, sha256? }]   the abilities already published for each task
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from './hash-util.mjs';
import { ROLES, ownerSigningKey, privacyScreen, signOwnerEnvelope, validRevocations, verifyOwnerEnvelope } from './ability-pipeline.mjs';
import { corpusFingerprints, corpusMatch, methodFingerprint } from './corpus-guard.mjs';
import { parseMethodFile } from './method-conductor.mjs';
import { abilityStores } from './method-request.mjs';
import { FLEET_DISCLOSURE_DIGEST } from './sharing.mjs';

export const SUBMISSION_SCHEMA = 'kingmaker.fleet-submission/1';
export const PUBLICATION_SCHEMA = 'kingmaker.fleet-publication/1';
export const APPROVAL_SCHEMA = 'kingmaker.fleet-publication-approval/1';
export const VERDICT = Object.freeze({ accept: 'accept-candidate', reject: 'reject', hold: 'hold' });
export const DEFAULT_THRESHOLDS = Object.freeze({ minSamples: 5, margin: 0.02, minScore: 0.5, nearDuplicate: 0.9, possibleDuplicate: 0.6 });

const BLOCK = /```kingmaker-method\r?\n([\s\S]*?)```/;
const isHash = (h) => /^[a-f0-9]{64}$/.test(String(h));
const inside = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** Paths a quarantine / stage directory must never be inside: every method-store load path of `state`, plus extras. */
export function methodLoadPaths(state, extra = []) {
  const s = state ? abilityStores(state) : {};
  return [...Object.values(s), ...extra].filter(Boolean).map((p) => resolve(p));
}
function assertOffLoadPath(dir, state, extra) {
  for (const p of methodLoadPaths(state, extra)) if (inside(dir, p) || inside(p, dir)) throw new Error(`QUARANTINE_ON_LOAD_PATH: ${dir} overlaps the method store ${p}`);
}

/** Word 3-shingle Jaccard similarity of two methods' executable steps (0..1). */
function stepShingles(text) {
  const m = BLOCK.exec(String(text ?? '')); if (!m) return new Set();
  let steps; try { steps = JSON.parse(m[1]).steps ?? []; } catch { return new Set(); }
  const words = JSON.stringify(steps).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set(); for (let i = 0; i + 2 < words.length; i += 1) out.add(words.slice(i, i + 3).join(' '));
  return out;
}
export function stepSimilarity(a, b) {
  const x = stepShingles(a), y = stepShingles(b); if (!x.size || !y.size) return 0;
  let n = 0; for (const s of x) if (y.has(s)) n += 1;
  return n / (x.size + y.size - n);
}

export function publicationHash(bundle) { return sha256Hex(canonicalJson(bundle)); }

/**
 * The quarantine in `root`. `state` (when given) is the install whose method stores the root must stay off;
 * `loadPaths` adds any other store directories to keep it off.
 */
export function createFleetQuarantine({ root, state = null, loadPaths = [], armorCheck = null, verifySubmitter = null, measurePerformance = null,
  incumbents = () => [], corpusStores = [], thresholds = {}, now = () => new Date() }) {
  if (!root) throw new Error('QUARANTINE_ROOT_REQUIRED');
  assertOffLoadPath(root, state, loadPaths);
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dirOf = (h) => { if (!isHash(h)) throw new Error('QUARANTINE_ITEM_ID_INVALID'); return join(root, h); };
  const read = (h) => { try { return JSON.parse(readFileSync(join(dirOf(h), 'submission.json'), 'utf8')); } catch { return null; } };
  const write = (item) => { const d = dirOf(item.sha256); mkdirSync(d, { recursive: true, mode: 0o700 }); const f = join(d, 'submission.json'); writeFileSync(`${f}.tmp`, JSON.stringify(item, null, 2), { mode: 0o600 }); renameSync(`${f}.tmp`, f); };
  const list = () => readdirSync(root).filter(isHash).map(read).filter(Boolean);

  function submit(bundle, { submitter = null, task = null } = {}) {
    const refuse = (reason) => ({ status: 'refused', reason });
    if (bundle?.schema !== 'kingmaker.ability-proposal/1') return refuse('not an ability proposal');
    if (typeof bundle.text !== 'string' || !isHash(bundle.sha256)) return refuse('malformed proposal');
    if (sha256Hex(bundle.text) !== bundle.sha256) return refuse('integrity: text does not match its sha256');
    const prior = read(bundle.sha256); if (prior) return refuse(`already quarantined (${prior.status})`);
    write({ schema: SUBMISSION_SCHEMA, sha256: bundle.sha256, status: 'quarantined', receivedAt: now().toISOString(), task: task ?? null, submitter, bundle, evaluation: null });
    return { status: 'quarantined', sha256: bundle.sha256 };
  }

  async function evaluate(h) {
    const item = read(h); if (!item) throw new Error('QUARANTINE_ITEM_UNKNOWN');
    if (item.status === VERDICT.reject) throw new Error('QUARANTINE_ITEM_REJECTED: a rejected submission is not re-evaluated; submit a new version');
    const { bundle } = item;
    const checks = [];
    const add = (name, outcome, detail, extra = {}) => checks.push({ name, outcome, detail, ...extra }); // outcome: pass | hold | reject

    // 1. provenance
    const prov = [];
    if (sha256Hex(bundle.text) !== bundle.sha256) prov.push('integrity');
    // Same consent rule as lib/fleet-review.mjs enqueue: per-item consent recorded under the current disclosure.
    if (bundle.provenance?.consent?.perItem !== true || bundle.consentDigest !== FLEET_DISCLOSURE_DIGEST) prov.push('no recorded per-item user consent under the current disclosure');
    if (bundle.rights?.attested !== true || !['own-work', 'licensed'].includes(bundle.rights?.source) || (bundle.rights.source === 'licensed' && !bundle.rights.licence)) prov.push('rights not established');
    if (prov.length) add('provenance', 'reject', prov.join('; '));
    else if (typeof verifySubmitter !== 'function') add('provenance', 'hold', 'submitter identity could not be verified: no fleet enrollment verifier is wired');
    else {
      let v; try { v = await verifySubmitter(bundle, item.submitter); } catch (e) { v = { ok: null, reason: `verifier failed: ${e.message}` }; }
      if (v?.ok === true) add('provenance', 'pass', `submitter verified${v.identity ? ` (${v.identity})` : ''}; consent + rights recorded`);
      else if (v?.ok === false) add('provenance', 'reject', `submitter verification failed: ${v.reason ?? 'no reason'}`);
      else add('provenance', 'hold', v?.reason ?? 'submitter verification inconclusive');
    }

    // 2. parse (an unparseable ability is not publishable)
    let spec = null; try { spec = parseMethodFile(bundle.text); if (spec.id !== bundle.id) throw new Error(`id ${spec.id} ≠ bundle id ${bundle.id}`); add('parse', 'pass', `${spec.steps.length} steps`); }
    catch (e) { add('parse', 'reject', e.message); }

    // 3. Scripture Armor (injected)
    let armor = null;
    if (typeof armorCheck !== 'function') add('armor', 'hold', 'Scripture Armor check unavailable: not wired');
    else {
      try { armor = await armorCheck({ kind: 'fleet-ability', id: bundle.id, version: bundle.version, sha256: bundle.sha256, text: bundle.text }); } catch (e) { armor = { ok: null, error: e.message }; }
      if (armor?.ok === true && typeof armor.armorVersion === 'string') add('armor', 'pass', `clean under Scripture Armor ${armor.armorVersion}`, { armorVersion: armor.armorVersion });
      else if (armor?.ok === false) add('armor', 'reject', `Scripture Armor findings: ${(armor.findings ?? []).map((f) => (typeof f === 'string' ? f : f?.rule ?? f?.id ?? JSON.stringify(f))).join(', ') || 'unspecified'}`, { armorVersion: armor.armorVersion ?? null, findings: armor.findings ?? [] });
      else add('armor', 'hold', `Scripture Armor result inconclusive${armor?.error ? `: ${armor.error}` : ''}`);
    }

    // 4. privacy (whole text, not just the block) + paid corpus
    const flags = privacyScreen(bundle.text);
    const corpus = corpusMatch(bundle.text, { fps: corpusFingerprints({ stores: corpusStores }) });
    if (flags.length || corpus) add('privacy', 'reject', [...flags, ...(corpus ? [corpus] : [])].join(', '), { limitation: 'Pattern screen: it cannot recognise every kind of personal or proprietary content.' });
    else add('privacy', 'pass', 'no credential, personal-data, device-path or paid-corpus pattern');

    // 5. duplication (vs published incumbents and other live submissions)
    const task = item.task ?? spec?.id ?? bundle.id;
    let incs = []; try { incs = (await incumbents()) ?? []; } catch { incs = null; }
    const fp = methodFingerprint(bundle.text);
    const dupes = [];
    const others = [...(incs ?? []).map((i) => ({ ...i, where: 'published' })),
      ...list().filter((o) => o.sha256 !== h && o.status !== VERDICT.reject).map((o) => ({ id: o.bundle.id, version: o.bundle.version, task: o.task ?? o.bundle.id, text: o.bundle.text, where: 'quarantine' }))];
    for (const o of others) {
      const ofp = methodFingerprint(o.text);
      const sim = stepSimilarity(bundle.text, o.text);
      const kind = sha256Hex(String(o.text)) === bundle.sha256 ? 'exact' : fp && ofp && fp.steps === ofp.steps ? 'same-steps'
        : sim >= t.nearDuplicate ? 'near' : (o.task === task || o.id === bundle.id) ? 'same-task' : sim >= t.possibleDuplicate ? 'possible' : null;
      if (kind) dupes.push({ kind, id: o.id, version: o.version ?? null, where: o.where, similarity: Number(sim.toFixed(3)), task: o.task ?? null });
    }
    const incumbent = (incs ?? []).find((i) => i.task === task) ?? (incs ?? []).find((i) => dupes.some((d) => d.where === 'published' && d.id === i.id && d.kind !== 'possible')) ?? null;
    if (incs === null) add('duplication', 'hold', 'the incumbent registry could not be read');
    else if (dupes.some((d) => d.kind === 'exact')) add('duplication', 'reject', `exact duplicate of ${dupes.find((d) => d.kind === 'exact').id} (${dupes.find((d) => d.kind === 'exact').where})`, { duplicates: dupes });
    else if (dupes.some((d) => d.where === 'quarantine' && ['same-steps', 'near', 'same-task'].includes(d.kind))) add('duplication', 'hold', 'a near-identical or same-task submission is already in quarantine; the owner chooses between them', { duplicates: dupes });
    else if (dupes.some((d) => d.kind === 'possible') && !incumbent) add('duplication', 'hold', 'possible duplicate with no shared task to measure against', { duplicates: dupes });
    else add('duplication', 'pass', dupes.length ? `overlaps ${dupes.map((d) => `${d.id} (${d.kind})`).join(', ')}: decided by measured performance` : 'no duplicate found', { duplicates: dupes });

    // 6. task-specific performance (measured here; the submitter's claims are not evidence)
    const claim = bundle.performance ?? null;
    let perf = null;
    const isDup = dupes.some((d) => d.where === 'published' && d.kind !== 'possible');
    if (!spec) add('performance', 'hold', 'not measured: the ability does not parse');
    else if (typeof measurePerformance !== 'function') add('performance', 'hold', 'no task-specific performance harness is wired', { claim });
    else {
      try { perf = await measurePerformance({ task, candidate: { id: bundle.id, version: bundle.version, text: bundle.text }, incumbent: incumbent ? { id: incumbent.id, version: incumbent.version, text: incumbent.text } : null }); }
      catch (e) { perf = { error: e.message }; }
      const c = perf?.candidate, i = perf?.incumbent;
      const num = (x) => typeof x === 'number' && Number.isFinite(x);
      if (!c || !num(c.score) || !num(c.samples)) add('performance', 'hold', `performance measurement unavailable${perf?.error ? `: ${perf.error}` : ''}`, { claim });
      else if (c.samples < t.minSamples || (incumbent && (!i || !num(i.score) || !num(i.samples) || i.samples < t.minSamples))) add('performance', 'hold', `insufficient evidence: fewer than ${t.minSamples} measured samples`, { measured: perf, claim });
      else if (!incumbent) {
        const ok = perf.higherIsBetter === false ? c.score <= t.minScore : c.score >= t.minScore;
        add('performance', ok ? 'pass' : 'reject', `${perf.metric ?? 'score'} ${c.score} on ${c.samples} samples (bar ${t.minScore}); no incumbent for task "${task}"`, { measured: perf, claim });
      } else {
        const delta = (perf.higherIsBetter === false ? -1 : 1) * (c.score - i.score);
        const what = `${perf.metric ?? 'score'} ${c.score} vs incumbent ${incumbent.id}@${incumbent.version ?? '?'} ${i.score} (${c.samples}/${i.samples} samples)`;
        if (delta > t.margin) add('performance', 'pass', `better than the incumbent: ${what}`, { measured: perf, claim, supersedes: { id: incumbent.id, version: incumbent.version ?? null } });
        else if (delta < -t.margin) add('performance', 'reject', `${isDup ? 'inferior duplicate' : 'inferior to the incumbent for the same task'}: ${what}`, { measured: perf, claim });
        else add('performance', 'hold', `no measurable improvement over the incumbent (within ±${t.margin}): ${what}`, { measured: perf, claim });
      }
    }

    const verdict = checks.some((c) => c.outcome === 'reject') ? VERDICT.reject : checks.some((c) => c.outcome === 'hold') ? VERDICT.hold : VERDICT.accept;
    const evaluation = { verdict, task, evaluatedAt: now().toISOString(), checks,
      reasons: checks.filter((c) => c.outcome !== 'pass').map((c) => `${c.name}: ${c.detail}`),
      armorVersion: checks.find((c) => c.name === 'armor')?.armorVersion ?? null,
      supersedes: checks.find((c) => c.name === 'performance')?.supersedes ?? null };
    evaluation.digest = sha256Hex(canonicalJson(evaluation));
    item.evaluation = evaluation; item.status = verdict; write(item);
    return evaluation;
  }

  /** accept-candidate only → the publication bundle (still unpublishable until the owner signs its exact hash). */
  function buildPublicationBundle(h, { destination }) {
    const item = read(h); if (!item) throw new Error('QUARANTINE_ITEM_UNKNOWN');
    if (item.status !== VERDICT.accept || item.evaluation?.verdict !== VERDICT.accept) throw new Error(`NOT_A_CANDIDATE: verdict is ${item.evaluation?.verdict ?? item.status}`);
    if (!destination || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(destination.repo)) || typeof destination.path !== 'string'
      || !destination.path || destination.path.startsWith('/') || destination.path.split('/').includes('..')) throw new Error('PUBLICATION_DESTINATION_INVALID: { repo: "owner/name", path: "relative/dir" }');
    const b = item.bundle, ev = item.evaluation;
    const bundle = { schema: PUBLICATION_SCHEMA, id: b.id, version: b.version, task: ev.task, sha256: b.sha256, text: b.text,
      destination: { repo: destination.repo, path: destination.path.replace(/\/+$/, '') },
      evaluation: { verdict: ev.verdict, digest: ev.digest, armorVersion: ev.armorVersion, evaluatedAt: ev.evaluatedAt, supersedes: ev.supersedes,
        checks: ev.checks.map((c) => ({ name: c.name, outcome: c.outcome, detail: c.detail })) },
      provenance: { proposer: b.proposer ?? null, consentDigest: b.consentDigest ?? null, rights: b.rights ?? null, receivedAt: item.receivedAt },
      builtAt: now().toISOString() };
    const bundleSha256 = publicationHash(bundle);
    writeFileSync(join(dirOf(h), 'publication.json'), JSON.stringify(bundle, null, 2), { mode: 0o600 });
    item.publication = { bundleSha256, builtAt: bundle.builtAt }; write(item);
    return { bundle, bundleSha256 };
  }

  return { root, submit, evaluate, buildPublicationBundle, get: read, list: (status = null) => list().filter((i) => !status || i.status === status) };
}

/** The OWNER's act: sign the exact bundle hash with the owner ability-approve key (only on the owner's private Kingmaker). */
export function approvePublication({ bundle, ownerDir, note = '', now = () => new Date() }) {
  if (bundle?.schema !== PUBLICATION_SCHEMA) throw new Error('NOT_A_PUBLICATION_BUNDLE');
  if (bundle.evaluation?.verdict !== VERDICT.accept) throw new Error('NOT_APPROVABLE: the quarantine verdict is not accept-candidate');
  if (sha256Hex(bundle.text) !== bundle.sha256) throw new Error('NOT_APPROVABLE: text does not match its sha256');
  const priv = ownerSigningKey(ownerDir, 'ability');
  const trust = JSON.parse(readFileSync(join(ownerDir, 'trust.json'), 'utf8'));
  // Flat payload: the shared signer covers top-level fields only (see lib/ability-pipeline.mjs signOwnerEnvelope).
  return signOwnerEnvelope(APPROVAL_SCHEMA, { schema: APPROVAL_SCHEMA, role: ROLES.ability, keyId: trust.ability.keyId, bundleSha256: publicationHash(bundle),
    id: bundle.id, version: bundle.version, sha256: bundle.sha256, destinationRepo: bundle.destination.repo, destinationPath: bundle.destination.path,
    note: String(note), decisionId: randomUUID(), approvedAt: now().toISOString() }, priv);
}

/**
 * Is this bundle releasable? `trust` is the PINNED owner trust record ({ ability: { keyId, publicKeyPem } });
 * `armorCheck` is re-run now (required). Fleet participation settings are deliberately not an input.
 */
export async function verifyPublication({ bundle, approval, trust, armorCheck, revocations = [] }) {
  const reasons = [];
  const p = approval?.payload;
  if (bundle?.schema !== PUBLICATION_SCHEMA) reasons.push('not a publication bundle');
  const bundleSha256 = bundle ? publicationHash(bundle) : null;
  if (!p) reasons.push('owner approval required: no approval signature');
  else {
    if (p.schema !== APPROVAL_SCHEMA || p.role !== ROLES.ability) reasons.push('not an owner publication approval');
    if (!trust?.ability?.keyId || p.keyId !== trust.ability.keyId) reasons.push('not signed by the pinned owner ability-approve key');
    else if (!verifyOwnerEnvelope(APPROVAL_SCHEMA, approval, trust.ability.publicKeyPem)) reasons.push('approval signature does not verify against the pinned owner key');
    if (p.bundleSha256 !== bundleSha256) reasons.push('the bundle changed after the owner approved it (hash mismatch)');
    if (bundle && (p.id !== bundle.id || p.version !== bundle.version || p.sha256 !== bundle.sha256 || p.destinationRepo !== bundle.destination?.repo || p.destinationPath !== bundle.destination?.path)) reasons.push('approval does not name this bundle');
  }
  if (bundle && sha256Hex(String(bundle.text)) !== bundle.sha256) reasons.push('text does not match its sha256');
  if (bundle?.evaluation?.verdict !== VERDICT.accept) reasons.push('quarantine verdict is not accept-candidate');
  if (bundle && trust?.ability && validRevocations(revocations, trust).some((r) => r.payload.id === bundle.id && r.payload.version === bundle.version)) reasons.push('revoked by the owner');
  if (typeof armorCheck !== 'function') reasons.push('Scripture Armor re-check required at release: not wired');
  else if (bundle) {
    let a; try { a = await armorCheck({ kind: 'fleet-ability', id: bundle.id, version: bundle.version, sha256: bundle.sha256, text: bundle.text }); } catch (e) { a = { ok: null, error: e.message }; }
    if (a?.ok !== true) reasons.push(`Scripture Armor re-check did not pass${a?.error ? `: ${a.error}` : ''}`);
  }
  return { releasable: reasons.length === 0, reasons, bundleSha256 };
}

/** Write a releasable bundle into `outDir` for the transport (a PR to the destination repo). Refuses otherwise. */
export async function stagePublication({ bundle, approval, trust, armorCheck, revocations = [], outDir, state = null, loadPaths = [] }) {
  const v = await verifyPublication({ bundle, approval, trust, armorCheck, revocations });
  if (!v.releasable) return { status: 'refused', reasons: v.reasons };
  assertOffLoadPath(outDir, state, loadPaths);
  const safe = (x) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(x)) && !String(x).includes('..');
  if (!safe(bundle.id) || !safe(bundle.version)) return { status: 'refused', reasons: ['unsafe id/version for a path'] };
  const dir = join(outDir, bundle.id, String(bundle.version));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${bundle.id}.method.md`), bundle.text, { mode: 0o600 });
  writeFileSync(join(dir, 'publication.json'), JSON.stringify(bundle, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, 'owner-approval.json'), JSON.stringify(approval, null, 2), { mode: 0o600 });
  return { status: 'staged', dir, bundleSha256: v.bundleSha256, destination: bundle.destination };
}
