// The status line about Scripture Armor states only what the connection verified, never a subscription.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abilityAccess } from '../lib/access-status.mjs';
const nonMember = async () => ({ ok: false, reason: 'no membership' });
test('Armor line: connected names version and auth; unavailable names the refusal; neither claims a subscription', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-access-armor-')); t.after(() => rmSync(state, { recursive: true, force: true }));
  const off = await abilityAccess(state, { verifyMembership: nonMember, armorState: () => ({ ok: false, code: 'ARMOR_MISSING', detail: 'x' }) });
  assert.equal(off.armor.connected, false); assert.match(off.armor.line, /not connected \(ARMOR_MISSING\)/); assert.ok(off.lines.includes(off.armor.line));
  assert.equal(off.own.active, true, 'own methods stay on without Armor');
  const on = await abilityAccess(state, { verifyMembership: nonMember, armorState: () => ({ ok: true, version: '1.2.3', auth: { method: 'apple-codesign' } }) });
  assert.match(on.armor.line, /connected — installed 1\.2\.3, authenticated \(apple-codesign\)/);
  for (const l of [on.armor.line, off.armor.line]) assert.doesNotMatch(l, /subscription (is )?(active|current)|protected/i);
});
