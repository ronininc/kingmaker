// two-endpoint/peer-server.mjs — the ENROLLED ARMOR PEER that runs
// INSIDE the QEMU guest. It is a real endpoint on a real (virtual)
// network: its own identity, its own state, the real armor library.
//
// Three listeners:
//   18731  armor package peer (HTTP POST of SCRIPTURE-ARMOR v3 text,
//          exactly the protocol engine/lib/armor-egress.mjs speaks:
//          open the envelope, answer with a sealed doc naming
//          in_reply_to = the request frame's canary)
//   18732  Addendum K flow echo peer (raw TCP, refit-net Flow —
//          the same echo pattern the loopback proof used, now
//          across a routed virtual link)
//   8899   plain file server for the identity exchange + evidence
//          (peer-block.txt, evidence.json, rogue-info.json) — this
//          is test scaffolding, NOT part of the armor protocol.
//
// The peer NEVER sees the host's files. Everything it knows arrived
// over the wire or was created in the guest.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureIdentity, openInbound, wrapEgress, identityDir, signFpOfBlock, readBeacons, claimServed } from './engine/lib/armor-native.mjs';
import * as armorLib from './scripture-armor/armor.mjs';
import { Flow } from './scripture-armor/refit-net.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STATE = join(here, 'state-peer');
const ENGINE_BLOCK_FILE = join(here, 'engine-block.txt');
const PKG_PORT = 18731, FLOW_PORT = 18732, FILE_PORT = 8899;
export const PEER_PAYLOAD = 'PEER-TO-ENGINE-PAYLOAD-9c41e7::the guest composed this inside the VM';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const me = ensureIdentity(STATE, 'vm-peer');
const myBlock = armorLib.publicBlock(me);
fs.writeFileSync(join(here, 'peer-block.txt'), myBlock, { mode: 0o600 });

const evidence = {
  peer_sign_fp: me.signFp, peer_seal_fp: me.sealFp,
  packages_opened: 0, packages_refused: 0,
  senders_seen: [], last_payload_sha256: null, last_envelope_sha256: null,
  refusals: [], unexpected_sender_beacons: 0, expired_beacons: 0, replay_beacons: 0,
};
function saveEvidence() {
  fs.writeFileSync(join(here, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}
saveEvidence();

// ---------------------------------------------------------- package peer
const pkgServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    // Sender pinning (airlock rule): the peer's only enrolled contact
    // is the engine whose public block it was handed over the link.
    // A package signed by anyone else refuses (+ beacons) before its
    // payload is handled. The pin derives from the enrolled block,
    // never from the arriving frame.
    const engineSignFp = signFpOfBlock(fs.readFileSync(ENGINE_BLOCK_FILE, 'utf8'));
    const opened = openInbound(STATE, raw, { expectSenderSignFp: engineSignFp });
    // Replay: a canary is served once. A captured package re-sent
    // verbatim refuses (+ beacons) before it is answered again.
    claimServed(STATE, opened.frame);
    const envelope = JSON.parse(opened.plaintext.toString('utf8'));
    const payload = envelope.body_b64 ? Buffer.from(envelope.body_b64, 'base64') : Buffer.alloc(0);
    evidence.packages_opened++;
    evidence.last_payload_sha256 = sha256(payload);
    evidence.last_envelope_sha256 = sha256(opened.plaintext);
    if (!evidence.senders_seen.includes(opened.frame.sender_sign_fp)) evidence.senders_seen.push(opened.frame.sender_sign_fp);
    saveEvidence();
    const ack = {
      ack: true, received_sha256: sha256(payload), received_bytes: payload.length,
      peer_payload: PEER_PAYLOAD, peer_payload_sha256: sha256(Buffer.from(PEER_PAYLOAD, 'utf8')),
    };
    const doc = JSON.stringify({
      in_reply_to: opened.frame.canary, status: 200,
      headers: { 'content-type': 'application/json' },
      body_b64: Buffer.from(JSON.stringify(ack), 'utf8').toString('base64'),
    });
    const engineBlock = fs.readFileSync(ENGINE_BLOCK_FILE, 'utf8');
    const { text } = await wrapEgress(STATE, Buffer.from(doc, 'utf8'), engineBlock, { purpose: 'vm-peer-ack' });
    res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
    res.end(text);
  } catch (e) {
    evidence.packages_refused++;
    evidence.refusals.push(String(e?.message || e));
    evidence.unexpected_sender_beacons = readBeacons(STATE).filter((b) => b.event === 'package-unexpected-sender').length;
    evidence.expired_beacons = readBeacons(STATE).filter((b) => b.event === 'package-expired').length;
    evidence.replay_beacons = readBeacons(STATE).filter((b) => b.event === 'package-replay').length;
    saveEvidence();
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`peer refused: ${e?.message || e}`);
  }
});

// ------------------------------------------------------------- flow peer
const flowServer = net.createServer((conn) => {
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

// ------------------------------------------------------------ file server
const fileServer = http.createServer((req, res) => {
  const name = req.url.replace(/^\//, '');
  if (!['peer-block.txt', 'evidence.json', 'rogue-info.json'].includes(name)) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(fs.readFileSync(join(here, name))); }
  catch { res.writeHead(404); res.end(); }
});

await new Promise((r) => pkgServer.listen(PKG_PORT, '0.0.0.0', r));
await new Promise((r) => flowServer.listen(FLOW_PORT, '0.0.0.0', r));
await new Promise((r) => fileServer.listen(FILE_PORT, '0.0.0.0', r));
console.log(`PEER-READY sign_fp=${me.signFp} pkg=${PKG_PORT} flow=${FLOW_PORT} files=${FILE_PORT}`);
