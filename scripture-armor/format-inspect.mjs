// format-inspect.mjs — Scripture Armor format-coverage expansion (ITEM 9,
// remainder run 2026-11-04). UNAPPLIED PART built in a work copy; see
// INTEGRATION-NOTE-item-09-10.md before wiring into any live tree.
//
// WHY THIS EXISTS: scan.mjs's classifyBuffer knows three classes —
// binary (ELF/PE/Mach-O/ar magic → Ghidra lane), source (extensions,
// manifests, shebang, content sniff → lexical lane), and everything
// else → 'data', whose record claims analysis_confidence 'full' and
// verdict 'not-applicable' ("we looked and it isn't code"). For a PDF,
// a ZIP, a PNG or a WASM file that claim was FALSE: nothing looked.
// This module is the honest fourth lane. It inspects — without ever
// executing, rendering, or extracting-to-disk — the formats that can
// be inspected safely at structure/metadata/text-layer level, and it
// returns an EXPLICIT 'unsupported' record with a named reason for the
// formats that cannot.
//
// Inspection levels (record.coverage.inspection):
//   'structure+text-layer'  PDF: header, object flags, inflated stream
//                           text indicators. NOT rendering, NOT a full
//                           content audit.
//   'listing'               ZIP/TAR/GZIP: entry listing + per-entry
//                           routing. Entries are never extracted or
//                           executed by this lane.
//   'metadata'              PNG/JPEG/MP4: chunk/marker/box metadata +
//                           trailing-data check.
//   'header-indicators'     WASM / unknown binary: header, entropy,
//                           printable-string indicators. Confidence is
//                           'limited' — never 'full'.
//   'unsupported'           Named-reason refusal (coverage.unsupported).

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const FORMAT_RULES_VERSION = 'format-rules/1';
export const FORMAT_INSPECT_CAP_BYTES = 64 * 1024 * 1024; // honest cap; streaming is gate 2, not claimed here

const SEV_SCORE = { critical: 40, high: 15, medium: 5, low: 2, info: 0 };
function verdictRisk(findings, confidence) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  let verdict = 'pass';
  if (counts.critical > 0) verdict = 'critical';
  else if (counts.high > 0 || confidence === 'limited' || confidence === 'low') verdict = 'warn';
  const score = Math.min(100, findings.reduce((a, f) => a + (SEV_SCORE[f.severity] || 0), 0));
  const tier = counts.critical ? 2 : (counts.high || confidence !== 'full') ? 1 : 0;
  const drivers = [...new Set(findings.filter((f) => f.severity === 'critical' || f.severity === 'high').map((f) => f.rule))];
  return { counts, verdict, risk: { score, tier, drivers } };
}

function baseRecord(cls, sha, findings, confidence, coverage) {
  const { counts, verdict, risk } = verdictRisk(findings, confidence);
  return {
    format: 'scripture-armor-scan/1', target_sha256: sha, target_class: cls,
    engine: { name: 'scripture-format', version: 'scripture-format/1', rules: FORMAT_RULES_VERSION },
    started: new Date().toISOString(), duration_ms: 0, analysis_confidence: confidence,
    findings, counts, verdict: coverage.unsupported ? 'unsupported' : verdict, risk, override: null,
    coverage,
  };
}

function unsupportedRecord(format, sha, reason) {
  return baseRecord('unsupported', sha, [{
    rule: 'format-unsupported', severity: 'info', basis: 'coverage',
    location: '(whole file)',
    detail: `UNSUPPORTED: ${format} cannot be inspected safely by this build — ${reason}. This is a coverage gap, not a clean bill: the file was NOT inspected.`,
  }], 'none', { format, inspection: 'unsupported', unsupported: true, unsupported_reason: reason });
}

function shannonEntropy(buf) {
  if (!buf.length) return 0;
  const freq = new Array(256).fill(0);
  for (const b of buf) freq[b]++;
  let h = 0;
  for (const n of freq) { if (!n) continue; const p = n / buf.length; h -= p * Math.log2(p); }
  return h;
}

