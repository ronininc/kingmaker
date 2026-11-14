// Ronin / Solomon — Intent Manifest Schema v1
// Every user input must be classified before authority, governance, routing, execution, storage, or response.

import type { KingmakerRiskClass } from './runtime-sovereignty';
import type { CapabilityAuthorityLevel } from './capability-manifest';

export type SolomonIntentType =
  | 'QUESTION'
  | 'RESEARCH_REQUEST'
  | 'IDEA'
  | 'FUTURE_OBJECTIVE'
  | 'ACTIVE_OBJECTIVE'
  | 'COMMAND'
  | 'APPROVAL'
  | 'STATUS_REQUEST'
  | 'DIAGNOSTIC_REQUEST'
  | 'ENHANCEMENT_REQUEST'
  | 'RANDOM_THOUGHT'
  | 'CONTEXT_UPDATE'
  | 'CORRECTION'
  | 'REJECTION'
  | 'UNKNOWN';

export type SolomonIntentAction =
  | 'ANSWER_ONLY'
  | 'RESEARCH_ONLY'
  | 'NO_ACTION'
  | 'ASK_CLARIFYING_QUESTION'
  | 'CREATE_OBJECTIVE'
  | 'UPDATE_OBJECTIVE'
  | 'CREATE_TASK'
  | 'QUEUE_FOR_APPROVAL'
  | 'ROUTE_TO_CAPABILITY'
  | 'SUBMIT_ENHANCEMENT_REQUEST'
  | 'RUN_DIAGNOSTIC'
  | 'BLOCK_EXECUTION';

export type SolomonStorageDisposition =
  | 'DO_NOT_STORE'
  | 'EPHEMERAL_CONTEXT'
  | 'SESSION_CONTEXT'
  | 'SUGGESTED_MEMORY'
  | 'OBJECTIVE_REGISTRY'
  | 'AUDIT_REQUIRED';

export interface IntentClassificationInput {
  inputId: string;
  actorId: string;
  organizationId?: string;
  rawText: string;
  currentObjectiveIds?: string[];
  hasDirectImperative?: boolean;
  asksForInformation?: boolean;
  asksForExecution?: boolean;
  referencesFuture?: boolean;
  grantsApproval?: boolean;
  rejectsAction?: boolean;
  correctsPriorState?: boolean;
}

export interface IntentClassificationResult {
  inputId: string;
  primaryIntent: SolomonIntentType;
  secondaryIntents: SolomonIntentType[];
  action: SolomonIntentAction;
  storageDisposition: SolomonStorageDisposition;
  authorityRequired: CapabilityAuthorityLevel;
  riskClass: KingmakerRiskClass;
  confidence: number;
  reasonPlain: string;
  executionAllowed: boolean;
  auditRequired: boolean;
}

