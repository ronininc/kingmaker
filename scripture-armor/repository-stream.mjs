// Disk-backed streaming support for the repository review job.
//
// Why this file exists: the buffered intake path (review-intake.mjs
// fetchPublicBytes) hard-caps a single response at 16 MiB, and the sandbox
// reader (sandbox-review.mjs) rejects any single file over 16 MiB, so an
// oversized repository blob used to become a coverage gap by construction.
// The functions here inspect a blob of ANY size from disk in bounded
// memory: the file is never held whole in RAM.
//
// Stated memory bound: at any moment the inspector holds at most
//   one read chunk (STREAM_CHUNK_BYTES = 256 KiB)
// + one decoded text batch (STREAM_TEXT_BATCH_CHARS = 512 Ki chars)
// + the tail of one partial line (bounded by STREAM_MAX_LINE_CHARS; a
//   longer single line is scanned in slices and the slicing is reported
//   as a limitation)
// + at most STREAM_MAX_FINDINGS (100) finding records, matching the
//   review worker's existing cap.
// Total inspector-owned heap is therefore < ~4 MiB regardless of blob
// size. Verified by the 24 MiB acceptance run under
// --max-old-space-size=64 (see item-02 report).
import fs from 'node:fs';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {publicReviewURL, isPublicAddress} from './review-intake.mjs';
import {classifyBuffer, scanSourceText} from './scan.mjs';

export const STREAM_CHUNK_BYTES = 256 * 1024;
export const STREAM_TEXT_BATCH_CHARS = 512 * 1024;
export const STREAM_MAX_LINE_CHARS = 1024 * 1024;
export const STREAM_MAX_FINDINGS = 100;
export const STREAM_MEMORY_BOUND_BYTES = 4 * 1024 * 1024; // inspector-owned, excluding V8/runtime baseline

const PRIVATE_MATERIAL = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|"(?:seal_priv|sign_priv|kem_priv|mldsa_priv)"\s*:/;

