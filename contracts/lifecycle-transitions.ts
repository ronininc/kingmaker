// Ronin / Solomon — Lifecycle Transition Contract v1
// Explicit state movement. Nothing teleports.

import type { LifecycleStage } from './lifecycle-stage';

export interface LifecycleTransitionRule {
  from: LifecycleStage;
  to: LifecycleStage;
  requiresReference?: string;
  reasonPlain: string;
}

export const LIFECYCLE_TRANSITION_RULES: LifecycleTransitionRule[] = [
  { from: 'INTAKE', to: 'INTENT_CLASSIFIED', requiresReference: 'intentRef', reasonPlain: 'Intent must be classified before objective or execution.' },
  { from: 'INTENT_CLASSIFIED', to: 'OBJECTIVE_CREATED', requiresReference: 'objectiveRef', reasonPlain: 'Executable work requires governed objective state.' },
  { from: 'OBJECTIVE_CREATED', to: 'KINGMAKER_QUEUED', requiresReference: 'queueRef', reasonPlain: 'Objectives enter Kingmaker queue before build or release.' },
  { from: 'KINGMAKER_QUEUED', to: 'CAPABILITY_SELECTED', requiresReference: 'capabilityRef', reasonPlain: 'A capability must be selected before build or validation.' },
  { from: 'CAPABILITY_SELECTED', to: 'BUILDING', reasonPlain: 'Selected capability may enter build when authority and routing are satisfied.' },
  { from: 'BUILDING', to: 'VALIDATING', reasonPlain: 'Built capability must validate before Vault registration or release.' },
  { from: 'VALIDATING', to: 'VAULT_REGISTERED', requiresReference: 'vaultRef', reasonPlain: 'Validated capability must be registered in Vault before release.' },
  { from: 'VAULT_REGISTERED', to: 'PUBLIC_TELEMETRY_UPDATED', reasonPlain: 'Public telemetry may update after Vault registration.' },
  { from: 'PUBLIC_TELEMETRY_UPDATED', to: 'READY_FOR_RELEASE', reasonPlain: 'Release readiness follows validation, Vault, attribution, and telemetry.' },
  { from: 'READY_FOR_RELEASE', to: 'RELEASED', reasonPlain: 'Release requires explicit ready state.' },
];

export function canTransitionLifecycle(from: LifecycleStage, to: LifecycleStage): boolean {
  if (to === 'BLOCKED') return true;
  return LIFECYCLE_TRANSITION_RULES.some((rule) => rule.from === from && rule.to === to);
}

export function getLifecycleTransitionRule(from: LifecycleStage, to: LifecycleStage): LifecycleTransitionRule | undefined {
  return LIFECYCLE_TRANSITION_RULES.find((rule) => rule.from === from && rule.to === to);
}

export function nextLifecycleStages(from: LifecycleStage): LifecycleStage[] {
  return LIFECYCLE_TRANSITION_RULES.filter((rule) => rule.from === from).map((rule) => rule.to);
}
