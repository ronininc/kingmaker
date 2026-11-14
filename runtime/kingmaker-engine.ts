// Ronin / Solomon — Kingmaker Engine Runtime v1
// Kingmaker routes governed objectives. Governance owns risk; Kingmaker owns routing.

import {
  createKingmakerQueueItem,
  mayKingmakerMoveWithoutFounder,
  mustGoToFounderTable,
  type KingmakerQueueItemV1,
} from '../contracts/kingmaker-queue';
import type { ObjectiveRecordV1 } from '../contracts/objective-registry';
import type { KingmakerRiskClass, RoninDeviceTier, RoninRuntimeWeight, RoninWorkloadType } from '../contracts/runtime-sovereignty';
import type { CapabilityAuthorityLevel } from '../contracts/capability-manifest';

export interface KingmakerEngineResult {
  ok: boolean;
  queueItem: KingmakerQueueItemV1;
  founderReviewRequired: boolean;
  mayProceedWithoutFounder: boolean;
  reasonPlain: string;
}

export function routeObjectiveThroughKingmaker(input: {
  objective: ObjectiveRecordV1;
  queueItemId: string;
  sourceType: KingmakerQueueItemV1['sourceType'];
  sourceId: string;
  submittedById: string;
  submittedByDisplayName: string;
  organizationName?: string;
  riskClass: KingmakerRiskClass;
  authorityRequired: CapabilityAuthorityLevel;
  workloadType: RoninWorkloadType;
  runtimeWeight: RoninRuntimeWeight;
  preferredDeviceTier: RoninDeviceTier;
  createdAt: string;
}): KingmakerEngineResult {
  const queueItem = createKingmakerQueueItem({
    queueItemId: input.queueItemId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    title: input.objective.title,
    descriptionPlain: input.objective.descriptionPlain,
    submittedById: input.submittedById,
    submittedByDisplayName: input.submittedByDisplayName,
    organizationName: input.organizationName,
    riskClass: input.riskClass,
    authorityRequired: input.authorityRequired,
    workloadType: input.workloadType,
    runtimeWeight: input.runtimeWeight,
    preferredDeviceTier: input.preferredDeviceTier,
    createdAt: input.createdAt,
  });

  const founderReviewRequired = mustGoToFounderTable(queueItem);
  const mayProceedWithoutFounder = mayKingmakerMoveWithoutFounder(queueItem);

  return {
    ok: mayProceedWithoutFounder,
    queueItem,
    founderReviewRequired,
    mayProceedWithoutFounder,
    reasonPlain: founderReviewRequired
      ? 'Objective routed to Founder Table. No build, release, or public estimate allowed until reviewed.'
      : 'Objective routed through Kingmaker queue.',
  };
}

export function summarizeKingmakerRoute(item: KingmakerQueueItemV1): string {
  if (item.lane === 'RED_FOUNDER_TABLE') {
    return 'Founder Review Pending: item is red-class and cannot proceed without founder review.';
  }

  if (item.lane === 'YELLOW_REVIEW') {
    return 'Under Review: Kingmaker may scope, research, and prepare a brief before build.';
  }

  return 'Selected for Build: Kingmaker may proceed through governed queue.';
}
