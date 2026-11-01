import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

export const EXTERNAL_REVIEW_ADAPTER = 'little-brother-local-static-review';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_METHODS = new Set(['offline source review', 'mocked transport tests']);
const clean = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
const list = (v) => Array.isArray(v) ? [...new Set(v.map((x) => clean(x, 500)).filter(Boolean))].sort((a, b) => a.localeCompare(b)) : [];
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');

/** Equivalent to CRM worker/external-security-jobs.ts normalization. */
export function normalizeExternalSecurityManifest(v = {}) {
  const m = { schema: 'ronin.external-security-scope/v1', program: clean(v.program, 200), officialRulesUrl: clean(v.officialRulesUrl, 2000), rulesVersion: clean(v.rulesVersion, 200), repositoryUrl: clean(v.repositoryUrl, 2000), commitSha: clean(v.commitSha, 64).toLowerCase(), includedAssets: list(v.includedAssets), excludedAssets: list(v.excludedAssets), allowedMethods: list(v.allowedMethods), prohibitedMethods: list(v.prohibitedMethods), aiPolicy: clean(v.aiPolicy, 2000), credentialPolicy: clean(v.credentialPolicy, 2000), submissionPolicy: clean(v.submissionPolicy, 2000), safeHarbor: clean(v.safeHarbor, 4000) };
  if (v.schema !== m.schema || !m.program || !/^https:\/\//.test(m.officialRulesUrl) || !/^https:\/\//.test(m.repositoryUrl) || !m.rulesVersion || !COMMIT.test(m.commitSha) || !m.includedAssets.length || !m.allowedMethods.length || !m.aiPolicy || !m.credentialPolicy || !m.submissionPolicy || !m.safeHarbor) throw new Error('EXTERNAL_SCOPE_INCOMPLETE');
  return m;
}
export function externalSecurityManifestSha256(v) { return sha(normalizeExternalSecurityManifest(v)); }

export function validateExternalReviewManifest(input, { allowedRoots = [], inspectSource } = {}) {
  if (!input || input.schema !== 'ronin.external-security-local-dispatch/v1') throw new Error('EXTERNAL_REVIEW_DISPATCH_SCHEMA');
  if (!JOB_ID.test(String(input.externalJobId ?? '')) || !JOB_ID.test(String(input.boardJobId ?? ''))) throw new Error('EXTERNAL_REVIEW_JOB_ID');
  if (input.state !== 'eligible' || input.hold !== 'released' || input.ownerApproval?.decision !== 'approved-for-local-review' || !input.ownerApproval?.approvedBy || !input.ownerApproval?.approvedAt) throw new Error('EXTERNAL_REVIEW_NOT_APPROVED');
  if (input.execution?.mode !== 'local-static-source-review' || input.execution?.network !== false || input.execution?.credentials !== 'fake-only' || input.execution?.submission !== 'owner-approval-required') throw new Error('EXTERNAL_REVIEW_POLICY');
  if ('commands' in input || 'command' in input || 'token' in input || 'credentials' in input) throw new Error('EXTERNAL_REVIEW_FORBIDDEN_INPUT');
  const manifest = normalizeExternalSecurityManifest(input.manifest), manifestSha256 = sha(manifest);
  if (!SHA256.test(String(input.manifestSha256 ?? '')) || input.manifestSha256 !== manifestSha256) throw new Error('EXTERNAL_REVIEW_MANIFEST_DIGEST');
  if (!manifest.allowedMethods.every((m) => ALLOWED_METHODS.has(m))) throw new Error('EXTERNAL_REVIEW_METHOD_REFUSED');
  if (!manifest.prohibitedMethods.some((x) => /live credential/i.test(x)) || !manifest.prohibitedMethods.some((x) => /production prob/i.test(x)) || !/independent verification/i.test(manifest.aiPolicy) || !/(synthetic|fake).*(mock|only)|mock.*only/i.test(manifest.credentialPolicy) || !/owner review.*required/i.test(manifest.submissionPolicy) || /pending|cannot authorize/i.test(manifest.safeHarbor)) throw new Error('EXTERNAL_REVIEW_POLICY');
  const localPath = input.execution?.localSourcePath;
  if (!isAbsolute(String(localPath ?? ''))) throw new Error('EXTERNAL_REVIEW_SOURCE');
  const actual = realpathSync(localPath), st = lstatSync(actual);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('EXTERNAL_REVIEW_SOURCE_UNSAFE');
  const root = allowedRoots.map((x) => realpathSync(x)).find((x) => { const r = relative(x, actual); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); });
  if (!root) throw new Error('EXTERNAL_REVIEW_SOURCE_OUTSIDE_ROOT');
  const source = typeof inspectSource === 'function' ? inspectSource(actual) : null;
  if (!source || source.repositoryUrl !== manifest.repositoryUrl || source.commit !== manifest.commitSha || source.clean !== true) throw new Error('EXTERNAL_REVIEW_SOURCE_MISMATCH');
  return { input: structuredClone(input), manifest, sourceRoot: actual, manifestSha256 };
}

/** Local-only adapter: no network, shell, live credentials, scans, or submissions. */
export function createLocalStaticReviewAdapter({ allowedRoots, inspectSource, analyze, auditAppend = () => {} } = {}) {
  if (typeof analyze !== 'function') throw new Error('EXTERNAL_REVIEW_ANALYZER_REQUIRED');
  return async ({ id, text, attempt }) => {
    let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('EXTERNAL_REVIEW_JSON'); }
    const checked = validateExternalReviewManifest(parsed, { allowedRoots, inspectSource });
    if (checked.input.externalJobId !== id) throw new Error('EXTERNAL_REVIEW_QUEUE_ID_MISMATCH');
    const auditId = `extreview:${sha(`${id}:${checked.manifestSha256}`).slice(0, 32)}`;
    auditAppend({ event: 'external_review_started', auditId, jobId: id, boardJobId: checked.input.boardJobId, manifestSha256: checked.manifestSha256, attempt });
    const result = await analyze({ manifest: checked.manifest, sourceRoot: checked.sourceRoot, network: false, credentials: 'fake-only' });
    const findings = Array.isArray(result?.findings) ? result.findings.slice(0, 200).map((f) => ({ title: String(f?.title ?? '').slice(0, 200), severity: String(f?.severity ?? 'unknown').slice(0, 40), evidence: String(f?.evidence ?? '').slice(0, 2000), file: String(f?.file ?? '').slice(0, 500) })) : [];
    const evidence = { kind: 'external-static-review', productionReady: false, executionMode: 'local-static-source-review', auditId, externalJobId: id, boardJobId: checked.input.boardJobId, manifestSha256: checked.manifestSha256, source: { repositoryUrl: checked.manifest.repositoryUrl, commit: checked.manifest.commitSha }, methods: checked.manifest.allowedMethods, findings, analyzerEvidence: result?.evidence ?? null, reviewRequired: true, submissionAllowed: false, networkUsed: false, credentialsUsed: 'fake-only' };
    auditAppend({ event: 'external_review_evidence', auditId, jobId: id, evidenceSha256: sha(evidence), reviewRequired: true });
    return evidence;
  };
}
