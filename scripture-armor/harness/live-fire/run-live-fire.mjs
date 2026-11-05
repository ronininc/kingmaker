// live-fire/run-live-fire.mjs — Scripture Armor vs the REAL internet.
//
// Everything prior ran on loopback with stubs. This run uses ONLY the
// code's own paths (createArmorEgress relay/package/refused modes,
// the v3 frame format, the proof relay pattern with its DEFAULT real
// fetch — no URL substitution, no stub) against real public endpoints:
//
//   engine →(armor package, tapped)→ estate relay →(plain HTTPS)→
//     https://api.github.com/zen        (GET)
//     https://httpbin.org/post          (POST, echo)
//     https://httpbin.org/headers       (GET, echo — API-side view)
//   engine →(armor package, tapped)→ enrolled peer bound to the VM's
//     NON-LOOPBACK interface address    (package round trip)
//   engine → unenrolled target, native policy, no relay → refused
//
// Exit 0 only if every check passes. Output + results.json are the
// evidence; LIVE-FIRE-REPORT.md is written from them.

import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as native from '../../../lib/armor-native.mjs';
import { createArmorEgress } from '../../../lib/armor-egress.mjs';
import * as armorLib from '../../armor.mjs';
import { startRelay } from '../proof/relay.mjs';
import { startTap, readCapture } from '../proof/tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT_IP = '198.19.0.2'; // this VM's non-loopback interface (host0)
const P = { relay: 19711, tapRelay: 19712, peer: 19713, tapPeer: 19714 };
const S = {
  engine: join(here, 'state-engine'),
  relay: join(here, 'state-relay'),
  peer: join(here, 'state-peer'),
  fresh: join(here, 'state-fresh'),
};
for (const d of Object.values(S)) fs.rmSync(d, { recursive: true, force: true });

const results = [];
const evidence = { timings: {}, relayLeg: [], frameFields: null, apiSawHeaders: null, apiSawOrigin: null };
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// A tap that can sit on a non-loopback interface — same byte-for-byte
// capture discipline as proof/tap.mjs, parameterized by host.
function startTapOn({ host, listenPort, targetHost, targetPort, captureBase }) {
  const c2s = fs.createWriteStream(captureBase + '.c2s');
  const s2c = fs.createWriteStream(captureBase + '.s2c');
  const server = net.createServer((client) => {
    const upstream = net.createConnection(targetPort, targetHost);
    client.on('data', (d) => { c2s.write(d); upstream.write(d); });
    upstream.on('data', (d) => { s2c.write(d); client.write(d); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.end());
    upstream.on('close', () => client.end());
  });
  return new Promise((resolve) => server.listen(listenPort, host, () => resolve({ server, port: listenPort })));
}

// An enrolled armor peer bound to the external interface: unwraps the
// envelope with armor-native (the relay.mjs pattern), answers with an
// echo digest sealed back, return-matched by the engine by canary.
function startExtPeer({ state, engineBlock, host, port }) {
  native.ensureIdentity(state, 'ext-peer');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      // Sender pinning: the peer's only enrolled contact is the engine.
      const opened = native.openInbound(state, raw, { expectSenderSignFp: native.signFpOfBlock(engineBlock) });
      const env = JSON.parse(opened.plaintext.toString('utf8'));
      const bodyBuf = env.body_b64 ? Buffer.from(env.body_b64, 'base64') : Buffer.alloc(0);
      const doc = JSON.stringify({
        in_reply_to: opened.frame.canary,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body_b64: Buffer.from(JSON.stringify({
          peer: 'ext-peer', echo_sha256: sha256(bodyBuf), received_bytes: bodyBuf.length,
        }), 'utf8').toString('base64'),
      });
      const { text } = await native.wrapEgress(state, Buffer.from(doc, 'utf8'), engineBlock, { purpose: 'package-response' });
      res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
      res.end(text);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`ext-peer error: ${e?.message || e}`);
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port })));
}

