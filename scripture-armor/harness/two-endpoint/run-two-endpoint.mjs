// two-endpoint/run-two-endpoint.mjs — host side of the two-endpoint
// proof. Modes:
//   setup  create the engine armor identity; write its public block
//          to staging/engine-block.txt (the guest fetches it itself)
//   run    the full battery against the peer inside the QEMU guest
//
// The engine side uses the REAL engine modules (armor-egress +
// armor-native) in their real tree layout. The peer is a separate
// process in a separate operating system (Alpine guest) with its
// own kernel TCP stack, reached over a tap interface at 10.77.0.2.

import fs from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as native from '../../../lib/armor-native.mjs';
import { createArmorEgress } from '../../../lib/armor-egress.mjs';
import * as armorLib from '../../armor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Topology (see TWO-ENDPOINT-PROOF.md): the guest is a real QEMU VM
// (Alpine, own kernel + TCP stack) behind QEMU slirp user-net with
// host-forwarded ports on host loopback. Every host-side socket in
// this script is 127.0.0.1; every packet then crosses QEMU's NAT
// into the guest's own stack. The sandbox EPERMs direct connects
// from agent processes to any non-loopback address, which is what
// killed the tap-subnet design (and the earlier external-IP hairpin).
const HOSTFWD = '127.0.0.1';
const PKG_PORT = 18731, FLOW_PORT = 18732, ROGUE_PORT = 18733, FILE_PORT = 18899, TAP_PORT = 18741;
const GUEST_FILES = `http://${HOSTFWD}:${FILE_PORT}`;
const S = {
  engine: join(here, 'state-engine'),
  rogueHost: join(here, 'state-rogue-host'),
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2];

if (mode === 'setup') {
  fs.rmSync(S.engine, { recursive: true, force: true });
  const id = native.ensureIdentity(S.engine, 'kingmaker-engine');
  const block = native.publicBlockOf(S.engine);
  fs.writeFileSync(join(here, 'staging', 'engine-block.txt'), block);
  console.log(`SETUP-OK engine sign_fp=${id.signFp}`);
  process.exit(0);
}

// ------------------------------------------------------------------ tap
function startTap({ listenPort, targetHost, targetPort, captureBase }) {
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
  return new Promise((res) => server.listen(listenPort, '127.0.0.1', () => res(server)));
}

// ------------------------------------------------------------------ run
const results = [];
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail, kind: 'proof' });
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
}
function finding(label, observed, detail = '') {
  results.push({ label, observed, detail, kind: 'finding' });
  console.log(`FINDING — ${label} :: ${observed}${detail ? ` :: ${detail}` : ''}`);
}

async function pollPeerBlock(timeoutMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${GUEST_FILES}/peer-block.txt`);
      if (r.ok) return await r.text();
    } catch { /* guest not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('peer block never appeared — guest peer did not come up');
    await sleep(2000);
  }
}

const peerBlock = await pollPeerBlock();
const peerParsed = armorLib.parsePublicBlock(peerBlock);
const peerSignFp = armorLib.fingerprintOfRaw(Buffer.from(peerParsed.sign_pub, 'base64url'));
console.log(`peer block received: sign_fp=${peerSignFp}`);
check('setup: guest peer identity block arrived over the link and parses', !!peerSignFp);

await startTap({ listenPort: TAP_PORT, targetHost: HOSTFWD, targetPort: PKG_PORT, captureBase: join(here, 'capture-vm') });
await startTap({ listenPort: 18742, targetHost: HOSTFWD, targetPort: FLOW_PORT, captureBase: join(here, 'capture-flow') });

native.savePeers(S.engine, {
  vmpeer: { block: peerBlock, endpoint: `http://127.0.0.1:${TAP_PORT}/` },
  vmflow: { block: peerBlock, mode: 'flow', flowPort: 18742, flowHost: HOSTFWD },
  vmrogue: { block: peerBlock, endpoint: `http://${HOSTFWD}:${ROGUE_PORT}/forge-match` },
  vmrogueunknown: { block: peerBlock, endpoint: `http://${HOSTFWD}:${ROGUE_PORT}/forge-unknown` },
});
const egress = createArmorEgress({ state: S.engine, policy: 'native' });