function printableStrings(buf, min = 6) {
  const out = [];
  let cur = '';
  for (const b of buf) {
    if (b >= 0x20 && b < 0x7f) { cur += String.fromCharCode(b); }
    else { if (cur.length >= min) out.push(cur); cur = ''; }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

const ENDPOINT_RE = /(https?:\/\/[^\s"'<>]+|\b(?:\d{1,3}\.){3}\d{1,3}\b(?::\d{1,5})?)/;
function endpointFindings(strings, limit = 10) {
  const out = [];
  for (const s of strings) {
    if (out.length >= limit) break;
    const m = s.match(ENDPOINT_RE);
    if (m) out.push({ rule: 'embedded-endpoint', severity: 'info', basis: 'inventory', location: 'string', detail: `embedded endpoint string: ${m[0].slice(0, 120)}` });
  }
  return out;
}

// ---------------------------------------------------------------- PDF ----
function inspectPdf(buf, sha) {
  const text = buf.toString('latin1');
  const findings = [];
  const ver = text.slice(0, 16).match(/%PDF-(\d\.\d)/);
  findings.push({ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'header', detail: `PDF ${ver ? ver[1] : '(version unreadable)'}; structure/text-layer inspection only — the document was NOT rendered and embedded content was NOT executed` });
  if (/\/Encrypt\b/.test(text)) {
    return unsupportedRecord('pdf-encrypted', sha, 'the document is encrypted (/Encrypt present); decryption is out of scope for an inspection lane');
  }
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  findings.push({ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'body', detail: `${pages} page object(s) declared` });
  for (const [key, rule, sev, detail] of [
    ['/JavaScript', 'pdf-javascript', 'high', 'document declares JavaScript — script content is inventoried, never executed [behavior: remote-activation candidate]'],
    ['/JS', 'pdf-javascript', 'high', 'document carries a /JS action entry — never executed'],
    ['/OpenAction', 'pdf-open-action', 'medium', 'document runs an action on open (/OpenAction)'],
    ['/AA', 'pdf-additional-actions', 'medium', 'document carries additional actions (/AA)'],
    ['/Launch', 'pdf-launch-action', 'high', 'document carries a /Launch action (external program launch) — never executed'],
    ['/EmbeddedFile', 'pdf-embedded-file', 'medium', 'document embeds a file (/EmbeddedFile) — the embedded file is NOT extracted or opened by this lane'],
    ['/URI', 'pdf-uri', 'info', 'document carries external URI reference(s)'],
  ]) {
    if (text.includes(key)) findings.push({ rule, severity: sev, basis: 'inventory', location: 'body', detail });
  }
  // Text layer: inflate FlateDecode streams and scan the recovered text
  // for endpoint/script indicators. Undecodable streams are counted as
  // a coverage note, never silently skipped.
  let streams = 0, inflated = 0, streamText = '';
  let idx = 0;
  while (true) {
    const s = text.indexOf('stream', idx); if (s < 0) break;
    const e = text.indexOf('endstream', s); if (e < 0) break;
    streams++;
    const raw = buf.subarray(s + 6 + (text[s + 6] === '\r' ? 2 : 1), e);
    try { const dec = zlib.inflateSync(raw, { maxOutputLength: 4 * 1024 * 1024 }); inflated++; streamText += dec.toString('latin1') + '\n'; } catch { /* not flate or corrupt — counted below */ }
    idx = e + 9;
  }
  if (streams) findings.push({ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'streams', detail: `${inflated}/${streams} stream(s) inflated for text-layer inspection; the rest (if any) use filters this lane does not decode and were NOT inspected` });
  findings.push(...endpointFindings(printableStrings(Buffer.from(streamText, 'latin1'))));
  if (/\b(eval|system|cmd\.exe|powershell)\b/i.test(streamText)) {
    findings.push({ rule: 'pdf-stream-indicator', severity: 'medium', basis: 'pattern', location: 'text layer', detail: 'inflated stream text contains code-execution vocabulary — a pattern indicator, not proof of behavior' });
  }
  return baseRecord('document', sha, findings, 'full', { format: 'pdf', inspection: 'structure+text-layer', unsupported: false });
}

// ---------------------------------------------------------------- ZIP ----
const EXEC_ENTRY_RE = /\.(exe|dll|sys|scr|com|msi|jar|sh|bash|zsh|mjs|cjs|js|py|rb|pl|ps1|bat|cmd|app|dylib|so)$/i;
const ARCHIVE_ENTRY_RE = /\.(zip|tar|tgz|gz|7z|rar)$/i;
function routeEntry(name) {
  if (/vbaProject\.bin$/i.test(name)) return 'macro-container';
  if (EXEC_ENTRY_RE.test(name)) return 'executable-entry';
  if (ARCHIVE_ENTRY_RE.test(name)) return 'nested-archive';
  return 'listed-only';
}
function inspectZip(buf, sha) {
  // Central directory walk (listing only — nothing is decompressed).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return unsupportedRecord('zip-corrupt', sha, 'no end-of-central-directory record found; the archive structure cannot be listed safely');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < total && off + 46 <= buf.length && buf.readUInt32LE(off) === 0x02014b50; n++) {
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), comLen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, csize, encrypted: (flags & 1) === 1, route: routeEntry(name) });
    off += 46 + nameLen + extraLen + comLen;
  }
  const findings = [{ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'central directory', detail: `ZIP archive: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} listed from the central directory. Entries were NOT extracted or executed; per-entry routing: ${entries.map((e) => `${e.name} → ${e.route}`).join('; ').slice(0, 900)}` }];
  for (const e of entries) {
    if (e.encrypted) findings.push({ rule: 'archive-entry-encrypted', severity: 'medium', basis: 'coverage', location: `entry: ${e.name}`, detail: 'entry is encrypted (general-purpose flag bit 0) — its content is UNSUPPORTED by this lane and was not inspected' });
    if (e.route === 'macro-container') findings.push({ rule: 'archive-macro', severity: 'high', basis: 'inventory', location: `entry: ${e.name}`, detail: 'Office macro project (vbaProject.bin) present — macros are inventoried, never executed' });
    else if (e.route === 'executable-entry') findings.push({ rule: 'archive-entry-executable', severity: 'medium', basis: 'inventory', location: `entry: ${e.name}`, detail: 'executable/script entry inside an archive — listed only; sealing the archive does not inspect this entry\'s code' });
    else if (e.route === 'nested-archive') findings.push({ rule: 'archive-nested', severity: 'medium', basis: 'inventory', location: `entry: ${e.name}`, detail: 'nested archive — this lane lists one level; the nested archive\'s contents are a coverage gap unless scanned separately' });
  }
  const cov = { format: 'zip', inspection: 'listing', unsupported: false, entries: entries.map((e) => ({ name: e.name, route: e.route, encrypted: e.encrypted })) };
  return baseRecord('archive', sha, findings, 'full', cov);
}

