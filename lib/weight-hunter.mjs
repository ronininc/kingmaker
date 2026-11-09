// Prompt-time weight hunter. This is not the forge (lib/weight-hunter-forge.mjs).
// The forge plans new models offline and waits for the owner. This module only
// chooses an existing Brain Library model for the task in front of it.
//
// It classifies the task, scores library models that are eligible for that
// role inside this Mac's memory class, and drops anything under the role's
// speed floor (roleScore already does). The highest score wins. A tie prefers
// a model Ollama already has, then one whose GGUF is already in the cache,
// then one that still has to be fetched. The chosen model is the only model
// for that task: the caller does not swap to another one mid-task.
//
// Fetching, when it is needed, is a cached download of the full GGUF. Ollama
// cannot run a portion.

import { eligible, roleScore } from './brain-library.mjs';
import { ruleLane } from './fast-route.mjs';
import { classFor } from './mac-profiles.mjs';
import { hasModel } from './model-bench.mjs';

const CODER = /\b(code|coder|coding|debug|refactor|patch|compile|python|javascript|typescript|sql|function|script|bug|implement)\b/i;
const VISION = /\b(screenshot|photo|picture of|image of|diagram|what(?:'s| is) (?:in|on) (?:this|the) (?:photo|image|picture|screenshot))\b/i;
const REASONING = /\b(prove|reason(?:ing)?|step by step|think through|analy[sz]e|derive|theorem|why does)\b/i;

const RANK = Object.freeze({ installed: 0, cached: 1, fetch: 2 });

/** The calibration switch, or the Kingmaker x Heretic spine, turns the hunter on. */
export function weightHunterEnabled(calibration) {
  if (!calibration || typeof calibration !== 'object') return false;
  if (calibration.weightHunter?.on === true) return true;
  if (calibration.router?.governanceSpine === 'kingmaker-x-heretic') return true;
  return false;
}

/** Actions, lookups, opens, and picture draws stay on their existing lanes. */
export function leavesLocalWeights(text) {
  const lane = ruleLane(text);
  return lane === 'act' || lane === 'open' || lane === 'lookup' || lane === 'image';
}

/** The library role for this task, or null when the governed lanes should keep it.
 *  A grouped instruction is classified from its local steps. "Write it, then
 *  email it" is still a writing task; the email step stays on the governed brain. */
export function classifyTask(text, { image = false } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return null;
  const steps = source.split(/\s*;\s*|\s+->\s*|\s*→\s*|\s+then\s+|\n/).map((step) => step.trim()).filter(Boolean);
  const local = (steps.length > 1 ? steps : [source]).filter((step) => !leavesLocalWeights(step));
  if (!local.length) return null;
  const basis = local.join('\n');
  if (image || VISION.test(basis)) return 'vision';
  if (CODER.test(basis)) return 'coder';
  if (REASONING.test(basis)) return 'reasoning';
  return 'writer';
}

function availabilityOf(model, installed, cached) {
  if (hasModel(installed, model.tag)) return 'installed';
  const have = cached ?? [];
  if (have.includes(model.tag) || have.includes(model.slug)) return 'cached';
  if (model.weights?.sha256 && model.weights?.parts?.length) return 'fetch';
  return null;
}

/**
 * Eligible models for this role and memory class, best score first.
 * A model with no measurement on this class is kept only when it is already
 * the class's pick for the role, and then only at score 0 so a measured
 * model outranks it. A measured footprint above the class budget is out.
 */
export function scoreLibraryModels(library, role, memoryClass) {
  const cls = (library?.classes ?? []).find((item) => item.class === memoryClass);
  if (!cls || !role) return [];
  const scored = [];
  for (const model of library.models ?? []) {
    if (!eligible(model, role, cls)) continue;
    const runs = (model.bench ?? []).filter((bench) => (cls.measuredOn ?? []).includes(bench.file));
    const best = runs.map((bench) => ({ bench, score: roleScore(role, bench) })).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score)[0];
    if (best) {
      if (best.bench.holdsGb != null && best.bench.holdsGb > cls.maxResidentGb) continue;
      scored.push({ model, score: best.score, measured: true, holdsGb: best.bench.holdsGb ?? null, tokS: best.bench.tokS ?? null });
      continue;
    }
    const picked = (model.picks ?? []).some((pick) => pick.class === cls.class && pick.role === role);
    if (picked) scored.push({ model, score: 0, measured: false, holdsGb: null });
  }
  return scored;
}

/**
 * The model the task should run on, or null when nothing eligible fits.
 * Score decides. Availability breaks ties: installed, then cached, then fetch.
 */
export function huntWeights({ text, library, memoryClass, installed = [], cached = [], image = false } = {}) {
  const role = classifyTask(text, { image });
  if (!role) return null;
  const ranked = scoreLibraryModels(library, role, memoryClass).map((item) => ({
    ...item,
    availability: availabilityOf(item.model, installed, cached),
  })).filter((item) => item.availability);
  ranked.sort((a, b) => (b.score - a.score) || (RANK[a.availability] - RANK[b.availability]) || ((a.holdsGb ?? 99) - (b.holdsGb ?? 99)));
  const top = ranked[0];
  if (!top) return null;
  return {
    role,
    tag: top.model.tag,
    slug: top.model.slug,
    score: top.score,
    tokS: top.tokS ?? null,
    holdsGb: top.holdsGb ?? null,
    availability: top.availability,
    model: top.model,
    swap: false,
  };
}

/**
 * `beforeWeights` for lib/execution-loop.mjs. Null when the hunter is off, so
 * the loop's bench pick is unchanged. When it is on, the returned pick carries
 * a measured tok/s (the bench record for that tag, else the library measurement)
 * and `swap: false`.
 */
export function executionLoopBeforeWeights({ calibration, library, memoryClass, installed = [], cached = [], ensure = async () => {} } = {}) {
  if (!weightHunterEnabled(calibration)) return null;
  return async ({ request, ramGb, records }) => {
    const plan = huntWeights({ text: request, library, memoryClass: memoryClass ?? classFor(ramGb ?? 8), installed, cached });
    if (!plan) return null;
    if (plan.availability !== 'installed') await ensure(plan);
    const record = (records ?? []).find((item) => item.model === plan.tag);
    const genTokS = Number(record?.genTokS ?? plan.tokS);
    if (!Number.isFinite(genTokS) || genTokS <= 0) return null;
    return {
      model: plan.tag,
      genTokS,
      loadS: Number(record?.loadS) || 0,
      sizeGb: record?.sizeGb ?? plan.holdsGb ?? null,
      evalShare: record?.evalShare ?? null,
      benchFile: record?.benchFile || 'brain-library',
      availability: plan.availability,
      reason: `weight hunter picked ${plan.tag} (${plan.role}, ${plan.availability}) for this task; the run keeps that one model`,
      considered: [],
    };
  };
}

/**
 * The execution loop calls this before it selects a model.
 * Off: the fallback model is returned and nothing is fetched.
 * On: the hunted tag is the model for the whole task. `ensure` runs only
 * when that model is not already installed.
 */
export async function beforeModelSelection({
  text,
  calibration,
  pin = null,
  profileModel = null,
  image = false,
  library = null,
  loadLibrary = null,
  memoryClass = 8,
  installed = [],
  cached = [],
  ensure = async () => {},
} = {}) {
  const fallback = pin || profileModel || null;
  if (!weightHunterEnabled(calibration)) return { enabled: false, hunted: false, model: fallback, swap: false };
  let catalog = library;
  if (!catalog && typeof loadLibrary === 'function') {
    try { catalog = await loadLibrary(); } catch { catalog = null; }
  }
  if (!catalog) return { enabled: true, hunted: false, model: fallback, swap: false, reason: 'no-catalog' };
  const plan = huntWeights({ text, library: catalog, memoryClass, installed, cached, image });
  if (!plan) return { enabled: true, hunted: false, model: fallback, swap: false, reason: 'no-eligible-model' };
  if (plan.availability !== 'installed') await ensure(plan);
  return {
    enabled: true,
    hunted: true,
    model: plan.tag,
    role: plan.role,
    availability: plan.availability,
    score: plan.score,
    swap: false,
    plan,
  };
}