// ------------------------------------------------- P: package round trip
const MARKER = 'VM-PROOF-MARKER-3f8a1c';
const payloadObj = { marker: MARKER, kind: 'two-endpoint-proof', note: 'composed on the host, recovered inside the guest', n: 42 };
const payloadStr = JSON.stringify(payloadObj);
const payloadSha = sha256(Buffer.from(payloadStr, 'utf8'));
let t0 = Date.now();
const resp = await egress.fetch('http://vmpeer/proof', {
  method: 'POST', purpose: 'two-endpoint-package',
  headers: { 'content-type': 'application/json' }, body: payloadStr,
});
const pkgMs = Date.now() - t0;
const ack = JSON.parse((await resp.text()) || '{}');
check('P1 package round trip host→guest→host completes through armor-egress package mode', resp.ok === true, `ms=${pkgMs} status=${resp.status}`);
check('P2 guest recovered the payload byte-for-byte (its own hash of what arrived == host hash of what was sent)',
  ack.received_sha256 === payloadSha, `guest=${ack.received_sha256} host=${payloadSha}`);
check('P3 engine recovered the guest payload byte-for-byte (ack hash == hash of body the engine opened)',
  ack.peer_payload_sha256 === sha256(Buffer.from(ack.peer_payload || '', 'utf8')) && String(ack.peer_payload || '').includes('inside the VM'));
check('P4 provenance: return-matched, answered by the enrolled guest peer identity',
  resp.provenance?.return_match === true && resp.provenance?.answered_by_sign_fp === peerSignFp,
  `answered_by=${resp.provenance?.answered_by_sign_fp}`);
await sleep(300);
const ev = await (await fetch(`${GUEST_FILES}/evidence.json`)).json();
check('P5 guest-side evidence independently records the same payload hash (peer process, not the reply)',
  ev.last_payload_sha256 === payloadSha && ev.peer_sign_fp === peerSignFp, `evidence=${ev.last_payload_sha256}`);

// ------------------------------------------------------- F: flow round trip
t0 = Date.now();
const fx = await egress.flowExchange('vmflow', Buffer.from('vm-flow-payload-1'), { purpose: 'two-endpoint-flow' });
const flowMs = Date.now() - t0;
check('F1 Addendum K flow round trip across the link echoes the payload',
  fx.replies.length >= 1 && fx.replies[0].toString() === 'echo:vm-flow-payload-1', `ms=${flowMs}`);
check('F2 RETURN-HASH LOOP: guest chain receipt verifies against the sent chain',
  fx.provenance.receipt_verified === true && fx.provenance.chain_head === fx.flow.sentHead, `head=${fx.provenance.chain_head}`);

// ------------------------------------------- N1: forged responder, real canary
// AIRLOCK REPAIR expectation: since the fix, the forged response must
// be REFUSED at the responder pin (its signer is not the enrolled
// peer the request was sealed to) and the refusal must beacon.
const rogueInfo = await (await fetch(`${GUEST_FILES}/rogue-info.json`)).json();
const beaconsBeforeN1 = native.readBeacons(S.engine).length;
let n1Accepted = false; let n1Body = ''; let n1Err = '';
try {
  const r1 = await egress.fetch('http://vmrogue/proof', { method: 'POST', purpose: 'forge-probe', body: JSON.stringify({ probe: 1 }) });
  n1Body = await r1.text();
  n1Accepted = r1.ok === true && n1Body.includes('FORGED-RESPONSE-PAYLOAD');
} catch (e) { n1Err = String(e?.message || e); }
check('N1 response forged by an UNENROLLED keypair naming the real canary is REFUSED at the responder pin',
  !n1Accepted && /unexpected sender/.test(n1Err),
  `err=${n1Err.slice(0, 110)} rogue_fp=${rogueInfo.rogue_sign_fp}`);
check('N1b the refusal beaconed on the engine, naming the rogue fingerprint',
  native.readBeacons(S.engine).slice(beaconsBeforeN1)
    .some((b) => b.event === 'package-unexpected-sender' && b.got_sign_fp === rogueInfo.rogue_sign_fp));

// ---------------------------------------- N2: forged responder, unknown canary
// The pin fires before return-match now: a rogue-signed response is
// refused at the door whatever canary it names. (Return-match itself
// still refuses unknown canaries from the genuine peer — the
// integration proof's D1 case covers that layer on-host.)
const beaconsBeforeN2 = native.readBeacons(S.engine).length;
let n2Refused = false; let n2Err = '';
try {
  await egress.fetch('http://vmrogueunknown/proof', { method: 'POST', purpose: 'forge-probe-unknown', body: JSON.stringify({ probe: 2 }) });
} catch (e) { n2Err = String(e?.message || e); n2Refused = /unexpected sender/.test(n2Err); }
check('N2 rogue response naming a never-sent canary is refused — at the sender pin, before return-match', n2Refused, n2Err.slice(0, 120));
check('N2b the refusal is in the engine beacon record',
  native.readBeacons(S.engine).slice(beaconsBeforeN2).some((b) => b.event === 'package-unexpected-sender'));

