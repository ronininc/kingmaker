// Kingmaker — Record of Dissent (Solomon Enterprises LLC JV, §7). Pure types + pure functions, no I/O.
//
// The JV Term Sheet makes KINGMAKER the contractual system-of-record for a member's dissent (§7.1a):
// "Ronin's objections are recorded through its own Kingmaker system as a logged verdict (for example,
// Robbie saying 'I don't like it, but he can do it'), and the parties agree a Kingmaker verdict log is
// valid evidence of a Ronin dissent." This module encodes that record and the consequences the contract
// attaches to it:
//   §7.1a — a timestamped, CONTEMPORANEOUS record made BEFORE the action proceeds.
//   §7.2  — if a member proceeds over the other's Record of Dissent, it does so at SOLE cost/risk/liability
//           and indemnifies the dissenting member (and its owner personally) AND the Company.
//   §7.3  — the economics of a dissented action are for the PROCEEDING member's own account (profit follows
//           risk), not split 50/50, unless the members agree otherwise.
//   §7.4  — NO PARALYSIS: a dissent never BLOCKS the other from proceeding; it only shifts risk/liability.
// Kingmaker stays Ronin's own system, outside the Company (§5).
//
// NOT legal advice — mirrors the draft term sheet so the running system produces the artifact the contract
// relies on. Counsel reviews the contract; this produces its evidence record.

export type JvMember = 'RONIN_INC' | 'OROSOLU_LLC';
export type DissentMethod = 'KINGMAKER_VERDICT' | 'WRITTEN_NOTICE';

const OTHER_MEMBER: Record<JvMember, JvMember> = { RONIN_INC: 'OROSOLU_LLC', OROSOLU_LLC: 'RONIN_INC' };
const OWNER_OF: Record<JvMember, string> = { RONIN_INC: 'Robert Glover', OROSOLU_LLC: 'Yordi' };

export interface RecordOfDissentInput {
  dissentId: string;
  dissentingMember: JvMember;
  /** What is being objected to — a proposed build, product, feature, deployment, deal, or action (§7.1). */
  proposedAction: string;
  /** The logged verdict, e.g. "I don't like it, but he can do it" (§7.1a). */
  verdictText: string;
  method: DissentMethod;
  /** ISO 8601. Must be contemporaneous — recorded before the action proceeds. */
  recordedAt: string;
  /** ISO 8601, optional. When the action is expected/scheduled to proceed — used for the before-check. */
  actionStartsAt?: string;
}

export interface DissentConsequences {
  proceedingMemberBearsSoleRiskAndLiability: true; // §7.2
  dissentingMemberBearsNoLiability: true; // §7.2
  /** Who the proceeding member must defend/indemnify/hold harmless (§7.2). */
  indemnifies: string[];
  /** §7.3 default — profit + loss of the dissented action are the proceeding member's own account. */
  economics: 'PROCEEDING_MEMBER_OWN_ACCOUNT';
  /** §7.4 — a dissent never blocks the action. */
  blocksAction: false;
}

export interface RecordOfDissentV1 {
  schemaVersion: '1.0';
  dissentId: string;
  dissentingMember: JvMember;
  /** The other member — the one who would proceed over this dissent (§7.2). */
  proceedingMember: JvMember;
  proposedAction: string;
  verdictText: string;
  method: DissentMethod;
  recordedAt: string;
  /** TRUE when recorded before the action proceeds — the condition for valid evidence (§7.1a). */
  contemporaneous: boolean;
  consequences: DissentConsequences;
  bindingSections: string[]; // §7 is binding even pre-signature
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Build a Record of Dissent, computing the proceeding member and the §7.2/7.3/7.4 consequences. */
export function createRecordOfDissent(input: RecordOfDissentInput): RecordOfDissentV1 {
  const proceedingMember = OTHER_MEMBER[input.dissentingMember];
  // Contemporaneous = recorded before the action. If an action time is given, recordedAt must precede it;
  // otherwise the record is taken as made before the action (the operator logs it ahead of proceeding).
  const contemporaneous = input.actionStartsAt ? Date.parse(input.recordedAt) <= Date.parse(input.actionStartsAt) : true;
  return {
    schemaVersion: '1.0',
    dissentId: input.dissentId,
    dissentingMember: input.dissentingMember,
    proceedingMember,
    proposedAction: input.proposedAction,
    verdictText: input.verdictText,
    method: input.method,
    recordedAt: input.recordedAt,
    contemporaneous,
    consequences: {
      proceedingMemberBearsSoleRiskAndLiability: true,
      dissentingMemberBearsNoLiability: true,
      indemnifies: [
        `${input.dissentingMember} (the dissenting member)`,
        `${OWNER_OF[input.dissentingMember]} (personally)`,
        'Solomon Enterprises LLC (the Company)',
      ],
      economics: 'PROCEEDING_MEMBER_OWN_ACCOUNT',
      blocksAction: false,
    },
    bindingSections: ['§7 Dissent & Non-Liability'],
  };
}

export interface DissentValidation { valid: boolean; blockers: string[] }

/** Structural validity of the record. */
export function validateRecordOfDissent(record: RecordOfDissentV1): DissentValidation {
  const blockers: string[] = [];
  if (record.schemaVersion !== '1.0') blockers.push('schemaVersion must be 1.0');
  for (const [k, v] of [['dissentId', record.dissentId], ['proposedAction', record.proposedAction], ['verdictText', record.verdictText]] as const) {
    if (!isNonEmpty(v)) blockers.push(`${k} is required`);
  }
  if (record.dissentingMember !== 'RONIN_INC' && record.dissentingMember !== 'OROSOLU_LLC') blockers.push('dissentingMember invalid');
  if (record.proceedingMember === record.dissentingMember) blockers.push('proceeding member must be the OTHER member');
  if (!isIso(record.recordedAt)) blockers.push('recordedAt must be a valid ISO timestamp');
  return { valid: blockers.length === 0, blockers };
}

/**
 * Is this a valid piece of dissent EVIDENCE under §7.1a? It must be structurally valid AND contemporaneous
 * (recorded before the action). A non-contemporaneous record is not the §7.1a evidence — it is a later
 * objection with no proceed-at-own-risk protection for the already-taken action.
 */
export function isValidDissentEvidence(record: RecordOfDissentV1): boolean {
  return validateRecordOfDissent(record).valid && record.contemporaneous === true;
}
