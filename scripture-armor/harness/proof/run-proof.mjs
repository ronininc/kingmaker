// proof/run-proof.mjs — the armor-native integration proof.
//
// Runs the REAL engine modules and the REAL armor library, in the
// built tree's own layout (engine/ beside scripture-armor/), against
// local harness endpoints standing in for the fleet front door, an
// estate relay, a public API, and a flow peer. A TCP tap sits on the
// fleet and relay legs: the capture files are what an observer of
// the wire would see, and the assertions read them exactly that way.
//
// Transport substitution, stated once and plainly: the fleet config
// requires an https:// URL (production front doors are HTTPS
// workers). The harness door is a loopback HTTP server, so the
// engine's fetchImpl rewrites https://127.0.0.1:<tap> to http for the
// last loopback hop only. The armor wrap being proven is identical
// either way; TLS to a production door is orthogonal to it, and the
// relay leg uses the same substitution for its last hop to the stub.
//
// Exit 0 only if every assertion passes. Output is the evidence.

import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as native from '../../../lib/armor-native.mjs';
import { createArmorEgress } from '../../../lib/armor-egress.mjs';
import { fleetTransport, installSecret } from '../../../lib/fleet-transport.mjs';
import * as bridge from '../../../surface/kernel/armor-bridge.mjs';
import * as armorLib from '../../armor.mjs';
import { Flow } from '../../refit-net.mjs';
import { startFleetHost } from './fleet-host.mjs';
import { startRelay, startApiStub, API_MARKER } from './relay.mjs';
import { startTap, readCapture } from './tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const P = {
  host: 18711, tapFleet: 18712, stub: 18713, relay: 18714, tapRelay: 18715, flow: 18716, tapLegacy: 18722,
};
const S = {
  engine: join(here, 'state-engine'), host: join(here, 'state-host'),
  relay: join(here, 'state-relay'), flowpeer: join(here, 'state-flowpeer'),
  legacy: join(here, 'state-engine-legacy'), kernel: join(here, 'state-kernel'),
};
for (const d of Object.values(S)) fs.rmSync(d, { recursive: true, force: true });

const results = [];
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- setup
native.ensureIdentity(S.engine, 'kingmaker-engine');
const engineBlock = native.publicBlockOf(S.engine);
const hostId = native.ensureIdentity(S.host, 'fleet-host');
const relayId = native.ensureIdentity(S.relay, 'estate-relay');
const flowId = native.ensureIdentity(S.flowpeer, 'flow-peer');
const hostBlock = armorLib.publicBlock(hostId);
const relayBlock = armorLib.publicBlock(relayId);
const flowBlock = armorLib.publicBlock(flowId);
check('setup: identities created and public blocks parse', (() => {
  try { armorLib.parsePublicBlock(engineBlock); armorLib.parsePublicBlock(hostBlock); return true; } catch { return false; }
})());

native.savePeers(S.engine, {
  'estate-relay': { block: relayBlock, endpoint: `http://127.0.0.1:${P.tapRelay}/` },
  flowpeer: { block: flowBlock, mode: 'flow', flowPort: P.flow, flowHost: '127.0.0.1' },
});

const host = await startFleetHost({ state: S.host, engineBlock, port: P.host });
await startTap({ listenPort: P.tapFleet, targetPort: P.host, captureBase: join(here, 'capture-fleet') });
await startTap({ listenPort: P.tapLegacy, targetPort: P.host, captureBase: join(here, 'capture-legacy') });
await startApiStub({ port: P.stub });
await startRelay({
  state: S.relay, engineBlock, port: P.relay,
  fetchImpl: (url, opts) => fetch(String(url).replace('https://api.example.test', `http://127.0.0.1:${P.stub}`), opts),
});
await startTap({ listenPort: P.tapRelay, targetPort: P.relay, captureBase: join(here, 'capture-relay') });

// ------------------------------------------------- B: fleet, wrapped
const MARKER = 'PLAINTEXT-MARKER-7f3d9c';
const HASH = sha256('proof-manifest-contents');
const packet = {
  installationId: 'inst-proof-1', packetId: 'pkt-proof-1', kind: 'fleet-learning',
  payload: { marker: MARKER, manifestSha256: HASH, note: 'operational knowledge, personal data stays local' },
};
const fleetEnv = {
  KINGMAKER_FLEET_URL: `https://127.0.0.1:${P.tapFleet}`,
  KINGMAKER_FLEET_KEY: host.publicKeyPem,
  KINGMAKER_FLEET_ARMOR_PEER: hostBlock,
};
const loopbackFetch = (tapPort) => (url, opts) =>
  fetch(String(url).replace(`https://127.0.0.1:${tapPort}`, `http://127.0.0.1:${tapPort}`), opts);

