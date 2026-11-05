// interop/run-interop.mjs — Scripture Armor vs the internet as it
// actually works. Builds ON the live-fire harness (same relay pattern,
// same egress, same tap discipline) and asks the BREADTH question:
// does the governed relay leg survive redirects, methods, encodings,
// binary, gzip, structured APIs, Cloudflare, streaming — and does the
// covered FORM travel through real infrastructure unmolested, with
// zero usable surface in transit?
//
// Only the code's own paths: createArmorEgress relay mode, the proof
// relay with its default real fetch (instrumented to count/time only),
// armor-native wrap/open/match primitives — the same functions
// armor-egress itself composes. Exit code is informational; the
// results.json + this output are the evidence for INTEROP-REPORT.md.

import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as native from '../../../lib/armor-native.mjs';
import { createArmorEgress } from '../../../lib/armor-egress.mjs';
import * as armorLib from '../../armor.mjs';
import { startRelay } from '../proof/relay.mjs';
import { startTap, readCapture } from '../proof/tap.mjs';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const P = { relay: 19811, tapRelay: 19812, tamper: 19813 };
const S = {
  engine: join(here, 'state-engine'),
  relay: join(here, 'state-relay'),
  stranger: join(here, 'state-stranger'),
};
for (const d of Object.values(S)) fs.rmSync(d, { recursive: true, force: true });

const results = [];
const evidence = { relayLeg: [], oracle: [], notes: {} };
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
}
function observe(label, detail = '') {
  results.push({ label, ok: null, detail });
  console.log(`OBSERVED — ${label}${detail ? ` :: ${detail}` : ''}`);
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------------------------------------------------------------- setup
native.ensureIdentity(S.engine, 'kingmaker-engine');
const engineBlock = native.publicBlockOf(S.engine);
const engineId = armorLib.loadIdentity(native.identityDir(S.engine));
const relayId = native.ensureIdentity(S.relay, 'estate-relay');
const relayBlock = armorLib.publicBlock(relayId);
const strangerId = native.ensureIdentity(S.stranger, 'stranger');
const strangerBlock = armorLib.publicBlock(strangerId);

let relayApiCount = 0;
const countedFetch = async (url, opts) => {
  relayApiCount++;
  const t0 = now();
  const r = await fetch(url, opts);
  evidence.relayLeg.push({ url: String(url), ms: Math.round(now() - t0), status: r.status });
  return r;
};
await startRelay({ state: S.relay, engineBlock, port: P.relay, fetchImpl: countedFetch });
await startTap({ listenPort: P.tapRelay, targetPort: P.relay, captureBase: join(here, 'capture-interop-relay') });
native.savePeers(S.engine, {
  'estate-relay': { block: relayBlock, endpoint: `http://127.0.0.1:${P.tapRelay}/` },
});
const egress = createArmorEgress({ state: S.engine, policy: 'native', relayName: 'estate-relay' });
const RELAY_URL = `http://127.0.0.1:${P.relay}/`;

// A relay round trip composed from armor-native's own primitives —
// the identical functions armor-egress composes internally — for the
// cases that need raw response BYTES (egress.fetch's response surface
// is text/json by design; byte fidelity lives at this layer).
async function relayRoundTrip(envelope, purpose) {
  const { text, frame } = await native.wrapEgress(S.engine, Buffer.from(JSON.stringify(envelope), 'utf8'), relayBlock, { purpose });
  native.noteSent(S.engine, { canary: frame.canary, purpose, peer: frame.recipient_seal_fp });
  const r = await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
    body: text, signal: AbortSignal.timeout(30_000),
  });
  const respText = await r.text();
  if (!respText.startsWith('SCRIPTURE-ARMOR')) throw new Error(`relay answered unarmored: HTTP ${r.status} ${respText.slice(0, 80)}`);
  const { plaintext } = native.openInbound(S.engine, respText);
  const doc = JSON.parse(plaintext.toString('utf8'));
  const match = native.matchReturn(S.engine, doc.in_reply_to, { purpose });
  if (!match.ok) throw new Error(`return-match failed: ${match.error}`);
  return { doc, body: doc.body_b64 ? Buffer.from(doc.body_b64, 'base64') : Buffer.alloc(0) };
}

