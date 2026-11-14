// Ronin / Solomon — Lifecycle Snapshot Contract v1
// Canonical state container for one governed request lifecycle.

import type { LifecycleStageState } from './lifecycle-stage';

export interface LifecycleReference {
  id: string;
  label: string;
}

export interface LifecycleSnapshotV1 {
  schemaVersion: '1.0';
  lifecycleId: string;
  stageState: LifecycleStageState;
  intentRef?: LifecycleReference;
  objectiveRef?: LifecycleReference;
  queueRef?: LifecycleReference;
  capabilityRef?: LifecycleReference;
  vaultRef?: LifecycleReference;
  openDevRef?: LifecycleReference;
  createdAt: string;
  updatedAt: string;
}

export function createLifecycleSnapshot(input: {
  lifecycleId: string;
  stageState: LifecycleStageState;
  intentRef?: LifecycleReference;
  createdAt: string;
}): LifecycleSnapshotV1 {
  return {
    schemaVersion: '1.0',
    lifecycleId: input.lifecycleId,
    stageState: input.stageState,
    intentRef: input.intentRef,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function withLifecycleReference(
  snapshot: LifecycleSnapshotV1,
  key: 'intentRef' | 'objectiveRef' | 'queueRef' | 'capabilityRef' | 'vaultRef' | 'openDevRef',
  ref: LifecycleReference,
  updatedAt: string,
): LifecycleSnapshotV1 {
  return {
    ...snapshot,
    [key]: ref,
    updatedAt,
  };
}

export function withLifecycleStage(
  snapshot: LifecycleSnapshotV1,
  stageState: LifecycleStageState,
  updatedAt: string,
): LifecycleSnapshotV1 {
  return {
    ...snapshot,
    stageState,
    updatedAt,
  };
}
