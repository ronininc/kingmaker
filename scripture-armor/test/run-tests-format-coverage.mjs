// run-tests-format-coverage.mjs — ITEM 9 + ITEM 10 part tests
// (remainder run 2026-11-04, work copy only).
// Synthetic fixtures are generated in a temp dir; nothing executes
// fixture content. Run: node test/run-tests-format-coverage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { inspectBuffer, detectFormat } from '../format-inspect.mjs';
import { createArmorLittleBrother, extractIndicators } from '../littlebrother-integration.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
}
const has = (rec, rule) => rec.findings.some((f) => f.rule === rule);

// ---- fixture builders -------------------------------------------------
function buildPdf({ encrypted = false, js = false } = {}) {
  const stream = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (hello world) Tj ET'));
  let s = '%PDF-1.7\n';
  s += '1 0 obj<</Type/Catalog/Pages 2 0 R' + (js ? '/OpenAction[3 0 R]/Names<</JavaScript 4 0 R>>' : '') + '>>endobj\n';
  s += '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n';
  s += '3 0 obj<</Type/Page/Parent 2 0 R' + (js ? '/AA<</O 4 0 R>>' : '') + '>>endobj\n';
  if (js) s += '4 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj\n';
  if (encrypted) s += 'trailer<</Encrypt 9 0 R>>\n';
  const body = Buffer.from(s, 'latin1');
  const streamPart = Buffer.concat([Buffer.from('5 0 obj<</Length ' + stream.length + '/Filter/FlateDecode>>stream\n', 'latin1'), stream, Buffer.from('\nendstream endobj\n', 'latin1')]);
  return Buffer.concat([body, streamPart]);
}
function zipEntry(name, data, { encrypted = false } = {}) {
  const nb = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(encrypted ? 1 : 0, 6);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nb.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(encrypted ? 1 : 0, 8);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nb.length, 28);
  return { local: Buffer.concat([local, nb, data]), central: Buffer.concat([central, nb]), size: data.length };
}
function buildZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) { const z = zipEntry(e.name, e.data, e); locals.push(z.local); centrals.push(z.central); off += z.local.length; }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
function buildTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 'utf8');
    h.write(e.data.length.toString(8).padStart(11, '0'), 124, 'ascii');
    h.write('0', 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    blocks.push(h, e.data, Buffer.alloc(Math.ceil(e.data.length / 512) * 512 - e.data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
function buildPng(trailing = Buffer.alloc(0)) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); };
  return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Comment\0synthetic fixture')), chunk('IEND', Buffer.alloc(0)), trailing]);
}
function buildJpeg(trailing = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(8), Buffer.from([0xff, 0xd9]), trailing]);
}

// ---- ITEM 9: format coverage ------------------------------------------
{
  const rec = inspectBuffer(buildPdf(), 'plain.pdf');
  check('pdf: detected + document class', rec.target_class === 'document' && rec.coverage.format === 'pdf');
  check('pdf: structure inspection level named', rec.coverage.inspection === 'structure+text-layer');
  check('pdf: not unsupported, verdict pass', rec.verdict === 'pass' && !rec.coverage.unsupported);
}
{
  const rec = inspectBuffer(buildPdf({ js: true }), 'active.pdf');
  check('pdf+JS: javascript finding (high)', has(rec, 'pdf-javascript'));
  check('pdf+JS: open-action finding', has(rec, 'pdf-open-action'));
  check('pdf+JS: verdict warn', rec.verdict === 'warn');
}
{
  const rec = inspectBuffer(buildPdf({ encrypted: true }), 'locked.pdf');
  check('pdf encrypted: EXPLICITLY unsupported', rec.verdict === 'unsupported' && rec.coverage.unsupported === true);
  check('pdf encrypted: named reason', /encrypted/.test(rec.coverage.unsupported_reason));
}
{
  const zip = buildZip([
    { name: 'readme.txt', data: Buffer.from('hello') },
    { name: 'payload.exe', data: Buffer.from('MZ fake') },
    { name: 'doc.xlsm/vbaProject.bin', data: Buffer.from('macro') },
    { name: 'inner.zip', data: Buffer.from('PK fake') },
    { name: 'secret.txt', data: Buffer.from('hidden'), encrypted: true },
  ]);
  const rec = inspectBuffer(zip, 'bundle.zip');
  check('zip: archive class + listing', rec.target_class === 'archive' && rec.coverage.inspection === 'listing');
  check('zip: 5 entries routed', rec.coverage.entries.length === 5);
  check('zip: executable entry flagged', has(rec, 'archive-entry-executable'));
  check('zip: macro entry flagged high', rec.findings.some((f) => f.rule === 'archive-macro' && f.severity === 'high'));
  check('zip: nested archive flagged', has(rec, 'archive-nested'));
  check('zip: encrypted entry named as gap', has(rec, 'archive-entry-encrypted'));
}
{
  const tar = buildTar([{ name: 'src/app.mjs', data: Buffer.from('console.log(1)') }, { name: 'run.sh', data: Buffer.from('#!/bin/sh\ntrue') }]);
  const rec = inspectBuffer(tar, 'src.tar');
  check('tar: archive class + 2 entries', rec.target_class === 'archive' && rec.coverage.entries.length === 2);
  check('tar: script entry flagged', has(rec, 'archive-entry-executable'));
  const gz = inspectBuffer(zlib.gzipSync(tar), 'src.tar.gz');
  check('gzip(tar): listed through the wrapper', gz.coverage.format === 'gzip+tar' && gz.coverage.entries.length === 2);
  const gzTxt = inspectBuffer(zlib.gzipSync(Buffer.from('plain text https://example.com/x')), 'note.gz');
  check('gzip(text): inner classified, endpoint inventoried', gzTxt.coverage.inner === 'text-looking' && has(gzTxt, 'embedded-endpoint'));
}
{
  const rec = inspectBuffer(buildPng(), 'clean.png');
  check('png: media class + text chunk inventoried', rec.target_class === 'media' && has(rec, 'media-text-chunk'));
  const dirty = inspectBuffer(buildPng(Buffer.from('PAYLOAD')), 'dirty.png');
  check('png: trailing data after IEND flagged', has(dirty, 'media-trailing-data'));
  const jpg = inspectBuffer(buildJpeg(Buffer.from('extra')), 'x.jpg');
  check('jpeg: trailing data after EOI flagged', has(jpg, 'media-trailing-data'));
}
{
  const rar = inspectBuffer(Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.alloc(32)]), 'x.rar');
  check('rar: EXPLICITLY unsupported with reason', rar.verdict === 'unsupported' && /RAR/.test(rar.coverage.unsupported_reason));
  const seven = inspectBuffer(Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(32)]), 'x.7z');
  check('7z: EXPLICITLY unsupported with reason', seven.verdict === 'unsupported' && /7z/.test(seven.coverage.unsupported_reason));
  const ole = inspectBuffer(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]), 'x.doc');
  check('ole: EXPLICITLY unsupported with reason', ole.verdict === 'unsupported' && /OLE/.test(ole.coverage.unsupported_reason));
}
{
  const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.from('https://example.com/beacon')]);
  const rec = inspectBuffer(wasm, 'mod.wasm');
  check('wasm: binary-generic class, LIMITED confidence (never full)', rec.target_class === 'binary-generic' && rec.analysis_confidence === 'limited');
  check('wasm: endpoint indicator found, verdict capped at warn', has(rec, 'embedded-endpoint') && rec.verdict === 'warn');
  const plain = inspectBuffer(Buffer.from('just some prose, no format at all'), 'note.txt');
  check('plain text: NOT claimed by format lane (null → data lane stays)', plain === null);
  check('detectFormat: pdf magic', detectFormat(buildPdf(), 'x') === 'pdf');
}

