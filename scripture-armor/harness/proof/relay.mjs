// proof/relay.mjs — the estate egress relay + a public-API stub.
//
// The relay is the estate-side endpoint of the relay leg: it holds an
// armor identity, unwraps the engine's sealed request envelope,
// performs the ordinary HTTPS call the target demands, and seals the
// answer back — return-matched by the engine against the request
// canary. The stub stands in for an ordinary public API: it speaks
// plain JSON, knows nothing of armor, and reports whether the API
// key the engine sealed into the envelope actually arrived (proving
// the key crossed inside the wrap, not on the wire).

import http from 'node:http';
import { ensureIdentity, openInbound, wrapEgress, signFpOfBlock, claimServed } from '../../../lib/armor-native.mjs';

export const API_MARKER = 'API-STUB-PLAINTEXT-MARKER-41c2';

export function startApiStub({ port }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(200, { 'content-type': 'application/json', server: 'proof-stub' });
    res.end(JSON.stringify({
      stub: true,
      marker: API_MARKER,
      sawApiKey: typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].length > 0,
      method: req.method,
      url: req.url,
    }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port })));
}

export function startRelay({ state, engineBlock, port, fetchImpl = fetch }) {
  ensureIdentity(state, 'estate-relay');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      // Sender pinning: the relay's only enrolled contact is the
      // engine — a package from anyone else refuses (+ beacons)
      // before its payload is handled.
      const opened = openInbound(state, raw, { expectSenderSignFp: signFpOfBlock(engineBlock) });
      // Replay: a canary is served once. A captured request re-sent
      // verbatim refuses (+ beacons) BEFORE the API is touched again.
      claimServed(state, opened.frame);
      const env = JSON.parse(opened.plaintext.toString('utf8'));
      const r = await fetchImpl(env.url, {
        method: env.method || 'GET',
        headers: env.headers || {},
        body: env.body_b64 ? Buffer.from(env.body_b64, 'base64') : undefined,
      });
      const body = Buffer.from(await r.arrayBuffer());
      const doc = JSON.stringify({
        in_reply_to: opened.frame.canary,
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        body_b64: body.toString('base64'),
      });
      const { text } = await wrapEgress(state, Buffer.from(doc, 'utf8'), engineBlock, { purpose: 'relay-response' });
      res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
      res.end(text);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`relay error: ${e?.message || e}`);
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port })));
}