async function postToRelay(rawText) {
  const t0 = now();
  const r = await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
    body: rawText, signal: AbortSignal.timeout(30_000),
  });
  const body = await r.text();
  return { status: r.status, body, ms: Math.round(now() - t0) };
}

// ------------------------------------------------- 1: redirects
try {
  const r = await egress.fetch('https://httpbin.org/absolute-redirect/2', { method: 'GET', purpose: 'interop-redirect' });
  const doc = await r.json();
  check('1a redirect chain (absolute-redirect/2) completes through the wrap; final body intact',
    r.status === 200 && doc.url === 'https://httpbin.org/get',
    `engine-visible status=${r.status} final url in body=${doc.url} return_match=${r.provenance.return_match}`);
  observe('1a-note: engine sees ONLY the final status/body — the intermediate 302 hops happen on the relay last hop and are not in provenance',
    `provenance keys: ${Object.keys(r.provenance).join(', ')}`);
} catch (e) { check('1a redirect chain completes through the wrap', false, String(e?.message || e)); }
try {
  const r = await egress.fetch('https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Fget&status_code=302', { method: 'GET', purpose: 'interop-redirect-to' });
  const doc = await r.json();
  check('1b redirect-to (302 to another path) completes; final body intact',
    r.status === 200 && doc.url === 'https://httpbin.org/get', `status=${r.status}`);
} catch (e) { check('1b redirect-to completes through the wrap', false, String(e?.message || e)); }

// ------------------------------------------------- 2: methods
try {
  const payload = JSON.stringify({ interop: 'put-case', n: 42 });
  const r = await egress.fetch('https://httpbin.org/anything', {
    method: 'PUT', purpose: 'interop-put',
    headers: { 'content-type': 'application/json' }, body: payload,
  });
  const doc = await r.json();
  check('2a PUT through the wrap: method + body echoed intact',
    r.status === 200 && doc.method === 'PUT' && doc.json?.interop === 'put-case' && doc.json?.n === 42,
    `status=${r.status} echoed method=${doc.method}`);
} catch (e) { check('2a PUT through the wrap', false, String(e?.message || e)); }
try {
  const r = await egress.fetch('https://httpbin.org/anything', { method: 'DELETE', purpose: 'interop-delete' });
  const doc = await r.json();
  check('2b DELETE through the wrap: status + echoed method survive',
    r.status === 200 && doc.method === 'DELETE', `status=${r.status} echoed method=${doc.method}`);
} catch (e) { check('2b DELETE through the wrap', false, String(e?.message || e)); }
try {
  const r = await egress.fetch('https://httpbin.org/get', { method: 'HEAD', purpose: 'interop-head' });
  const t = await r.text();
  check('2c HEAD through the wrap: status + headers survive, body empty as HEAD demands',
    r.status === 200 && t.length === 0 && !!r.headers['content-type'],
    `status=${r.status} body_len=${t.length} headers: ${Object.keys(r.headers).slice(0, 6).join(', ')}`);
} catch (e) { check('2c HEAD through the wrap', false, String(e?.message || e)); }

// ------------------------------------------------- 3: query + encoding
try {
  const longVal = 'x'.repeat(1500);
  const q = new URLSearchParams();
  q.set('name', '名前は値です');
  q.set('reserved', 'a=b&c=d?e');
  q.set('spaces', 'hello world + plus');
  q.set('long', longVal);
  const r = await egress.fetch(`https://httpbin.org/get?${q.toString()}`, { method: 'GET', purpose: 'interop-query' });
  const doc = await r.json();
  const args = doc.args || {};
  check('3 query string survives: unicode, reserved chars, spaces, 1500-char value all echoed exactly',
    args.name === '名前は値です' && args.reserved === 'a=b&c=d?e' &&
    args.spaces === 'hello world + plus' && args.long === longVal,
    `echoed keys: ${Object.keys(args).join(', ')}`);
} catch (e) { check('3 query string survives through the wrap', false, String(e?.message || e)); }

