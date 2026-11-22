/**
 * Kingmaker — think / no-think lane policy (Edge0 × MiniCPM5 augmentation).
 *
 * One checkpoint serves two tempers: a fast assistant and a deliberate
 * reasoner. MiniCPM5-1B makes the split a template behavior — think
 * blocks emitted or force-emptied per call — with a sampling preset
 * per mode (card + generation_config.json: think 0.9/0.95, no-think
 * 0.7/0.95). This module is that split as serving policy, model-
 * agnostic: which lane a call runs in is decided by the CALLER and
 * the task kind — never by the model — and every decision returns
 * its reason so the choice is auditable after the fact.
 *
 * Policy is data + pure functions. No I/O, no network, no state.
 */

/**
 * Sampling presets, MiniCPM5's per-mode recommendations.
 * think: generation_config.json ships temperature 0.9 / top_p 0.95.
 * noThink: the card's No-Think row — 0.7 / 0.95.
 */
export const SAMPLING_PRESETS = {
  think: { temperature: 0.9, topP: 0.95 },
  noThink: { temperature: 0.7, topP: 0.95 },
};

/**
 * The lanes.
 *   reflex   — the fast-route seat: routing, classification, tool
 *              calls. No thinking, tight budget, stop at the first
 *              complete tool call. A reflex call that needs reasoning
 *              is a misroute — the governor escalates it to deep.
 *   standard — ordinary governed-brain work: answers, summaries,
 *              extraction. No thinking, normal budget.
 *   deep     — deliberate reasoning: planning, analysis, code, review.
 *              Think enabled, think preset, generous budget.
 */
export const LANES = {
  reflex: {
    id: 'reflex',
    think: false,
    sampling: SAMPLING_PRESETS.noThink,
    maxTokens: 256,
    stopOnFirstToolCall: true,
    description: 'Routing, classification, tool calls. No-think, tight budget.',
  },
  standard: {
    id: 'standard',
    think: false,
    sampling: SAMPLING_PRESETS.noThink,
    maxTokens: 2048,
    stopOnFirstToolCall: false,
    description: 'Ordinary answers, summaries, extraction. No-think, normal budget.',
  },
  deep: {
    id: 'deep',
    think: true,
    sampling: SAMPLING_PRESETS.think,
    maxTokens: 8192,
    stopOnFirstToolCall: false,
    description: 'Planning, analysis, code, review. Think enabled, generous budget.',
  },
};

/** Default lane when nothing about the task is known. */
export const DEFAULT_LANE = 'standard';

/**
 * Task kind → lane. Kinds are named by the caller (the router, the
 * governed brain) — this table is the whole classification logic,
 * deliberately small enough to audit at a glance.
 */
export const KIND_TO_LANE = {
  route: 'reflex',
  classify: 'reflex',
  'tool-call': 'reflex',
  reflex: 'reflex',
  chat: 'standard',
  answer: 'standard',
  summarize: 'standard',
  extract: 'standard',
  reason: 'deep',
  plan: 'deep',
  analyze: 'deep',
  code: 'deep',
  review: 'deep',
};

/** The policy object for a lane id. Throws on unknown lane. */
export function lanePolicy(laneId) {
  const lane = LANES[laneId];
  if (!lane) throw new Error(`unknown lane: ${laneId}`);
  return lane;
}

/**
 * Choose the lane for a task.
 *
 * @param {Object} task
 * @param {string} [task.kind] - caller-named task kind (see KIND_TO_LANE)
 * @param {string} [task.lane] - explicit lane chosen by the caller; wins
 * @returns {{ lane: string, policy: Object, reason: string, decidedBy: string }}
 *   decidedBy is 'caller' or 'kind' or 'default' — never 'model'.
 */
export function classifyLane(task = {}) {
  if (task.lane !== undefined) {
    if (!LANES[task.lane]) throw new Error(`unknown lane: ${task.lane}`);
    return {
      lane: task.lane,
      policy: LANES[task.lane],
      reason: `caller specified lane '${task.lane}' — caller's call, honored as given`,
      decidedBy: 'caller',
    };
  }
  if (task.kind !== undefined && KIND_TO_LANE[task.kind]) {
    const lane = KIND_TO_LANE[task.kind];
    return {
      lane,
      policy: LANES[lane],
      reason: `task kind '${task.kind}' maps to lane '${lane}'`,
      decidedBy: 'kind',
    };
  }
  return {
    lane: DEFAULT_LANE,
    policy: LANES[DEFAULT_LANE],
    reason:
      task.kind !== undefined
        ? `unknown task kind '${task.kind}' — default lane '${DEFAULT_LANE}'`
        : `no kind or lane given — default lane '${DEFAULT_LANE}'`,
    decidedBy: 'default',
  };
}

/**
 * Enforce a lane's token budget on a request.
 *
 * @param {string} laneId
 * @param {Object} [request]
 * @param {number} [request.maxTokens] - what the caller asked for
 * @returns {{ maxTokens: number, clamped: boolean, reason: string }}
 */
export function enforceBudget(laneId, request = {}) {
  const lane = lanePolicy(laneId);
  const requested = request.maxTokens;
  if (!Number.isFinite(requested)) {
    return {
      maxTokens: lane.maxTokens,
      clamped: false,
      reason: `no budget requested — lane '${laneId}' default of ${lane.maxTokens} applies`,
    };
  }
  if (requested > lane.maxTokens) {
    return {
      maxTokens: lane.maxTokens,
      clamped: true,
      reason: `requested ${requested} exceeds lane '${laneId}' budget ${lane.maxTokens} — clamped`,
    };
  }
  return {
    maxTokens: requested,
    clamped: false,
    reason: `requested ${requested} is within lane '${laneId}' budget ${lane.maxTokens}`,
  };
}

/**
 * Check observed usage against a lane's budget mid-flight.
 *
 * @param {string} laneId
 * @param {Object} usage
 * @param {number} usage.tokensUsed
 * @returns {{ withinBudget: boolean, tokensUsed: number, budget: number,
 *             remaining: number, overBy: number, action: string, reason: string }}
 *   action is 'continue' or 'stop' — the serving loop stops generation
 *   at the budget rather than discovering the overrun afterwards.
 */
export function checkUsage(laneId, usage = {}) {
  const lane = lanePolicy(laneId);
  const tokensUsed = usage.tokensUsed || 0;
  const overBy = Math.max(0, tokensUsed - lane.maxTokens);
  const withinBudget = overBy === 0;
  return {
    withinBudget,
    tokensUsed,
    budget: lane.maxTokens,
    remaining: Math.max(0, lane.maxTokens - tokensUsed),
    overBy,
    action: withinBudget ? 'continue' : 'stop',
    reason: withinBudget
      ? `${tokensUsed}/${lane.maxTokens} tokens used in lane '${laneId}' — within budget`
      : `${tokensUsed}/${lane.maxTokens} tokens used in lane '${laneId}' — over budget by ${overBy}, stop`,
  };
}

/**
 * The sampling + thinking configuration a lane hands to the serving
 * layer for one call — the MiniCPM-style preset, resolved.
 */
export function generationConfigFor(laneId, request = {}) {
  const lane = lanePolicy(laneId);
  const budget = enforceBudget(laneId, request);
  return {
    lane: laneId,
    enableThinking: lane.think,
    temperature: lane.sampling.temperature,
    topP: lane.sampling.topP,
    maxTokens: budget.maxTokens,
    stopOnFirstToolCall: lane.stopOnFirstToolCall,
    budgetReason: budget.reason,
  };
}