const fleet = fleetTransport({ state: S.engine, env: fleetEnv, fetchImpl: loopbackFetch(P.tapFleet) });
const sent = await fleet.send(packet);
check('B1 fleet contribute through the wrap completes', sent.ok === true && sent.armored === true, JSON.stringify(sent).slice(0, 160));
check('B2 signed fleet receipt verified THROUGH the wrap', sent.receipt?.accepted === true);
const forgot = await fleet.forgetRemote('inst-proof-1');
check('B3 fleet forget through the wrap completes', forgot.ok === true && forgot.armored === true);
await sleep(300);
const capF = readCapture(join(here, 'capture-fleet'), '.c2s');
check('B4 wire shows Scripture Armor packages', capF.includes('SCRIPTURE-ARMOR v3'));
check('B5 wire does NOT show the packet plaintext marker', !capF.includes(MARKER));
check('B6 wire does NOT show the transmitted hash in the clear', !capF.includes(HASH));
check('B7 wire does NOT show the install proof secret', !capF.includes(installSecret(S.engine)));
check('B8 wire body is glyph armor (PUA / Linear A / Cuneiform ranges)', [...capF].some((ch) => {
  const cp = ch.codePointAt(0);
  return (cp >= 0xE000 && cp <= 0xE07F) || (cp >= 0x10600 && cp <= 0x1063F) || (cp >= 0x12000 && cp <= 0x1203F);
}));
const provAfterFleet = native.readProvenance(S.engine);
const fleetProv = provAfterFleet.find((r) => r.kind === 'egress' && r.purpose === 'fleet-contribute');
check('B9 provenance: fleet leg recorded, answered by the host identity, return-matched',
  !!fleetProv && fleetProv.mode === 'package' && fleetProv.return_match === true && fleetProv.answered_by_sign_fp === hostId.signFp,
  fleetProv ? `answered_by=${fleetProv.answered_by_sign_fp}` : 'no record');

// ------------------------------------------------- C: legacy control
const legacyEnv = { KINGMAKER_FLEET_URL: `https://127.0.0.1:${P.tapLegacy}`, KINGMAKER_FLEET_KEY: host.publicKeyPem };
const legacy = fleetTransport({ state: S.legacy, env: legacyEnv, fetchImpl: loopbackFetch(P.tapLegacy) });
const legacySent = await legacy.send(packet);
await sleep(300);
const capL = readCapture(join(here, 'capture-legacy'), '.c2s');
check('C1 legacy (unenrolled) contribute still works — compatibility kept', legacySent.ok === true);
check('C2 CONTROL: legacy wire DOES show the plaintext marker (the wrap is the difference)', capL.includes(MARKER));

// --------------------------------------- D: return-match negatives
const forged = await native.wrapEgress(S.host, Buffer.from(JSON.stringify({ in_reply_to: 'canary-never-sent', receipt: null }), 'utf8'), engineBlock, { purpose: 'proof-forged' });
const openedForged = native.openInbound(S.engine, forged.text, { expectSenderSignFp: hostId.signFp });
const forgedDoc = JSON.parse(openedForged.plaintext.toString('utf8'));
const m1 = native.matchReturn(S.engine, forgedDoc.in_reply_to, { purpose: 'proof' });
check('D1 response naming a never-sent canary is refused as a beacon', m1.ok === false && m1.error === 'return-unknown-canary');
const realCanary = fleetProv?.canary;
const m2 = native.matchReturn(S.engine, realCanary, { purpose: 'proof' });
check('D2 a second answer to an answered request is refused as replay', m2.ok === false && m2.error === 'return-replay');
check('D3 both refusals are in the beacon record', native.readBeacons(S.engine).filter((b) => b.event?.startsWith('return-')).length >= 2);

