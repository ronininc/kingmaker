import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBinaryFindings } from '../scan.mjs';
const withStore = (fn) => { const dir = mkdtempSync(join(tmpdir(), 'armor-confidence-')); try { fn(dir); } finally { rmSync(dir, { recursive: true }); } };
const observed = { functions_count: 4, imports: [], call_paths: [], sections: [], call_sites: [], coverage: { paths_total: 0, paths_omitted: 0, sites_total: 0, sites_omitted: 0, decompile_eligible: 1, decompile_omitted: 0 }, decompile: { attempted: 1, failed: 0 } };
test('even one missing native decompilation limits confidence', () => withStore(dir => {
 const r = normalizeBinaryFindings({ ...observed, decompile: { attempted: 1, failed: 1 } }, '0'.repeat(64), dir);
 assert.equal(r.confidence, 'low'); assert.ok(r.findings.some(f => f.rule === 'static-analysis-limited'));
}));
test('a small failure rate cannot conceal incomplete analysis', () => withStore(dir => {
 assert.equal(normalizeBinaryFindings({ ...observed, decompile: { attempted: 24, failed: 1 } }, '0'.repeat(64), dir).confidence, 'low');
}));
test('zero-function or absent analysis cannot receive full confidence', () => withStore(dir => {
 for (const functions_count of [0, undefined]) assert.equal(normalizeBinaryFindings({ ...observed, functions_count }, '0'.repeat(64), dir).confidence, 'low');
}));
test('complete observations retain full confidence without suppressing findings', () => withStore(dir => {
 const r = normalizeBinaryFindings(observed, '0'.repeat(64), dir); assert.equal(r.confidence, 'full');
 assert.equal(r.findings.some(f => f.rule === 'static-analysis-limited'), false);
}));
