import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureIdentity, armor } from '../../lib/armor-native.mjs';
import { commandJob, createScriptureCommandGate } from '../../lib/scripture-command-gate.mjs';

export const armorAttemptId = '77777777-7777-4777-8777-777777777777';
export function armorFixture(job, attemptId = armorAttemptId, { now = Date.now } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scripture-command-fixture-'));
  const state = join(root, 'receiver'), sender = ensureIdentity(join(root, 'sender'), 'synthetic-owner'), receiver = ensureIdentity(state, 'synthetic-vm');
  const senderBlock = armor.publicBlock(sender), audience = 'fixture-executor';
  const commandGate = createScriptureCommandGate({ state, senderBlock, audience, now });
  const seal = (jobValue = job, edits = {}, signer = sender) => {
    const issuedAt = now(), expiresAt = issuedAt + 60_000;
    const body = { schema: 'ronin.scripture-command/v1', audience, action: 'external-static-inventory', attemptId, issuedAt, expiresAt, job: commandJob(jobValue), ...edits };
    return armor.sealPlaintext(Buffer.from(JSON.stringify(body)), signer, armor.parsePublicBlock(armor.publicBlock(receiver)), { expires: body.expiresAt }).text;
  };
  return { commandGate, armorPacket: seal(), seal, state, senderBlock, audience, receiver, sender, attemptId };
}