// ---------------------------------------------------------------- TAR ----
function inspectTar(buf, sha) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/[^0-7]/g, ''), 8) || 0;
    const type = String.fromCharCode(block[156] || 48);
    if (!name) break;
    entries.push({ name, size, type, route: routeEntry(name) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  if (!entries.length) return unsupportedRecord('tar-corrupt', sha, 'no readable 512-byte tar headers; the archive cannot be listed safely');
  const findings = [{ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'headers', detail: `TAR archive: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} listed from headers. Entries were NOT extracted or executed; per-entry routing: ${entries.map((e) => `${e.name} → ${e.route}`).join('; ').slice(0, 900)}` }];
  for (const e of entries) {
    if (e.route === 'executable-entry') findings.push({ rule: 'archive-entry-executable', severity: 'medium', basis: 'inventory', location: `entry: ${e.name}`, detail: 'executable/script entry inside an archive — listed only' });
    if (e.route === 'nested-archive') findings.push({ rule: 'archive-nested', severity: 'medium', basis: 'inventory', location: `entry: ${e.name}`, detail: 'nested archive — contents are a coverage gap unless scanned separately' });
  }
  return baseRecord('archive', sha, findings, 'full', { format: 'tar', inspection: 'listing', unsupported: false, entries: entries.map((e) => ({ name: e.name, route: e.route })) });
}

// --------------------------------------------------------------- GZIP ----
function inspectGzip(buf, name, sha) {
  let inner;
  try { inner = zlib.gunzipSync(buf, { maxOutputLength: FORMAT_INSPECT_CAP_BYTES }); }
  catch (e) { return unsupportedRecord('gzip-unreadable', sha, `gzip stream cannot be decompressed within the inspection cap (${e.message})`); }
  const isTar = inner.length >= 512 && inner.subarray(257, 262).toString('ascii') === 'ustar';
  if (isTar) {
    const rec = inspectTar(inner, sha);
    rec.coverage.format = 'gzip+tar';
    rec.findings.unshift({ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'header', detail: 'gzip wrapper decompressed in memory (nothing written to disk); inner content is TAR and was listed' });
    return rec;
  }
  const innerCls = inner.includes(0) ? 'binary-looking' : 'text-looking';
  return baseRecord('archive', sha, [
    { rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'header', detail: `gzip single-stream archive decompressed in memory; inner content is ${innerCls} (${inner.length} bytes). The inner content itself was classified, not deep-scanned — scan it separately for a content verdict.` },
    ...endpointFindings(printableStrings(inner)),
  ], 'full', { format: 'gzip', inspection: 'listing', unsupported: false, inner: innerCls });
}

// --------------------------------------------------------------- MEDIA ---
function inspectPng(buf, sha) {
  const findings = [];
  const chunks = [];
  let off = 8, sawIend = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    chunks.push(type);
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const raw = buf.subarray(off + 8, off + 8 + Math.min(len, 512)).toString('latin1');
      findings.push({ rule: 'media-text-chunk', severity: 'info', basis: 'inventory', location: `chunk ${type}`, detail: `PNG text chunk present: ${raw.replace(/[^\x20-\x7e]/g, ' ').slice(0, 160)}` });
    }
    off += 12 + len;
    if (type === 'IEND') { sawIend = true; break; }
    if (len > buf.length) break;
  }
  findings.unshift({ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'chunks', detail: `PNG image: chunks ${chunks.join(', ') || '(none readable)'} — metadata-level inspection only; pixels were NOT decoded` });
  if (sawIend && off < buf.length) findings.push({ rule: 'media-trailing-data', severity: 'medium', basis: 'inventory', location: 'after IEND', detail: `${buf.length - off} byte(s) of trailing data after IEND — a classic payload-hiding shape; the trailing bytes were not interpreted` });
  if (!sawIend) findings.push({ rule: 'format-structure', severity: 'low', basis: 'inventory', location: 'chunks', detail: 'no IEND chunk found — file may be truncated or nonstandard' });
  return baseRecord('media', sha, findings, 'full', { format: 'png', inspection: 'metadata', unsupported: false });
}