// ------------------------------------------------- 4: binary download (envelope layer bytes)
try {
  const { doc, body } = await relayRoundTrip(
    { method: 'GET', url: 'https://httpbin.org/image/png', headers: {}, body_b64: null },
    'interop-binary');
  const ref = Buffer.from(await (await fetch('https://httpbin.org/image/png')).arrayBuffer());
  check('4 binary (PNG) through the wrap: byte-for-byte hash match vs origin',
    doc.status === 200 && sha256(body) === sha256(ref),
    `wrapped sha=${sha256(body).slice(0, 16)}… origin sha=${sha256(ref).slice(0, 16)}… bytes=${body.length}`);
  observe('4-note: egress.fetch\'s engine-facing response exposes text()/json() only — byte fidelity was verified at the envelope layer (doc.body_b64) using armor-native\'s own wrap/open/match primitives, the same functions armor-egress composes');
} catch (e) { check('4 binary through the wrap', false, String(e?.message || e)); }

// ------------------------------------------------- 5: gzip
try {
  const r = await egress.fetch('https://httpbin.org/gzip', { method: 'GET', purpose: 'interop-gzip' });
  const doc = await r.json();
  check('5 gzip endpoint through the wrap: body arrives decoded and usable (JSON parses, gzipped flag true)',
    r.status === 200 && doc.gzipped === true,
    `status=${r.status} engine-visible content-encoding header: ${r.headers['content-encoding'] ?? '(absent)'} — decompression happened on the relay last hop (undici), body delivered decoded inside the envelope`);
} catch (e) { check('5 gzip through the wrap', false, String(e?.message || e)); }

// ------------------------------------------------- 6: structured JSON API (the project's own repo)
let ghOk = false;
try {
  const r = await egress.fetch('https://api.github.com/repos/ronininc/kingmaker', { method: 'GET', purpose: 'interop-github-repo' });
  const text = await r.text();
  let doc = null; try { doc = JSON.parse(text); } catch { /* recorded below */ }
  ghOk = r.status === 200 && doc?.full_name === 'ronininc/kingmaker';
  check('6 structured JSON API (api.github.com/repos/ronininc/kingmaker) through the wrap: full JSON parses',
    ghOk, `status=${r.status} full_name=${doc?.full_name ?? '(none)'} keys=${doc ? Object.keys(doc).length : 0}`);
  const rl = { limit: r.headers['x-ratelimit-limit'], remaining: r.headers['x-ratelimit-remaining'], reset: r.headers['x-ratelimit-reset'] };
  evidence.notes.githubRateHeaders = rl;
  check('6b API response headers (rate-limit set) visible engine-side through the envelope',
    !!rl.limit && !!rl.remaining, `x-ratelimit-limit=${rl.limit} remaining=${rl.remaining}`);
} catch (e) { check('6 structured JSON API through the wrap', false, String(e?.message || e)); }
if (!ghOk) {
  try {
    const r = await egress.fetch('https://api.github.com/users/ronininc', { method: 'GET', purpose: 'interop-github-user' });
    const doc = await r.json();
    observe('6-fallback: api.github.com/users/ronininc through the wrap',
      `status=${r.status} login=${doc?.login ?? '(none)'} type=${doc?.type ?? '(none)'}`);
  } catch (e) { observe('6-fallback also failed', String(e?.message || e)); }
}

// ------------------------------------------------- 7: his own production site (Cloudflare)
for (const path of ['/', '/kingmaker']) {
  try {
    const url = `https://ronininc.org${path}`;
    const r = await egress.fetch(url, { method: 'GET', purpose: 'interop-own-site' });
    const text = await r.text();
    const ref = await (await fetch(url)).text();
    check(`7 GET ${url} through the wrap (Cloudflare-fronted): status + body hash match vs direct`,
      r.status === 200 && sha256(text) === sha256(ref),
      `status=${r.status} wrapped sha=${sha256(text).slice(0, 16)}… direct sha=${sha256(ref).slice(0, 16)}… bytes=${text.length} server hdr=${r.headers['server'] ?? '(none)'}`);
  } catch (e) { check(`7 GET ronininc.org${path} through the wrap`, false, String(e?.message || e)); }
}

