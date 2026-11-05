// run-tests-overlay-wiring.mjs — ITEM 9/10 overlay-port checks
// (remainder run 2026-11-04, overlay work copy only).
// Exercises the REAL overlay reader (agnostic-review.mjs) after the
// format-lane port, plus the product.json pricing block through the
// real product-paths validator. Synthetic fixtures; nothing executed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { inspectAgnostic } from '../agnostic-review.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
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
  return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('IEND', Buffer.alloc(0)), trailing]);
}

// TAR: before the port this fell into the generic opaque line.
{
  const r = inspectAgnostic(buildTar([{ name: 'run.sh', data: Buffer.from('#!/bin/sh\ntrue') }]), 'x.tar');
  check('overlay tar: NAMED as TAR archive (was generic opaque)', r.format === 'TAR archive', r.format);
  check('overlay tar: limitation carries the listing/routing detail', r.limitations.some((l) => /TAR archive:/.test(l)));
}
// RAR: named unsupported with reason, through the real reader.
{
  const r = inspectAgnostic(Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.alloc(32)]), 'x.rar');
  check('overlay rar: format named + UNSUPPORTED limitation with reason', /rar/i.test(r.format) && r.limitations.some((l) => l.startsWith('UNSUPPORTED:')), `${r.format} | ${r.limitations.join(' ')}`);
}
// PNG with trailing payload: named format + trailing-data limitation.
{
  const r = inspectAgnostic(buildPng(Buffer.from('PAYLOAD')), 'x.png');
  check('overlay png: named PNG image (was Image/media signature-only)', r.format === 'PNG image', r.format);
  check('overlay png: trailing data after IEND reported', r.limitations.some((l) => /trailing data after IEND/.test(l)));
}
// PDF: overlay limitation retained AND text-layer detail added; JS active.
{
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog/OpenAction[2 0 R]>>endobj\n2 0 obj<</S/JavaScript/JS(x)>>endobj\n', 'latin1');
  const r = inspectAgnostic(pdf, 'x.pdf');
  check('overlay pdf: original limitation retained', r.limitations.some((l) => /full document and embedded-object analysis is not available/.test(l)));
  check('overlay pdf: structure detail added by format lane', r.limitations.some((l) => /structure\/text-layer inspection/.test(l)));
  check('overlay pdf: activeContent true for JavaScript', r.activeContent === true);
}
// GZIP(text): named, inner classified.
{
  const r = inspectAgnostic(zlib.gzipSync(Buffer.from('hello https://example.com')), 'x.gz');
  check('overlay gzip: named GZIP archive', r.format === 'GZIP archive', r.format);
}
// Regression inside the reader: plain source + plain text unchanged.
{
  const src = inspectAgnostic(Buffer.from('const x = eval("1");\n'), 'evil.mjs');
  check('overlay regression: source still source', src.kind === 'source' && src.texts.length === 1);
  const txt = inspectAgnostic(Buffer.from('plain prose here'), 'note.txt');
  check('overlay regression: text still text', txt.format === 'Text' && txt.texts.length === 1);
}
// product.json: pricing block present AND boundary validator still passes.
{
  const cfg = JSON.parse(fs.readFileSync(new URL('../product.json', import.meta.url), 'utf8'));
  check('overlay product.json: $99/month pricing block present', cfg.pricing?.amountUsd === 99 && cfg.pricing?.termLabel === 'month' && cfg.pricing?.display === '$99/month');
  check('overlay product.json: schema + product boundary values untouched', cfg.schema === 'scripture-armor.product/1' && cfg.product === 'kingmaker');
  const pp = await import('../product-paths.mjs');
  check('overlay product.json: product-paths validator accepts it (ARMOR_PRODUCT=kingmaker)', pp.ARMOR_PRODUCT === 'kingmaker');
}

console.log(`\nOVERLAY WIRING: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
