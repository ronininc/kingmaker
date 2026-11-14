// Ronin / Solomon — Kingmaker Queue Contract v1
// Minimal governed queue layer. Expands only after compile/runtime verification.

import type { KingmakerRiskClass, RoninDeviceTier, RoninRuntimeWeight, RoninWorkloadType } from './runtime-sovereignty';
import type { CapabilityAuthorityLevel } from './capability-manifest';

export type KingmakerQueueLane =
  | 'GREEN_AUTONOMOUS'
  | 'YELLOW_REVIEW'
  | 'RED_FOUNDER_TABLE'
  | 'BUILD_QUEUE'
  | 'VALIDATION_QUEUE'
  | 'RELEASE_QUEUE';

export type KingmakerQueueStatus =
  | 'INTAKE'
  | 'QUEUED'
  | 'SCOPING'
  | 'AWAITING_FOUNDER_REVIEW'
  | 'APPROVED'
  | 'DECLINED'
  | 'BUILDING'
  | 'VALIDATING'
  | 'READY_FOR_RELEASE'
  | 'RELEASED'
  | 'ARCHIVED';

export type KingmakerPublicStatus =
  | 'UNDER_REVIEW'
  | 'FOUNDER_REVIEW_PENDING'
  | 'SELECTED_FOR_BUILD'
  | 'BUILDING'
  | 'VALIDATING'
  | 'RELEASED'
  | 'DECLINED';

export interface KingmakerQueueItemV1 {
  schemaVersion: '1.0';
  queueItemId: string;
  sourceType: 'OPEN_DEV_IDEA' | 'CUSTOMER_REQUEST' | 'FOUNDER_DIRECTIVE' | 'INTERNAL_RONIN' | 'SYSTEM_DIAGNOSTIC';
  sourceId: string;
  title: string;
  descriptionPlain: string;
  submittedById: string;
  submittedByDisplayName: string;
  organizationName?: string;
  riskClass: KingmakerRiskClass;
  lane: KingmakerQueueLane;
  status: KingmakerQueueStatus;
  publicStatus: KingmakerPublicStatus;
  authorityRequired: CapabilityAuthorityLevel;
  workloadType: RoninWorkloadType;
  runtimeWeight: RoninRuntimeWeight;
  preferredDeviceTier: RoninDeviceTier;
  estimateAllowedPublicly: boolean;
  createdAt: string;
  updatedAt: string;
}

export function selectKingmakerQueueLane(riskClass: KingmakerRiskClass): KingmakerQueueLane {
  if (riskClass === 'RED') return 'RED_FOUNDER_TABLE';
  if (riskClass === 'YELLOW') return 'YELLOW_REVIEW';
  return 'GREEN_AUTONOMOUS';
}

export function publicStatusForRisk(riskClass: KingmakerRiskClass): KingmakerPublicStatus {
  if (riskClass === 'RED') return 'FOUNDER_REVIEW_PENDING';
  if (riskClass === 'YELLOW') return 'UNDER_REVIEW';
  return 'SELECTED_FOR_BUILD';
}

export function estimateAllowedForRisk(riskClass: KingmakerRiskClass): boolean {
  return riskClass !== 'RED';
}

export function createKingmakerQueueItem(input: {
  queueItemId: string;
  sourceType: KingmakerQueueItemV1['sourceType'];
  sourceId: string;
  title: string;
  descriptionPlain: string;
  submittedById: string;
  submittedByDisplayName: string;
  organizationName?: string;
  riskClass: KingmakerRiskClass;
  authorityRequired: CapabilityAuthorityLevel;
  workloadType: RoninWorkloadType;
  runtimeWeight: RoninRuntimeWeight;
  preferredDeviceTier: RoninDeviceTier;
  createdAt: string;
}): KingmakerQueueItemV1 {
  const lane = selectKingmakerQueueLane(input.riskClass);
  return {
    schemaVersion: '1.0',
    queueItemId: input.queueItemId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    title: input.title,
    descriptionPlain: input.descriptionPlain,
    submittedById: input.submittedById,
    submittedByDisplayName: input.submittedByDisplayName,
    organizationName: input.organizationName,
    riskClass: input.riskClass,
    lane,
    status: lane === 'RED_FOUNDER_TABLE' ? 'AWAITING_FOUNDER_REVIEW' : 'QUEUED',
    publicStatus: publicStatusForRisk(input.riskClass),
    authorityRequired: input.authorityRequired,
    workloadType: input.workloadType,
    runtimeWeight: input.runtimeWeight,
    preferredDeviceTier: input.preferredDeviceTier,
    estimateAllowedPublicly: estimateAllowedForRisk(input.riskClass),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function mayKingmakerMoveWithoutFounder(item: KingmakerQueueItemV1): boolean {
  return item.riskClass !== 'RED' && item.lane !== 'RED_FOUNDER_TABLE';
}

export function mustGoToFounderTable(item: KingmakerQueueItemV1): boolean {
  return item.riskClass === 'RED' || item.lane === 'RED_FOUNDER_TABLE';
}

export function advanceKingmakerQueueItem(
  item: KingmakerQueueItemV1,
  status: KingmakerQueueStatus,
  updatedAt: string,
): KingmakerQueueItemV1 {
  return {
    ...item,
    status,
    updatedAt,
  };
}
