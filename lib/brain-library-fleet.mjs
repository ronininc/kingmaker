// lib/brain-library-fleet.mjs — Fleet Replication v1: peer serving + verified
// fetching for the Brain Library, on the seams of lib/brain-library-access.mjs.
//
// Doctrine (owner, 2026-11-14): fleet-based streaming, NO SERVER. Every install
// carries its own copy of the library; a docked fleet streams portions
// peer-to-peer; the GitHub/Forgejo door is bootstrap/discovery only. A portion
// is accepted from ANY source — local disk, a fleet peer, the door — by exactly
// one test: its SHA-256 equals the descriptor's portion pin. The serving peer
// is untrusted by construction; mesh identity (an admission token here, the
// Headscale mesh in production) controls who may ask, never what is believed.
//
// This module changes no existing file. It consumes the access layer's source
// shape ({ id, kind, name, size, sha256, readRange }) and produces sources of
// the same shape, so createBrainLibraryAccess() pulls fleet-backed items with
// its existing segment walk and its existing whole-item SHA-256 acceptance on
// top of this module's per-portion acceptance.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { MAX_PORTION_BYTES, PULL_SEGMENT_BYTES } from './brain-library-access.mjs';

export const FLEET_PROTOCOL = 'kingmaker.fleet/1';
export const DEFAULT_FLEET_PORTION_BYTES = PULL_SEGMENT_BYTES;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const PROTECTED_KINDS = new Set(['catalog', 'method', 'knowledge-index']);

function fleetError(code, message, extra = {}) {
  const err = new Error(`brain-library-fleet: ${message}`);
  err.code = code;
  return Object.assign(err, extra);
}

/** Portions an item of `size` splits into at `portionBytes`. */
export function portionCount(size, portionBytes) {
  if (!Number.isFinite(size) || size < 0) throw new Error('brain-library-fleet: size must be a non-negative number');
  if (!Number.isFinite(portionBytes) || portionBytes <= 0 || portionBytes > MAX_PORTION_BYTES) {
    throw new Error(`brain-library-fleet: portionBytes must be within 1..${MAX_PORTION_BYTES}`);
  }
  return Math.ceil(size / portionBytes);
}

function assertDescriptor(d) {
  if (!d?.id || !Number.isFinite(d?.size) || !d?.sha256) {
    throw fleetError('FLEET_DESCRIPTOR_INVALID', 'a fleet descriptor needs id, size and a whole-item sha256 pin');
  }
  const count = portionCount(d.size, d.portionBytes ?? DEFAULT_FLEET_PORTION_BYTES);
  if (!Array.isArray(d.portionSha256) || d.portionSha256.length !== count) {
    throw fleetError('FLEET_PIN_MANIFEST_MISSING', `"${d.id}" has no complete portion pin manifest (${count} portions expected) — refusing to trust unpinned portions`, { id: d.id });
  }
  return { ...d, portionBytes: d.portionBytes ?? DEFAULT_FLEET_PORTION_BYTES };
}

/**
 * Build an item descriptor (with its portion pin manifest) from any access-layer
 * source, by reading it portion by portion — the door/catalog builder's job,
 * done here from the source of truth. The whole-item pin is the source's own.
 */
export async function buildPortionManifest(source, { portionBytes = DEFAULT_FLEET_PORTION_BYTES } = {}) {
  const count = portionCount(source.size, portionBytes);
  const portionSha256 = [];
  for (let i = 0; i < count; i++) {
    const start = i * portionBytes;
    const data = await source.readRange(start, Math.min(portionBytes, source.size - start));
    if (data.length !== Math.min(portionBytes, source.size - start)) {
      throw fleetError('FLEET_SHORT_READ', `"${source.id}" served ${data.length} bytes for portion ${i}`, { id: source.id, portion: i });
    }
    portionSha256.push(sha256(data));
  }
  return assertDescriptor({
    id: source.id, kind: source.kind, name: source.name ?? source.id,
    size: source.size, sha256: source.sha256, portionBytes, portionSha256,
  });
}

