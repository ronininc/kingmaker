// Ronin / Solomon — Lifecycle Stage Contract v1
// Small dependency-free lifecycle vocabulary for governed orchestration.

export type LifecycleStage =
  | 'INTAKE'
  | 'INTENT_CLASSIFIED'
  | 'OBJECTIVE_CREATED'
  | 'KINGMAKER_QUEUED'
  | 'CAPABILITY_SELECTED'
  | 'BUILDING'
  | 'VALIDATING'
  | 'VAULT_REGISTERED'
  | 'PUBLIC_TELEMETRY_UPDATED'
  | 'READY_FOR_RELEASE'
  | 'RELEASED'
  | 'BLOCKED';

export type LifecycleBlockReason =
  | 'NONE'
  | 'UNKNOWN_INTENT'
  | 'AUTHORITY_REQUIRED'
  | 'FOUNDER_REVIEW_REQUIRED'
  | 'MISSING_OBJECTIVE'
  | 'MISSING_QUEUE_ITEM'
  | 'MISSING_CAPABILITY'
  | 'VALIDATION_REQUIRED'
  | 'VAULT_NOT_READY';

export type LifecycleReleaseReadiness =
  | 'NOT_READY'
  | 'READY_INTERNAL'
  | 'READY_PUBLIC'
  | 'RELEASED';

export interface LifecycleMessagePair {
  publicMessagePlain: string;
  internalMessagePlain: string;
}

export interface LifecycleStageState {
  stage: LifecycleStage;
  blocked: boolean;
  blockReason: LifecycleBlockReason;
  releaseReadiness: LifecycleReleaseReadiness;
  message: LifecycleMessagePair;
}

export function createLifecycleStageState(input: {
  stage: LifecycleStage;
  blocked?: boolean;
  blockReason?: LifecycleBlockReason;
  releaseReadiness?: LifecycleReleaseReadiness;
  publicMessagePlain: string;
  internalMessagePlain: string;
}): LifecycleStageState {
  return {
    stage: input.stage,
    blocked: input.blocked ?? false,
    blockReason: input.blockReason ?? 'NONE',
    releaseReadiness: input.releaseReadiness ?? 'NOT_READY',
    message: {
      publicMessagePlain: input.publicMessagePlain,
      internalMessagePlain: input.internalMessagePlain,
    },
  };
}

export function isLifecycleBlocked(state: LifecycleStageState): boolean {
  return state.blocked || state.blockReason !== 'NONE' || state.stage === 'BLOCKED';
}

export function canLifecycleRelease(state: LifecycleStageState): boolean {
  return !isLifecycleBlocked(state) && (state.releaseReadiness === 'READY_INTERNAL' || state.releaseReadiness === 'READY_PUBLIC');
}
