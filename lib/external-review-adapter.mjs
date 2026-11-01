import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const EXTERNAL_REVIEW_ADAPTER = 'little-brother-local-static-review';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ALLOWED_METHODS = new Set(['static-source-review', 'mocked-transport-credential-routing']);
const boundedStrings = (v, max, len = 300) => Array.isArray(v) && v.length > 0 && v.length <= max
  && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= len);
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');

export function validateExternalReviewManifest(manifest, { allowedRoots = [], inspectSource } = {}) {
  if (!manifest || manifest.schema !== 'ronin.external-review.job/v1') throw new Error('EXTERNAL_REVIEW_SCHEMA');
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(String(manifest.uniqueJobId ?? ''))) throw new Error('EXTERNAL_REVIEW_JOB_ID');
  if (manifest.executionMode !== 'local-static-source-review') throw new Error('EXTERNAL_REVIEW_MODE');
  const p = manifest.program || {}, s = manifest.source || {}, scope = manifest.scope || {}, policy = manifest.policy || {}, eligibility = manifest.eligibility || {};
  if (!p.name || !/^https:\/\//.test(String(p.rulesUrl)) || !SHA256.test(String(p.rulesSha256))) throw new Error('EXTERNAL_REVIEW_RULES');
  if (!/^https:\/\//.test(String(s.repositoryUrl)) || !COMMIT.test(String(s.commit)) || !isAbsolute(String(s.localPath ?? ''))) throw new Error('EXTERNAL_REVIEW_SOURCE');
  if (!boundedStrings(scope.assets, 100) || !boundedStrings(scope.methods, 20) || !Array.isArray(scope.exclusions)) throw new Error('EXTERNAL_REVIEW_SCOPE');
  if (!scope.methods.every((m) => ALLOWED_METHODS.has(m))) throw new Error('EXTERNAL_REVIEW_METHOD_REFUSED');
  if (policy.network !== false || policy.credentials !== 'fake-only' || policy.submission !== 'owner-approval-required'
    || !['allowed', 'prohibited'].includes(policy.aiAnalysis)) throw new Error('EXTERNAL_REVIEW_POLICY');
  if (eligibility.state !== 'verified' || eligibility.approvalState !== 'approved-for-local-review') throw new Error('EXTERNAL_REVIEW_NOT_APPROVED');
  if ('commands' in manifest || 'command' in manifest || 'token' in manifest || 'credentials' in manifest) throw new Error('EXTERNAL_REVIEW_FORBIDDEN_INPUT');
  const actual = realpathSync(s.localPath), st = lstatSync(actual);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('EXTERNAL_REVIEW_SOURCE_UNSAFE');
  const root = allowedRoots.map((x) => realpathSync(x)).find((x) => { const r = relative(x, actual); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); });
  if (!root) throw new Error('EXTERNAL_REVIEW_SOURCE_OUTSIDE_ROOT');
  const source = typeof inspectSource === 'function' ? inspectSource(actual) : null;
  if (!source || source.repositoryUrl !== s.repositoryUrl || source.commit !== s.commit || source.clean !== true) throw new Error('EXTERNAL_REVIEW_SOURCE_MISMATCH');
  return { manifest: structuredClone(manifest), sourceRoot: actual, manifestSha256: sha(manifest) };
}

/**
 * Local-only adapter. It performs no network, shell, credential, scanning, or
 * submission operation. The injected analyzer receives an already validated
 * immutable manifest and local source root; its output is always held for an
 * independent owner-approved review.
 */
export function createLocalStaticReviewAdapter({ allowedRoots, inspectSource, analyze, auditAppend = () => {} } = {}) {
  if (typeof analyze !== 'function') throw new Error('EXTERNAL_REVIEW_ANALYZER_REQUIRED');
  return async ({ id, text, attempt }) => {
    let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('EXTERNAL_REVIEW_JSON'); }
    const checked = validateExternalReviewManifest(parsed, { allowedRoots, inspectSource });
    if (checked.manifest.uniqueJobId !== id) throw new Error('EXTERNAL_REVIEW_QUEUE_ID_MISMATCH');
    const auditId = `extreview:${sha(`${id}:${checked.manifestSha256}`).slice(0, 32)}`;
    auditAppend({ event: 'external_review_started', auditId, jobId: id, manifestSha256: checked.manifestSha256, attempt });
    const result = await analyze({ manifest: checked.manifest, sourceRoot: checked.sourceRoot, network: false, credentials: 'fake-only' });
    const findings = Array.isArray(result?.findings) ? result.findings.slice(0, 200).map((f) => ({
      title: String(f?.title ?? '').slice(0, 200), severity: String(f?.severity ?? 'unknown').slice(0, 40),
      evidence: String(f?.evidence ?? '').slice(0, 2000), file: String(f?.file ?? '').slice(0, 500),
    })) : [];
    const evidence = { kind: 'external-static-review', productionReady: false, executionMode: 'local-static-source-review',
      auditId, manifestSha256: checked.manifestSha256, source: { repositoryUrl: checked.manifest.source.repositoryUrl, commit: checked.manifest.source.commit },
      methods: checked.manifest.scope.methods, findings, analyzerEvidence: result?.evidence ?? null,
      reviewRequired: true, submissionAllowed: false, networkUsed: false, credentialsUsed: 'fake-only' };
    auditAppend({ event: 'external_review_evidence', auditId, jobId: id, evidenceSha256: sha(evidence), reviewRequired: true });
    return evidence;
  };
}
