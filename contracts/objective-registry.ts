// Ronin / Solomon — Objective Registry Schema v1
// Conversation is not memory. Intent is not objective. Objective is governed state.

import type { KingmakerRiskClass, RoninDeviceTier } from './runtime-sovereignty';
import type { CapabilityAuthorityLevel } from './capability-manifest';
import type { SolomonIntentType } from './intent-manifest';

export type ObjectiveStatus =
  | 'DRAFT'
  | 'PROPOSED'
  | 'ACTIVE'
  | 'BLOCKED'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'ABANDONED'
  | 'ARCHIVED';

export type ObjectivePriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export type ObjectiveOrigin =
  | 'FOUNDER_DIRECTIVE'
  | 'CUSTOMER_REQUEST'
  | 'KINGMAKER_CREATED'
  | 'SOLOMON_CREATED'
  | 'COMMUNITY_ENHANCEMENT'
  | 'SYSTEM_DIAGNOSTIC'
  | 'IMPORT';

export type ObjectiveMemoryDisposition = 'OBJECTIVE_ONLY' | 'OBJECTIVE_AND_AUDIT' | 'ARCHIVE_ON_COMPLETION' | 'DO_NOT_PROMOTE';

export interface ObjectiveDependency {
  objectiveId: string;
  label: string;
  required: boolean;
  blocking: boolean;
  reasonPlain: string;
}

export interface ObjectiveCapabilityLink {
  capabilityId: string;
  required: boolean;
  minimumVersion?: string;
  reasonPlain: string;
}

export interface ObjectiveAuditEvent {
  eventId: string;
  at: string;
  actorId: string;
  eventType: 'CREATED' | 'UPDATED' | 'STATUS_CHANGED' | 'APPROVED' | 'BLOCKED' | 'COMPLETED' | 'ABANDONED' | 'COMMENTED';
  reasonPlain: string;
  previousStatus?: ObjectiveStatus;
  nextStatus?: ObjectiveStatus;
}

export interface ObjectiveProgressState {
  percentComplete: number;
  currentStatePlain: string;
  nextStepPlain: string;
  blockedReasonPlain?: string;
  lastUpdatedAt: string;
}

export interface ObjectiveRecordV1 {
  schemaVersion: '1.0';
  objectiveId: string;
  title: string;
  descriptionPlain: string;
  ownerId: string;
  organizationId?: string;
  status: ObjectiveStatus;
  priority: ObjectivePriority;
  origin: ObjectiveOrigin;
  originatingIntent: SolomonIntentType;
  memoryDisposition: ObjectiveMemoryDisposition;
  authorityRequired: CapabilityAuthorityLevel;
  riskClass: KingmakerRiskClass;
  preferredDeviceTier: RoninDeviceTier;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  dependencies: ObjectiveDependency[];
  linkedCapabilities: ObjectiveCapabilityLink[];
  progress: ObjectiveProgressState;
  auditTrail: ObjectiveAuditEvent[];
  exitConditionPlain: string;
}

export interface ObjectiveCreateInput {
  objectiveId: string;
  title: string;
  descriptionPlain: string;
  ownerId: string;
  organizationId?: string;
  origin: ObjectiveOrigin;
  originatingIntent: SolomonIntentType;
  priority?: ObjectivePriority;
  authorityRequired: CapabilityAuthorityLevel;
  riskClass: KingmakerRiskClass;
  preferredDeviceTier: RoninDeviceTier;
  dueAt?: string;
  exitConditionPlain: string;
  createdAt: string;
}

export function createObjectiveRecord(input: ObjectiveCreateInput): ObjectiveRecordV1 {
  return {
    schemaVersion: '1.0',
    objectiveId: input.objectiveId,
    title: input.title,
    descriptionPlain: input.descriptionPlain,
    ownerId: input.ownerId,
    organizationId: input.organizationId,
    status: 'PROPOSED',
    priority: input.priority ?? 'NORMAL',
    origin: input.origin,
    originatingIntent: input.originatingIntent,
    memoryDisposition: 'OBJECTIVE_AND_AUDIT',
    authorityRequired: input.authorityRequired,
    riskClass: input.riskClass,
    preferredDeviceTier: input.preferredDeviceTier,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    dueAt: input.dueAt,
    dependencies: [],
    linkedCapabilities: [],
    progress: {
      percentComplete: 0,
      currentStatePlain: 'Objective proposed and awaiting activation or approval.',
      nextStepPlain: 'Classify authority, dependencies, and required capabilities.',
      lastUpdatedAt: input.createdAt,
    },
    auditTrail: [
      {
        eventId: `${input.objectiveId}:created`,
        at: input.createdAt,
        actorId: input.ownerId,
        eventType: 'CREATED',
        reasonPlain: 'Objective created from governed intent.',
        nextStatus: 'PROPOSED',
      },
    ],
    exitConditionPlain: input.exitConditionPlain,
  };
}

export function canActivateObjective(objective: ObjectiveRecordV1): boolean {
  if (objective.status !== 'PROPOSED' && objective.status !== 'DRAFT') return false;
  if (objective.riskClass === 'RED') return false;
  if (objective.authorityRequired === 'FOUNDER') return false;
  return objective.dependencies.every((dependency) => !dependency.blocking);
}

export function objectiveRequiresApproval(objective: ObjectiveRecordV1): boolean {
  return objective.status === 'WAITING_APPROVAL' || objective.riskClass === 'RED' || objective.authorityRequired === 'FOUNDER';
}

export function shouldPersistObjective(objective: ObjectiveRecordV1): boolean {
  return objective.memoryDisposition !== 'DO_NOT_PROMOTE' && objective.status !== 'ARCHIVED';
}

export function updateObjectiveStatus(
  objective: ObjectiveRecordV1,
  nextStatus: ObjectiveStatus,
  actorId: string,
  at: string,
  reasonPlain: string,
): ObjectiveRecordV1 {
  return {
    ...objective,
    status: nextStatus,
    updatedAt: at,
    auditTrail: [
      ...objective.auditTrail,
      {
        eventId: `${objective.objectiveId}:status:${at}`,
        at,
        actorId,
        eventType: 'STATUS_CHANGED',
        reasonPlain,
        previousStatus: objective.status,
        nextStatus,
      },
    ],
  };
}
