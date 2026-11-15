import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triageCandidate } from '../lib/model-triage.mjs';
const c = JSON.parse(readFileSync(new URL('../catalog/model-candidates/inkling-2-small.json', import.meta.url)));
test('Inkling candidate records a model, not image/video generation or an admitted runtime', () => {
 assert.deepEqual(c.outputModalities, ['text']);
 assert.equal(c.admission.enabled, false);
 assert.equal(c.admission.weightsDownloaded, false);
 assert.equal(c.admission.inferenceVerified, false);
 assert.equal(c.publishedHash, '');
 assert.equal(c.provenance.artifactHashesVerified, false);
});
test('existing local admission rejects oversized checkpoint without rejecting Apache license', () => {
 const result = triageCandidate(c, { pinnedHashes:new Map(), knownPublishers:new Set(), flaggedPublishers:new Set(), libraryDedupKeys:new Set() });
 assert.equal(result.verdict,'reject');
 assert.equal(result.findings.find(x=>x.check==='size').verdict,'reject');
 assert.equal(result.findings.find(x=>x.check==='license').verdict,'pass');
 assert.equal(result.findings.find(x=>x.check==='hash').verdict,'flag');
});