// Inspect a file already on disk (a streamed download or a local file).
// Returns the same shape the buffered analyze() path returns, plus
// {size, codeLines, gitBlobSha1} computed incrementally, plus (Item 3)
// a coverage object accounting the deep content pass chunk by chunk.
// status is always 'limited': the streamed lane runs classification and
// the lexical source-pattern scan in bounded windows over text, and —
// for blobs the text lane cannot run on (native binaries, opaque data:
// the weight-file shape, previously hash + head-classification only) —
// a portion-wise DEEP CONTENT scan over every chunk (wall (d) closure
// for the content layer). It does NOT run archive expansion, the REA
// pass or sandbox binary analysis on the oversized blob, and says so
// in limitations — an explicit partial inspection, never a silent pass
// and never a silent gap.
export async function streamInspectFile(filePath, name) {
  const sha256 = crypto.createHash('sha256');
  let size = 0, header = null, codeLines = 0, lastByte = -1;
  let kind = null, opaque = false, privateMaterial = false;
  const decoder = new StringDecoder('utf8');
  let batch = '', batchStartLine = 1, lineNo = 1, partial = '';
  let hasNet = false, hasBulkRead = false, firstTextError = false;
  const findings = [];
  // Deep content pass state (Item 3, wall (d)). Printable runs are
  // extracted chunk by chunk; a run that reaches a chunk boundary
  // unterminated is carried whole into the next chunk (bounded by the
  // same 1 MiB line cap the text lane uses — an over-long run is
  // examined in slices, so every byte is still covered). Raw bytes are
  // additionally checked for embedded archive/executable signatures
  // with an 8-byte boundary overlap.
  let deepChunks = 0, deepBytes = 0, deepStrings = 0, deepRan = false;
  let carryText = '', carryOffset = 0, tailBytes = Buffer.alloc(0);
  const deepFindings = [];
  let deepEndpoints = 0, deepPayloads = 0;
  const ENDPOINT_RE = /(https?:\/\/[^\s"'<>]+|\b(?:\d{1,3}\.){3}\d{1,3}\b(?::\d{1,5})?)/;
  const PAYLOAD_MAGICS = [
    {bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), label: 'ZIP archive'},
    {bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: 'ELF executable'},
    {bytes: Buffer.from('Rar!\x1a\x07', 'latin1'), label: 'RAR archive'},
    {bytes: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), label: '7z archive'},
  ];
  const handleDeepString = (s, offset) => {
    deepStrings++;
    const m = s.match(ENDPOINT_RE);
    if (m && deepEndpoints < 20) {
      deepEndpoints++;
      deepFindings.push({rule: 'embedded-endpoint', severity: 'info', title: 'embedded endpoint', basis: 'inventory', location: `${name} @ byte ${offset}`, detail: `embedded endpoint string in deep content: ${m[0].slice(0, 120)}`});
    }
    if (PRIVATE_MATERIAL.test(s)) privateMaterial = true;
  };
  const feedDeep = (chunk, chunkOffset) => {
    deepRan = true; deepChunks++; deepBytes += chunk.length;
    const text = carryText + chunk.toString('latin1');
    const base = carryText ? carryOffset : chunkOffset;
    const trailingMatch = /[\x20-\x7e]+$/.exec(text);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const body = text.slice(0, text.length - trailing.length);
    for (const m of body.matchAll(/[\x20-\x7e]{6,}/g)) handleDeepString(m[0], base + m.index);
    let held = trailing, heldOffset = base + body.length;
    while (held.length > STREAM_MAX_LINE_CHARS) { handleDeepString(held.slice(0, STREAM_MAX_LINE_CHARS), heldOffset); held = held.slice(STREAM_MAX_LINE_CHARS); heldOffset += STREAM_MAX_LINE_CHARS; }
    carryText = held; carryOffset = heldOffset;
    const buf = tailBytes.length ? Buffer.concat([tailBytes, chunk]) : chunk;
    const bufBase = chunkOffset - tailBytes.length;
    for (const sig of PAYLOAD_MAGICS) {
      let at = -1;
      while ((at = buf.indexOf(sig.bytes, at + 1)) >= 0) {
        const off = bufBase + at;
        if (off === 0 || off + sig.bytes.length <= chunkOffset || deepPayloads >= 10) continue;
        deepPayloads++;
        deepFindings.push({rule: 'embedded-payload-magic', severity: 'medium', title: 'embedded payload magic', basis: 'inventory', location: `${name} @ byte ${off}`, detail: `${sig.label} signature found at byte offset ${off} inside an opaque blob — an indicator of appended or embedded content, not proof of behavior; the embedded content was not extracted`});
      }
    }
    tailBytes = Buffer.from(buf.subarray(Math.max(0, buf.length - 8)));
  };
  const pushBatch = (flush = false) => {
    if (!batch) return;
    const report = scanSourceText(batch, name, 'streamed');
    for (const f of report.findings) {
      if (f.severity === 'info') continue;
      if (findings.length >= STREAM_MAX_FINDINGS) break;
      let location = f.location;
      const m = /:(\d+)$/.exec(location || '');
      if (m) location = location.slice(0, m.index) + ':' + (batchStartLine + Number(m[1]) - 1);
      findings.push({rule: f.rule, severity: f.severity, title: String(f.rule).replace(/[-_]+/g, ' '), basis: f.basis, location, detail: f.detail, excerpt: f.excerpt, ...(f.explanation ? {explanation: f.explanation} : {})});
    }
    if (/(?:fetch\s*\(|axios|https?\.request|requests\.(?:post|put)|urllib|socket\.connect|curl\s|wget\s)/.test(batch)) hasNet = true;
    if (/(?:readFileSync|createReadStream|os\.environ|process\.env|glob\.|readdirSync|os\.walk)/.test(batch)) hasBulkRead = true;
    if (PRIVATE_MATERIAL.test(batch)) privateMaterial = true;
    batch = '';
  };
  const feedText = (text) => {
    partial += text;
    let idx;
    while ((idx = partial.indexOf('\n')) >= 0) {
      let line = partial.slice(0, idx + 1); partial = partial.slice(idx + 1);
      while (line.length > STREAM_MAX_LINE_CHARS) { batch += line.slice(0, STREAM_MAX_LINE_CHARS); line = line.slice(STREAM_MAX_LINE_CHARS); pushBatch(); batchStartLine = lineNo; }
      batch += line; lineNo++;
      if (batch.length >= STREAM_TEXT_BATCH_CHARS) { pushBatch(); batchStartLine = lineNo; }
    }
    if (partial.length > STREAM_MAX_LINE_CHARS) { batch += partial; partial = ''; pushBatch(); batchStartLine = lineNo; }
  };
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath, {highWaterMark: STREAM_CHUNK_BYTES});
    rs.on('data', (chunk) => {
      size += chunk.length; lastByte = chunk[chunk.length - 1];
      sha256.update(chunk);
      if (!header) header = Buffer.from(chunk.subarray(0, 16384));
      if (kind === null) {
        kind = classifyBuffer(header, name);
        // Opaque-data detection mirrors inspectAgnostic: NUL in the head
        // of a non-source file means it is not decodable text.
        if (kind !== 'source' && header.subarray(0, 8192).includes(0)) opaque = true;
      }
      if (kind !== 'binary' && !opaque) {
        try { feedText(decoder.write(chunk)); } catch { firstTextError = true; }
      } else {
        feedDeep(chunk, size - chunk.length);
      }
      // Line counting is byte-exact and matches the buffered path:
      // one per '\n', plus one for a trailing unterminated line.
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) codeLines++;
    });
    rs.on('end', resolve); rs.on('error', reject);
  });
  // Git blob SHA-1 must be computed over "blob <size>\0" + content; the
  // header depends on total size, so recompute it in a second streaming
  // pass (disk is cheap; memory stays bounded).
  const gitBlobSha1 = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1'); h.update(Buffer.from(`blob ${size}\0`));
    const rs = fs.createReadStream(filePath, {highWaterMark: STREAM_CHUNK_BYTES});
    rs.on('data', (c) => h.update(c)); rs.on('end', () => resolve(h.digest('hex'))); rs.on('error', reject);
  });
  if (kind !== 'binary' && !opaque) { feedText(decoder.end()); if (partial) { batch += partial; partial = ''; lineNo++; } pushBatch(true); }
  if (deepRan && carryText.length >= 6) handleDeepString(carryText, carryOffset);
  for (const f of deepFindings) { if (findings.length >= STREAM_MAX_FINDINGS) break; findings.push(f); }
  if (size && lastByte !== 10 && kind === 'source') codeLines++;
  const limitations = [];
  if (deepRan) {
    limitations.push(`Streamed disk-backed inspection: whole-file SHA-256 and head classification ran, and a portion-wise deep content scan ran over every chunk of the file (${deepChunks} chunks, ${deepBytes} of ${size} bytes): printable strings were extracted with boundary overlap and checked for embedded endpoints and private-material patterns, and the raw bytes were checked for embedded archive/executable signatures. Archive expansion, REA inspection and sandbox binary analysis were not run on this oversized file.`);
    limitations.push('Tensor-level semantic analysis is not performed by any lane: the deep content scan covers byte content (strings, endpoints, signatures), not what model weights compute. A clean deep content scan is not evidence that weights are benign.');
  } else {
    limitations.push('Streamed disk-backed inspection: classification and lexical source-pattern scan ran in bounded windows over the whole file. Archive expansion, REA inspection and sandbox binary analysis were not run on this oversized file.');
  }
  if (opaque) limitations.push('Opaque or unsupported binary data; not classified as clean.');
  if (privateMaterial) limitations.push('Private key material pattern detected in streamed text; content withheld from preview.');
  if (hasNet && hasBulkRead && findings.length < STREAM_MAX_FINDINGS) findings.push({rule: 'behavior-covert-exfiltration', severity: 'high', title: 'behavior covert exfiltration', basis: 'pattern', location: name, detail: 'outbound network channel co-occurs with bulk local data/environment access in one file [behavior: covert-exfiltration]'});
  const shortfalls = deepRan ? [{kind: 'semantic-analysis', what: 'tensor-level semantics', disposition: 'not-performed', detail: 'no lane performs weight-space semantic analysis; the deep content scan covers byte content only (strings, endpoints, embedded signatures)'}] : [];
  return {
    kind: kind || 'data',
    status: 'limited',
    format: kind === 'binary' ? 'Native binary (streamed header classification)' : kind === 'source' ? 'Source text (streamed)' : 'Data (streamed)',
    findings, limitations, shortfalls,
    coverage: {deepContentScan: {ran: deepRan, chunks: deepChunks, bytesScanned: deepBytes, bytesTotal: size, stringsExamined: deepStrings, complete: deepRan && deepBytes === size}},
    contentSha256: sha256.digest('hex'),
    gitBlobSha1, size, codeLines,
    commandAuthority: false, targetExecuted: false,
  };
}

