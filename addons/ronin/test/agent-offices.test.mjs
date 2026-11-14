import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_OFFICES, agentIdentity, agentOfficePaths, agentPermissions, AUTHORITY_BOUNDARY, ensureAgentOffice, officePrompt, routeAgentOrder } from '../agent-offices.mjs';
import { MUSE_IDENTITY, MUSE_PERMISSIONS } from '../muse-office.mjs';

const state = () => ({ state: mkdtempSync(join(tmpdir(), 'km-offices-')) });

test('every acting brain carries Muse\'s authority boundary word for word and the same denied mutations', () => {
  assert.deepEqual(AGENT_OFFICES, ['claude', 'codex', 'grok-bot']);
  assert.ok(MUSE_IDENTITY.includes(`Muse ${AUTHORITY_BOUNDARY} Muse reports what a human or a separately authorized governed workflow would need to do.`), 'the boundary text is Muse\'s own');
  for (const slug of AGENT_OFFICES) {
    const id = agentIdentity(slug);
    assert.ok(id.includes(AUTHORITY_BOUNDARY));
    assert.match(id, /Ronin Inc only/);
    assert.match(id, /\$0 new spend/);
    assert.match(id, /never another office's memory/);
    assert.match(id, /reports back to Seeker/);
    const perm = agentPermissions(slug);
    assert.deepEqual(perm.denied_mutations, MUSE_PERMISSIONS.denied_mutations);
    assert.deepEqual(perm.lifecycle, MUSE_PERMISSIONS.lifecycle);
    assert.equal(perm.spend_usd, 0);
    assert.deepEqual(perm.memory, { namespace: `ronininc/${slug}`, cross_office_read: false, cross_office_write: false });
  }
});

test('an office is private and an order goes inbox → brain → outbox → its own memory, once', async () => {
  const paths = state();
  const p = ensureAgentOffice(paths, 'codex');
  assert.equal(statSync(p.root).mode & 0o777, 0o700);
  assert.equal(statSync(p.identity).mode & 0o777, 0o600);
  let prompts = 0; let seen = '';
  const think = async (prompt) => { prompts++; seen = prompt; return { ok: true, text: 'Built the invoice fix; PR proposed.' }; };
  const r = await routeAgentOrder(paths, 'codex', { id: 'q-1', asker_name: 'Seeker', question: 'Fix the invoice totals.', context: 'ronininc-crm, tax rounding' }, think);
  assert.deepEqual(r, { ok: true, text: 'Built the invoice fix; PR proposed.' });
  assert.match(seen, /^# Codex/);
  assert.match(seen, /Context: ronininc-crm, tax rounding/);
  assert.equal(JSON.parse(readFileSync(join(p.inbox, 'q-1.json'), 'utf8')).question, 'Fix the invoice totals.');
  assert.equal(JSON.parse(readFileSync(join(p.outbox, 'q-1.json'), 'utf8')).answer, 'Built the invoice fix; PR proposed.');
  assert.match(readFileSync(p.memoryHistory, 'utf8'), /invoice totals/);
  assert.equal(JSON.parse(readFileSync(p.lifecycle, 'utf8')).state, 'idle');
  const again = await routeAgentOrder(paths, 'codex', { id: 'q-1', question: 'Fix the invoice totals.' }, think);
  assert.equal(again.reused, true); assert.equal(prompts, 1, 'a replayed order is never paid for twice');
  // Memory is the office's own: Claude never sees Codex's history.
  let claudeSeen = '';
  await routeAgentOrder(paths, 'claude', { id: 'q-2', question: 'Pipeline status?' }, async (pr) => { claudeSeen = pr; return { ok: true, text: 'Three deals open.' }; });
  assert.doesNotMatch(claudeSeen, /invoice/);
  assert.match(officePrompt('claude', agentIdentity('claude'), '', { question: 'x' }), /proposal for the owner, never done/);
});

test('one worker per office: a second order waits its turn instead of running twice', async () => {
  const paths = state();
  const p = ensureAgentOffice(paths, 'grok-bot');
  writeFileSync(p.lock, `${process.pid}\n`);
  await assert.rejects(routeAgentOrder(paths, 'grok-bot', { id: 'q-3', question: 'x' }, async () => ({ ok: true, text: 'y' })), /Grok is already working/);
  assert.equal(agentOfficePaths(paths, 'grok-bot').root, p.root);
});
