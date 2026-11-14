// The lane a prompt is on before any model sees it. Each gate here is a pure check the bar
// or the engine runs first. Ordinary writing, math, code, and opinions stay on `model` or
// `write`. A gate returns something else only for an explicit ask.
import { isAdRequest } from './ad-video.mjs';
import { isExplicitReadiness, isSelfContainedReasoningPrompt } from './direct-reasoning.mjs';
import { ruleLane } from './fast-route.mjs';
import { jobRefusal } from './job-inbox.mjs';
import { isDecisionRequest } from './reflex-layer.mjs';
import { splitInstructionChain } from './turn-chain.mjs';

export function preModelLane(text) {
  const t = String(text ?? '');
  const refusal = jobRefusal(t);
  if (refusal === 'DECISION_NOT_ALLOWED' || refusal === 'COMMAND_NOT_ALLOWED') return 'refused';
  if (isExplicitReadiness(t)) return 'readiness';
  if (isAdRequest(t)) return 'ad';
  if (isDecisionRequest(t)) return 'reflex';
  if (isSelfContainedReasoningPrompt(t)) return 'direct-reasoning';
  if (splitInstructionChain(t).length >= 2) return 'chain';
  return ruleLane(t) ?? 'model';
}