export function classifyIntent(input: IntentClassificationInput): IntentClassificationResult {
  const text = input.rawText.trim().toLowerCase();

  if (input.grantsApproval || /^approved\b|^approve\b|^yes proceed\b|^proceed\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'APPROVAL',
      secondaryIntents: [],
      action: 'QUEUE_FOR_APPROVAL',
      storageDisposition: 'AUDIT_REQUIRED',
      authorityRequired: 'USER',
      riskClass: 'GREEN',
      confidence: 0.82,
      reasonPlain: 'Input appears to approve a pending action or continue a governed workflow.',
      executionAllowed: false,
      auditRequired: true,
    };
  }

  if (input.rejectsAction || /\b(stop|cancel|reject|do not|don't)\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'REJECTION',
      secondaryIntents: [],
      action: 'BLOCK_EXECUTION',
      storageDisposition: 'AUDIT_REQUIRED',
      authorityRequired: 'USER',
      riskClass: 'GREEN',
      confidence: 0.8,
      reasonPlain: 'Input appears to reject, stop, or block an action.',
      executionAllowed: false,
      auditRequired: true,
    };
  }

  if (input.correctsPriorState || /\b(correct|actually|swap|replace|fix that|wrong)\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'CORRECTION',
      secondaryIntents: [],
      action: 'UPDATE_OBJECTIVE',
      storageDisposition: 'AUDIT_REQUIRED',
      authorityRequired: 'USER',
      riskClass: 'GREEN',
      confidence: 0.76,
      reasonPlain: 'Input appears to correct prior state, doctrine, routing, or assumptions.',
      executionAllowed: false,
      auditRequired: true,
    };
  }

  if (/\bdiagnostic|health check|verify|status\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: text.includes('status') ? 'STATUS_REQUEST' : 'DIAGNOSTIC_REQUEST',
      secondaryIntents: [],
      action: text.includes('diagnostic') || text.includes('health check') || text.includes('verify') ? 'RUN_DIAGNOSTIC' : 'ANSWER_ONLY',
      storageDisposition: 'EPHEMERAL_CONTEXT',
      authorityRequired: 'USER',
      riskClass: 'GREEN',
      confidence: 0.74,
      reasonPlain: 'Input requests status or diagnostic information.',
      executionAllowed: false,
      auditRequired: false,
    };
  }

  if (/\b(enhancement request|feature request|submit request|add this to solomon)\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'ENHANCEMENT_REQUEST',
      secondaryIntents: [],
      action: 'SUBMIT_ENHANCEMENT_REQUEST',
      storageDisposition: 'AUDIT_REQUIRED',
      authorityRequired: 'USER',
      riskClass: 'YELLOW',
      confidence: 0.78,
      reasonPlain: 'Input asks to submit a platform or capability enhancement request.',
      executionAllowed: false,
      auditRequired: true,
    };
  }

  if (input.asksForInformation || /\bwhat|why|how|explain|tell me|research\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: text.includes('research') ? 'RESEARCH_REQUEST' : 'QUESTION',
      secondaryIntents: [],
      action: text.includes('research') ? 'RESEARCH_ONLY' : 'ANSWER_ONLY',
      storageDisposition: 'EPHEMERAL_CONTEXT',
      authorityRequired: 'NONE',
      riskClass: 'GREEN',
      confidence: 0.72,
      reasonPlain: 'Input asks for information rather than execution.',
      executionAllowed: false,
      auditRequired: false,
    };
  }

  if (input.referencesFuture || /\b(someday|down the road|eventually|future|one day)\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'FUTURE_OBJECTIVE',
      secondaryIntents: ['IDEA'],
      action: 'NO_ACTION',
      storageDisposition: 'SUGGESTED_MEMORY',
      authorityRequired: 'NONE',
      riskClass: 'GREEN',
      confidence: 0.7,
      reasonPlain: 'Input describes a future possibility or direction, not a current executable objective.',
      executionAllowed: false,
      auditRequired: false,
    };
  }

  if (input.asksForExecution || /\b(build|create|make|launch|send|execute|start|begin)\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'COMMAND',
      secondaryIntents: ['ACTIVE_OBJECTIVE'],
      action: 'ROUTE_TO_CAPABILITY',
      storageDisposition: 'AUDIT_REQUIRED',
      authorityRequired: 'USER',
      riskClass: 'YELLOW',
      confidence: 0.69,
      reasonPlain: 'Input appears to request execution. Governance and authority checks are required before action.',
      executionAllowed: false,
      auditRequired: true,
    };
  }

  if (/\bidea|thought|concept|maybe\b/.test(text)) {
    return {
      inputId: input.inputId,
      primaryIntent: 'IDEA',
      secondaryIntents: [],
      action: 'NO_ACTION',
      storageDisposition: 'SESSION_CONTEXT',
      authorityRequired: 'NONE',
      riskClass: 'GREEN',
      confidence: 0.68,
      reasonPlain: 'Input appears to be an idea or concept, not an approved objective.',
      executionAllowed: false,
      auditRequired: false,
    };
  }

  return {
    inputId: input.inputId,
    primaryIntent: 'UNKNOWN',
    secondaryIntents: [],
    action: 'ASK_CLARIFYING_QUESTION',
    storageDisposition: 'DO_NOT_STORE',
    authorityRequired: 'NONE',
    riskClass: 'GREEN',
    confidence: 0.35,
    reasonPlain: 'Intent is ambiguous. Solomon must clarify before storing or acting.',
    executionAllowed: false,
    auditRequired: false,
  };
}

export function mayCreateObjective(result: IntentClassificationResult): boolean {
  return result.action === 'CREATE_OBJECTIVE' || result.primaryIntent === 'ACTIVE_OBJECTIVE';
}

export function mayExecuteImmediately(result: IntentClassificationResult): boolean {
  return result.executionAllowed === true && result.auditRequired === true && result.authorityRequired !== 'NONE';
}

export function mustClarifyBeforeAction(result: IntentClassificationResult): boolean {
  return result.primaryIntent === 'UNKNOWN' || result.action === 'ASK_CLARIFYING_QUESTION';
}