function inspectJpeg(buf, sha) {
  const findings = [{ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'markers', detail: 'JPEG image — metadata-level inspection only; pixels were NOT decoded' }];
  if (buf.includes(Buffer.from('Exif\0\0'))) findings.push({ rule: 'media-exif', severity: 'info', basis: 'inventory', location: 'APP1', detail: 'EXIF metadata present (camera/device fields possible) — inventoried, not parsed field-by-field' });
  let eoi = -1;
  for (let i = buf.length - 2; i >= 0; i--) { if (buf[i] === 0xff && buf[i + 1] === 0xd9) { eoi = i; break; } }
  if (eoi >= 0 && eoi + 2 < buf.length) findings.push({ rule: 'media-trailing-data', severity: 'medium', basis: 'inventory', location: 'after EOI', detail: `${buf.length - eoi - 2} byte(s) of trailing data after the EOI marker — not interpreted` });
  return baseRecord('media', sha, findings, 'full', { format: 'jpeg', inspection: 'metadata', unsupported: false });
}

function inspectMp4(buf, sha) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (!size || size < 8) break;
    boxes.push(type);
    off += size;
  }
  return baseRecord('media', sha, [{ rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'boxes', detail: `MP4/MOV container: top-level boxes ${boxes.join(', ') || '(none readable)'} — metadata-level inspection only; media was NOT decoded or played` }], 'full', { format: 'mp4', inspection: 'metadata', unsupported: false });
}

// ------------------------------------------------- GENERIC BINARY/WASM ---
function inspectGenericBinary(buf, name, sha, formatLabel) {
  const entropy = shannonEntropy(buf.subarray(0, 1024 * 1024));
  const strings = printableStrings(buf.subarray(0, 4 * 1024 * 1024));
  const findings = [
    { rule: 'format-structure', severity: 'info', basis: 'inventory', location: 'header', detail: `${formatLabel}: header/entropy/string-indicator inspection only (entropy ${entropy.toFixed(2)} over the first MiB, ${strings.length} printable strings ≥6 chars). This is NOT binary analysis — no Ghidra lane ran on this format.` },
    ...endpointFindings(strings),
  ];
  if (entropy >= 7.2) findings.push({ rule: 'binary-high-entropy', severity: 'medium', basis: 'inventory', location: '(whole file)', detail: `high entropy (${entropy.toFixed(2)}) — packed/encrypted/compressed content is plausible; indicators may be hidden` });
  if (strings.some((s) => /\b(exec|system|powershell|cmd\.exe|curl|wget)\b/.test(s))) findings.push({ rule: 'binary-string-indicator', severity: 'medium', basis: 'pattern', location: 'strings', detail: 'printable strings contain process/network vocabulary — an indicator, not proof of behavior' });
  return baseRecord('binary-generic', sha, findings, 'limited', { format: formatLabel, inspection: 'header-indicators', unsupported: false });
}

// ------------------------------------------------------------- DETECT ----
export function detectFormat(buf, name = '') {
  if (!buf || buf.length < 4) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  if (buf.length >= 265 && buf.subarray(257, 262).toString('ascii') === 'ustar') return 'tar';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buf[0] === 0x00 && buf.subarray(1, 4).toString('latin1') === 'asm') return 'wasm';
  if (buf.subarray(0, 6).toString('latin1') === 'Rar!\x1a\x07') return 'rar';
  if (buf.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole-cfb';
  // Unknown but binary-looking (NUL bytes in the head): indicators lane.
  if (buf.subarray(0, 8192).includes(0)) return 'generic-binary';
  return null; // plain data — the caller's existing data lane stays honest for it
}