// ------------------------------------------------- 8: streaming / SSE-shaped endpoints
try {
  const t0 = now();
  const r = await egress.fetch('https://httpbin.org/stream/3', { method: 'GET', purpose: 'interop-stream' });
  const text = await r.text();
  const lines = text.split('\n').filter((l) => l.trim());
  check('8a chunked stream (/stream/3) through the wrap: completes, all 3 chunks present in the delivered body',
    r.status === 200 && lines.length === 3 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
    `status=${r.status} chunks=${lines.length} elapsed_ms=${Math.round(now() - t0)}`);
} catch (e) { check('8a chunked stream through the wrap', false, String(e?.message || e)); }
try {
  const t0 = now();
  const r = await egress.fetch('https://httpbin.org/drip?duration=4&numbytes=12&delay=1', { method: 'GET', purpose: 'interop-drip' });
  const text = await r.text();
  const elapsed = Math.round(now() - t0);
  observe('8b drip (4s stream) through the wrap: what actually happens',
    `status=${r.status} bytes=${text.length} elapsed_ms=${elapsed} — the relay buffers the FULL stream before sealing (await arrayBuffer in proof/relay.mjs); the engine receives nothing until the stream closes, then the whole body at once. A stream that never closes dies at the egress timeout (armor-egress timeoutMs default 20s). NO incremental delivery exists on this leg.`);
  check('8b drip completes buffered with the full body intact', r.status === 200 && text.length === 12, `bytes=${text.length}`);
} catch (e) {
  observe('8b drip through the wrap FAILED', String(e?.message || e));
  check('8b drip completes buffered', false, String(e?.message || e));
}

// ------------------------------------------------- 9: discrimination control (same run)
{
  const before = native.readBeacons(S.engine).length;
  const egressNoRelay = createArmorEgress({ state: S.engine, policy: 'native' });
  const refused = await egressNoRelay.gather('https://httpbin.org/get', { purpose: 'interop-control' });
  const beacons = native.readBeacons(S.engine).slice(before);
  check('9 discrimination control: unenrolled direct attempt at httpbin under native policy (no relay) refuses closed + beacons — in THIS run',
    refused.ok === false && refused.source.mode === 'refused' &&
    beacons.some((b) => b.event === 'egress-refused-unenrolled'),
    `mode=${refused.source.mode} beacon=${beacons.map((b) => b.event).join(',')}`);
}

// ------------------------------------------------- 10a: covered FORM raw to httpbin
const canaryPath = '/home/hatch/workspace/site-armor-test/public/armor-test/canary-package.scripture';
try {
  const covered = fs.readFileSync(canaryPath);
  const r = await fetch('https://httpbin.org/post', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
    body: covered,
  });
  const doc = await r.json();
  const echoedSha = typeof doc.data === 'string' ? sha256(Buffer.from(doc.data, 'utf8')) : '(no data)';
  check('10a covered package POSTed raw to httpbin.org/post: no block/challenge, body arrives byte-intact',
    r.status === 200 && echoedSha === sha256(covered),
    `status=${r.status} sent sha=${sha256(covered).slice(0, 16)}… echoed sha=${String(echoedSha).slice(0, 16)}… bytes=${covered.length}`);
} catch (e) { check('10a covered form raw to httpbin', false, String(e?.message || e)); }

// ------------------------------------------------- 10b: covered vs plain at the Cloudflare edge
async function edgeProbe(body, contentType) {
  const r = await fetch('https://ronininc.org/', {
    method: 'POST', headers: { 'content-type': contentType }, body,
  });
  const text = await r.text();
  return {
    status: r.status,
    cfRay: r.headers.get('cf-ray'), server: r.headers.get('server'),
    contentType: r.headers.get('content-type'),
    bodyHead: text.slice(0, 120).replace(/\s+/g, ' '),
    challenge: /attention required|just a moment|challenge-platform|cf-challenge/i.test(text),
  };
}
try {
  const covered = fs.readFileSync(canaryPath);
  const cov = await edgeProbe(covered, 'application/vnd.scripture-armor; v=3');
  const plain = await edgeProbe('interop control body — plain text probe', 'text/plain');
  evidence.notes.edgeCovered = cov; evidence.notes.edgePlain = plain;
  check('10b Cloudflare edge treats the covered body the SAME as a plain body (no bot challenge, no differential block)',
    cov.challenge === false && plain.challenge === false && cov.status === plain.status,
    `covered: status=${cov.status} cf-ray=${cov.cfRay ? 'yes' : 'no'} body="${cov.bodyHead.slice(0, 60)}…" | plain: status=${plain.status} cf-ray=${plain.cfRay ? 'yes' : 'no'} body="${plain.bodyHead.slice(0, 60)}…"`);
} catch (e) { check('10b covered vs plain at the Cloudflare edge', false, String(e?.message || e)); }