/**
 * Pure eviction planner (design §6): the LRU set to evict so the store fits
 * `budgetBytes`. Protected kinds and pinned rows are never evicted; if the
 * protected floor alone exceeds the budget the planner says so instead of
 * pretending the budget is reachable.
 */
export function chooseEvictions(holdings, { budgetBytes } = {}) {
  if (!Number.isFinite(budgetBytes) || budgetBytes < 0) throw new Error('brain-library-fleet: budgetBytes is required');
  const rows = [...(holdings ?? [])];
  const total = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const evictable = rows
    .filter((r) => !r.pinned && !PROTECTED_KINDS.has(r.kind))
    .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
  const evict = [];
  let held = total;
  for (const row of evictable) {
    if (held <= budgetBytes) break;
    evict.push(row.id);
    held -= row.bytes ?? 0;
  }
  return { evict, keptBytes: held, totalBytes: total, budgetBytes, reachable: held <= budgetBytes };
}

/**
 * A serving fleet node over the sources it holds. `manifests` may supply
 * descriptors built elsewhere (the door catalog's); by default each held
 * source's manifest is built from the source itself at startup. A node serves
 * a portion only when it holds the item; it re-verifies nothing it did not
 * read from its own source — the fetcher's pin check is the acceptance gate.
 *
 * Options: `meshToken` (admission; TEST identities in v1), `profile`
 * ('standard' | 'phone'), `budgets` (advertised, not enforced in v1),
 * `onServed({id, portion, nodeId})` — a receipt hook fired after each portion
 * response is handed to the socket.
 */
export function createFleetNode({ nodeId, sources, manifests = null, portionBytes = DEFAULT_FLEET_PORTION_BYTES, meshToken = null, profile = 'standard', budgets = {}, onServed = null } = {}) {
  if (!nodeId) throw new Error('brain-library-fleet: nodeId is required');
  const byId = sources instanceof Map ? sources : new Map(Object.entries(sources ?? {}));
  const given = manifests ? (manifests instanceof Map ? manifests : new Map(Object.entries(manifests))) : null;
  const descriptors = new Map();
  const stats = { requests: 0, served: 0, refused: 0, failures: 0 };
  let readyPromise = null;

  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        for (const [id, source] of byId) {
          descriptors.set(id, given?.get(id) ? assertDescriptor(given.get(id)) : await buildPortionManifest(source, { portionBytes }));
        }
        return descriptors;
      })();
    }
    return readyPromise;
  }

  const advertisement = async () => ({
    protocol: FLEET_PROTOCOL,
    nodeId, profile, serving: true,
    budgets: { storageBytes: budgets.storageBytes ?? null, maxConcurrent: budgets.maxConcurrent ?? 2, serveMetered: budgets.serveMetered ?? false },
    items: [...descriptors.values()].map((d) => ({
      id: d.id, kind: d.kind, size: d.size, sha256: d.sha256, portionBytes: d.portionBytes,
      heldPortions: d.portionSha256.map((_, i) => i),
    })),
  });

  function authorized(req) {
    if (!meshToken) return true;
    return req.headers['x-kingmaker-mesh-token'] === meshToken;
  }

  async function handler(req, res) {
    stats.requests++;
    const send = (status, body, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/octet-stream', ...headers });
      res.end(body);
    };
    try {
      if (!authorized(req)) { stats.refused++; return send(403, 'mesh admission refused'); }
      const url = new URL(req.url, 'http://fleet.local');
      if (url.pathname === '/health') {
        return send(200, JSON.stringify({ ok: true, nodeId, protocol: FLEET_PROTOCOL }), { 'content-type': 'application/json' });
      }
      if (url.pathname === '/v1/advertise') {
        await ready();
        return send(200, JSON.stringify(await advertisement()), { 'content-type': 'application/json' });
      }
      const m = url.pathname.match(/^\/v1\/items\/(.+)\/portions\/(\d+)$/);
      if (m) {
        await ready();
        const id = decodeURIComponent(m[1]);
        const index = Number(m[2]);
        const source = byId.get(id);
        const descriptor = descriptors.get(id);
        if (!source || !descriptor || index >= descriptor.portionSha256.length) { stats.refused++; return send(404, 'portion not held'); }
        const start = index * descriptor.portionBytes;
        const data = await source.readRange(start, Math.min(descriptor.portionBytes, descriptor.size - start));
        send(200, data, { 'x-kingmaker-sha256': sha256(data), 'x-kingmaker-node': nodeId });
        stats.served++;
        if (onServed) { try { await onServed({ id, portion: index, nodeId }); } catch { /* a receipt hook never breaks serving */ } }
        return;
      }
      stats.refused++;
      return send(404, 'unknown fleet path');
    } catch (e) {
      stats.failures++;
      return send(500, String(e?.message ?? e));
    }
  }

  let server = null;
  return {
    nodeId, stats, ready, advertisement, handler,
    async listen(port = 0, host = '127.0.0.1') {
      await ready();
      server = createServer(handler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address();
      return { url: `http://${host}:${address.port}`, port: address.port, close: () => this.close() };
    },
    async close() {
      if (!server) return;
      const s = server; server = null;
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(() => resolve()));
    },
  };
}

