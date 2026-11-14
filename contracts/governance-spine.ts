// Ronin / Solomon — Governance Spine Schema v1
// The governance spine is set at the KINGMAKER level. Any model running
// underneath Kingmaker inherits the active spine — models do not pick their
// own governance. The spine cascades down; it is never overridden from below.

export type GovernanceSpineId =
  | 'custom'
  | 'kingmaker-x-heretic';

export interface GovernanceSpineV1 {
  /** Active spine. Set by founder. Inherited by all models underneath. */
  activeSpine: GovernanceSpineId;
  /** Who set it (founder tap reference) */
  setBy: string;
  /** When it was set */
  setAt: string;
  /** Tap reference authorizing the spine selection */
  tapReference: string;
}

export interface SpineConstraints {
  /** Only pinned models may load (always true — no unpinned weights ever) */
  requirePin: boolean;
  /** Only abliterated (can't-say-no) models may load */
  requireAbliterated: boolean;
  /** Founder tap required per inference session */
  requireTapPerSession: boolean;
  /** Full audit chain on every inference */
  auditEveryInference: boolean;
}

/**
 * Constraints for each spine. kingmaker-x-heretic is the powerhouse:
 * pinned abliterated models only, tap per session, full audit.
 * custom inherits the pin requirement but relaxes the abliteration gate —
 * the founder defines what custom allows, but unpinned weights are still refused.
 */
export function spineConstraints(spine: GovernanceSpineId): SpineConstraints {
  switch (spine) {
    case 'kingmaker-x-heretic':
      return {
        requirePin: true,
        requireAbliterated: true,
        requireTapPerSession: true,
        auditEveryInference: true,
      };
    case 'custom':
      return {
        requirePin: true,
        requireAbliterated: false,
        requireTapPerSession: false,
        auditEveryInference: true,
      };
  }
}

/**
 * Set the active spine. Founder authority only (enforced by caller).
 * Returns the new spine record. The previous spine is superseded, not deleted —
 * history is preserved for the audit chain.
 */
export function setGovernanceSpine(
  current: GovernanceSpineV1 | null,
  spine: GovernanceSpineId,
  setBy: string,
  tapReference: string,
): { spine: GovernanceSpineV1; previous: GovernanceSpineV1 | null } {
  void current; // history preserved by caller in audit chain
  return {
    spine: {
      activeSpine: spine,
      setBy,
      setAt: new Date().toISOString(),
      tapReference,
    },
    previous: current,
  };
}