// ---- ITEM 10: LB integration against a STUB (no live calls) -----------
{
  const calls = [];
  const stubFactory = async (opts) => {
    check('lb stub: armor requests solomon mode (public set only)', opts.mode === 'solomon');
    check('lb stub: spine labeled scripture-armor', opts.spine === 'scripture-armor');
    const api = {
      mode: opts.mode, methods: ['usernameLookup', 'ipLookup', 'domainLookup', 'webRecon', 'emailFormatCheck'],
      verifyAudit: () => ({ ok: true, entries: calls.length }),
      domainLookup: async (d) => { calls.push(['domainLookup', d]); return opts.transport ? { ok: true, data: { domain: d, source: 'stub' } } : { ok: false, refused: true, reason: 'no transport (fail-closed)' }; },
      ipLookup: async (ip) => { calls.push(['ipLookup', ip]); return { ok: true, data: { ip } }; },
      webRecon: async (u) => { calls.push(['webRecon', u]); return { ok: true, data: { url: u } }; },
    };
    return api;
  };
  const unwired = await createArmorLittleBrother({});
  check('lb unwired: wired=false', unwired.wired === false);
  const r0 = await unwired.lookup('domainLookup', 'example.com');
  check('lb unwired: lookup refuses by name', r0.refused === true && /not-wired/.test(r0.reason));

  const lb = await createArmorLittleBrother({ lbFactory: stubFactory, transport: async () => ({}) });
  check('lb wired with stub factory', lb.wired === true);
  const full = await lb.lookup('personLookup', 'someone');
  check('lb policy: tap-gated full method refused by ARMOR before LB', full.refused === true && /tap-gated/.test(full.reason) && calls.length === 0);
  const rec = { findings: [
    { rule: 'embedded-endpoint', detail: 'embedded endpoint string: https://evil.example.com:8443/x' },
    { rule: 'embedded-endpoint', detail: 'embedded endpoint string: 203.0.113.7:9001' },
    { rule: 'other', detail: 'nothing' },
  ] };
  const inds = extractIndicators(rec);
  check('lb indicators: domain + url + ip extracted', inds.length === 3);
  const out = await lb.enrichScanRecord(rec);
  check('lb enrichment: 3 governed calls made via stub', calls.length === 3);
  check('lb enrichment: findings appended, original record untouched', out.enrichment.findings.length === 3 && out.record === rec);
  check('lb enrichment: audit verification surfaced', out.enrichment.audit.ok === true);

  const closed = await createArmorLittleBrother({ lbFactory: stubFactory }); // no transport
  const out2 = await closed.enrichScanRecord(rec);
  const domainResult = out2.enrichment.results.find((r) => r.method === 'domainLookup');
  check('lb no-transport: refusal surfaces as enrichment note, not a crash or a pass', domainResult.result.refused === true);
}

console.log(`\nFORMAT+LB: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
