// Prompt-time weight hunter. This is not the forge (lib/weight-hunter-forge.mjs).
// The forge plans new models offline and waits for the owner. This module only
// chooses an existing Brain Library model for the task in front of it.
//
// It is the owner's OVERRIDE lane (calibration switch, or the Kingmaker x
// Heretic spine): the loop's default pick is the smallest-sufficient
// selector's, and the hunter replaces it only when the owner has turned it
// on. It classifies the task, scores library models that are eligible for
// that role — measured anywhere, on any device; no memory class is
// consulted — and drops anything under the role's speed floor (roleScore
// already does). The highest score wins. A tie prefers a model Ollama
// already has, then one whose GGUF is already in the cache, then one that
// still has to be fetched, then the smaller hold. The chosen model is the
// only model for that task: the caller does not swap to another one mid-task.
//
// Fetching, when it is needed, is a cached download of the full GGUF. Ollama
// cannot run a portion.

import { isWorkflowCreationRequest } from './workflow-intent.mjs';
import { eligible, roleScore } from './brain-library.mjs';
import { isSelfContainedReasoningPrompt } from './direct-reasoning.mjs';
import { ruleLane } from './fast-route.mjs';
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
  const local = (steps.length > 1 ? steps : [source]).filter((step) => !leavesLocalWeights(step) || isWorkflowCreationRequest(step));
  if (!local.length) return null;
  const basis = local.join('\n');
  if (local.some(isWorkflowCreationRequest)) return 'coder'; // planner only; action lane unchanged
  if (image || VISION.test(basis)) return 'vision';
  if (CODER.test(basis)) return 'coder';
  if (REASONING.test(basis) || isSelfContainedReasoningPrompt(basis)) return 'reasoning';
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
 * Eligible models for this role, best score first. Measurements count from
 * every bench file — a model measured on any device is measured. A model
 * with no measurement at all is kept only when it is the floor's pick for
 * the role, and then only at score 0 so a measured model outranks it. No
 * footprint rejects a model here: size orders ties, it never gates.
 */
export function scoreLibraryModels(library, role) {
  if (!role) return [];
  const scored = [];
  for (const model of library.models ?? []) {
    if (!eligible(model, role)) continue;
    const runs = model.bench ?? [];
    const best = runs.map((bench) => ({ bench, score: roleScore(role, bench) })).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score)[0];
    if (best) {
      scored.push({ model, score: best.score, measured: true, holdsGb: best.bench.holdsGb ?? null, tokS: best.bench.tokS ?? null });
      continue;
    }
    const picked = (model.picks ?? []).some((pick) => pick.role === role);
    if (picked) scored.push({ model, score: 0, measured: false, holdsGb: null });
  }
  return scored;
}

/**
 * The model the task should run on, or null when nothing eligible fits.
 * Retrieval policy limits candidates first. Score decides among allowed models;
 * availability breaks ties: installed, then cached, then fetch.
 */
