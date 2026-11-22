/**
 * lib/routing-bandit.mjs
 *
 * Cost-shaped Thompson-sampling bandit, keyed by task-complexity bucket.
 * Pattern studied from RuFlow's model router (behavior spec §1.2, mapping
 * §8: PORT + ADAPT) and re-implemented clean-room, with the spec's fix
 * applied: upstream's learning loop records outcomes from self-reported /
 * caller-asserted success, so the bandit learns to trust whatever the
 * caller claims. Here, recordOutcome is only ever fed by the structural
 * verifier and task acceptance checks — `governed-router.mjs` is the
 * sole caller, and it passes verifier verdicts, never model self-reports.
 *
 * Rewards are cost-shaped: a success on the cheap tier pays 1.0, on the
 * standard tier 0.7, on the frontier tier 0.4 — an expensive model
 * succeeding on a simple task is scored as waste, so the bandit drifts
 * work downhill to the cheapest tier that actually passes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const TIERS = ['cheap', 'standard', 'frontier'];

/** Tier ladder order — the escalation ladder climbs this. */
export const TIER_RANK = Object.freeze({ cheap: 0, standard: 1, frontier: 2 });

export const TIER_REWARD = Object.freeze({ cheap: 1.0, standard: 0.7, frontier: 0.4 });

/**
 * How much a bucket wants a tier before any learning. Simple work prefers
 * cheap hands; hard work prefers the frontier. Multiplies the Thompson draw.
 */
export const BUCKET_AFFINITY = Object.freeze({
  low: Object.freeze({ cheap: 1.0, standard: 0.55, frontier: 0.25 }),
  med: Object.freeze({ cheap: 0.7, standard: 1.0, frontier: 0.6 }),
  high: Object.freeze({ cheap: 0.35, standard: 0.75, frontier: 1.0 }),
});

/** Deterministic RNG (mulberry32) — inject for reproducible tests; default Math.random. */
export function seededRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleGamma(shape, rng) {
  // Marsaglia–Tsang.
  if (shape < 1) {
    const u = Math.max(rng(), Number.EPSILON);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    // Box–Muller, one draw per call (no spare caching — the rng must stay stateless-looking).
    const u1 = Math.max(rng(), Number.EPSILON);
    const u2 = rng();
    x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(Math.max(u, Number.EPSILON)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha, beta, rng) {
  const ga = sampleGamma(alpha, rng);
  const gb = sampleGamma(beta, rng);
  return ga / (ga + gb);
}

const armKey = (bucket, modelId) => `${bucket}:${modelId}`;

/**
 * Create a bandit. opts:
 *   statePath — local JSON file; loaded if present, rewritten on every outcome.
 *   rng       — draw source (default Math.random); pass seededRng(n) for tests.
 * Arms are created lazily per (bucket, model) with a uniform Beta(1,1) prior.
 */
export function createBandit({ statePath = null, rng = Math.random } = {}) {
  let arms = {};
  let history = [];
  if (statePath && existsSync(statePath)) {
    try {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      arms = saved.arms ?? {};
      history = saved.history ?? [];
    } catch {
      arms = {}; // a corrupt state file must not take routing down — priors relearn fast
      history = [];
    }
  }

  const save = () => {
    if (statePath) writeFileSync(statePath, JSON.stringify({ arms, history }, null, 2));
  };

  const arm = (bucket, modelId) => {
    const k = armKey(bucket, modelId);
    if (!arms[k]) arms[k] = { alpha: 1, beta: 1, observations: 0 };
    return arms[k];
  };

  return {
    statePath,

    /**
     * Pick among candidates = [{ id, tier }]. Returns the winner plus every
     * candidate's draw (the ranked alternatives the decision record carries).
     */
    pick(bucket, candidates) {
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('routing-bandit: pick needs at least one candidate');
      }
      const affinity = BUCKET_AFFINITY[bucket] ?? BUCKET_AFFINITY.med;
      const scored = candidates.map((c) => {
        const a = arm(bucket, c.id);
        const theta = sampleBeta(a.alpha, a.beta, rng);
        return { modelId: c.id, tier: c.tier, theta, score: theta * (affinity[c.tier] ?? 0.5) };
      });
      scored.sort((x, y) => y.score - x.score);
      return { pick: scored[0], alternatives: scored.slice(1), scored };
    },

    /**
     * Record a VERIFIED outcome. outcome: 'success' | 'fail' | 'escalated'.
     * 'escalated' means this arm's output failed the verifier and the task
     * climbed a tier — scored as failure for this arm.
     */
    recordOutcome({ bucket, modelId, tier, outcome, task = '' }) {
      const a = arm(bucket, modelId);
      const reward = outcome === 'success' ? (TIER_REWARD[tier] ?? 0.5) : 0;
      a.alpha += reward;
      a.beta += 1 - reward;
      a.observations += 1;
      history.push({
        ts: new Date().toISOString(),
        bucket,
        modelId,
        tier,
        outcome,
        reward,
        task: String(task).slice(0, 100), // truncated, as in the reference state file
      });
      if (history.length > 100) history = history.slice(-100);
      save();
      return { ...a };
    },

    /** Read an arm's learned state (priors + observation count). */
    armState(bucket, modelId) {
      return { ...arm(bucket, modelId) };
    },

    save,
    get history() {
      return [...history];
    },
  };
}