/** Fetch + parse one peer's advertisement. Throws on any non-200 / bad body. */
export async function fetchAdvertisement(peer, { fetchImpl = fetch, meshToken = null } = {}) {
  const base = String(peer?.url ?? peer).replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/v1/advertise`, { headers: meshToken ? { 'x-kingmaker-mesh-token': meshToken } : {} });
  if (res.status !== 200) throw fleetError('FLEET_PEER_UNAVAILABLE', `${base} answered HTTP ${res.status} for its advertisement`, { peer: base });
  const body = await res.json();
  if (body?.protocol !== FLEET_PROTOCOL || !Array.isArray(body?.items)) {
    throw fleetError('FLEET_PEER_UNAVAILABLE', `${base} did not return a ${FLEET_PROTOCOL} advertisement`, { peer: base });
  }
  return { ...body, url: base };
}

/**
 * A fleet-backed access-layer source for one item.
 *
 * Resolution order per portion: `localSource` (this install's own held copy)
 * → fleet `peers` (base URLs or {url} objects, in the order given; each must
 * advertise the item) → `doorSource` (an access-layer source for the same
 * item — the bootstrap door's range path). Every candidate's bytes are
 * pin-verified identically. Attempt receipts accumulate on `stats()`.
 */
export function createFleetSource({ descriptor, peers = [], doorSource = null, localSource = null, fetchImpl = fetch, meshToken = null } = {}) {
  const d = assertDescriptor(descriptor);
  const receipts = [];
  const peerState = new Map(); // base -> { nodeId, items:Set<id>, down:boolean, badFor:Set<id> }
  let discovery = null;

  async function discover() {
    if (discovery) return discovery;
    discovery = (async () => {
      for (const peer of peers) {
        const base = String(peer?.url ?? peer).replace(/\/+$/, '');
        if (peerState.has(base)) continue;
        const state = { nodeId: peer?.nodeId ?? base, items: new Set(), down: false, badFor: new Set() };
        peerState.set(base, state);
        try {
          const ad = await fetchAdvertisement(base, { fetchImpl, meshToken });
          state.nodeId = ad.nodeId ?? state.nodeId;
          for (const item of ad.items) state.items.add(item.id);
          receipts.push({ portion: null, source: state.nodeId, outcome: 'advertised', items: ad.items.length });
        } catch (e) {
          state.down = true;
          receipts.push({ portion: null, source: base, outcome: 'unavailable', error: String(e?.message ?? e).slice(0, 160) });
        }
      }
      return peerState;
    })();
    return discovery;
  }

  async function portionFromPeer(base, state, index, expectedLength, pin) {
    const res = await fetchImpl(`${base}/v1/items/${encodeURIComponent(d.id)}/portions/${index}`, {
      headers: meshToken ? { 'x-kingmaker-mesh-token': meshToken } : {},
    });
    if (res.status !== 200) throw fleetError('FLEET_PEER_UNAVAILABLE', `${state.nodeId} answered HTTP ${res.status} for portion ${index}`, { portion: index });
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length !== expectedLength) {
      receipts.push({ portion: index, source: state.nodeId, outcome: 'refused-length', bytes: data.length });
      state.badFor.add(d.id);
      throw fleetError('FLEET_PORTION_LENGTH', `${state.nodeId} served ${data.length} of ${expectedLength} bytes for portion ${index}`, { portion: index });
    }
    const digest = sha256(data);
    if (digest !== pin) {
      receipts.push({ portion: index, source: state.nodeId, outcome: 'refused-pin', sha256: digest });
      state.badFor.add(d.id);
      throw fleetError('FLEET_PORTION_PIN_MISMATCH', `${state.nodeId} served portion ${index} whose sha256 ${digest} does not match the pin ${pin} — refused`, { portion: index, sha256: digest, pin });
    }
    receipts.push({ portion: index, source: state.nodeId, outcome: 'accepted', sha256: digest });
    return data;
  }

  async function fetchPortion(index) {
    const start = index * d.portionBytes;
    const length = Math.min(d.portionBytes, d.size - start);
    const pin = d.portionSha256[index];
    if (localSource) {
      const data = await localSource.readRange(start, length);
      const digest = sha256(data);
      if (data.length !== length || digest !== pin) {
        throw fleetError('FLEET_PORTION_PIN_MISMATCH', `the local copy of "${d.id}" failed its portion ${index} pin — refused`, { portion: index, sha256: digest, pin });
      }
      receipts.push({ portion: index, source: 'local', outcome: 'accepted', sha256: digest });
      return data;
    }
    await discover();
    let lastPinError = null;
    for (const [base, state] of peerState) {
      if (state.down || state.badFor.has(d.id) || !state.items.has(d.id)) continue;
      try {
        return await portionFromPeer(base, state, index, length, pin);
      } catch (e) {
        if (e?.code === 'FLEET_PORTION_PIN_MISMATCH' || e?.code === 'FLEET_PORTION_LENGTH') { lastPinError = e; continue; }
        state.down = true;
        receipts.push({ portion: index, source: state.nodeId, outcome: 'unavailable', error: String(e?.message ?? e).slice(0, 160) });
      }
    }
    if (doorSource) {
      const data = await doorSource.readRange(start, length);
      const digest = sha256(data);
      if (data.length !== length || digest !== pin) {
        receipts.push({ portion: index, source: 'door', outcome: 'refused-pin', sha256: digest });
        throw fleetError('FLEET_PORTION_PIN_MISMATCH', `the door served portion ${index} of "${d.id}" whose sha256 does not match the pin — refused`, { portion: index, sha256: digest, pin });
      }
      receipts.push({ portion: index, source: 'door', outcome: 'accepted', sha256: digest });
      return data;
    }
    if (lastPinError) throw lastPinError;
    throw fleetError('FLEET_PORTION_UNAVAILABLE', `no fleet peer or door could serve a verified portion ${index} of "${d.id}"`, { portion: index, receipts: [...receipts] });
  }

  return {
    id: d.id, kind: d.kind, name: d.name ?? d.id, size: d.size, sha256: d.sha256, descriptor: d,
    async readRange(start, length) {
      if (start >= d.size) return Buffer.alloc(0);
      const want = Math.min(length, d.size - start);
      const first = Math.floor(start / d.portionBytes);
      const last = Math.floor((start + want - 1) / d.portionBytes);
      const chunks = [];
      for (let i = first; i <= last; i++) chunks.push(await fetchPortion(i));
      return Buffer.concat(chunks).subarray(start - first * d.portionBytes, start - first * d.portionBytes + want);
    },
    stats: () => ({ id: d.id, receipts: [...receipts] }),
  };
}
