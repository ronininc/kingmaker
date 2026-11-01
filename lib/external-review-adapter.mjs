import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { runBuiltinStaticInventory } from './builtin-static-analyzer.mjs';

export const EXTERNAL_REVIEW_ADAPTER = 'little-brother-local-static-review';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_METHODS = new Set(['offline source review', 'mocked transport tests']);
const clean = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
const list = (v) => Array.isArray(v) ? [...new Set(v.map((x) => clean(x, 500)).filter(Boolean))].sort() : [];
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');

/** Equivalent to CRM worker/external-security-jobs.ts normalization. */
export function normalizeExternalSecurityManifest(v = {}) {
  const m = { schema: 'ronin.external-security-scope/v1', program: clean(v.program, 200), officialRulesUrl: clean(v.officialRulesUrl, 2000), rulesVersion: clean(v.rulesVersion, 200), repositoryUrl: clean(v.repositoryUrl, 2000), commitSha: clean(v.commitSha, 64).toLowerCase(), includedAssets: list(v.includedAssets), excludedAssets: list(v.excludedAssets), allowedMethods: list(v.allowedMethods), prohibitedMethods: list(v.prohibitedMethods), aiPolicy: clean(v.aiPolicy, 2000), credentialPolicy: clean(v.credentialPolicy, 2000), submissionPolicy: clean(v.submissionPolicy, 2000), safeHarbor: clean(v.safeHarbor, 4000), rulesSnapshotDigest: SHA256.test(clean(v.rulesSnapshotDigest, 64)) ? clean(v.rulesSnapshotDigest, 64) : '' };
  if (v.schema !== m.schema || !m.program || !/^https:\/\//.test(m.officialRulesUrl) || !/^https:\/\//.test(m.repositoryUrl) || !m.rulesVersion || !COMMIT.test(m.commitSha) || !m.includedAssets.length || !m.allowedMethods.length || !m.aiPolicy || !m.credentialPolicy || !m.submissionPolicy || !m.safeHarbor) throw new Error('EXTERNAL_SCOPE_INCOMPLETE');
  return m;
}
export function externalSecurityManifestSha256(v) { return sha(normalizeExternalSecurityManifest(v)); }

const dispatchBytes = (receipt) => Buffer.from(JSON.stringify(receipt, Object.keys(receipt).sort()));
export function createExternalDispatchReceiptVerifier({ authorities = {}, executorRegistration, now = () => Date.now(), admissionStore, authorityStatus, executorStatus, attemptStatus } = {}) {
  if (!executorRegistration?.id || !SHA256.test(String(executorRegistration.fingerprint ?? '')) || typeof admissionStore?.admit !== 'function' || typeof admissionStore?.complete !== 'function' || typeof authorityStatus !== 'function' || typeof executorStatus !== 'function' || typeof attemptStatus !== 'function') throw new Error('EXTERNAL_DISPATCH_TRUST_CONFIG_REQUIRED');
  return async (envelope, expected) => {
    const r = envelope?.receipt, s = envelope?.signature;
    if (!r || !s || r.schema !== 'ronin.external-security-dispatch/v1' || !s.keyId || !s.value) throw new Error('EXTERNAL_DISPATCH_FORMAT');
    const configured = authorities[s.keyId];
    if (!configured?.publicJwk) throw new Error('EXTERNAL_DISPATCH_UNKNOWN_AUTHORITY');
    const authority = await authorityStatus(s.keyId), executor = await executorStatus(r.executorRegistrationId);
    const nowSec = Math.floor(now() / 1000);
    if (authority?.active !== true || authority.revoked === true || authority.expiresAt != null && authority.expiresAt <= nowSec || executor?.active !== true || executor.revoked === true) throw new Error('EXTERNAL_DISPATCH_REVOKED');
    const valid = verifySignature(null, dispatchBytes(r), createPublicKey({ key: configured.publicJwk, format: 'jwk' }), Buffer.from(s.value, 'base64url'));
    if (!valid) throw new Error('EXTERNAL_DISPATCH_SIGNATURE');
    if (!Number.isSafeInteger(r.issuedAt) || !Number.isSafeInteger(r.leaseExpiresAt) || r.issuedAt > nowSec + 30 || r.leaseExpiresAt <= nowSec || r.leaseExpiresAt - r.issuedAt > 900 || r.leaseExpiresAt <= r.issuedAt) throw new Error('EXTERNAL_DISPATCH_STALE');
    if (!/^[A-Za-z0-9_-]{24,160}$/.test(String(r.nonce ?? '')) || !r.attemptId) throw new Error('EXTERNAL_DISPATCH_NONCE');
    const leaseToken = String(envelope.lease_token ?? '');
    if (!leaseToken || !SHA256.test(String(r.leaseTokenHash ?? '')) || sha(leaseToken) !== r.leaseTokenHash) throw new Error('EXTERNAL_DISPATCH_LEASE_TOKEN');
    if (r.jobId !== expected.externalJobId || r.nativeOpportunityId !== expected.nativeOpportunityId || r.manifestDigest !== expected.manifestSha256 || r.rulesSnapshotDigest !== expected.rulesSnapshotDigest || r.sourceCommit !== expected.commitSha || r.executorRegistrationId !== executorRegistration.id || r.executorFingerprint !== executorRegistration.fingerprint) throw new Error('EXTERNAL_DISPATCH_BINDING');
    const current = await attemptStatus(r.attemptId);
    if (!current || current.status !== 'queued' || current.jobId !== r.jobId || current.manifestSha256 !== r.manifestDigest || current.executorId !== r.executorRegistrationId || current.leaseTokenHash !== r.leaseTokenHash || current.leaseExpiresAt !== r.leaseExpiresAt || current.nonce !== r.nonce || current.dispatchKeyId !== s.keyId) throw new Error('EXTERNAL_DISPATCH_ATTEMPT_CHANGED');
    const receiptSha256 = sha(canonical({ receipt: r, signature: s, leaseTokenHash: r.leaseTokenHash }));
    const admission = admissionStore.admit({ keyId: s.keyId, nonce: r.nonce, attemptId: r.attemptId, jobId: r.jobId, receiptSha256 });
    return { authorized: true, receiptId: `${s.keyId}:${r.nonce}`, attemptId: r.attemptId, authorityKeyId: s.keyId, completedEvidence: admission.status === 'completed' ? admission.evidence : null,
      completeAdmission: (evidence) => admissionStore.complete({ keyId: s.keyId, nonce: r.nonce, attemptId: r.attemptId, jobId: r.jobId, receiptSha256, evidence }) };
  };
}

export function validateExternalReviewManifest(input, { allowedRoots = [], inspectSource } = {}) {
  if (!input || input.schema !== 'ronin.external-security-local-dispatch/v1') throw new Error('EXTERNAL_REVIEW_DISPATCH_SCHEMA');
  if (!JOB_ID.test(String(input.externalJobId ?? '')) || !JOB_ID.test(String(input.boardJobId ?? '')) || !JOB_ID.test(String(input.nativeOpportunityId ?? ''))) throw new Error('EXTERNAL_REVIEW_JOB_ID');
  if (!input.dispatchReceipt || typeof input.dispatchReceipt !== 'object') throw new Error('EXTERNAL_REVIEW_SIGNED_RECEIPT_REQUIRED');
  if (input.execution?.mode !== 'local-static-source-review' || input.execution?.network !== false || input.execution?.credentials !== 'fake-only' || input.execution?.submission !== 'owner-approval-required') throw new Error('EXTERNAL_REVIEW_POLICY');
  if ('commands' in input || 'command' in input || 'token' in input || 'credentials' in input) throw new Error('EXTERNAL_REVIEW_FORBIDDEN_INPUT');
  const manifest = normalizeExternalSecurityManifest(input.manifest), manifestSha256 = sha(manifest);
  if (!SHA256.test(manifest.rulesSnapshotDigest)) throw new Error('EXTERNAL_REVIEW_RULES_SNAPSHOT_REQUIRED');
  if (!SHA256.test(String(input.manifestSha256 ?? '')) || input.manifestSha256 !== manifestSha256) throw new Error('EXTERNAL_REVIEW_MANIFEST_DIGEST');
  if (!manifest.allowedMethods.every((m) => ALLOWED_METHODS.has(m))) throw new Error('EXTERNAL_REVIEW_METHOD_REFUSED');
  if (!manifest.prohibitedMethods.some((x) => /live credential/i.test(x)) || !manifest.prohibitedMethods.some((x) => /production prob/i.test(x)) || !/independent verification/i.test(manifest.aiPolicy) || !/(synthetic|fake).*(mock|only)|mock.*only/i.test(manifest.credentialPolicy) || !/owner review.*required/i.test(manifest.submissionPolicy) || /pending|cannot authorize/i.test(manifest.safeHarbor)) throw new Error('EXTERNAL_REVIEW_POLICY');
  const localPath = input.execution?.localSourcePath;
  if (!isAbsolute(String(localPath ?? ''))) throw new Error('EXTERNAL_REVIEW_SOURCE');
  const original = lstatSync(localPath);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('EXTERNAL_REVIEW_SOURCE_UNSAFE');
  const actual = realpathSync(localPath), st = lstatSync(actual);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('EXTERNAL_REVIEW_SOURCE_UNSAFE');
  const root = allowedRoots.map((x) => realpathSync(x)).find((x) => { const r = relative(x, actual); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); });
  if (!root) throw new Error('EXTERNAL_REVIEW_SOURCE_OUTSIDE_ROOT');
  const source = typeof inspectSource === 'function' ? inspectSource(actual) : null;
  if (!source || source.repositoryUrl !== manifest.repositoryUrl || source.commit !== manifest.commitSha || source.clean !== true
    || source.immutableSnapshot !== true || !SHA256.test(String(source.treeSha256 ?? '')) || !source.snapshotId || !Array.isArray(source.trackedFiles) || !source.trackedFiles.length || source.trackedFiles.length > 5000) throw new Error('EXTERNAL_REVIEW_SOURCE_MISMATCH');
  return { input: structuredClone(input), manifest, sourceRoot: actual, sourceIdentity: { dev: st.dev, ino: st.ino, treeSha256: source.treeSha256, snapshotId: source.snapshotId, trackedFiles: structuredClone(source.trackedFiles) }, manifestSha256 };
}