export function oversizedRecord(sizeBytes, targetSha) {
  return unsupportedRecord('oversized-input', targetSha, `file is ${sizeBytes} bytes, above this lane's ${FORMAT_INSPECT_CAP_BYTES}-byte in-memory cap; disk-backed streaming (release gate 2) is not implemented in this build, so the file is a declared coverage gap, not a pass`);
}

// ---------------------------------------------------------------
// OVERLAY ADAPTER (added in the overlay-copy port, 2026-11-04):
// agnostic-review.mjs speaks { format, limitations[], activeContent }
// rather than scan records. agnosticAugment() translates this lane's
// results into that shape for the branches the overlay reader does
// not cover: named media formats, TAR/GZIP, and the named-unsupported
// formats that otherwise fall into its generic "opaque" line.
// Returns null when this lane has nothing to add (the caller's own
// handling stands).
export function agnosticAugment(buf, name) {
  const fmt = detectFormat(buf, name);
  if (!fmt || fmt === 'zip') return null; // the overlay ZIP path extracts texts itself; do not shadow it
  const rec = inspectBuffer(buf, name);
  if (!rec) return null;
  const limitations = [];
  if (rec.coverage.unsupported) {
    limitations.push(`UNSUPPORTED: ${rec.coverage.format} — ${rec.coverage.unsupported_reason}`);
    const label = { rar: 'RAR archive', '7z': '7z archive', 'ole-cfb': 'OLE compound document', 'pdf-encrypted': 'PDF (encrypted)', 'zip-corrupt': 'ZIP archive (unreadable)', 'tar-corrupt': 'TAR archive (unreadable)', 'gzip-unreadable': 'GZIP archive (unreadable)', 'oversized-input': 'Oversized input' }[rec.coverage.format] || rec.coverage.format;
    return { format: label, limitations, activeContent: false };
  }
  for (const f of rec.findings) {
    if (f.rule === 'format-structure' || f.rule === 'media-trailing-data' || f.rule === 'pdf-embedded-file') {
      limitations.push(`${f.detail}`);
    }
  }
  const activeContent = rec.findings.some((f) => ['pdf-javascript', 'pdf-launch-action', 'archive-macro'].includes(f.rule));
  const formatLabel = { pdf: 'PDF', png: 'PNG image', jpeg: 'JPEG image', mp4: 'MP4 media', tar: 'TAR archive', gzip: 'GZIP archive', 'gzip+tar': 'TAR archive (gzip)', wasm: 'WebAssembly binary', 'unknown-binary': 'Unknown binary' }[rec.coverage.format] || rec.coverage.format;
  return { format: formatLabel, limitations, activeContent, coverageFormat: rec.coverage.format };
}

export function inspectBuffer(buf, name, targetSha) {
  const sha = targetSha || crypto.createHash('sha256').update(buf).digest('hex');
  if (buf.length > FORMAT_INSPECT_CAP_BYTES) {
    return unsupportedRecord('oversized-input', sha, `file is ${buf.length} bytes, above this lane's ${FORMAT_INSPECT_CAP_BYTES}-byte in-memory cap; disk-backed streaming (release gate 2) is not implemented in this build, so the file is a declared coverage gap, not a pass`);
  }
  switch (detectFormat(buf, name)) {
    case 'pdf': return inspectPdf(buf, sha);
    case 'zip': return inspectZip(buf, sha);
    case 'tar': return inspectTar(buf, sha);
    case 'gzip': return inspectGzip(buf, name, sha);
    case 'png': return inspectPng(buf, sha);
    case 'jpeg': return inspectJpeg(buf, sha);
    case 'mp4': return inspectMp4(buf, sha);
    case 'wasm': return inspectGenericBinary(buf, name, sha, 'wasm');
    case 'generic-binary': return inspectGenericBinary(buf, name, sha, 'unknown-binary');
    case 'rar': return unsupportedRecord('rar', sha, 'RAR decompression requires a parser this zero-dependency build does not carry; listing or inspecting RAR contents safely is not implemented');
    case '7z': return unsupportedRecord('7z', sha, '7z decompression requires a parser this zero-dependency build does not carry; listing or inspecting 7z contents safely is not implemented');
    case 'ole-cfb': return unsupportedRecord('ole-cfb', sha, 'legacy OLE compound documents (.doc/.xls/.msi family) need a CFB parser to inventory their streams safely; not implemented in this build — macros and embedded objects in such files are NOT inspected');
    default: return null;
  }
}