// ------------------------------------------------- E: flow leg
function startFlowEcho({ state, port }) {
  const me = armorLib.loadIdentity(native.identityDir(state));
  const server = net.createServer((conn) => {
    let buf = ''; let flow = null;
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8'); let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { conn.destroy(); return; }
        if (!flow) {
          flow = new Flow(me, msg.from_sign_fp, {});
          const acc = flow.acceptHello(msg);
          if (!acc.ok) { conn.destroy(); return; }
          conn.write(JSON.stringify(flow.hello()) + '\n'); continue;
        }
        if (msg.receipt_request) { conn.write(JSON.stringify({ receipt: flow.receipt() }) + '\n'); continue; }
        const r = flow.receive(msg);
        if (!r.ok) { conn.destroy(); return; }
        const s = flow.send(Buffer.concat([Buffer.from('echo:'), r.plaintext]));
        if (s.ok) conn.write(JSON.stringify(s.frame) + '\n');
      }
    });
    conn.on('error', () => {});
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server })));
}
await startFlowEcho({ state: S.flowpeer, port: P.flow });
const egress = createArmorEgress({ state: S.engine, policy: 'native', relayName: 'estate-relay' });
const fx = await egress.flowExchange('flowpeer', Buffer.from('research-payload-1'), { purpose: 'gather' });
check('E1 flow exchange round-trips a payload', fx.replies.length >= 1 && fx.replies[0].toString() === 'echo:research-payload-1');
check('E2 RETURN-HASH LOOP: peer chain receipt verifies against the sent chain', fx.provenance.receipt_verified === true && fx.provenance.chain_head === fx.flow.sentHead, `head=${fx.provenance.chain_head}`);

const idA = armorLib.loadIdentity(native.identityDir(S.engine));
const idB = armorLib.loadIdentity(native.identityDir(S.flowpeer));
{
  const a = new Flow(idA, idB.signFp, {}); const b = new Flow(idB, idA.signFp, {});
  b.acceptHello(a.hello()); a.acceptHello(b.hello());
  const fr = a.send(Buffer.from('secret-payload'));
  const raw = Buffer.from(fr.frame.body_b64, 'base64'); raw[3] ^= 1;
  const tampered = b.receive({ counter: fr.frame.counter, body_b64: raw.toString('base64') });
  check('E3 one flipped byte kills the flow and raises its beacon', tampered.ok === false && b.beacons.length >= 1, tampered.error || '');
}
{
  const a = new Flow(idA, idB.signFp, {}); const b = new Flow(idB, idA.signFp, {});
  b.acceptHello(a.hello()); a.acceptHello(b.hello());
  const sentFrame = a.send(Buffer.from('counted-payload'));
  b.receive(sentFrame.frame);
  const good = b.receipt();
  const forgedReceipt = armorLib.signPayload(idB, { type: 'flow-receipt', body: { flow_id: b.flowId, head: '00'.repeat(32), count: a.sendCounter } });
  check('E4 a signed receipt with the wrong chain head is refused', a.verifyReceipt(good).ok === true && a.verifyReceipt(forgedReceipt).ok === false);
}

// --------------------------------------- F: relay leg + sensing
const APIKEY = 'sk-proof-SECRETKEY-9e1b';
const relayRes = await egress.fetch('https://api.example.test/v1/chat', {
  method: 'POST', purpose: 'model-call',
  headers: { 'x-api-key': APIKEY, 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'hello' }),
});
const relayJson = await relayRes.json();
check('F1 public-API call completes through the estate relay', relayRes.ok === true && relayJson.marker === API_MARKER);
check('F2 the API key crossed INSIDE the wrap (stub saw it; it was never a wire header)', relayJson.sawApiKey === true);
await sleep(300);
const capR = readCapture(join(here, 'capture-relay'), '.c2s') + readCapture(join(here, 'capture-relay'), '.s2c');
check('F3 engine↔relay wire shows no API key, no prompt, no response plaintext',
  !capR.includes(APIKEY) && !capR.includes('prompt') && !capR.includes(API_MARKER) && capR.includes('SCRIPTURE-ARMOR v3'));
check('F4 relay provenance names the answering relay identity', relayRes.provenance.answered_by_sign_fp === relayId.signFp && relayRes.provenance.mode === 'relay');

const egressNative = createArmorEgress({ state: S.engine, policy: 'native' });
const refused = await egressNative.gather('https://api.anthropic.com/v1/messages', { purpose: 'gather' });
check('F5 native policy refuses an unenrolled target (fail-closed, and the refusal is provenance)',
  refused.ok === false && refused.source.mode === 'refused');
const egressResid = createArmorEgress({
  state: S.engine, policy: 'residual-direct',
  fetchImpl: (url, opts) => fetch(String(url).replace('api-stub.local', '127.0.0.1:' + P.stub), opts),
});
const direct = await egressResid.gather('http://api-stub.local/data', { purpose: 'gather' });
check('F6 residual-direct leg works and is NAMED unwrapped in its provenance',
  direct.ok === true && direct.source.mode === 'direct-residual' && direct.source.unwrapped === true);
