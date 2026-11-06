// The review path used by the build: the shipped upload lane's analysis
// (review-worker.mjs: scanSourceText/pack scan + REA inspect over a staged
// copy) run inside a disposable workspace that is destroyed in a finally
// on every exit — the sandbox-review.mjs lifecycle pattern [INV §6b]. The
// shipped Seatbelt wrapper is darwin-only and refuses off-darwin, so in
// this VM the workspace lifecycle is the harness's and the analysis is the
// product's own code. B1 collection hooks here: the file-review record is
// emitted to the ledger BEFORE the finally destruction runs (SPEC §3.1) —
// testimony leaves before the door closes; the original is never touched
// (A3) and the staged copy never survives (A4's rule for contents).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateText } from './shield-eval.mjs';
import { emitFileReview } from './shield-ledger.mjs';

export const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Review one artifact (bytes + name) under a configuration.
// opts.ledgerIdentityDir: when set, the file-review record is retained in
// the ledger before destruction (B1). Returns the outcome + record +
// isolation evidence (workspace path + destroyed flag).
export function reviewArtifact(bytes, name, config, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-review-'));
  fs.chmodSync(root, 0o700);
  const input = path.join(root, 'upload');
  let result;
  try {
    fs.writeFileSync(input, bytes, { mode: 0o400, flag: 'wx' });
    const text = bytes.toString('utf8');
    const targetSha = sha256hex(bytes);
    const ev = evaluateText(text, name, targetSha, config);
    const findings = [];
    for (const f of ev.scan.findings) {
      if (findings.length >= 100) break;
      findings.push({ rule: f.rule, severity: f.severity, title: f.rule.replace(/[-_]+/g, ' '),
        basis: f.basis, location: f.location, detail: f.detail, ...(f.excerpt != null ? { excerpt: f.excerpt } : {}) });
    }
    for (const f of [...ev.reaFindings, ...ev.genFindings]) {
      if (findings.length >= 100) break;
      findings.push({ rule: f.rule, severity: f.severity === 'reject' ? 'high' : 'medium',
        title: f.rule.replace(/[-_]+/g, ' '), basis: 'rea', location: `${name}:${f.line}`,
        detail: f.why || '', excerpt: f.code, generated_rule: !!f.generated });
    }
    const record = {
      schema: 'scripture-armor.file-review/1', contentSha256: targetSha,
      format: 'text', kind: 'source', status: 'reviewed_static', limitations: [],
      findings, activeContent: ev.scan.counts.critical + ev.scan.counts.high > 0,
      entries: null, rea: { verdict: ev.outcome.reaVerdict },
      verdict: ev.outcome.verdict, stopped: ev.outcome.stopped, sandboxed: ev.outcome.sandboxed,
      commandAuthority: false, targetExecuted: false,
    };
    if (opts.ledgerIdentityDir) emitFileReview(opts.ledgerIdentityDir, record, targetSha);
    result = { record, outcome: ev.outcome, scan: ev.scan, reaFindings: ev.reaFindings, genFindings: ev.genFindings,
               isolation: { workspace: root, originalRemoved: false } };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  result.isolation.workspaceDestroyedOnReturn = !fs.existsSync(root);
  result.isolation.nextReview = 'fresh-workspace';
  return result;
}