// ------------------------------------------------- 10c: large covered payload + burst
try {
  const big = ('Kingmaker interop large-payload probe. '.repeat(40000)).slice(0, 1_500_000); // ~1.5MB
  const bigSha = sha256(big);
  const r = await egress.fetch('https://httpbin.org/post', {
    method: 'POST', purpose: 'interop-large-relay',
    headers: { 'content-type': 'text/plain' }, body: big,
  });
  const doc = await r.json();
  check('10c-i ~1.5MB payload THROUGH THE RELAY LEG: arrives intact (echo hash match)',
    r.status === 200 && typeof doc.data === 'string' && sha256(doc.data) === bigSha,
    `status=${r.status} sent sha=${bigSha.slice(0, 16)}… echoed sha=${typeof doc.data === 'string' ? sha256(doc.data).slice(0, 16) : 'n/a'}…`);
  const { text: bigCovered } = await native.wrapEgress(S.engine, Buffer.from(big, 'utf8'), relayBlock, { purpose: 'interop-large-raw' });
  evidence.notes.bigCoveredBytes = Buffer.byteLength(bigCovered, 'utf8');
  const rr = await fetch('https://httpbin.org/post', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
    body: bigCovered,
  });
  const rdoc = await rr.json().catch(() => null);
  check('10c-ii the ~1.5MB payload\'s COVERED FORM (~2MB+ of glyph package) POSTed raw: arrives byte-intact, no size block',
    rr.status === 200 && typeof rdoc?.data === 'string' && sha256(Buffer.from(rdoc.data, 'utf8')) === sha256(Buffer.from(bigCovered, 'utf8')),
    `status=${rr.status} covered bytes=${evidence.notes.bigCoveredBytes}`);
} catch (e) { check('10c large covered payload handling', false, String(e?.message || e)); }
try {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const r = await egress.fetch(`https://httpbin.org/get?burst=${i}`, { method: 'GET', purpose: 'interop-burst' });
    statuses.push(r.status);
  }
  check('10c-iii burst of 12 small covered packets through the relay in rapid succession: no rate-limit/block triggered by the pattern',
    statuses.every((s) => s === 200), `statuses: ${statuses.join(',')}`);
} catch (e) { check('10c-iii burst of covered packets', false, String(e?.message || e)); }

// ------------------------------------------------- frame evidence (canary in cleartext — cross-ref)
await sleep(300);
try {
  const cap = readCapture(join(here, 'capture-interop-relay'), '.c2s');
  const start = cap.indexOf('SCRIPTURE-ARMOR');
  const parsed = armorLib.parseScriptureFile(cap.slice(start));
  evidence.frameFields = Object.keys(parsed.frame);
  observe('X-ref (daemon audit): the frame on THIS run\'s wire is cleartext JSON and the canary is visible in it',
    `frame fields: ${evidence.frameFields.join(', ')}; canary=${parsed.frame.canary.slice(0, 13)}… visible to any transit observer. Return-match on the generic leg trusts this canary — the fix build\'s responder pinning closes the responder half; the canary\'s visibility is by frame design.`);
} catch (e) { observe('X-ref frame parse from capture failed', String(e?.message || e)); }

// ------------------------------------------------- 11a: replay
const zenEnv = { method: 'GET', url: 'https://api.github.com/zen', headers: {}, body_b64: null };
const { text: reqPacket, frame: reqFrame } = await native.wrapEgress(
  S.engine, Buffer.from(JSON.stringify(zenEnv), 'utf8'), relayBlock, { purpose: 'interop-transit' });