// ------------------------------------- N3: stranger package offered to the peer
native.ensureIdentity(S.rogueHost, 'host-rogue');
const rogueHostBlock = native.publicBlockOf(S.rogueHost);
const rogueHostId = native.ensureIdentity(S.rogueHost, 'host-rogue');
const evBefore = await (await fetch(`${GUEST_FILES}/evidence.json`)).json();
const strangerEnvelope = JSON.stringify({
  method: 'POST', url: 'http://vmpeer/proof', headers: {},
  body_b64: Buffer.from(JSON.stringify({ stranger: true }), 'utf8').toString('base64'),
});
const strangerPkg = await native.wrapEgress(S.rogueHost, Buffer.from(strangerEnvelope, 'utf8'), peerBlock, { purpose: 'stranger-probe' });
const rStranger = await fetch(`http://${HOSTFWD}:${PKG_PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/vnd.scripture-armor; v=3' }, body: strangerPkg.text,
});
await sleep(300);
const evAfter = await (await fetch(`${GUEST_FILES}/evidence.json`)).json();
check('N3 well-formed package from an UNENROLLED sender is REFUSED by the guest peer (sender pinning)',
  rStranger.status === 400 && evAfter.packages_opened === evBefore.packages_opened && !evAfter.senders_seen.includes(rogueHostId.signFp),
  `http=${rStranger.status} opened ${evBefore.packages_opened}→${evAfter.packages_opened} refused ${evBefore.packages_refused}→${evAfter.packages_refused}`);
check('N3c the peer-side refusal beaconed (peer beacon record, reported via guest evidence)',
  (evAfter.unexpected_sender_beacons || 0) >= 1,
  `beacons=${evAfter.unexpected_sender_beacons} last_refusal=${(evAfter.refusals || []).slice(-1)[0] || ''}`.slice(0, 200));

// ------------------------------- N3b: package addressed to someone else entirely
const misaddressed = await native.wrapEgress(S.rogueHost, Buffer.from(strangerEnvelope, 'utf8'), rogueHostBlock, { purpose: 'misaddressed-probe' });
const rMis = await fetch(`http://${HOSTFWD}:${PKG_PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/vnd.scripture-armor; v=3' }, body: misaddressed.text,
});
check('N3b package addressed to a different recipient is refused by the peer (recipient check)',
  rMis.status === 400, `http=${rMis.status}`);

// ------------------------------------------------------------- wire capture
await sleep(300);
const capC = (() => { try { return fs.readFileSync(join(here, 'capture-vm.c2s'), 'utf8'); } catch { return ''; } })();
const capS = (() => { try { return fs.readFileSync(join(here, 'capture-vm.s2c'), 'utf8'); } catch { return ''; } })();
const capAll = capC + capS;
check('W1 tap capture (package leg) shows Scripture Armor v3 packages', capC.includes('SCRIPTURE-ARMOR v3'));
check('W2 tap capture does NOT show the payload marker or plaintext', !capAll.includes(MARKER) && !capAll.includes('composed on the host'));
check('W3 tap capture does NOT show the forged payload in the clear', !capAll.includes('FORGED-RESPONSE-PAYLOAD'));
check('W4 wire bodies are glyph armor (PUA / Linear A / Cuneiform ranges)', [...capAll].some((ch) => {
  const cp = ch.codePointAt(0);
  return (cp >= 0xE000 && cp <= 0xE07F) || (cp >= 0x10600 && cp <= 0x1063F) || (cp >= 0x12000 && cp <= 0x1203F);
}));
const capFlow = (() => { try { return fs.readFileSync(join(here, 'capture-flow.c2s'), 'utf8') + fs.readFileSync(join(here, 'capture-flow.s2c'), 'utf8'); } catch { return ''; } })();
check('W5 flow-leg capture carries sealed flow frames (hello + body_b64), no plaintext payload',
  capFlow.includes('body_b64') && !capFlow.includes('vm-flow-payload-1') && !capFlow.includes('echo:'));  

const failed = results.filter((r) => r.kind === 'proof' && !r.ok);
fs.writeFileSync(join(here, 'results.json'), JSON.stringify({
  at: new Date().toISOString(), topology: 'host <-> QEMU slirp hostfwd (127.0.0.1 ports) <-> Alpine guest (DHCP 10.0.2.15)', peer_sign_fp: peerSignFp,
  rogue_sign_fp: rogueInfo.rogue_sign_fp, timings_ms: { package: pkgMs, flow: flowMs },
  results,
}, null, 2));
console.log(`\n==== two-endpoint proof checks: ${results.filter((r) => r.kind === 'proof' && r.ok).length} passed, ${failed.length} failed; findings: ${results.filter((r) => r.kind === 'finding').length} ====`);
process.exit(failed.length ? 1 : 0);
