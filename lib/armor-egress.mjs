// ============================================================================
// LANE-A FOLD MARK (Kingmaker 4.4 Phase 0.1, 2026-10-26) — this folded/ copy
// differs from merged/lib/armor-egress.mjs ONLY at the line marked
// "LANE-A FOLD RP-". Full list in ../FOLD-REPORT.md.
//   RP-5 APPLIED below (packageRoundTrip): content-type v=3 -> v=4, matching
//        the v4 package text the converged armor now emits. No code in
//        either tree parses this header as a gate (grep-verified).
//   RP-2 UNRESOLVED, NOT applied: dynamic import('../scripture-armor/
//        refit-net.mjs') in flowExchange — same missing-file break as
//        armor-native RP-1.
//   OD-3 FLAGGED, NOT touched: fetch() passes caller headers to fetchImpl
//        outside the wrap on local/direct-residual legs, and Node default
//        headers ride outside the package leg. Fix-or-leave is Robbie's
//        OD-3 call; this lane does not default it.
//   OD-1 FLAGGED, NOT touched: modes relay / direct-residual are the parked
//        modes OD-1 names; classify() behaviour is unchanged by the fold.
// ============================================================================
// lib/armor-egress.mjs — the ONE governed egress point for the engine.
//
// Every outbound call the engine makes routes through here and is
// classified before a single byte leaves:
//
//   local            loopback — the machine talking to itself (Ollama
//                    probes, the phone companion). Direct; recorded.
//   package          the target is an ENROLLED armor peer: the call
//                    leaves as a Scripture Armor v3 package (sealed,
//                    glyph-bodied) and the answer must come back as
//                    one — return-matched by canary before it is
//                    trusted. On the wire: frame metadata + glyphs.
//   flow             an enrolled peer's flow listener (refit-net
//                    Addendum K): X25519-sealed stream, counter
//                    nonces, rolling hash chain; the peer's signed
//                    chain receipt is verified against what was sent
//                    — the return-hash loop, at packet level.
//   relay            the target cannot unwrap (an ordinary public
//                    API). The call is sealed to the install's
//                    enrolled ESTATE RELAY, which unwraps on the
//                    estate side, performs the plain call, and seals
//                    the answer back. The engine's leg — the leg that
//                    identifies Kingmaker — is wrapped end to end.
//                    The relay's own last hop to the API is ordinary
//                    HTTPS and is NAMED as such in provenance; this
//                    module never claims otherwise.
//   refused          native policy, target not enrolled: the call
//                    does not happen. Fail-closed, recorded.
//   direct-residual  ONLY under an explicit non-native policy: the
//                    call goes out unwrapped and the provenance
//                    record says so, in so many words. A named
//                    residual leg, never a silent downgrade.
//
// Sensing (transparency of media): every call writes a provenance
// record — target, mode, request canary, WHO answered (the response
// frame's signer fingerprint, or the flow peer, or the TLS-side
// facts a direct leg exposes), return-match / receipt verdict, and
// any beacon. gather() returns that record as data the research
// tools read. See lib/armor-native.mjs readProvenance().

import net from 'node:net';
import {
  ensureIdentity, identityDir, loadPeers, wrapEgress, openInbound, noteSent, matchReturn,
  recordProvenance, recordBeacon, signFpOfBlock,
} from './armor-native.mjs';
import { armor } from './armor-native.mjs';

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

function responseLike({ status = 200, headers = {}, body = Buffer.alloc(0), provenance }) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    provenance,
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
}

/**
 * createArmorEgress({ state, policy = 'native', relayName = null, fetchImpl = fetch, timeoutMs })
 *   policy: 'native' (fail-closed) | 'residual-direct' (unwrapped legs allowed, named)
 *   relayName: name of an enrolled peer acting as the estate egress relay.
 */
