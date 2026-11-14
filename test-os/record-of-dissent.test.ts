#!/usr/bin/env tsx
// Kingmaker — Record of Dissent proof (Solomon Enterprises LLC JV §7). Verifies the running system produces
// the exact evidence artifact the contract relies on: a contemporaneous, logged Kingmaker verdict that
// (a) names the OTHER member as the one who proceeds at sole risk, (b) holds the dissenter + its owner
// personally + the Company harmless, (c) puts the economics on the proceeding member's own account, and
// (d) never blocks the action. Pure — no I/O.
import assert from 'node:assert/strict';
import { createRecordOfDissent, validateRecordOfDissent, isValidDissentEvidence, type RecordOfDissentV1 } from '../contracts/record-of-dissent';

function main(): void {
  // The contract's own example (§7.1a): Robbie logs "I don't like it, but he can do it".
  const rec = createRecordOfDissent({
    dissentId: 'rod-0001',
    dissentingMember: 'RONIN_INC',
    proposedAction: 'Orosolu wants to ship an autonomous-outreach build to a merchant',
    verdictText: "I don't like it, but he can do it",
    method: 'KINGMAKER_VERDICT',
    recordedAt: '2026-08-20T10:00:00.000Z',
    actionStartsAt: '2026-08-20T18:00:00.000Z',
  });

  // §7.2 — the OTHER member proceeds at sole risk; the dissenter (+ owner personally) + the Company are held harmless.
  assert.equal(rec.proceedingMember, 'OROSOLU_LLC', 'the non-dissenting member is the one who proceeds at own risk');
  assert.equal(rec.consequences.proceedingMemberBearsSoleRiskAndLiability, true, 'proceeding member bears sole risk + liability');
  assert.equal(rec.consequences.dissentingMemberBearsNoLiability, true, 'the dissenting member bears no liability');
  assert.ok(rec.consequences.indemnifies.some((i) => /Robert Glover \(personally\)/.test(i)), 'Robbie is indemnified personally');
  assert.ok(rec.consequences.indemnifies.some((i) => /Solomon Enterprises LLC/.test(i)), 'the Company is indemnified');

  // §7.3 — economics follow risk (proceeding member's own account); §7.4 — never blocks.
  assert.equal(rec.consequences.economics, 'PROCEEDING_MEMBER_OWN_ACCOUNT', 'profit/loss of a dissented action is the proceeding member’s own account');
  assert.equal(rec.consequences.blocksAction, false, 'a dissent never blocks the action (no paralysis)');

  // §7.1a — contemporaneous (recorded before the action) → valid evidence.
  assert.equal(rec.contemporaneous, true, 'recorded before the action → contemporaneous');
  assert.ok(isValidDissentEvidence(rec), 'a contemporaneous, well-formed record is valid §7.1a evidence');
  assert.ok(validateRecordOfDissent(rec).valid, 'the record is structurally valid');

  // A record made AFTER the action starts is NOT §7.1a evidence.
  const late = createRecordOfDissent({ dissentId: 'rod-0002', dissentingMember: 'OROSOLU_LLC', proposedAction: 'x', verdictText: 'objection', method: 'WRITTEN_NOTICE', recordedAt: '2026-08-20T19:00:00.000Z', actionStartsAt: '2026-08-20T18:00:00.000Z' });
  assert.equal(late.contemporaneous, false, 'recorded after the action → not contemporaneous');
  assert.ok(!isValidDissentEvidence(late), 'a late record is not §7.1a proceed-at-own-risk evidence');
  assert.equal(late.proceedingMember, 'RONIN_INC', 'when Orosolu dissents, Ronin is the proceeding member');

  // Validation catches a malformed record (proceeding == dissenting; empty verdict).
  const bad: RecordOfDissentV1 = { ...rec, proceedingMember: rec.dissentingMember, verdictText: '' };
  const v = validateRecordOfDissent(bad);
  assert.ok(!v.valid && v.blockers.some((b) => /OTHER member/.test(b)) && v.blockers.some((b) => /verdictText/.test(b)), 'validation rejects a self-proceeding / empty-verdict record');

  console.log('KINGMAKER_RECORD_OF_DISSENT PASS · JV §7 encoded: a contemporaneous Kingmaker verdict names the other member as proceeding at sole risk, holds the dissenter + owner + Company harmless, puts economics on the proceeding member’s account, never blocks; a late record is not §7.1a evidence.');
}

main();
