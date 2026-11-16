// lib/ability-pipeline.mjs — owner-approved fleet abilities (2026-11-16). Extends the existing fleet pieces instead of
// replacing them: the fleet consent record and disclosure digest (lib/sharing.mjs), the credential/private-data screen
// of the reusable-skill gate (lib/reusable-skill-policy.mjs), REA (lib/rea.mjs) and the Armor lexical admission scan
// (lib/learning-armor-scan.mjs), and the method conductor for an independent test. What is NEW is the authority layer
// the inspection found ABSENT: an owner approval signature, separate roles, signed versioned ability releases,
// receiver-side verification against PINNED owner keys, and signed revocation with quarantine.
//
//   propose  (any install; no key)       local method → executable block only (prose, author names, paths dropped) →
//                                        privacy + rights + dependency checks → proposal bundle, or KEPT LOCAL with
//                                        the reasons. Requires the install's fleet consent (sharing.json, current
//                                        disclosure digest). Nothing is transmitted by this module.
//   review   (owner's private Kingmaker) re-hash, re-screen, REA + Armor lexical scan, Little Brother status recorded
//                                        honestly (it only enriches endpoint findings; it is not a method validator
//                                        and is not wired in Kingmaker), independent isolated test conduction.
//                                        Evidence records every check, limitation and failure.
//   approve  (owner key, role ability-approve)  signs a kingmaker.ability-release/1 over the exact text hash and the
//                                        evidence digest — refused unless the evidence passed.
//   runtime  (owner key, role runtime-release-approve) signs a kingmaker.runtime-approval/1 over a release manifest
//                                        hash. The two roles are separate keys: neither can stand in for the other.
//   accept   (any install)               verifies the signature against the install's PINNED owner keys, the role, the
//                                        text hash, the parse, and the signed revocation list; stores it in the
//                                        separate fleet layer (<state>/fleet/abilities/methods), keeping prior versions.
//   revoke   (owner key, role ability-approve)  signed revocations; receivers quarantine the ability.
// Signatures: Ed25519 over a domain-separated canonical payload ("kingmaker.ability-release/1\n" + JSON).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { METHODS_SCHEMA, normalizeMethodsIndex } from './brain-library.mjs';
import { createMethodConductor, parseMethodFile } from './method-conductor.mjs';
import { methodStoreIndexUrl } from './method-iteration.mjs';
import { FLEET_DISCLOSURE_DIGEST, BOX_WORDING_VERSION } from './sharing.mjs';
import { scanLearningMethod } from './learning-armor-scan.mjs';

export const ROLES = Object.freeze({ ability: 'ability-approve', runtime: 'runtime-release-approve' });
const sha = (x) => createHash('sha256').update(x).digest('hex');
const canonical = (o) => JSON.stringify(o, Object.keys(o).sort());
const signed = (domain, payload, privPem) => ({ payload, sig: sign(null, Buffer.from(`${domain}\n${canonical(payload)}`), createPrivateKey(privPem)).toString('base64') });
const sigOk = (domain, env, pubPem) => { try { return verify(null, Buffer.from(`${domain}\n${canonical(env.payload)}`), createPublicKey(pubPem), Buffer.from(env.sig, 'base64')); } catch { return false; } };
const keyIdOf = (pubPem) => sha(pubPem).slice(0, 16);
const BLOCK = /```kingmaker-method\r?\n([\s\S]*?)```/;

// ── owner authority (the owner's private Kingmaker only) ─────────────────────────────────────────────────────────────
/** Create the owner's two role keys in `dir` (0700/0600). Returns ONLY the public trust record to pin on installs. */
export function createOwnerAuthority(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const trust = { schema: 'kingmaker.owner-trust/1' };
  for (const [name, role] of Object.entries(ROLES)) {
    const kp = generateKeyPairSync('ed25519');
    const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }), priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(join(dir, `${name}.key.pem`), priv, { mode: 0o600 });
    trust[name] = { role, keyId: keyIdOf(pub), publicKeyPem: pub };
  }
  writeFileSync(join(dir, 'trust.json'), JSON.stringify(trust, null, 2), { mode: 0o600 });
  return trust;
}
const ownerKey = (dir, name) => { const p = join(dir, `${name}.key.pem`); if (!existsSync(p)) throw new Error(`OWNER_AUTHORITY_REQUIRED: no ${name} key in ${dir} — only the owner's private Kingmaker can approve`); return readFileSync(p, 'utf8'); };
/** Pin the owner's public trust on an install (provisioning; production pinning belongs in the signed release). */
export function pinOwnerTrust(state, trust) { mkdirSync(join(state, 'fleet'), { recursive: true, mode: 0o700 }); writeFileSync(join(state, 'fleet', 'owner-trust.json'), JSON.stringify(trust, null, 2), { mode: 0o600 }); }
const readTrust = (state) => JSON.parse(readFileSync(join(state, 'fleet', 'owner-trust.json'), 'utf8'));

