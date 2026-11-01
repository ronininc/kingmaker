// proof/fleet-host.mjs — an armor-capable fleet front door, for proof only.
//
// Stands in for fleet-host/worker.js with the armor enrollment the
// production door needs: it holds its own armor identity, unwraps
// contributed packages with the armor library (via armor-native,
// parameterized by its own state dir), signs receipts with the same
// Ed25519 pinned-key discipline fleet-transport verifies, and seals
// its answers back. It also still speaks the legacy JSON protocol so
// the proof can run the A/B control through the same door.

import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from '../../../vendor/fleet/fleet-packet.mjs';
import { ensureIdentity, openInbound, wrapEgress, signFpOfBlock, claimServed } from '../../../lib/armor-native.mjs';

export const RECEIPT_DOMAIN = 'solomon.fleet-receipt.v1';

export function startFleetHost({ state, engineBlock, port }) {
  ensureIdentity(state, 'fleet-host');
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  let contributed = 0;

  function signReceipt(unsigned) {
    const signature = sign(null, Buffer.from(`${RECEIPT_DOMAIN}:${canonicalJson(unsigned)}`, 'utf8'), keys.privateKey).toString('base64');
    return { ...unsigned, signature };
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const isArmor = (req.headers['content-type'] || '').includes('scripture-armor');
    try {
      if (req.url === '/contribute') {
        let packet; let reqFrame = null;
        if (isArmor) {
          // Sender pinning: this door's enrolled sender is the engine
          // whose block it was handed — anything else refuses
          // (+ beacons) before payload handling.
          const opened = openInbound(state, raw, { expectSenderSignFp: signFpOfBlock(engineBlock) });
          // Replay: a contributed canary is served once — a verbatim
          // re-send refuses (+ beacons) before it is counted again.
          claimServed(state, opened.frame);
          reqFrame = opened.frame;
          packet = JSON.parse(opened.plaintext.toString('utf8')).packet;
        } else {
          packet = JSON.parse(raw).packet;
        }
        contributed++;
        const receipt = signReceipt({
          installationId: packet.installationId, packetId: packet.packetId,
          accepted: true, at: new Date().toISOString(),
        });
        if (isArmor) {
          const doc = JSON.stringify({ in_reply_to: reqFrame.canary, receipt });
          const { text } = await wrapEgress(state, Buffer.from(doc, 'utf8'), engineBlock, { purpose: 'fleet-receipt' });
          res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
          res.end(text);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ receipt }));
        }
        return;
      }
      if (req.url === '/forget') {
        let reqFrame = null; let doc = { forgotten: true, packets: contributed };
        if (isArmor) {
          const opened = openInbound(state, raw, { expectSenderSignFp: signFpOfBlock(engineBlock) });
          // Replay: same rule — a re-sent forget is not executed twice.
          claimServed(state, opened.frame);
          reqFrame = opened.frame;
          doc = { in_reply_to: reqFrame.canary, ...doc };
          const { text } = await wrapEgress(state, Buffer.from(JSON.stringify(doc), 'utf8'), engineBlock, { purpose: 'fleet-forget-receipt' });
          res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
          res.end(text);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(doc));
        }
        return;
      }
      res.writeHead(404); res.end('nope');
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`fleet-host error: ${e?.message || e}`);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, publicKeyPem, port }));
  });
}