native.noteSent(S.engine, { canary: reqFrame.canary, purpose: 'interop-transit', peer: reqFrame.recipient_seal_fp });
try {
  const countBefore = relayApiCount;
  const a1 = await postToRelay(reqPacket);
  const a2 = await postToRelay(reqPacket); // verbatim replay
  const opened1 = native.openInbound(S.engine, a1.body);
  const m1 = native.matchReturn(S.engine, JSON.parse(opened1.plaintext.toString('utf8')).in_reply_to, { purpose: 'interop-transit' });
  const opened2 = native.openInbound(S.engine, a2.body);
  const beaconMark = native.readBeacons(S.engine).length;
  const m2 = native.matchReturn(S.engine, JSON.parse(opened2.plaintext.toString('utf8')).in_reply_to, { purpose: 'interop-transit' });
  const newBeacons = native.readBeacons(S.engine).slice(beaconMark - 1);
  check('11a-i replayed REQUEST to the relay: relay re-performs the call (it holds no replay cache) — recorded, not hidden',
    a1.status === 200 && a2.status === 200 && relayApiCount === countBefore + 2,
    `relay API calls for 1 genuine + 1 replayed packet: ${relayApiCount - countBefore}`);
  check('11a-ii the closed loop refuses the replayed ANSWER: first answer matches, second is refused as return-replay + beaconed',
    m1.ok === true && m2.ok === false && m2.error === 'return-replay' &&
    native.readBeacons(S.engine).some((b) => b.event === 'return-replay' && b.canary === reqFrame.canary),
    `m1=${m1.ok} m2=${m2.ok}/${m2.error ?? ''}`);
  let strangerOpen = '';
  try { native.openInbound(S.stranger, a2.body); strangerOpen = 'OPENED (BAD)'; } catch (e) { strangerOpen = `refused: ${String(e?.message || e).slice(0, 60)}`; }
  check('11a-iii the replayed answer is worthless to the attacker: sealed to the engine, a stranger identity cannot open it',
    strangerOpen.startsWith('refused'), strangerOpen);
} catch (e) { check('11a replay handling', false, String(e?.message || e)); }

// ------------------------------------------------- 11b: bit-flip in transit
function flipGlyphChar(text) {
  const firstNl = text.indexOf('\n');
  const secondNl = text.indexOf('\n', firstNl + 1);
  const bodyStart = secondNl + 1;
  const pos = bodyStart + 40;
  const ch = text[pos];
  const cp = ch.codePointAt(0);
  const replacement = cp >= 0xE000 && cp <= 0xE07F
    ? String.fromCodePoint(0xE000 + ((cp - 0xE000 + 1) % 128))
    : '';
  return text.slice(0, pos) + replacement + text.slice(pos + 1);
}
try {
  const flipped = flipGlyphChar(reqPacket);
  const relayBeaconsBefore = native.readBeacons(S.relay).length;
  const apiCountBeforeFlip = relayApiCount;
  const fr = await postToRelay(flipped);
  evidence.oracle.push({ variant: 'bit-flipped glyph body → relay', status: fr.status, body: fr.body, ms: fr.ms });
  check('11b-i bit-flipped packet in transit is KILLED at the relay (AEAD/frame integrity), never processed — relay performed NO API call for it',
    fr.status === 400 && relayApiCount === apiCountBeforeFlip && !fr.body.startsWith('SCRIPTURE-ARMOR'),
    `relay HTTP ${fr.status}: "${fr.body.slice(0, 90)}" relay API calls delta=${relayApiCount - apiCountBeforeFlip}`);
  observe('11b-i-note: relay-side beacon record for the killed packet',
    `beacons on relay state before=${relayBeaconsBefore} after=${native.readBeacons(S.relay).length} — openInbound throws; the relay records NO beacon for transit kills on this leg (the beacon for a tampered RESPONSE lives engine-side only when the response is unarmored; see 11b-ii).`);
} catch (e) { check('11b-i bit-flip at the relay', false, String(e?.message || e)); }
// 11b-ii: tamper proxy between engine and relay flips one glyph in the RESPONSE
try {
  const tamperServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const up = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const text = await up.text();
    res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
    res.end(text.startsWith('SCRIPTURE-ARMOR') ? flipGlyphChar(text) : text);
  });
  await new Promise((r) => tamperServer.listen(P.tamper, '127.0.0.1', r));
  native.savePeers(S.engine, {
    'estate-relay': { block: relayBlock, endpoint: `http://127.0.0.1:${P.tamper}/` },
  });
  const egressTampered = createArmorEgress({ state: S.engine, policy: 'native', relayName: 'estate-relay' });
  const beaconsBefore = native.readBeacons(S.engine).length;
  let tamperError = '';
  try {
    await egressTampered.fetch('https://api.github.com/zen', { method: 'GET', purpose: 'interop-tamper' });
  } catch (e) { tamperError = String(e?.message || e); }
  const tamperBeacons = native.readBeacons(S.engine).slice(beaconsBefore);
  check('11b-ii bit-flipped RESPONSE in transit is killed engine-side: the call throws, tampered content is never delivered as data',
    tamperError.length > 0, `error: ${tamperError.slice(0, 110)}`);
  observe('11b-ii-note: engine-side beacon record for the tampered response',
    `new beacons: ${tamperBeacons.length ? JSON.stringify(tamperBeacons.map((b) => b.event)) : 'NONE — on the HTTP package/relay leg a glyph-flipped (still armor-shaped) response dies inside openInbound as a thrown AEAD error; no beacon is written for this class (contrast flow mode\'s flow-aead-failure beacon in the integration proof). Named limit, fix-build material.'}`);
  tamperServer.close();
  native.savePeers(S.engine, {
    'estate-relay': { block: relayBlock, endpoint: `http://127.0.0.1:${P.tapRelay}/` },
  });
} catch (e) { check('11b-ii tampered response handling', false, String(e?.message || e)); }