// ── propose (any install) ────────────────────────────────────────────────────────────────────────────────────────────
const PRIVATE = [
  ['credential_or_secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}|(?:password|passwd|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*\S+/i],
  ['private_or_customer_data', /\b(?:confidential|proprietary|customer|client data|internal only)\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i],
  ['personal_path', /(?:\/Users\/|\/home\/|[A-Z]:\\\\Users\\\\)[^\s"']+/],
  ['private_network', /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\w-]+\.local\b/],
  ['phone_number', /\b\+?\d{1,2}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/],
];
export function privacyScreen(text) { return PRIVATE.filter(([, re]) => re.test(text)).map(([flag]) => flag); }

export function proposeAbility({ state, methodText, rights, now = () => new Date() }) {
  const rec = (() => { try { return JSON.parse(readFileSync(join(state, 'fleet', 'sharing.json'), 'utf8')); } catch { return null; } })();
  const consent = rec?.on === true && rec.shown === true && rec.wording === BOX_WORDING_VERSION && rec.disclosureDigest === FLEET_DISCLOSURE_DIGEST;
  if (!consent) return { status: 'kept-local', reasons: ['no_current_fleet_consent'], detail: 'Fleet sharing is not on with the current disclosure; nothing leaves this install.' };
  const m = BLOCK.exec(String(methodText)); if (!m) return { status: 'kept-local', reasons: ['not_a_method'] };
  let spec; try { spec = JSON.parse(m[1]); parseMethodFile(methodText); } catch (e) { return { status: 'kept-local', reasons: ['unparseable'], detail: e.message }; }
  const reasons = privacyScreen(m[1]);
  // Non-empty input defaults are where a user's own values live; a shareable ability ships empty defaults.
  if (Object.values(spec.inputs ?? {}).some((v) => typeof v === 'string' && v.trim() !== '')) reasons.push('input_defaults_may_hold_private_values');
  if (!rights || !['own-work', 'licensed'].includes(rights.source) || (rights.source === 'licensed' && !rights.licence) || rights.attested !== true) reasons.push('rights_not_established');
  const tools = [...new Set((spec.steps ?? []).filter((s) => s.type === 'run-tool').map((s) => s.tool))];
  if (spec.tool?.path) reasons.push('tool_path_is_device_specific');
  if (reasons.length) return { status: 'kept-local', reasons, detail: 'This method cannot be separated from private, device-specific or unlicensed material automatically; it stays local.' };
  const text = `# Ability — ${spec.title}\n\nProposed for the Kingmaker fleet. Executable block only; the proposer's notes and identity are not included.\n\n\`\`\`kingmaker-method\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`;
  let installHash = 'unknown'; try { installHash = sha(readFileSync(join(state, 'fleet', 'install-id'), 'utf8').trim()).slice(0, 16); } catch { /* pseudonymous id unavailable */ }
  const bundle = { schema: 'kingmaker.ability-proposal/1', id: spec.id, version: spec.version, text, sha256: sha(text), rights: { source: rights.source, licence: rights.licence ?? 'own work', attested: true, attribution: rights.attribution ?? 'Kingmaker user (pseudonymous)' },
    proposer: installHash, dependencies: { tools, model: spec.weights ?? null }, consentDigest: FLEET_DISCLOSURE_DIGEST, proposedAt: now().toISOString(), testInput: rights.testInput ?? null };
  mkdirSync(join(state, 'fleet', 'outbox'), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, 'fleet', 'outbox', `${spec.id}-${spec.version}.proposal.json`), JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return { status: 'proposed', bundle, transmitted: false };
}

// ── review (owner's private Kingmaker) ───────────────────────────────────────────────────────────────────────────────
export async function reviewProposal(bundle, { reasoner = null, toolRunner = null, now = () => new Date() } = {}) {
  const checks = [];
  const add = (name, pass, detail, limitation = null) => checks.push({ name, pass, detail, ...(limitation ? { limitation } : {}) });
  add('schema', bundle?.schema === 'kingmaker.ability-proposal/1', bundle?.schema ?? 'missing');
  add('integrity', sha(bundle.text ?? '') === bundle.sha256, 'sha256 of the proposed text matches the bundle');
  const flags = privacyScreen(bundle.text ?? ''); add('privacy-rescreen', flags.length === 0, flags.length ? flags.join(', ') : 'no flagged patterns', 'Pattern screen only: it cannot recognize all personal or proprietary content in prose.');
  add('rights', bundle.rights?.attested === true && ['own-work', 'licensed'].includes(bundle.rights?.source), JSON.stringify(bundle.rights ?? null), 'A rights statement is the proposer\'s assertion, not proof.');
  let spec = null; try { spec = parseMethodFile(bundle.text); add('parse', spec.id === bundle.id, `conductor parse ok, ${spec.steps.length} steps`); } catch (e) { add('parse', false, e.message); }
  try { const s = await scanLearningMethod(bundle.text); add('armor-lexical-scan', true, `verdict ${s.record.verdict}`, s.limitation); } catch (e) { add('armor-lexical-scan', false, e.message); }
  try {
    const { inspect } = await import('./rea.mjs');
    const box = mkdtempSync(join(tmpdir(), 'km-rea-')); writeFileSync(join(box, 'ability.method.md'), bundle.text);
    const r = inspect([box], { prose: true }); rmSync(box, { recursive: true, force: true });
    add('rea', r.verdict !== 'rejected', `REA verdict ${r.verdict} (${(r.findings ?? []).length} finding(s))`, 'Lexical rules for phone-home, credential reads, persistence and dynamic exec.');
  } catch (e) { add('rea', false, `REA unavailable: ${e.message}`); }
  checks.push({ name: 'little-brother', pass: null, detail: 'NOT APPLIED: Little Brother enriches embedded-endpoint findings via local OSINT datasets; it does not validate method files and is not wired into Kingmaker.', limitation: 'Not a validator for abilities.' });
  if (spec && checks.every((c) => c.pass !== false)) {
    const box = mkdtempSync(join(tmpdir(), 'km-ability-test-'));
    try {
      const store = join(box, 'store'); mkdirSync(store); mkdirSync(join(box, 'work'));
      writeFileSync(join(store, `${spec.id}.method.md`), bundle.text);
      writeFileSync(join(store, 'index.json'), JSON.stringify({ schema: METHODS_SCHEMA, methods: [{ id: spec.id, title: spec.title, domain: spec.domain, file: `${spec.id}.method.md`, quality: { tier: 'draft', score: 0, basis: 'under review' } }] }));
      const c = await createMethodConductor({ indexUrl: methodStoreIndexUrl(store), toolProvider: null }).conduct(spec.id, { workDir: join(box, 'work'), inputs: bundle.testInput ?? {}, reasoner, toolRunner });
      const v = c.trace.find((t) => t.type === 'verify');
      add('independent-test', c.status === 'completed' && v?.status === 'executed', `conduction ${c.status}${c.reason ? `: ${c.reason}` : ''}; verify ${v?.status ?? 'absent'}`, 'One isolated run on the proposer-supplied test input; not proof of general correctness.');
    } finally { rmSync(box, { recursive: true, force: true }); }
  } else add('independent-test', false, 'not run: an earlier check failed');
  const evidence = { schema: 'kingmaker.ability-evidence/1', id: bundle.id, version: bundle.version, sha256: bundle.sha256, reviewedAt: now().toISOString(), checks, passed: checks.every((c) => c.pass !== false) };
  return { ...evidence, digest: sha(canonical(evidence)) };
}

// ── approve / runtime / revoke (owner keys) ──────────────────────────────────────────────────────────────────────────
export function approveAbility({ bundle, evidence, ownerDir, now = () => new Date() }) {
  if (!evidence?.passed) throw new Error('ABILITY_NOT_APPROVABLE: the review evidence did not pass');
  if (evidence.sha256 !== bundle.sha256 || sha(bundle.text) !== bundle.sha256) throw new Error('ABILITY_EVIDENCE_MISMATCH');
  const priv = ownerKey(ownerDir, 'ability');
  const trust = JSON.parse(readFileSync(join(ownerDir, 'trust.json'), 'utf8'));
  return signed('kingmaker.ability-release/1', { schema: 'kingmaker.ability-release/1', role: ROLES.ability, keyId: trust.ability.keyId, id: bundle.id, version: bundle.version, sha256: bundle.sha256, text: bundle.text,
    rights: bundle.rights, dependencies: bundle.dependencies, evidenceDigest: evidence.digest, approvedAt: now().toISOString() }, priv);
}
export function approveRuntimeRelease({ manifestSha256, version, ownerDir, now = () => new Date() }) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error('RUNTIME_MANIFEST_HASH_REQUIRED');
  const trust = JSON.parse(readFileSync(join(ownerDir, 'trust.json'), 'utf8'));
  return signed('kingmaker.runtime-approval/1', { schema: 'kingmaker.runtime-approval/1', role: ROLES.runtime, keyId: trust.runtime.keyId, manifestSha256, version, approvedAt: now().toISOString() }, ownerKey(ownerDir, 'runtime'));
}
export function verifyRuntimeApproval(approval, trust) {
  const p = approval?.payload;
  return Boolean(p && p.schema === 'kingmaker.runtime-approval/1' && p.role === ROLES.runtime && p.keyId === trust.runtime.keyId && sigOk('kingmaker.runtime-approval/1', approval, trust.runtime.publicKeyPem));
}
export function revokeAbility({ id, version, reason, ownerDir, now = () => new Date() }) {
  const trust = JSON.parse(readFileSync(join(ownerDir, 'trust.json'), 'utf8'));
  return signed('kingmaker.ability-revocation/1', { schema: 'kingmaker.ability-revocation/1', role: ROLES.ability, keyId: trust.ability.keyId, id, version, reason, revokedAt: now().toISOString() }, ownerKey(ownerDir, 'ability'));
}

// ── accept (any install) ─────────────────────────────────────────────────────────────────────────────────────────────
const validRevocations = (revocations, trust) => (revocations ?? []).filter((r) => r?.payload?.schema === 'kingmaker.ability-revocation/1' && r.payload.role === ROLES.ability && r.payload.keyId === trust.ability.keyId && sigOk('kingmaker.ability-revocation/1', r, trust.ability.publicKeyPem));
export function fleetStore(state) { return join(state, 'fleet', 'abilities', 'methods'); }

export function acceptAbilityRelease({ state, release, revocations = [], now = () => new Date() }) {
  const trust = readTrust(state);
  const p = release?.payload;
  const refuse = (why) => ({ status: 'refused', reason: why });
  if (!p || p.schema !== 'kingmaker.ability-release/1') return refuse('not an ability release');
  if (p.role !== ROLES.ability || p.keyId !== trust.ability.keyId) return refuse('not signed by the pinned owner ability-approve key');
  if (!sigOk('kingmaker.ability-release/1', release, trust.ability.publicKeyPem)) return refuse('signature does not verify against the pinned owner key');
  if (sha(p.text) !== p.sha256) return refuse('text does not match its signed hash');
  let spec; try { spec = parseMethodFile(p.text); } catch (e) { return refuse(`does not parse: ${e.message}`); }
  if (spec.id !== p.id || spec.version !== p.version) return refuse('id/version mismatch');
  if (validRevocations(revocations, trust).some((r) => r.payload.id === p.id && r.payload.version === p.version)) return refuse('revoked by the owner');
  const store = fleetStore(state); mkdirSync(store, { recursive: true, mode: 0o700 });
  const file = `${p.id}.method.md`, path = join(store, file);
  if (existsSync(path)) copyFileSync(path, join(store, `${p.id}.prev.method.md`));
  writeFileSync(`${path}.tmp`, p.text, { mode: 0o600 }); renameSync(`${path}.tmp`, path);
  let prior = []; try { prior = normalizeMethodsIndex(JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))); } catch { prior = []; }
  writeFileSync(join(store, 'index.json'), JSON.stringify({ schema: METHODS_SCHEMA, methods: [...prior.filter((m) => m.id !== p.id), { id: p.id, title: spec.title, domain: spec.domain, file, quality: { tier: 'vetted', score: 70, basis: `owner-approved fleet ability ${p.version}, approved ${p.approvedAt}` } }] }, null, 2));
  appendFileSync(join(state, 'fleet', 'accepted.jsonl'), `${JSON.stringify({ at: now().toISOString(), id: p.id, version: p.version, sha256: p.sha256, keyId: p.keyId, evidenceDigest: p.evidenceDigest })}\n`);
  return { status: 'accepted', id: p.id, version: p.version, path };
}

/** Apply owner-signed revocations: a revoked installed ability is moved to quarantine and leaves the index. */
export function applyRevocations({ state, revocations }) {
  const trust = readTrust(state); const store = fleetStore(state);
  const out = [];
  for (const r of validRevocations(revocations, trust)) {
    let idx; try { idx = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8')); } catch { continue; }
    if (!idx.methods.some((m) => m.id === r.payload.id)) continue;
    const q = join(state, 'fleet', 'quarantine'); mkdirSync(q, { recursive: true, mode: 0o700 });
    const f = join(store, `${r.payload.id}.method.md`); if (existsSync(f)) renameSync(f, join(q, `${r.payload.id}-${r.payload.version}.method.md`));
    idx.methods = idx.methods.filter((m) => m.id !== r.payload.id); writeFileSync(join(store, 'index.json'), JSON.stringify(idx, null, 2));
    out.push({ id: r.payload.id, version: r.payload.version, quarantined: true, reason: r.payload.reason });
  }
  return out;
}