export function createArmorEgress({ state, policy = 'native', relayName = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!state) throw new Error('armor-egress: state dir required');
  ensureIdentity(state);
  const peers = () => loadPeers(state);

  function classify(url) {
    let u;
    try { u = new URL(url); } catch { return { mode: 'refused', reason: 'malformed-url' }; }
    const host = u.hostname.toLowerCase();
    if (isLoopback(host)) return { mode: 'local', url: u };
    const peer = peers()[host];
    if (peer) return { mode: peer.mode === 'flow' ? 'flow' : 'package', url: u, peerName: host, peer };
    if (relayName && peers()[relayName]) return { mode: 'relay', url: u, peerName: relayName, peer: peers()[relayName] };
    if (policy === 'residual-direct') return { mode: 'direct-residual', url: u };
    return { mode: 'refused', url: u, reason: 'target-not-enrolled' };
  }

  async function packageRoundTrip({ endpoint, peerBlockText, envelope, purpose }) {
    const { text, frame } = await wrapEgress(state, Buffer.from(JSON.stringify(envelope), 'utf8'), peerBlockText, { purpose });
    noteSent(state, { canary: frame.canary, purpose, peer: frame.recipient_seal_fp });
    const r = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.scripture-armor; v=4' }, // LANE-A FOLD RP-5 (applied): was v=3 — converged armor emits SCRIPTURE-ARMOR v4 packages
      body: text,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const respText = await r.text();
    if (!respText.startsWith('SCRIPTURE-ARMOR')) {
      recordBeacon(state, { event: 'response-unarmored', purpose, endpoint, detail: 'peer answered in cleartext — response not trusted' });
      throw new Error('armor-egress: peer answered unarmored — response refused');
    }
    // Responder pinning (airlock rule): the answer must be signed by
    // the enrolled peer this request was sealed to — the pin comes
    // from the peer's enrolled block, never from the arriving frame.
    const { plaintext, frame: respFrame } = openInbound(state, respText, { expectSenderSignFp: signFpOfBlock(peerBlockText) });
    const doc = JSON.parse(plaintext.toString('utf8'));
    const match = matchReturn(state, doc.in_reply_to, { purpose });
    if (!match.ok) throw new Error(`armor-egress: return-match failed (${match.error}) — response not trusted`);
    return { doc, respFrame, reqFrame: frame };
  }

  async function fetch(url, { method = 'GET', headers = {}, body = null, purpose = 'egress' } = {}) {
    const c = classify(url);
    const base = { kind: 'egress', purpose, target: String(url), mode: c.mode };

    if (c.mode === 'local') {
      const r = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const buf = Buffer.from(await r.arrayBuffer());
      const prov = { ...base, status: r.status };
      recordProvenance(state, prov);
      return responseLike({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: buf, provenance: prov });
    }

    if (c.mode === 'refused') {
      recordBeacon(state, { event: 'egress-refused-unenrolled', mode: 'refused', purpose, target: String(url), detail: `native policy: ${c.reason}` });
      throw new Error(`armor-egress: refused — target not enrolled and policy is native (${c.reason}): ${url}`);
    }

    if (c.mode === 'direct-residual') {
      const r = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const buf = Buffer.from(await r.arrayBuffer());
      const prov = {
        ...base, status: r.status, unwrapped: true,
        final_url: r.url || String(url), server: r.headers.get('server') || null,
        detail: 'NAMED RESIDUAL: this leg left unwrapped under residual-direct policy',
      };
      recordProvenance(state, prov);
      return responseLike({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: buf, provenance: prov });
    }

    if (c.mode === 'package') {
      const envelope = {
        method, url: String(url), headers,
        body_b64: body == null ? null : Buffer.from(body).toString('base64'),
      };
      const { doc, respFrame, reqFrame } = await packageRoundTrip({
        endpoint: c.peer.endpoint || String(url), peerBlockText: c.peer.block, envelope, purpose,
      });
      const prov = {
        ...base, status: doc.status, canary: reqFrame.canary,
        answered_by_sign_fp: respFrame.sender_sign_fp, return_match: true,
      };
      recordProvenance(state, prov);
      return responseLike({
        status: doc.status, headers: doc.headers || {},
        body: doc.body_b64 ? Buffer.from(doc.body_b64, 'base64') : Buffer.alloc(0),
        provenance: prov,
      });
    }

    if (c.mode === 'relay') {
      const envelope = {
        method, url: String(url), headers,
        body_b64: body == null ? null : Buffer.from(body).toString('base64'),
        relay_note: 'last hop from the relay to this target is ordinary HTTPS — named, not hidden',
      };
      const { doc, respFrame, reqFrame } = await packageRoundTrip({
        endpoint: c.peer.endpoint, peerBlockText: c.peer.block, envelope, purpose,
      });
      const prov = {
        ...base, status: doc.status, canary: reqFrame.canary,
        answered_by_sign_fp: respFrame.sender_sign_fp, return_match: true,
        via_relay: c.peerName,
      };
      recordProvenance(state, prov);
      return responseLike({
        status: doc.status, headers: doc.headers || {},
        body: doc.body_b64 ? Buffer.from(doc.body_b64, 'base64') : Buffer.alloc(0),
        provenance: prov,
      });
    }

    throw new Error(`armor-egress: mode ${c.mode} is not an HTTP mode — use flowExchange for flow peers`);
  }

  /**
   * Flow exchange with an enrolled flow peer (Addendum K): sends one
   * payload, collects reply frames, then demands the peer's signed
   * chain receipt and verifies it against the sent chain — the
   * return-hash loop. Any counter/AEAD/chain failure kills the flow
   * inside the armor and surfaces here as a beacon + a thrown error.
   */
  async function flowExchange(peerName, payload, { purpose = 'flow' } = {}) {
    const peer = peers()[peerName];
    if (!peer || peer.mode !== 'flow' || !peer.flowPort) throw new Error(`armor-egress: no flow peer enrolled as ${peerName}`);
    const identity = armor.loadIdentity(identityDir(state));
    if (!identity) throw new Error('armor-egress: no engine armor identity');
    const { openFlow } = await import('../scripture-armor/refit-net.mjs');
    const parsed = armor.parsePublicBlock(peer.block);
    const peerSignFp = armor.fingerprintOfRaw(Buffer.from(parsed.sign_pub, 'base64url'));
    const session = await openFlow(identity, peerSignFp, { port: peer.flowPort, host: peer.flowHost || '127.0.0.1' });
    const replies = [];
    let replyError = null;
    let buf = '';
    session.conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg && typeof msg.counter === 'number' && msg.body_b64) {
          const r = session.flow.receive(msg);
          if (!r.ok) { replyError = r.error; continue; }
          replies.push(r.plaintext);
        }
      }
    });
    session.send(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
    await new Promise((r) => setTimeout(r, 200)); // let the echo land before the receipt is demanded
    if (replyError) {
      recordBeacon(state, { event: 'flow-receive-failed', purpose, peer: peerName, detail: replyError });
      session.close();
      throw new Error(`armor-egress: flow receive failed: ${replyError}`);
    }
    const receipt = await session.requestReceipt();
    const verdict = session.flow.verifyReceipt(receipt);
    if (!verdict.ok) {
      recordBeacon(state, { event: 'flow-receipt-mismatch', purpose, peer: peerName, detail: verdict.error });
      session.close();
      throw new Error(`armor-egress: return-hash loop failed: ${verdict.error}`);
    }
    const prov = {
      kind: 'egress', purpose, target: `flow://${peerName}`, mode: 'flow',
      chain_head: session.flow.sentHead, receipt_count: session.flow.sendCounter,
      receipt_verified: true, answered_by_sign_fp: peerSignFp,
    };
    recordProvenance(state, prov);
    session.close();
    return { replies, receipt, provenance: prov, flow: session.flow };
  }

  /**
   * Sensing surface: fetch a source and return WHAT WAS LEARNED about
   * it — the interaction receipt a research tool reads. Never throws
   * for a refused target: a refusal is itself provenance.
   */
  async function gather(url, opts = {}) {
    const purpose = opts.purpose || 'gather';
    try {
      const response = await fetch(url, { ...opts, purpose });
      return { ok: true, response, source: response.provenance };
    } catch (e) {
      const source = { kind: 'egress', purpose, target: String(url), mode: 'refused', detail: String(e?.message || e) };
      return { ok: false, response: null, source, error: source.detail };
    }
  }

  return { fetch, gather, flowExchange, classify };
}