// ---------------------------------------------------------------- setup
native.ensureIdentity(S.engine, 'kingmaker-engine');
const engineBlock = native.publicBlockOf(S.engine);
const relayId = native.ensureIdentity(S.relay, 'estate-relay');
const relayBlock = armorLib.publicBlock(relayId);
const peerId = native.ensureIdentity(S.peer, 'ext-peer');
const peerBlock = armorLib.publicBlock(peerId);

// The relay with its DEFAULT real fetch — instrumented only for
// timing (startRelay takes fetchImpl by design; the proof used the
// same parameter to substitute, here it only observes).
const timedFetch = async (url, opts) => {
  const t0 = now();
  const r = await fetch(url, opts);
  evidence.relayLeg.push({ url: String(url), ms: Math.round(now() - t0), status: r.status });
  return r;
};
await startRelay({ state: S.relay, engineBlock, port: P.relay, fetchImpl: timedFetch });
await startTap({ listenPort: P.tapRelay, targetPort: P.relay, captureBase: join(here, 'capture-live-relay') });
await startExtPeer({ state: S.peer, engineBlock, host: EXT_IP, port: P.peer });
await startTapOn({ host: EXT_IP, listenPort: P.tapPeer, targetHost: EXT_IP, targetPort: P.peer, captureBase: join(here, 'capture-live-peer') });

native.savePeers(S.engine, {
  'estate-relay': { block: relayBlock, endpoint: `http://127.0.0.1:${P.tapRelay}/` },
  [EXT_IP]: { block: peerBlock, endpoint: `http://${EXT_IP}:${P.tapPeer}/` },
});
const egress = createArmorEgress({ state: S.engine, policy: 'native', relayName: 'estate-relay' });

// ------------------------------------------- L1: relay GET, real API
let zenText = '';
try {
  const t0 = now();
  const r = await egress.fetch('https://api.github.com/zen', { method: 'GET', purpose: 'live-fire-zen' });
  evidence.timings.zen_roundtrip_ms = Math.round(now() - t0);
  zenText = await r.text();
  evidence.zen = { status: r.status, body_sha256: sha256(zenText), body_len: zenText.length };
  check('L1 relay GET https://api.github.com/zen completes through the wrap', r.ok === true && r.status === 200 && zenText.length > 0,
    `status=${r.status} ms=${evidence.timings.zen_roundtrip_ms} body="${zenText.trim().slice(0, 60)}"`);
  check('L1b zen provenance: mode relay, return-matched, answered by the relay identity',
    r.provenance.mode === 'relay' && r.provenance.return_match === true && r.provenance.answered_by_sign_fp === relayId.signFp);
} catch (e) {
  check('L1 relay GET https://api.github.com/zen completes through the wrap', false, String(e?.message || e));
}

// ------------------------------------------- L2: relay POST, echo, body + secret header
const SECRET = 'Bearer LIVE-FIRE-SECRET-7c41d9';
const MARKER = 'LIVE-FIRE-PAYLOAD-MARKER-3f8a2c';
const postBody = JSON.stringify({ marker: MARKER, nonce: 'lf-2026-10-25', nested: { a: [1, 2, 3], s: 'round-trip me' } });
const postSha = sha256(postBody);
try {
  const t0 = now();
  const r = await egress.fetch('https://httpbin.org/post', {
    method: 'POST', purpose: 'live-fire-post',
    headers: { authorization: SECRET, 'content-type': 'application/json' },
    body: postBody,
  });
  evidence.timings.post_roundtrip_ms = Math.round(now() - t0);
  const echoed = await r.json();
  evidence.apiSawOrigin = echoed.origin || null;
  check('L2 relay POST https://httpbin.org/post completes through the wrap', r.ok === true && r.status === 200,
    `status=${r.status} ms=${evidence.timings.post_roundtrip_ms}`);
  check('L2b request body survived the round trip byte-for-byte (echo hash match)',
    typeof echoed.data === 'string' && sha256(echoed.data) === postSha,
    `sent sha=${postSha.slice(0, 16)}… echoed sha=${typeof echoed.data === 'string' ? sha256(echoed.data).slice(0, 16) : 'n/a'}…`);
  check('L2c parsed JSON round trip intact', echoed.json?.marker === MARKER && echoed.json?.nested?.s === 'round-trip me');
  const apiAuth = echoed.headers?.Authorization || echoed.headers?.authorization || '';
  check('L2d the API received the Authorization value — delivered INSIDE the envelope, applied by the relay',
    apiAuth === SECRET, `api saw: ${apiAuth ? apiAuth.slice(0, 22) + '…' : '(none)'}`);
} catch (e) {
  check('L2 relay POST https://httpbin.org/post completes through the wrap', false, String(e?.message || e));
}