// Streaming counterpart of fetchPublicBytes: same public-HTTPS-only and
// DNS-pinning discipline, but the body is written to destPath chunk by
// chunk and there is NO 16 MiB ceiling — the bound is the disk, not RAM.
// Non-2xx responses reject with an error carrying .statusCode and
// .retryAfterSeconds; 403/429 additionally carry .quota === true so the
// caller can pause for quota instead of crashing or silently skipping.
export async function fetchPublicBytesToFile(input, destPath, {resolve = dns.lookup, request = https.request, idleTimeoutMs = 15000, budgetMs = 10 * 60 * 1000} = {}) {
  const started = Date.now(); let url = publicReviewURL(input);
  for (let hop = 0; hop <= 3; hop++) {
    if (Date.now() - started > budgetMs) throw Error('Streamed intake exceeded its time budget.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let dnsTimer;
    const addresses = net.isIP(host) ? [{address: host, family: net.isIP(host)}] : await Promise.race([resolve(host, {all: true, verbatim: true}), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(Error('DNS lookup timed out.')), 3000); dnsTimer.unref?.(); })]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.length > 32 || addresses.some((entry) => !isPublicAddress(entry.address))) throw Error('The link resolves to a local, private or reserved address.');
    const pinned = addresses[0];
    const response = await new Promise((resolveResponse, reject) => {
      let finished = false, idle;
      const fail = (error) => { if (!finished) { finished = true; clearTimeout(idle); reject(error); } };
      const req = request({protocol: 'https:', hostname: host, port: 443, path: url.pathname + url.search, method: 'GET', agent: false, rejectUnauthorized: true,
        servername: net.isIP(host) ? undefined : host, headers: {accept: 'text/html,text/plain,application/json,application/octet-stream', 'accept-encoding': 'identity', 'user-agent': 'Scripture-Armor-Review/1'},
        lookup: (_host, options, done) => options?.all ? done(null, [pinned]) : done(null, pinned.address, pinned.family)}, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) { finished = true; res.destroy(); if (!res.headers.location) { reject(Error('Redirect location missing.')); return; } resolveResponse({redirect: res.headers.location}); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          const error = Error(`The public link could not be retrieved (HTTP ${res.statusCode}). Authentication is not forwarded.`);
          error.statusCode = res.statusCode;
          const ra = Number(res.headers['retry-after']); if (Number.isFinite(ra) && ra >= 0) error.retryAfterSeconds = ra;
          if (res.statusCode === 403 || res.statusCode === 429) error.quota = true;
          return fail(error);
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); return fail(Error('Compressed network responses are not accepted by this bounded intake.')); }
        const out = fs.createWriteStream(destPath, {mode: 0o600});
        let total = 0;
        const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { req.destroy(); out.destroy(); fail(Error('Streamed intake stalled.')); }, idleTimeoutMs); idle.unref?.(); };
        armIdle();
        res.on('data', (chunk) => { total += chunk.length; armIdle(); if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()); } });
        res.on('error', () => { out.destroy(); fail(Error('Link response interrupted.')); });
        res.on('aborted', () => { out.destroy(); fail(Error('Link response interrupted.')); });
        res.on('end', () => { out.end(() => { if (!finished) { finished = true; clearTimeout(idle); resolveResponse({bytes: total, url: url.href}); } }); });
      });
      req.setTimeout(Math.min(5000, idleTimeoutMs), () => { req.destroy(); fail(Error('Link intake timed out.')); });
      req.on('error', () => fail(Error('Public HTTPS intake failed.'))); req.end();
    });
    if (response.redirect) { if (hop === 3) throw Error('Too many link redirects.'); url = publicReviewURL(new URL(response.redirect, url).href); continue; }
    if (!response.bytes) { try { fs.unlinkSync(destPath); } catch {} throw Error('The linked response was empty.'); }
    return response;
  }
  throw Error('Streamed intake did not complete.');
}
