// lib/brain-library-fleet-directory.mjs — Fleet Replication follow-on 2:
// mesh-directory discovery.
//
// v1 discovery was a hardcoded peer list: createFleetSource took explicit
// base URLs, which is exactly what a directory would hand it (DESIGN §9) —
// but no directory existed, so two installs could only find each other if
// someone typed addresses into both configs. This module is that directory:
//
//   createFleetDirectory()        — a rendezvous speaking the fleet protocol
//     family. A node REGISTERS {nodeId, url, profile}; registrations expire
//     after a TTL unless renewed (heartbeat). GET /v1/directory returns the
//     live registrations. The directory never serves content and never
//     vouches for bytes: it hands out availability, and acceptance stays
//     with the portion pins, exactly like node advertisements (DESIGN §3.2).
//   registerFleetNode()           — one registration call.
//   startDirectoryHeartbeat()     — renew a registration until stopped.
//   discoverFleetPeers()          — the live peer list from a directory.
//   createDiscoveredFleetSource() — a createFleetSource whose peers come
//     from the directory at construction: the caller's ONLY network
//     configuration is the directory's address.
//
// Production shape (DESIGN §9, stated not claimed): in the Headscale mesh
// the directory role is played by MagicDNS enumeration — names are
// addresses, and liveness is the mesh's own. This module implements the
// same register/lookup contract for substrates without a mesh directory
// (and for the local proof). A lying directory can waste requests or hide
// peers; it cannot make bad bytes acceptable, because it never touches a
// pin. Mesh admission (x-kingmaker-mesh-token) gates who may register or
// read the directory when a token is set, as it gates node serving in v1.

import { createServer } from 'node:http';
import { FLEET_PROTOCOL, createFleetSource } from './brain-library-fleet.mjs';

export const FLEET_DIRECTORY_PROTOCOL = 'kingmaker.fleet-directory/1';
export const DEFAULT_DIRECTORY_TTL_MS = 30_000;

function directoryError(code, message, extra = {}) {
  const err = new Error(`brain-library-fleet-directory: ${message}`);
  err.code = code;
  return Object.assign(err, extra);
}

const tokenHeaders = (meshToken) => (meshToken ? { 'x-kingmaker-mesh-token': meshToken } : {});

export function createFleetDirectory({ directoryId = 'fleet-directory', meshToken = null, ttlMs = DEFAULT_DIRECTORY_TTL_MS, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('brain-library-fleet-directory: ttlMs must be positive');
  const registrations = new Map(); // nodeId -> { nodeId, url, profile, registeredAt, expiresAt }
  const stats = { registrations: 0, lookups: 0, refused: 0, expired: 0 };

  const live = () => {
    const t = now();
    const out = [];
    for (const [nodeId, r] of registrations) {
      if (r.expiresAt <= t) { registrations.delete(nodeId); stats.expired++; continue; }
      out.push({ ...r });
    }
    return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  };

  function authorized(req) {
    if (!meshToken) return true;
    return req.headers['x-kingmaker-mesh-token'] === meshToken;
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async function handler(req, res) {
    const send = (status, obj) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, 'http://fleet-directory.local');
      if (url.pathname === '/health') return send(200, { ok: true, directoryId, protocol: FLEET_DIRECTORY_PROTOCOL, nodes: live().length });
      if (!authorized(req)) { stats.refused++; return send(403, { error: 'mesh admission refused' }); }
      if (req.method === 'POST' && url.pathname === '/v1/register') {
        const body = await readJsonBody(req);
        if (!body?.nodeId || !body?.url) { stats.refused++; return send(400, { error: 'register needs nodeId and url' }); }
        const t = now();
        const entry = {
          nodeId: String(body.nodeId), url: String(body.url).replace(/\/+$/, ''),
          profile: body.profile ?? 'standard', registeredAt: t, expiresAt: t + ttlMs,
        };
        registrations.set(entry.nodeId, entry);
        stats.registrations++;
        return send(200, { ok: true, protocol: FLEET_DIRECTORY_PROTOCOL, directoryId, entry });
      }
      if (req.method === 'GET' && url.pathname === '/v1/directory') {
        stats.lookups++;
        return send(200, { protocol: FLEET_DIRECTORY_PROTOCOL, directoryId, fleetProtocol: FLEET_PROTOCOL, nodes: live() });
      }
      stats.refused++;
      return send(404, { error: 'unknown directory path' });
    } catch (e) {
      return send(500, { error: String(e?.message ?? e) });
    }
  }

  let server = null;
  return {
    directoryId, stats, handler, live,
    async listen(port = 0, host = '127.0.0.1') {
      server = createServer(handler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address();
      return { url: `http://${host}:${address.port}`, port: address.port };
    },
    async close() {
      if (!server) return;
      const s = server; server = null;
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(() => resolve()));
    },
  };
}