/** Local-only adapter: no network, shell, live credentials, scans, or submissions. */
export function createLocalStaticReviewAdapter({ allowedRoots, inspectSource, verifyDispatchReceipt } = {}) {
  if (typeof verifyDispatchReceipt !== 'function') throw new Error('EXTERNAL_REVIEW_TRUST_CONFIG_REQUIRED');
  return async ({ id, text, attempt, signal }) => {
    let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('EXTERNAL_REVIEW_JSON'); }
    const checked = validateExternalReviewManifest(parsed, { allowedRoots, inspectSource });
    if (checked.input.externalJobId !== id) throw new Error('EXTERNAL_REVIEW_QUEUE_ID_MISMATCH');
    const authorization = await verifyDispatchReceipt(checked.input.dispatchReceipt, { externalJobId: id, boardJobId: checked.input.boardJobId, nativeOpportunityId: checked.input.nativeOpportunityId, manifestSha256: checked.manifestSha256, rulesSnapshotDigest: checked.manifest.rulesSnapshotDigest, repositoryUrl: checked.manifest.repositoryUrl, commitSha: checked.manifest.commitSha, adapter: EXTERNAL_REVIEW_ADAPTER, attempt });
    if (!authorization?.authorized || !authorization.receiptId || !authorization.attemptId || !authorization.authorityKeyId) throw new Error('EXTERNAL_REVIEW_RECEIPT_REFUSED');
    if (authorization.completedEvidence) return authorization.completedEvidence;
    if (typeof authorization.completeAdmission !== 'function') throw new Error('EXTERNAL_REVIEW_ADMISSION_COMPLETION_REQUIRED');
    const auditId = `extreview:${sha(`${id}:${checked.manifestSha256}`).slice(0, 32)}`;
    const result = await runBuiltinStaticInventory({ sourceRoot: checked.sourceRoot, sourceTreeSha256: checked.sourceIdentity.treeSha256, trackedFiles: checked.sourceIdentity.trackedFiles, signal });
    const attestation = result.attestation;
    const afterSt = lstatSync(checked.sourceRoot), after = inspectSource(checked.sourceRoot);
    if (afterSt.dev !== checked.sourceIdentity.dev || afterSt.ino !== checked.sourceIdentity.ino || after?.treeSha256 !== checked.sourceIdentity.treeSha256 || after?.snapshotId !== checked.sourceIdentity.snapshotId || after?.clean !== true || JSON.stringify(after?.trackedFiles)!==JSON.stringify(checked.sourceIdentity.trackedFiles)) throw new Error('EXTERNAL_REVIEW_SOURCE_CHANGED');
    const findings = Array.isArray(result?.findings) ? result.findings.slice(0, 200).map((f) => ({ title: String(f?.title ?? '').slice(0, 200), severity: String(f?.severity ?? 'unknown').slice(0, 40), evidence: String(f?.evidence ?? '').slice(0, 2000), file: String(f?.file ?? '').slice(0, 500) })) : [];
    const analyzerEvidence = result?.evidence == null ? null : structuredClone(result.evidence);
    if (JSON.stringify(analyzerEvidence).length > 32_768) throw new Error('EXTERNAL_REVIEW_EVIDENCE_TOO_LARGE');
    const evidence = { kind: 'external-static-inventory', productionReady: false, executionMode: 'bounded-read-only-source-inventory', auditId, externalJobId: id, boardJobId: checked.input.boardJobId, receiptId: authorization.receiptId, attemptId: authorization.attemptId, manifestSha256: checked.manifestSha256, source: { repositoryUrl: checked.manifest.repositoryUrl, commit: checked.manifest.commitSha, treeSha256: checked.sourceIdentity.treeSha256 }, methods: ['verified tracked-file inventory'], findings, analyzerEvidence, reviewRequired: true, submissionAllowed: false, targetCodeExecuted: false, vulnerabilityDiscoveryClaimed: false, networkIsolation: 'not-os-enforced', contentReadForHashing: true, contentExported: false, secretPresence: 'unknown', coverage: 'verified-tracked-file-manifest-only' };
    return authorization.completeAdmission(evidence);
  };
}
