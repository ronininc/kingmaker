import './_bind.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retireStaleMemories, staleMemoryMatches } from '../memory-retire.mjs';

const mem = (id, content, stale = false) => ({ memoryId: id, content, stale });
const notConnected = 'Operator: [Orosolu CRM — Yordi (owner) is talking to Mia.] Solomon: The Orosolu CRM isn\'t connected to me. The CRM I can reach is Ronin Inc CRM (ronininc.org), and I won\'t answer…';
const sitePlan = 'Operator: [Orosolu employee job board task. Work only within…] Solomon: That is a 2-step plan: 1) In Ronin Inc CRM (ronininc.org), I will draft the proposal for the website…';
const myCrm = 'Operator: tell me whats left until my crm is fully functional Solomon: I didn\'t catch a CRM action in that. In Ronin Inc CRM (ronininc.org) I can handle your revenue brief…';

test('only the wrong claims are retired; a plain mention of Ronin Inc CRM stays', () => {
  const hits = staleMemoryMatches([mem('a', notConnected), mem('b', sitePlan), mem('c', myCrm), mem('d', 'Operator: open the Ronin Inc CRM dashboard Solomon: Opened.'), mem('e', notConnected, true)]);
  assert.deepEqual(hits.map((h) => h.memoryId), ['a', 'b', 'c']);
  assert.ok(hits.every((h) => h.why.length > 20));
});

test('each match is marked stale with the owner nonce and its reason', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ path: u.pathname, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const body = u.pathname === '/api/memory' ? { ok: true, memory: [mem('a', notConnected), mem('d', 'nothing wrong')] } : { ok: true, memory: { memoryId: 'a', stale: true } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await retireStaleMemories({ port: 3001, nonce: 'n'.repeat(64), fetchImpl });
  assert.equal(r.retired, 1); assert.equal(r.matched, 1); assert.equal(r.ok, true);
  const post = calls.find((c) => c.path === '/api/memory/stale');
  assert.equal(post.body.memoryId, 'a'); assert.match(post.body.reason, /Orosolu CRM/);
  assert.ok(Object.values(post.headers).includes('n'.repeat(64)));
});

test('the engine\'s memory records (content as an object) match too', () => {
  const rec = { memoryId: 'x', stale: false, content: { schemaVersion: 'solomon-mempalace-v1', verbatim: notConnected } };
  assert.deepEqual(staleMemoryMatches([rec]).map((h) => h.memoryId), ['x']);
});