// ------------------------------------------- L3: API-side view (exposure vantage b)
try {
  const t0 = now();
  const r = await egress.fetch('https://httpbin.org/headers', { method: 'GET', purpose: 'live-fire-headers' });
  evidence.timings.headers_roundtrip_ms = Math.round(now() - t0);
  const doc = await r.json();
  evidence.apiSawHeaders = doc.headers || {};
  check('L3 relay GET https://httpbin.org/headers completes; API-side header set captured for the exposure audit',
    r.ok === true && !!doc.headers, Object.keys(doc.headers || {}).join(', '));
} catch (e) {
  check('L3 relay GET https://httpbin.org/headers completes', false, String(e?.message || e));
}

// ------------------------------------------- L4: wire capture, engine→relay leg
await sleep(300);
const capRelay = readCapture(join(here, 'capture-live-relay'), '.c2s') + readCapture(join(here, 'capture-live-relay'), '.s2c');
check('L4 engine↔relay wire shows Scripture Armor v3 packages', capRelay.includes('SCRIPTURE-ARMOR v3'));
check('L4b wire does NOT show the secret header value', !capRelay.includes(SECRET) && !capRelay.includes('LIVE-FIRE-SECRET'));
check('L4c wire does NOT show the POST payload marker or plaintext', !capRelay.includes(MARKER) && !capRelay.includes('round-trip me'));
check('L4d wire does NOT show the zen response plaintext', zenText.trim().length > 0 && !capRelay.includes(zenText.trim()));
check('L4e wire does NOT name the target hosts (destination inside the envelope only)',
  !capRelay.includes('api.github.com') && !capRelay.includes('httpbin.org'));
check('L4f wire body is glyph armor (PUA / Linear A / Cuneiform ranges)', [...capRelay].some((ch) => {
  const cp = ch.codePointAt(0);
  return (cp >= 0xE000 && cp <= 0xE07F) || (cp >= 0x10600 && cp <= 0x1063F) || (cp >= 0x12000 && cp <= 0x1203F);
}));
try {
  const start = capRelay.indexOf('SCRIPTURE-ARMOR');
  const parsed = armorLib.parseScriptureFile(capRelay.slice(start));
  evidence.frameFields = Object.fromEntries(Object.entries(parsed.frame).map(([k, v]) => [k, String(v).slice(0, 48)]));
  check('L4g captured package parses as a v3 frame; field set recorded for the exposure audit', parsed.frame.v === 3,
    Object.keys(parsed.frame).join(', '));
} catch (e) {
  check('L4g captured package parses as a v3 frame', false, String(e?.message || e));
}