const provAll = native.readProvenance(S.engine);
check('F7 sensing ledger: fleet + relay + refusal all readable as source provenance',
  provAll.some((r) => r.answered_by_sign_fp === hostId.signFp) &&
  provAll.some((r) => r.answered_by_sign_fp === relayId.signFp) &&
  provAll.some((r) => r.mode === 'refused'));

// ------------------------------------------------- G: hashes wrapped
const HASH2 = sha256('release-unit-manifest');
const pub = await native.publishHashWrapped(S.engine, HASH2, hostBlock);
const parsed = armorLib.parseScriptureFile(pub.text);
check('G1 published hash does not appear anywhere in the package', !pub.text.includes(HASH2));
check('G2 the visible frame carries only the keyed commitment (no checkable relation)', armorLib.frameDigestKind(parsed.frame) === 'commit', armorLib.frameDigestKind(parsed.frame));
const openedHash = native.openInbound(S.host, pub.text, { expectSenderSignFp: native.signFpOfBlock(engineBlock) });
check('G3 the enrolled target opens the package and recovers the hash inside', JSON.parse(openedHash.plaintext.toString('utf8')).sha256 === HASH2);

// ------------------------------------------------- H: Addendum D
const codeBytes = fs.readFileSync(join(here, '..', '..', '..', 'lib', 'fleet-transport.mjs'));
const subj = native.wrapSubject('kingmaker', codeBytes);
check('H1 Addendum D: the armor refuses Kingmaker as a subject', subj.ok === false && /addendum-d/.test(subj.error));
const asTraffic = await native.wrapEgress(S.engine, codeBytes, hostBlock, { purpose: 'proof-traffic' });
check('H2 the same bytes ride fine as TRAFFIC — the armor serves Kingmaker, it does not process it', asTraffic.text.startsWith('SCRIPTURE-ARMOR'));
check('H3 integration surface exposes no cell/govern API', Object.keys(native).filter((k) => /cell|govern/i.test(k)).length === 0);

// ------------------------------------------------- I: kernel lane
const kLog = join(S.kernel, 'kernel-events.jsonl');
const prove = await new Promise((resolve) => {
  execFile('sh', ['prove.sh'], {
    cwd: join(here, '..', '..', '..', 'surface', 'kernel'),
    env: { ...process.env, KINGMAKER_STATE_DIR: S.kernel, KINGMAKER_KERNEL_EVENT_LOG: kLog },
    timeout: 60_000,
  }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
console.log('--- prove.sh (kernel lane, verbatim) ---');
console.log(prove.stdout.trim());
if (prove.stderr.trim()) console.log('[prove.sh stderr] ' + prove.stderr.trim().split('\n').slice(0, 4).join('\n'));
console.log(`--- prove.sh exit: ${prove.code} ---`);
check('I1 kernel lane prove.sh ran and left its hash-chained event log', fs.existsSync(kLog), `exit=${prove.code}`);
if (fs.existsSync(kLog)) {
  const v = bridge.verifyKernelChain(kLog);
  check('I2 armor bridge verifies the kernel chain', v.ok === true, `records=${v.records}`);
  const att = bridge.attestKernelLog(S.engine, kLog);
  const estate = (() => { try { return fs.readFileSync(join(native.identityDir(S.engine), 'estate-events.jsonl'), 'utf8'); } catch { return ''; } })();
  check('I3 kernel load events attested into the armor estate log', att.ok === true && att.attested_now >= 1 && estate.includes('kernel-load-attested'));
} else {
  check('I2 armor bridge verifies the kernel chain', false, 'no kernel log produced');
  check('I3 kernel load events attested into the armor estate log', false, 'no kernel log produced');
}
const audit = bridge.auditConnects(S.engine, [{ host: '127.0.0.1' }, { host: '203.0.113.99' }]);
check('I4 kernel accounting: the wrapped fleet connect is accounted; a stranger connect beacons',
  audit[0].accounted === true && audit[1].accounted === false &&
  native.readBeacons(S.engine).some((b) => b.event === 'kernel-egress-unaccounted' && b.host === '203.0.113.99'));

// ------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log(`\n==== armor-native proof: ${results.length - failed.length} passed, ${failed.length} failed ====`);
process.exit(failed.length ? 1 : 0);
