/**
 * contracts/decision-model.ts
 *
 * Type contracts for the decision-model reflex layer.
 *
 * A decision model answers typed questions (choice / yes-no / score) about a
 * piece of state in a single forward pass — no text generation. Kingmaker uses
 * this as the reflex layer: fast, local, bounded decisions (which engine
 * handles this? is this command safe? escalate or proceed?) so the large
 * reasoning models only wake up for actual thinking.
 *
 * Transport: Ollama >= 0.35.0 exposes the Jev-compatible `/v1/systemone`
 * endpoint. llama.cpp's llama-server exposes the same shape on :8080.
 *
 * License gate: only decision models distributed under Apache 2.0 (or
 * similarly permissive) licenses may be registered. Non-commercial builds
 * (e.g. CC BY-NC 4.0) are refused at registration time — see
 * DECISION_MODEL_REGISTRY notes in the runtime.
 *
 * Status: UNTESTED live. No traffic has hit a real /v1/systemone endpoint
 * from this module. Unit tests use a mocked transport.
 */

/** The three question types the /v1/systemone endpoint supports. */
export type DecisionQuestionType = 'choice' | 'noul' | 'score';

export interface DecisionChoiceQuestion {
  type: 'choice';
  /** Human-readable instruction, e.g. "Which engine should handle this?" */
  instructions: string;
  /** Map of option key -> description. The model picks one key. */
  criteria: Record<string, string>;
}

export interface DecisionNoulQuestion {
  type: 'noul';
  instructions: string;
  /** The condition being tested, e.g. "This command modifies persistent state." */
  condition: string;
}

export interface DecisionScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered levels, lowest to highest. */
  criteria: string[];
}

export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionNoulQuestion
  | DecisionScoreQuestion;

/** A single answered question as returned by the endpoint. */
export interface DecisionAnswer {
  /** The winning option key (choice), boolean (noul), or level index (score). */
  answer: string | boolean | number;
  /** Probability per allowed answer. Keys mirror the question's options. */
  probabilities: Record<string, number>;
}

/** Full response envelope from /v1/systemone. */
export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** Milliseconds the endpoint reports for the decision. */
  latencyMs?: number;
}

/** A request: state blob + named typed questions (max 64 per call). */
export interface DecisionRequest {
  /** Compact state bundle — the "sticky note", not the full conversation. */
  state: string;
  questions: Record<string, DecisionQuestion>;
}

/** License status enforced at registration. */
export type DecisionModelLicense = 'apache-2.0' | 'mit' | 'other-permissive';

/** A registered decision model. */
export interface DecisionModelRegistration {
  /** Ollama model name, e.g. "tev1", "nimble", "laya". */
  name: string;
  /** Parameter count label, e.g. "0.8B", "9B". */
  size: string;
  /** Approximate download size, e.g. "812MB", "9.5GB". */
  downloadSize: string;
  license: DecisionModelLicense;
  /** Minimum Ollama version that serves this model. */
  minOllamaVersion: string;
  /** Which Mac classes this model fits. */
  fitsMacClass: Array<'8gb' | '16gb' | '24gb' | '32gb' | '48gb+' | 'spark'>;
  /** Measured or published per-decision latency. */
  publishedLatencyMs?: number;
}

/**
 * Calibration policy: thresholds that turn probabilities into actions.
 * Uncalibrated probabilities make thresholds lies — these defaults are
 * conservative and each deployment MUST re-calibrate against its own
 * labeled traffic before tightening them.
 */
export interface DecisionCalibration {
  /** >= this: auto-proceed without escalation. Default 0.90. */
  autoProceedThreshold: number;
  /** < this: hard escalate to founder/human review. Default 0.60. */
  escalateThreshold: number;
  /** Between escalate and auto-proceed: route to the reasoning model. */
  betweenAction: 'route-to-reasoning';
  /** Maximum questions per single endpoint call. Endpoint cap is 64. */
  maxQuestionsPerCall: number;
  /** Per-decision timeout ms. A slow reflex is a broken reflex. */
  timeoutMs: number;
}

export const DEFAULT_CALIBRATION: DecisionCalibration = {
  autoProceedThreshold: 0.9,
  escalateThreshold: 0.6,
  betweenAction: 'route-to-reasoning',
  maxQuestionsPerCall: 64,
  timeoutMs: 2000,
};

/** Outcome of a routed decision. */
export type DecisionOutcome =
  | { kind: 'auto-proceed'; answer: DecisionAnswer; questionName: string }
  | { kind: 'escalate'; answer: DecisionAnswer; questionName: string; reason: string }
  | { kind: 'route-to-reasoning'; answer: DecisionAnswer; questionName: string }
  | { kind: 'transport-failed'; questionName: string; reason: string };

/** Integration point: the governance chain's Decision step. */
export interface GovernanceDecisionStep {
  /** The step consults the reflex layer before waking the reasoning model. */
  consultReflexLayer(request: DecisionRequest): Promise<DecisionOutcome[]>;
}