// ------------------------------------------------- 11c: frame-strip
try {
  const lines = reqPacket.split('\n');
  const bodyOnly = lines.slice(2).join('\n');
  const frameOnly = `${lines[0]}\n${lines[1]}\n`;
  const rb = await postToRelay(bodyOnly);
  const rf = await postToRelay(frameOnly);
  evidence.oracle.push({ variant: 'glyph body without frame → relay', status: rb.status, body: rb.body, ms: rb.ms });
  evidence.oracle.push({ variant: 'frame without body → relay', status: rf.status, body: rf.body, ms: rf.ms });
  check('11c-i glyph body WITHOUT its frame is useless: refused at parse',
    rb.status === 400, `relay HTTP ${rb.status}: "${rb.body.slice(0, 80)}"`);
  check('11c-ii frame WITHOUT its body is useless: refused, nothing opens',
    rf.status === 400, `relay HTTP ${rf.status}: "${rf.body.slice(0, 80)}"`);
} catch (e) { check('11c frame-strip handling', false, String(e?.message || e)); }

// ------------------------------------------------- 11e: error-oracle enumeration
async function oracleVariant(name, raw) {
  const r = await postToRelay(raw);
  evidence.oracle.push({ variant: name, status: r.status, body: r.body, ms: r.ms });
  return r;
}
try {
  await oracleVariant('plain garbage (not armor) → relay', 'hello this is not a scripture armor packet at all');
  // bad signature: flip one char inside the frame's sig value
  const fl = reqPacket.split('\n');
  const frameObj = JSON.parse(fl[1]);
  const sigKey = Object.keys(frameObj).find((k) => /sig/i.test(k)) || 'sig';
  const sigVal = String(frameObj[sigKey] ?? '');
  frameObj[sigKey] = (sigVal[0] === 'A' ? 'B' : 'A') + sigVal.slice(1);
  await oracleVariant('bad frame signature → relay', `${fl[0]}\n${JSON.stringify(frameObj)}\n${fl[2]}\n`);
  // unknown recipient: package sealed to the stranger
  const { text: wrongRecipient } = await native.wrapEgress(
    S.engine, Buffer.from(JSON.stringify(zenEnv), 'utf8'), strangerBlock, { purpose: 'interop-oracle' });
  await oracleVariant('package addressed to an unknown (non-relay) recipient → relay', wrongRecipient);
  // expired frame: sealPlaintext with a past expiry, engine → relay
  const relayPeer = armorLib.parsePublicBlock(relayBlock);
  const expired = armorLib.sealPlaintext(
    Buffer.from(JSON.stringify(zenEnv), 'utf8'), engineId, relayPeer,
    { expires: new Date(Date.now() - 3600_000).toISOString() });
  const countBeforeExp = relayApiCount;
  const expRes = await postToRelay(expired.text);
  evidence.oracle.push({ variant: 'EXPIRED frame → relay', status: expRes.status, body: expRes.body.slice(0, 80), ms: expRes.ms });
  check('11e-iv EXPIRED package on the relay leg: is expiry enforced by the opener (openInbound)?',
    expRes.status === 400,
    expRes.status === 200
      ? `NOT ENFORCED on this leg — the relay OPENED the expired package and performed the call (relay API calls +${relayApiCount - countBeforeExp}). vaultd.mjs enforces expiry (L1112/L1423); armor-native openInbound does not check frame.expiry. Named limit.`
      : `refused: HTTP ${expRes.status}`);
  // stranger SENDER: a well-formed package FROM an unenrolled identity, addressed TO the relay
  const strangerEnv = { method: 'GET', url: 'https://api.github.com/zen', headers: {}, body_b64: null };
  const { text: strangerPacket } = await native.wrapEgress(
    S.stranger, Buffer.from(JSON.stringify(strangerEnv), 'utf8'), relayBlock, { purpose: 'interop-oracle-stranger' });
  const countBeforeStranger = relayApiCount;
  const strRes = await postToRelay(strangerPacket);
  evidence.oracle.push({ variant: 'well-formed package from an UNENROLLED sender → relay', status: strRes.status, body: strRes.body.slice(0, 80), ms: strRes.ms });
  check('11e-v sender authentication on the relay leg: does the relay perform calls for a sender it has never enrolled?',
    strRes.status === 400,
    strRes.status === 200
      ? `NO SENDER AUTHENTICATION on this leg — the relay opened a package from a never-enrolled stranger identity and performed the call (relay API calls +${relayApiCount - countBeforeStranger}). openInbound verifies the frame signature against the key EMBEDDED IN THE FRAME and checks only that the package is addressed to the relay; expectSenderSignFp exists but no call site passes it (daemon audit). Anyone holding the relay's PUBLIC block can drive it. Named limit — the fix build's responder/sender pinning closes it.`
      : `refused: HTTP ${strRes.status}`);
  // unknown canary (response-side, engine's own matchReturn — the code packageRoundTrip composes)
  const fakeDoc = JSON.stringify({ in_reply_to: randomUUID(), status: 200, headers: {}, body_b64: Buffer.from('forged').toString('base64') });
  const { text: forgedResp } = await native.wrapEgress(S.relay, Buffer.from(fakeDoc, 'utf8'), engineBlock, { purpose: 'interop-oracle' });
  const openedForged = native.openInbound(S.engine, forgedResp);
  const fm = native.matchReturn(S.engine, JSON.parse(openedForged.plaintext.toString('utf8')).in_reply_to, { purpose: 'interop-oracle' });
  check('11e-vi response naming an UNKNOWN canary: engine refuses it (return-unknown-canary) + beacons',
    fm.ok === false && fm.error === 'return-unknown-canary' &&
    native.readBeacons(S.engine).some((b) => b.event === 'return-unknown-canary'),
    `matchReturn: ${fm.error}`);
  // oracle uniformity verdict
  const distinct = new Set(evidence.oracle.map((o) => `${o.status}|${String(o.body).slice(0, 60)}`));
  observe('11e-oracle: are the relay\'s refusals uniform to an active transit attacker who re-POSTs variants and reads the 400 bodies?',
    `${evidence.oracle.length} variants produced ${distinct.size} distinguishable (status|body) signals. The relay answers every failure with HTTP 400 and a PLAIN-TEXT body naming the exact failure class ('relay error: …'), readable by whoever POSTed — and, on a link an observer can read, by that observer too. A passive observer of the sealed leg itself learns nothing (traffic is packages); an ACTIVE attacker gets a full failure-class oracle at the relay's HTTP surface. Full enumeration in results.json evidence.oracle.`);
} catch (e) { check('11e oracle enumeration', false, String(e?.message || e)); }

// ---------------------------------------------------------------- wrap
evidence.provenance = native.readProvenance(S.engine).filter((r) => String(r.purpose || '').startsWith('interop'));
fs.writeFileSync(join(here, 'results.json'), JSON.stringify({ results, evidence }, null, 2));
const failed = results.filter((r) => r.ok === false);
const passed = results.filter((r) => r.ok === true);
const observed = results.filter((r) => r.ok === null);
console.log(`\n==== interop: ${passed.length} passed, ${failed.length} failed, ${observed.length} observations ====`);
console.log('relay→API legs:', JSON.stringify(evidence.relayLeg));
process.exit(0);