// ------------------------------------------- L5: package mode over the non-loopback interface
const pkgBody = JSON.stringify({ marker: MARKER, leg: 'non-loopback-package' });
try {
  const t0 = now();
  const r = await egress.fetch(`http://${EXT_IP}:${P.peer}/echo`, {
    method: 'POST', purpose: 'live-fire-package',
    headers: { 'content-type': 'application/json' }, body: pkgBody,
  });
  evidence.timings.package_roundtrip_ms = Math.round(now() - t0);
  const doc = await r.json();
  check('L5 package round trip to enrolled peer on the NON-LOOPBACK interface completes',
    r.ok === true && doc.peer === 'ext-peer', `status=${r.status} ms=${evidence.timings.package_roundtrip_ms}`);
  check('L5b peer received the body intact (echo hash match) and the answer was return-matched',
    doc.echo_sha256 === sha256(pkgBody) && r.provenance.mode === 'package' && r.provenance.return_match === true);
} catch (e) {
  const cause = e?.cause ? ` cause=${e.cause.code || ''} ${e.cause.message || ''}` : '';
  check('L5 package round trip over the non-loopback interface completes', false, `${e?.message || e}${cause}`);
  evidence.l5_transport_error = `${e?.message || e}${cause}`;
  // Failure attribution controls — harness-level, aimed ONLY at this
  // test's own peer, to separate "armor failed" from "this sandbox's
  // network layer refuses self-connections via the external address":
  const tcpOk = await new Promise((resolve) => {
    const c = net.createConnection(P.peer, EXT_IP);
    c.on('connect', () => { c.end(); resolve(true); });
    c.on('error', () => resolve(false));
    setTimeout(() => { c.destroy(); resolve(false); }, 4000);
  });
  check('L5d control: the peer IS bound and accepts TCP on the non-loopback interface', tcpOk);
  const plain = await new Promise((resolve) => {
    const req = http.request({ host: EXT_IP, port: P.peer, path: '/echo', method: 'POST', timeout: 5000 }, (res) => {
      res.resume(); res.on('end', () => resolve({ ok: true, status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, error: `${err.code || ''} ${err.message}` }));
    req.end('plaintext-control');
  });
  evidence.l5_plain_control = plain;
  check('L5e control: PLAINTEXT http to the same address fails identically — transport-level, armor not involved',
    plain.ok === false, plain.ok ? `unexpectedly succeeded status=${plain.status}` : plain.error);
}
await sleep(300);
const capPeer = readCapture(join(here, 'capture-live-peer'), '.c2s') + readCapture(join(here, 'capture-live-peer'), '.s2c');
check('L5c non-loopback wire shows packages only — no payload marker in the clear',
  capPeer.includes('SCRIPTURE-ARMOR v3') && !capPeer.includes(MARKER) && !capPeer.includes('non-loopback-package'));

// ------------------------------------------- L6: negative controls (fail closed)
const egressNoRelay = createArmorEgress({ state: S.engine, policy: 'native' });
const refused1 = await egressNoRelay.gather('https://api.github.com/zen', { purpose: 'live-fire-control' });
check('L6 native policy WITHOUT the relay refuses the same real-API call (fail-closed)',
  refused1.ok === false && refused1.source.mode === 'refused', refused1.error?.slice(0, 90) || '');
const egressFresh = createArmorEgress({ state: S.fresh, policy: 'native' });
const refused2 = await egressFresh.gather('https://httpbin.org/get', { purpose: 'live-fire-control' });
check('L6b a fresh install with NO enrollments at all refuses too',
  refused2.ok === false && refused2.source.mode === 'refused');
check('L6c both refusals are in the beacon record',
  native.readBeacons(S.engine).some((b) => b.event === 'egress-refused-unenrolled') &&
  native.readBeacons(S.fresh).some((b) => b.event === 'egress-refused-unenrolled'));

// ---------------------------------------------------------------- wrap
evidence.provenance = native.readProvenance(S.engine).filter((r) => String(r.purpose || '').startsWith('live-fire'));
fs.writeFileSync(join(here, 'results.json'), JSON.stringify({ results, evidence }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n==== live-fire: ${results.length - failed.length} passed, ${failed.length} failed ====`);
console.log('timings:', JSON.stringify(evidence.timings), 'relay→API legs:', JSON.stringify(evidence.relayLeg));
process.exit(failed.length ? 1 : 0);