export function huntWeights({ text, library, role: roleOverride = null, installed = [], cached = [], image = false, allowDownload = true } = {}) {
  const role = roleOverride ?? classifyTask(text, { image });
  if (!role) return null;
  const ranked = scoreLibraryModels(library, role).map((item) => ({
    ...item,
    availability: availabilityOf(item.model, installed, cached),
  })).filter((item) => item.availability && (allowDownload || item.availability !== 'fetch'));
  ranked.sort((a, b) => (b.score - a.score) || (RANK[a.availability] - RANK[b.availability]) || ((a.holdsGb ?? 99) - (b.holdsGb ?? 99)) || ((a.model.downloadGb ?? 99) - (b.model.downloadGb ?? 99)));
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

/** Cache checks are tie-break evidence, not a reason to hash the entire library.
 * Only models capable of beating the best guaranteed policy-allowed model
 * need probing. In local-only mode remote releases are not guaranteed. An installed top pick
 * outranks every cached/fetch tie, so it needs no cache disk reads at all.
 */
export function cacheCandidatesForTask({text,library,installed=[],image=false,allowDownload=true}={}) {
 const role=classifyTask(text,{image});
 const scored=scoreLibraryModels(library,role).filter(({model:m})=>
  hasModel(installed,m.tag)||(m.weights?.sha256&&m.slug&&m.weights.gguf));
 if(!scored.length)return [];
 const guaranteed=scored.filter(x=>hasModel(installed,x.model.tag)||(allowDownload && x.model.weights?.parts?.length));
 const floor=guaranteed.length?Math.max(...guaranteed.map(x=>x.score)):-Infinity;
 const top=scored.filter(x=>x.score>=floor);
 const installedBest=Math.max(-Infinity,...top.filter(x=>hasModel(installed,x.model.tag)).map(x=>x.score));
 return top.filter(x=>x.score>installedBest).map(x=>x.model);
}

/**
 * `beforeWeights` for lib/execution-loop.mjs. Null when the hunter is off, so
 * the loop's bench pick is unchanged. When it is on, the returned pick carries
 * a measured tok/s (the bench record for that tag, else the library measurement)
 * and `swap: false`.
 */
export function executionLoopBeforeWeights({ calibration, library, installed = [], cached = [], ensure = async () => {}, allowDownload = false } = {}) {
  if (!weightHunterEnabled(calibration)) return null;
  return async ({ request, requirement = null, records }) => {
    const selection = { text: request, library, role: requirement?.role ?? null, installed, cached };
    const plan = huntWeights({ ...selection, allowDownload }) ?? (!allowDownload ? huntWeights(selection) : null);
    if (!plan) return null;
    if(plan.availability === 'fetch' && !allowDownload){const error=new Error('Selected weights not local; download paused, no fallback');error.code='WEIGHTS_NOT_LOCAL';throw error;}
    if (plan.availability !== 'installed') await ensure(plan);
    const record = (records ?? []).find((item) => item.model === plan.tag);
    const genTokS = Number(record?.genTokS ?? plan.tokS);
    if (!Number.isFinite(genTokS) || genTokS <= 0) return null;
    return {
      model: plan.tag,
      genTokS,
      loadS: Number(record?.loadS) || 0,
      sizeGb: record?.sizeGb ?? plan.model.downloadGb ?? plan.holdsGb ?? null,
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
  installed = [],
  cached = [],
  ensure = async () => {},
  allowDownload = false,
} = {}) {
  const fallback = pin || profileModel || null;
  if (!weightHunterEnabled(calibration)) return { enabled: false, hunted: false, model: fallback, swap: false };
  let catalog = library;
  if (!catalog && typeof loadLibrary === 'function') {
    try { catalog = await loadLibrary(); } catch { catalog = null; }
  }
  if (!catalog) return { enabled: true, hunted: false, model: fallback, swap: false, reason: 'no-catalog' };
  const selection = { text, library: catalog, installed, cached, image };
  // Select within the retrieval policy before inference. This is not a model swap
  // or a failure fallback: missing remote weights cannot win a local-only turn.
  // Retain a blocked plan when no eligible local model exists, never a profile fallback.
  const plan = huntWeights({ ...selection, allowDownload }) ?? (!allowDownload ? huntWeights(selection) : null);
  if (!plan) return { enabled: true, hunted: false, model: fallback, swap: false, reason: 'no-eligible-model' };
  if (plan.availability === 'fetch' && !allowDownload) return {enabled:true,hunted:false,model:null,swap:false,reason:'weights-not-local-download-disabled',blocked:true,plan};
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

// ── The METHOD hunt (local-brain methods, 2026-11-16) ─────────────────────────────────────────
// The owner's "weights" in the routing sense: routing wisdom and method files — how a task is
// done — not neural-network parameters. The model hunt above picks an existing model; this hunt
// fills a MISSING METHOD. It is consulted only when the device's own method library (the local
// store + the bundled catalog) does not cover a request (the execution loop's coverage gate).
//
//   1. The configured Brain Library repo's methods index (lib/brain-library-repo.mjs
//      repoIndexUrl('methods', remote) — the same lane the remote conductor reads) is fetched once.
//   2. Every remote entry is scored with the loop's own scoreMethod; the best one at or above
//      COVERAGE_MIN_RELEVANCE is the candidate. Nothing below the gate is pulled ("no guessing").
//   3. Only that ONE file is fetched. It must match BOTH index pins (size and sha256 — the repo
//      supplier only enforced size), re-parse with the conductor's own parseMethodFile as the same
//      id, and pass the Armor lexical admission scan (lib/learning-armor-scan.mjs).
//   4. It is filed in the device's local method store (<state>/brain-library/methods, the layout
//      lib/method-iteration.mjs writes and every conductor reads): file first, then index. The
//      provenance (url, pins, scan verdict, time) is appended to <store>/acquired.jsonl.
// Later runs find it locally: no re-fetch, no hosted model. Offline, or with the remote switched
// off (KINGMAKER_LIBRARY_REMOTE=off), the hunt pulls nothing and returns status 'missing' with the
// exact method need stated — it never substitutes a cloud service.
export async function huntMethod({
  request, storeDir, remote = {}, fetchImpl = fetch, env = process.env, timeoutMs = 15_000,
  minRelevance = null, now = () => new Date(), entitlement = null, requireEntitlement = false,
} = {}) {
  const { repoIndexUrl, libraryRemoteEnabled } = await import('./brain-library-repo.mjs');
  const { scoreMethod, COVERAGE_MIN_RELEVANCE } = await import('./execution-loop.mjs');
  const { parseMethodFile } = await import('./method-conductor.mjs');
  const { normalizeMethodsIndex, METHODS_SCHEMA } = await import('./brain-library.mjs');
  const { scanLearningMethod } = await import('./learning-armor-scan.mjs');
  const { createHash } = await import('node:crypto');
  const { mkdir, readFile, writeFile, appendFile, rename } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const gate = minRelevance ?? COVERAGE_MIN_RELEVANCE;
  const need = String(request ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const network = { requests: 0, bytes: 0, urls: [] };
  if (!storeDir) throw new Error('huntMethod: storeDir is required (the device-local method store)');
  if (remote === false || !libraryRemoteEnabled(env)) {
    return { status: 'missing', offline: true, need, network, reason: `no local method covers "${need}", and remote method retrieval is off (KINGMAKER_LIBRARY_REMOTE=off) — nothing was fetched and no hosted model was used` };
  }
  const repoOpts = remote && typeof remote === 'object' ? remote : {};
  const indexUrl = repoIndexUrl('methods', repoOpts);
  // The curated library is a paid-membership corpus: its source (update-host /library/methods) serves only to a
  // host-signed entitlement for sku library.methods, sent as x-ronin-entitlement. The check that matters is the
  // server's; the client only declines to try without one, and reports a 401 as not-entitled (never as "missing").
  const ent = typeof entitlement === 'function' ? await entitlement() : entitlement;
  if (requireEntitlement && !ent) {
    return { status: 'not-entitled', need, network, source: indexUrl, reason: `no local method covers "${need}", and this install has no curated-library membership — the curated library was not contacted` };
  }
  const headers = ent ? { 'x-ronin-entitlement': Buffer.from(JSON.stringify(ent)).toString('base64') } : {};
  const get = async (url) => {
    network.requests += 1; network.urls.push(url);
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res?.status === 401 || res?.status === 403) throw Object.assign(new Error(`HTTP ${res.status}`), { notEntitled: true });
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 'no response'}`);
    const buf = Buffer.from(await res.arrayBuffer()); network.bytes += buf.length; return buf;
  };
  let raw;
  try { raw = JSON.parse((await get(indexUrl)).toString('utf8')); normalizeMethodsIndex(raw); }
  catch (e) {
    if (e.notEntitled) return { status: 'not-entitled', need, network, source: indexUrl, reason: `the curated library refused this install (${e.message}): no current membership entitlement` };
    return { status: 'missing', offline: true, need, network, source: indexUrl, reason: `no local method covers "${need}", and the method source ${indexUrl} could not be read (${e.message}) — offline or unavailable; nothing was substituted` };
  }
  const ranked = raw.methods.map((m) => ({ entry: m, relevance: scoreMethod({ id: m.id, title: m.title ?? m.id, domain: m.domain ?? null, inputKeys: m.inputKeys ?? [] }, request) }))
    .sort((a, b) => b.relevance - a.relevance || (b.entry.quality?.score ?? 0) - (a.entry.quality?.score ?? 0));
  const closest = ranked.slice(0, 3).map((r) => ({ id: r.entry.id, relevance: r.relevance }));
  const best = ranked[0];
  if (!best || best.relevance < gate) {
    return { status: 'no-remote-coverage', need, network, source: indexUrl, closest, reason: `the method source has no method covering "${need}" (best relevance ${best?.relevance ?? 0} < ${gate}) — nothing pulled` };
  }
  const { entry } = best;
  const refuse = (why) => ({ status: 'refused', need, network, source: indexUrl, id: entry.id, reason: why });
  if (!Number.isInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(String(entry.sha256 ?? ''))) return refuse(`method "${entry.id}" is not pinned (size + sha256 required) — not pulled`);
  if (!/^[a-z0-9][a-z0-9._-]*\.method\.md$/i.test(entry.file)) return refuse(`method "${entry.id}" names an unsafe file "${entry.file}" — not pulled`);
  const fileUrl = new URL(entry.file, indexUrl).href;
  let buf;
  try { buf = await get(fileUrl); } catch (e) { return { ...refuse(`fetch of ${fileUrl} failed (${e.message})`), status: 'missing', offline: true }; }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (buf.length !== entry.size) return refuse(`"${entry.id}" arrived as ${buf.length} bytes; the index pins ${entry.size} — refused, not stored`);
  if (sha256 !== entry.sha256) return refuse(`"${entry.id}" sha256 ${sha256.slice(0, 12)}… does not match the index pin ${entry.sha256.slice(0, 12)}… — refused, not stored`);
  const text = buf.toString('utf8');
  let spec;
  try { spec = parseMethodFile(text); } catch (e) { return refuse(`"${entry.id}" does not parse as a conductable method (${e.message}) — refused`); }
  if (spec.id !== entry.id) return refuse(`file declares id "${spec.id}" but the index names "${entry.id}" — refused`);
  let scan;
  try { scan = await scanLearningMethod(text); } catch (e) { return refuse(`Armor admission scan: ${e.message} — refused, not stored`); }
  // File it: method first, then the index (an unindexed file is inert), each via temp + rename.
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const indexPath = join(storeDir, 'index.json');
  let prior = [];
  try { prior = normalizeMethodsIndex(JSON.parse(await readFile(indexPath, 'utf8'))); } catch { prior = []; }
  const descriptor = { id: entry.id, title: entry.title ?? entry.id, domain: entry.domain ?? null, file: entry.file, quality: entry.quality };
  const indexDoc = { schema: METHODS_SCHEMA, methods: [...prior.filter((m) => m.id !== entry.id), descriptor] };
  normalizeMethodsIndex(indexDoc);
  const put = async (path, data) => { const tmp = `${path}.tmp-${process.pid}`; await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, path); };
  await put(join(storeDir, entry.file), buf);
  await put(indexPath, `${JSON.stringify(indexDoc, null, 2)}\n`);
  const receipt = { at: now().toISOString(), id: entry.id, version: spec.version, file: entry.file, url: fileUrl, source: indexUrl, size: buf.length, sha256, relevance: best.relevance, armor: { verdict: scan.record.verdict, engine: scan.record.engine?.name, limitation: scan.limitation } };
  await appendFile(join(storeDir, 'acquired.jsonl'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return { status: 'acquired', need, network, ...receipt, storeDir, closest };
}
