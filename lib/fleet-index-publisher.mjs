import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';
import { FLEET_INDEX_SCHEMA, fleetIndexProblems } from './fleet-skills.mjs';

export function prepareFleetIndex({ publishedAt, candidates, approvals, previous = null, revocations = [], deliveryOrigin }, { fixtureLoopback = false } = {}) {
  const origin = new URL(deliveryOrigin);
  const loopback = fixtureLoopback && origin.protocol === 'http:' && origin.hostname === '127.0.0.1';
  if ((!loopback && origin.protocol !== 'https:') || origin.username || origin.password ||
      origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Specify a private HTTPS delivery origin without a path or credentials.');
  }
  const approved = new Set(approvals.map(entry => canonicalJson(entry)));
  const entries = new Map();
  const omitted = [];
  const prior = new Map(previous?.entries.map(entry => [entry.id, entry]));
  if (previous && !(Date.parse(publishedAt) > Date.parse(previous.publishedAt))) {
    throw new Error('The draft must be newer than the previous signed Fleet index.');
  }

  for (const { reviewStatus, entry } of candidates) {
    if (!entry?.id || !['pending', 'ready'].includes(reviewStatus)) throw new Error('Candidate needs an ID and review status.');
    if (entries.has(entry.id) || omitted.includes(entry.id)) throw new Error(`Duplicate candidate: ${entry.id}`);
    if (reviewStatus === 'ready' && entry.state === 'reviewed' && approved.has(canonicalJson(entry))) entries.set(entry.id, entry);
    else omitted.push(entry.id);
  }
  for (const entry of prior.values()) {
    if (entry.state === 'revoked') entries.set(entry.id, entry);
  }
  for (const { id, reason } of revocations) {
    const entry = prior.get(id);
    if (!entry) throw new Error(`Revocation needs a previously signed entry: ${id}`);
    entries.set(id, { ...entry, state: 'revoked', ...(reason ? { reason } : {}) });
  }

  const index = { schema: FLEET_INDEX_SCHEMA, publishedAt, entries: [...entries.values()] };
  const problems = fleetIndexProblems(index, { url: origin, fixtureLoopback, auth: 'bearer' });
  if (problems.length) throw new Error(problems.join('\n'));
  return { index, omitted };
}

const tokenDigest = token => createHash('sha256').update(token).digest();

export function privateFleetReadHandler({ tokens, artifacts }) {
  if (!tokens.length || tokens.some(token => !/^[A-Za-z0-9._~-]{32,}$/.test(token))) {
    throw new Error('Private Fleet delivery requires provisioned bearer tokens.');
  }
  const authorized = tokens.map(tokenDigest);
  return (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    const bearer = /^Bearer ([A-Za-z0-9._~-]{32,})$/.exec(request.headers.authorization || '');
    const proof = bearer && tokenDigest(bearer[1]);
    if (!proof || !authorized.some(key => timingSafeEqual(key, proof))) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    const bytes = artifacts.get(request.url);
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(bytes);
  };
}
