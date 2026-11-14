/**
 * weightsynth-judge.mjs — the Judge and the deterministic search.
 *
 * The Judge measures two things, both on the target hardware (or its
 * twin, for screening): PERFORMANCE (fixed-suite score) and TOKEN
 * PRODUCTION (measured tok/s). Selection is the recipe's balance rule
 * applied to the Pareto frontier — neither metric wins alone, and the
 * rule is data, so a selection can be re-run and audited bit-for-bit.
 *
 * Evaluators and measurers are injected by the host (llama.cpp /
 * Ollama / twin cells). This module owns the arithmetic of judgment,
 * never the machinery of measurement.
 */

import { contentId, streamPrng } from './weightsynth-core.mjs';

/** Non-dominated candidates: nobody beats them on BOTH axes.
 *  Deterministic order: quality desc, production desc, id asc. */
export function paretoFrontier(candidates) {
  const sorted = [...candidates].sort((a, b) =>
    (b.quality - a.quality) || (b.production - a.production) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const frontier = [];
  let bestProduction = -Infinity;
  for (const c of sorted) {
    if (c.production > bestProduction) {
      frontier.push(c);
      bestProduction = c.production;
    }
  }
  return frontier;
}

/**
 * Apply a recipe's balance rule.
 *   refs: { quality, production } — the flagship reference point,
 *   measured on the same hardware. Candidates below
 *   balance.qualityFloor × refs.quality are disqualified outright
 *   (fast and dumb fails). Survivors are scored on the frontier:
 *   score = qw·(q/qRef) + pw·(p/pRef). Winner takes the highest
 *   score; ties break by candidate id (content order, deterministic).
 */
export function selectWinner(candidates, balance, refs) {
  if (!refs || !(refs.quality > 0) || !(refs.production > 0)) {
    throw new Error('REFUSE: flagship reference point must be measured, not assumed');
  }
  const floor = balance.qualityFloor * refs.quality;
  const eligible = candidates.filter((c) => c.quality >= floor);
  const disqualified = candidates.filter((c) => c.quality < floor).map((c) => c.id);
  if (eligible.length === 0) {
    return { winner: null, reason: 'all candidates below the quality floor', disqualified };
  }
  const frontier = paretoFrontier(eligible);
  const scored = frontier.map((c) => ({
    id: c.id,
    score: balance.qualityWeight * (c.quality / refs.quality)
         + balance.productionWeight * (c.production / refs.production),
    quality: c.quality,
    production: c.production,
  }));
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { winner: scored[0], frontier: scored, disqualified };
}

/**
 * Judge one candidate through injected measurement.
 *   evaluate(artifactRef) → { suiteScore, heldOutScore }   (greedy, host-side)
 *   measure(artifactRef)  → { decodeTokPerSec, prefillTokPerSec }
 * Quality = the held-out score when present (the suite can be gamed;
 * the held-out set is the truth), else the suite score. Production =
 * decode tok/s (decode is the sequential, expensive half).
 */
export async function judgeCandidate({ id, artifactRef, evaluate, measure }) {
  if (typeof evaluate !== 'function' || typeof measure !== 'function') {
    throw new Error('REFUSE: the Judge needs an evaluator and a measurer (host-injected)');
  }
  const ev = await evaluate(artifactRef);
  const me = await measure(artifactRef);
  const quality = typeof ev.heldOutScore === 'number' ? ev.heldOutScore : ev.suiteScore;
  if (typeof quality !== 'number' || typeof me.decodeTokPerSec !== 'number') {
    throw new Error('REFUSE: judge measurements must be numbers — a missing measurement is not a zero');
  }
  return {
    id, quality, production: me.decodeTokPerSec,
    suiteScore: ev.suiteScore, heldOutScore: ev.heldOutScore ?? null,
    prefillTokPerSec: me.prefillTokPerSec ?? null,
  };
}

/**
 * Deterministic evolutionary search over linear-merge coefficients.
 *
 *   propose(seed, generation, index) space: coefficient vectors on the
 *   simplex, drawn from the search seed's PRNG stream.
 *   score(recipe) → { quality, production } (injected; the host runs
 *   the merge + the Judge; tests inject a pure function).
 *
 * Population, mutation (gaussian jitter via the same stream, then
 * re-normalized to the simplex), elitism and generation count are all
 * fixed by the search spec — the same spec + seed + scorer produce
 * the same winner and the same record on any machine.
 */
export async function searchLinearRecipes({ baseRecipe, parentCount, score, generations = 6, populationSize = 8 }) {
  if (parentCount < 2) throw new Error('REFUSE: search needs at least two parents');
  if (typeof score !== 'function') throw new Error('REFUSE: search needs a scorer');
  const rand = streamPrng(baseRecipe.seed || 'search', 'linear-search');
  const log = [];

  const randomSimplex = () => {
    const xs = Array.from({ length: parentCount }, () => 0.05 + rand());
    const s = xs.reduce((a, b) => a + b, 0);
    return xs.map((x) => x / s);
  };
  const judged = async (coefficients, generation, index) => {
    const recipe = { ...baseRecipe, algorithm: 'linear', coefficients };
    const recipeId = contentId(recipe);
    const r = await score(recipe);
    return { id: recipeId, recipe, coefficients, quality: r.quality, production: r.production, generation, index };
  };

  let population = [];
  for (let i = 0; i < populationSize; i++) population.push(await judged(randomSimplex(), 0, i));
  log.push({ generation: 0, best: bestOf(population).id });

  for (let g = 1; g <= generations; g++) {
    const elite = bestOf(population);
    const next = [elite];
    for (let i = 1; i < populationSize; i++) {
      const parent = population[Math.floor(rand() * population.length)];
      const child = parent.coefficients.map((c) => Math.max(0.001, c + (rand() - 0.5) * 0.3));
      const s = child.reduce((a, b) => a + b, 0);
      next.push(await judged(child.map((c) => c / s), g, i));
    }
    population = next;
    log.push({ generation: g, best: bestOf(population).id });
  }

  const winner = bestOf(population);
  return { winner, log, evaluated: populationSize * (generations + 1) };
}

function bestOf(population) {
  // Selection pressure inside the search is the balance rule's job at
  // adoption; here the search ranks by quality×production product —
  // fixed rule, id tie-break.
  return [...population].sort((a, b) =>
    (b.quality * b.production - a.quality * a.production) || (a.id < b.id ? -1 : 1))[0];
}