/** One registration (or renewal) of a fleet node with a directory. */
export async function registerFleetNode({ directoryUrl, nodeId, url, profile = 'standard', meshToken = null, fetchImpl = fetch } = {}) {
  const base = String(directoryUrl ?? '').replace(/\/+$/, '');
  if (!base || !nodeId || !url) throw directoryError('FLEET_DIRECTORY_BAD_REGISTER', 'registerFleetNode needs directoryUrl, nodeId and the node url');
  const res = await fetchImpl(`${base}/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tokenHeaders(meshToken) },
    body: JSON.stringify({ nodeId, url, profile }),
  });
  if (res.status !== 200) throw directoryError('FLEET_DIRECTORY_UNAVAILABLE', `${base} answered HTTP ${res.status} for a registration`, { directory: base });
  const body = await res.json();
  return body.entry;
}

/** Renew a registration every `intervalMs` until stop() is called. The
 *  interval must be shorter than the directory's TTL; defaults to TTL/3 of
 *  the fleet default when only intervalMs is given. Returns receipts of
 *  every renewal on `renewals` so callers can prove liveness was kept. */
export function startDirectoryHeartbeat({ directoryUrl, nodeId, url, profile = 'standard', meshToken = null, fetchImpl = fetch, intervalMs = 10_000 } = {}) {
  const renewals = [];
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { renewals.push(await registerFleetNode({ directoryUrl, nodeId, url, profile, meshToken, fetchImpl })); }
    catch (e) { renewals.push({ error: String(e?.message ?? e), at: Date.now() }); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { renewals, stop: () => { stopped = true; clearInterval(timer); } };
}

/** The live peers a directory knows, optionally excluding one node (self). */
export async function discoverFleetPeers({ directoryUrl, meshToken = null, fetchImpl = fetch, excludeNodeId = null } = {}) {
  const base = String(directoryUrl ?? '').replace(/\/+$/, '');
  if (!base) throw directoryError('FLEET_DIRECTORY_BAD_LOOKUP', 'discoverFleetPeers needs a directoryUrl');
  const res = await fetchImpl(`${base}/v1/directory`, { headers: tokenHeaders(meshToken) });
  if (res.status !== 200) throw directoryError('FLEET_DIRECTORY_UNAVAILABLE', `${base} answered HTTP ${res.status} for the directory`, { directory: base });
  const body = await res.json();
  if (body?.protocol !== FLEET_DIRECTORY_PROTOCOL || !Array.isArray(body?.nodes)) {
    throw directoryError('FLEET_DIRECTORY_UNAVAILABLE', `${base} did not return a ${FLEET_DIRECTORY_PROTOCOL} listing`, { directory: base });
  }
  return body.nodes
    .filter((n) => n.nodeId !== excludeNodeId)
    .map((n) => ({ nodeId: n.nodeId, url: n.url, profile: n.profile }));
}

/**
 * A fleet source whose peer list is resolved from the directory — the
 * caller configures the DIRECTORY's address and nothing else. Resolution
 * happens once, at construction (v1 sources cache their discovery round);
 * build a new source to re-discover, as with v1. `peerReceipts` on the
 * returned source records exactly which peers the directory handed out, so
 * a run can prove no address arrived by any other channel.
 */
export async function createDiscoveredFleetSource({ descriptor, directoryUrl, doorSource = null, localSource = null, meshToken = null, fetchImpl = fetch, excludeNodeId = null } = {}) {
  const peers = await discoverFleetPeers({ directoryUrl, meshToken, fetchImpl, excludeNodeId });
  const source = createFleetSource({ descriptor, peers, doorSource, localSource, meshToken, fetchImpl });
  return Object.assign(source, { peerReceipts: peers });
}
