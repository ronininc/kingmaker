// lib/method-request.mjs — a plain-language request, conducted through the method library on this
// device (local-brain methods, 2026-11-16). "Kingmaker, run the boat test" → the wake phrase is
// stripped (lib/voice.mjs splitWake), the task is matched to a method by the execution loop's own
// pick and coverage gate, a missing method is hunted from the configured source, the method's
// steps are conducted (its tool steps dispatched by the conductor's allowlisted vocabulary; its
// reason steps on the local model), its verify steps checked, and a user-visible report is built
// with the exact method, layer, model, step dispatch, checks, timings, memory and every network
// request. No hosted model is ever called here; an external inference call would be counted and
// reported, never hidden.
//
// Ability layers (access model, 2026-11-16), conducted in this order:
//   your abilities   <state>/abilities/methods       methods you wrote or acquired yourself; never gated
//   curated library  <state>/brain-library/methods   the local cache the method hunt fills
//   built-in         catalog/methods (bundled)       the runtime's own baseline methods
// An APPROVED external drive (lib/external-storage.mjs) adds its own stores to the same layers, in the same order
// (its store first within a layer, so the place writes go is the place reads win); a missing or read-only drive is
// reported per resource on every run, local abilities keep working, and nothing is fetched instead.
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolveStorage, storageLayers, writeTarget, copyStoreToDrive, driveWriter } from './external-storage.mjs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createExecutionLoop } from './execution-loop.mjs';
import { localModelTurn } from './local-turn.mjs';
import { resolvePaths } from './paths.mjs';
import { detectDevice, firstRunModelPlan, GRANITE_8GB } from './mac-profiles.mjs';
import { fileURLToPath } from 'node:url';
import { splitWake, DEFAULT_WAKE_PHRASES } from './voice.mjs';
import { createToolRunner, readToolRegistry } from './tool-runner.mjs';

export const LAYER_NAMES = Object.freeze(['your abilities', 'fleet abilities', 'curated library', 'built-in']);

export function abilityStores(state = resolvePaths().state) {
  return { user: join(state, 'abilities', 'methods'), fleet: join(state, 'fleet', 'abilities', 'methods'), library: join(state, 'brain-library', 'methods') };
}

/** Pure: "Kingmaker, run the boat test." → { addressed, command, task, imperative }. */
export function parseMethodRequest(text) {
  const { addressed, command } = splitWake(String(text ?? ''), DEFAULT_WAKE_PHRASES);
  const c = String(command).replace(/[.!?]+$/, '').trim();
  const m = /^(?:please\s+)?(?:run|do|start|perform|execute|conduct)\s+(?:the\s+|a\s+|an\s+|my\s+)?(.+)$/i.exec(c);
  return { addressed, command: c, task: m ? m[1].trim() : c, imperative: Boolean(m) };
}

const LOOPBACK = /^(127\.|localhost$|\[?::1\]?$)/;
const INFERENCE_PATH = /\/(api\/(chat|generate)|v1\/(chat\/completions|completions|messages|responses|systemone))\b/;

/** Count every fetch made while `fn` runs: host, method, and whether it is an inference call off this device. */
export async function withNetworkLedger(fn) {
  const ledger = { requests: [], external: 0, externalInference: 0, localInference: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const local = LOOPBACK.test(url.hostname);
    const inference = INFERENCE_PATH.test(url.pathname) && String(init.method ?? 'GET').toUpperCase() === 'POST';
    ledger.requests.push({ host: url.host, path: url.pathname, method: String(init.method ?? 'GET').toUpperCase(), local, inference });
    if (!local) ledger.external += 1;
    if (inference) { if (local) ledger.localInference += 1; else ledger.externalInference += 1; }
    return real(input, init);
  };
  try { return { value: await fn(), ledger }; } finally { globalThis.fetch = real; }
}

async function installedModels(base) {
  try { const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) }); return (await r.json()).models.map((m) => m.name); } catch { return []; }
}
async function loadedModels(base) {
  try { const r = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) }); return (await r.json()).models.map((m) => ({ name: m.name, sizeGb: +(m.size / 2 ** 30).toFixed(2) })); } catch { return []; }
}

/**
 * A local brain for this profile: the layered method loop + the local reasoner. `remote` is the
 * method hunt's source options (false = never hunt). `model` pins the reasoner's model; otherwise
 * the loop's smallest-sufficient pick is used when the local runner has it, else the device plan's
 * starting brain — the substitution is recorded on every call, never silent.
 */
/** The curated library's source: KINGMAKER_LIBRARY_METHODS_URL, else <update host>/library, else null (unconfigured). */
export function curatedLibrarySource(state, env = process.env) {
  const explicit = String(env.KINGMAKER_LIBRARY_METHODS_URL ?? '').trim();
  if (explicit) return { baseUrl: explicit.replace(/\/+$/, ''), intelligencePath: '' };
  try { const u = JSON.parse(readFileSync(join(state, 'update.json'), 'utf8'))?.url; if (/^https:\/\//.test(u)) return { baseUrl: `${u.replace(/\/+$/, '')}/library`, intelligencePath: '' }; } catch { /* none */ }
  return null;
}
/** This install's stored membership entitlement for the curated library (host-signed ronin.entitlement/1), or null. */
export function libraryEntitlement(state) {
  try { const e = JSON.parse(readFileSync(join(state, 'entitlements', 'library.methods.json'), 'utf8')); return e?.payload && e?.sig ? e : null; } catch { return null; }
}

const NO_STORAGE = Object.freeze({ configured: false, drives: [], roles: {}, unavailable: [], notes: [], recovered: [] });

/** The curated-cache hunt, routed to an approved drive: refused when the drive is unavailable (nothing fetched, no
 *  internal duplicate made); otherwise the hunt files into a private staging store and the result is copied to the
 *  drive with verified writes. */
function driveHunt(hunt, target, state) {
  return async ({ request }) => {
    if (target.where === 'refused') return { status: 'missing', need: request, storage: 'unavailable', reason: target.reason };
    const stagingRoot = join(state, 'storage', 'staging'); mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(stagingRoot, 'hunt-'));
    try {
      const r = await hunt({ request, storeDir: staging });
      if (r?.status !== 'acquired') return r;
      const copy = await copyStoreToDrive({ from: staging, target });
      let log = ''; try { log = readFileSync(join(target.dir, 'acquired.jsonl'), 'utf8'); } catch { log = ''; }
      let add = ''; try { add = readFileSync(join(staging, 'acquired.jsonl'), 'utf8'); } catch { add = ''; }
      if (add) await driveWriter(target)(join(target.dir, 'acquired.jsonl'), log + add);
      return { ...r, storeDir: target.dir, drive: target.drive, copy };
    } finally { rmSync(staging, { recursive: true, force: true }); }
  };
}

export function createLocalBrain({ state = resolvePaths().state, remote = undefined, model = null, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', methodHunt = undefined, entitlement = undefined, reasoner: injectedReasoner = null, methodSelector = undefined, candidateRetriever = null, storage = undefined } = {}) {
  const stores = abilityStores(state);
  // Approved external drives (none configured → nothing is discovered and nothing changes).
  const resolved = storage === undefined ? resolveStorage({ state }) : (storage ?? NO_STORAGE);
  const driveStores = storageLayers(resolved);
  const libraryTarget = writeTarget(resolved, 'library-cache', stores.library);
  const source = remote === undefined ? curatedLibrarySource(state) : remote;
  if (methodHunt === undefined) {
    methodHunt = async ({ request, storeDir }) => {
      if (!source) return { status: 'missing', need: request, reason: 'no curated-library source is configured on this install (KINGMAKER_LIBRARY_METHODS_URL or the update host) — nothing was fetched' };
      const { huntMethod } = await import('./weight-hunter.mjs');
      return huntMethod({ request, storeDir, remote: source, requireEntitlement: true, entitlement: entitlement === undefined ? () => libraryEntitlement(state) : entitlement });
    };
  }
  const calls = [];
  let installed = null, plan = null;
  const reasoner = async ({ preamble, prompt, model: picked }) => {
    installed ??= await installedModels(base);
    plan ??= firstRunModelPlan(detectDevice(), { installed, measurements: deviceMeasurements(state) });
    let use = model ?? picked;
    let why = model ? 'pinned for this run' : 'the loop\'s smallest-sufficient pick';
    if (!model && !installed.includes(use)) { why = `the pick ${picked} is not on this device's runner, so the device plan's starting brain is used`; use = plan.use?.tag ?? picked; }
    const t0 = performance.now();
    const answer = await localModelTurn(use, prompt, { brief: preamble, temperature: 0 , base });
    calls.push({ model: use, picked, why, ms: Math.round(performance.now() - t0) });
    return answer;
  };
  // Jev routes the method pick (lib/open-jev.mjs). Default model: this device's local brain (measured 8/8 on the routing
  // check vs 3/8 for the CRM's 0.6b default); KINGMAKER_OPEN_JEV_MODEL overrides; KINGMAKER_OPEN_JEV=off disables.
  // Fixtures that inject a reasoner get no live Jev unless they pass a selector.
  if (methodSelector === undefined) {
    methodSelector = injectedReasoner || process.env.KINGMAKER_OPEN_JEV === 'off' ? null : async ({ request, candidates }) => {
      const { openJevChoose } = await import('./open-jev.mjs');
      installed ??= await installedModels(base);
      plan ??= firstRunModelPlan(detectDevice(), { installed, measurements: deviceMeasurements(state) });
      const t0 = performance.now();
      const r = await openJevChoose({ request, candidates, model: process.env.KINGMAKER_OPEN_JEV_MODEL || plan.use?.tag, endpoint: base });
      calls.push({ model: r.model, picked: r.model, why: 'Jev method route (one forward pass, logprobs)', ms: Math.round(performance.now() - t0), role: 'jev' });
      return r;
    };
  }
  if (typeof methodHunt === 'function' && libraryTarget.where !== 'internal') methodHunt = driveHunt(methodHunt, libraryTarget, state);
  const loop = createExecutionLoop({ methodSelector, candidateRetriever, methodStore: stores.library, userMethodStore: [...driveStores.user, stores.user], fleetMethodStore: [...driveStores.fleet, stores.fleet], libraryMethodStores: driveStores.library, remote: source ?? false, reasoner: injectedReasoner ? async (call) => { const a = await injectedReasoner(call); calls.push({ model: call.model, picked: call.model, why: 'injected reasoner', ms: 0 }); return a; } : reasoner, methodHunt, iterationStore: null });
  return { loop, stores, calls, base, state, methodSelector, storage: resolved };
}

function driveOf(storage, dir) {
  if (!dir || !storage?.configured) return null;
  for (const r of Object.values(storage.roles ?? {})) if (r.dir && r.dir === dir) return r.drive;
  return null;
}

function stepDispatch(trace = []) {
  return trace.map((s) => ({ step: s.step ?? s.id, type: s.type, status: s.status, detail: String(s.detail ?? '').slice(0, 200) }));
}

/** Run one plain-language request end to end and build the user-visible report. */
/** The runner for user-selected tools: registry from <state>/abilities/tools.json; live output to onOutput. */
export function toolRunnerFor(state, { approve = null, onOutput = () => {} } = {}) {
  return createToolRunner({ registry: readToolRegistry(state), approve, onOutput, paidAccess: (sku) => import('./paid-access.mjs').then((m) => m.createPaidAccess(state)(sku)) });
}

export async function handleMethodRequest(text, { brain, workDir, inputs = null, approve = null, onOutput = () => {}, methodHint = null } = {}) {
  const parsed = parseMethodRequest(text);
  const { loop } = brain;
  const t = { lookupMs: 0, huntMs: 0, executionMs: 0, totalMs: 0 };
  const orig = { conduct: loop.conductor.conduct, list: loop.conductor.listMethods };
  loop.conductor.conduct = async (...a) => { const s = performance.now(); try { return await orig.conduct(...a); } finally { t.executionMs += performance.now() - s; } };
  loop.conductor.listMethods = async (...a) => { const s = performance.now(); try { return await orig.list(...a); } finally { t.lookupMs += performance.now() - s; } };
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const { value: run, ledger } = await withNetworkLedger(() => loop.run(parsed.task, { workDir, inputs: inputs ?? { prompt: parsed.task }, methodHint, toolRunner: toolRunnerFor(brain.state, { approve, onOutput }) }));
  t.totalMs = performance.now() - t0;
  Object.assign(loop.conductor, { conduct: orig.conduct, listMethods: orig.list });
  // Model calls made by child processes (daemons) — recorded by them in the job folder.
  let childCalls = [];
  try { childCalls = readFileSync(join(workDir, '.kingmaker-model-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  for (const c of childCalls) { const local = LOOPBACK.test(String(c.host).split(':')[0]); if (local) ledger.localInference += 1; else { ledger.externalInference += 1; ledger.external += 1; } }
  const huntPhase = run.trace.find((x) => x.phase === 'method-hunt');
  if (huntPhase?.result?.network) t.huntMs = null; // hunt timing is inside lookup; reported via its own network ledger
  const methods = await orig.list.call(loop.conductor);
  const chosen = methods.find((m) => m.id === run.picks?.method?.id) ?? null;
  const loaded = await loadedModels(brain.base);
  const report = {
    request: text, parsed,
    outcome: run.refused ? 'refused' : run.escalated ? 'escalated' : run.conduction?.status ?? 'unknown',
    method: chosen ? { id: chosen.id, version: chosen.version, title: chosen.title, layer: LAYER_NAMES[chosen.layer] ?? `layer ${chosen.layer}`, sha256: chosen.sha256, coverage: run.coverage?.score, store: chosen.store ?? null, drive: driveOf(brain.storage, chosen.store) } : null,
    storage: brain.storage?.configured ? { drives: brain.storage.drives.map((d) => ({ label: d.label, status: d.status, mountPoint: d.mountPoint, roles: d.roles })), unavailable: brain.storage.unavailable, notes: brain.storage.notes, recovered: brain.storage.recovered } : null,
    jev: run.picks?.method?.jev ?? null,
    retrieval: run.picks?.method?.retrieval ?? null,
    hunt: huntPhase ? { status: huntPhase.result?.status, detail: huntPhase.detail, network: huntPhase.result?.network } : null,
    model: brain.calls.at(-1) ?? null,
    steps: stepDispatch(run.conduction?.trace),
    checks: (run.conduction?.trace ?? []).filter((s) => s.type === 'verify' || s.type === 'guard').map((s) => ({ step: s.step ?? s.id, status: s.status, detail: s.detail, objective: s.objective === true })),
    declared: run.conduction?.declared ?? [],
    toolRuns: Object.values(run.conduction?.outputs ?? {}).filter((v) => v && typeof v === 'object' && 'exitCode' in v && Array.isArray(v.lines)).map((v) => ({ path: v.path, argv: v.argv, exitCode: v.exitCode, ms: v.ms, lines: v.lines })),
    outputs: run.conduction?.outputs ?? null,
    failure: run.conduction && run.conduction.status !== 'completed' ? `${run.conduction.haltedAt ?? ''}: ${run.conduction.reason ?? ''}` : null,
    refusal: run.refused ? { reason: run.reason, unblock: run.unblock, closest: run.closest } : null,
    timings: { lookupMs: Math.round(t.lookupMs), executionMs: Math.round(t.executionMs), modelMs: brain.calls.reduce((a, c) => a + c.ms, 0), totalMs: Math.round(t.totalMs) },
    memory: { processRssMb: Math.round(process.memoryUsage().rss / 2 ** 20), processRssDeltaMb: Math.round((process.memoryUsage().rss - rssBefore) / 2 ** 20), modelsResident: loaded },
    modelCalls: { inProcess: brain.calls.length, childProcess: childCalls.length, childMs: childCalls.reduce((a, c) => a + (c.ms ?? 0), 0), childTokens: childCalls.reduce((a, c) => a + (c.evalTokens ?? 0) + (c.promptTokens ?? 0), 0), childHosts: [...new Set(childCalls.map((c) => c.host))], childModels: [...new Set(childCalls.map((c) => c.model))] },
    network: { requests: ledger.requests.length, external: ledger.external, localInference: ledger.localInference, externalInference: ledger.externalInference, detail: ledger.requests },
    workDir,
  };
  if (report.outcome === 'refused' && run.reason === 'no-method-coverage') report.subscribe = await subscribeLink(brain.state);
  report.lines = reportLines(report);
  return report;
}

export function reportLines(r) {
  const L = [];
  if (r.outcome === 'refused' && r.refusal.reason === 'no-method-coverage') {
    L.push(...missingMethodReply(r));
  } else if (r.outcome === 'refused') {
    L.push(`I could not run "${r.parsed.task}": ${r.refusal.reason}.`);
    L.push(`Needed: ${r.refusal.unblock}`);
  } else {
    L.push(`Task "${r.parsed.task}" → method ${r.method?.id} v${r.method?.version} from ${r.method?.layer}${r.method?.drive ? ` on drive "${r.method.drive}"` : ''} (coverage ${r.method?.coverage}, sha256 ${r.method?.sha256?.slice(0, 12)}…).`);
    if (r.hunt) L.push(`It was not on this device: ${r.hunt.detail}`);
    if (r.retrieval) L.push(r.retrieval.via === 'mempalace' ? `MemPalace retrieved: ${r.retrieval.ids.join(', ') || '(nothing)'} (engine /api/memory/retrieve).` : `MemPalace unavailable (${r.retrieval.error}); keyword order used.`);
    if (r.jev) L.push(r.jev.decided ? `Jev routed it: ${r.jev.none ? 'none of the candidates' : r.jev.id} (p=${Number(r.jev.confidence).toFixed(2)}, ${r.jev.model}, ${r.jev.ms} ms; probabilities ${JSON.stringify(r.jev.probabilities)}).` : `Jev did not decide (${r.jev.reason}); the keyword pick stands.`);
    if (r.model) L.push(`Local model: ${r.model.model} (${r.model.why}).`);
    for (const s of r.steps) L.push(`  ${s.status.padEnd(8)} ${String(s.step).padEnd(18)} ${s.type.padEnd(12)} ${s.detail}`);
    for (const t of r.toolRuns ?? []) {
      L.push(`Output of ${t.path} ${t.argv.join(' ')} (exit ${t.exitCode}, ${t.ms} ms):`);
      for (const ln of t.lines.slice(0, 200)) L.push(`  ${ln.stream === 'stderr' ? '!' : '|'} ${ln.line}`);
    }
    if (r.outcome !== 'completed' && r.failure) L.push(`Stopped: ${r.failure}`);
    L.push(`Checks: ${r.checks.length ? r.checks.map((c) => `${c.step} ${c.status}`).join(', ') : 'none declared by this method — the result is UNCHECKED'}.`);
    const lastRun = (r.toolRuns ?? []).at(-1);
    if (lastRun && !lastRun.lines.some((l) => l.stream === 'stdout' && l.line.trim())) L.push(`Note: ${lastRun.path.split('/').pop()} printed no output.`);
    L.push(r.outcome !== 'completed' ? `Outcome: NOT done (${r.outcome}).`
      : r.checks.some((c) => c.objective && c.status === 'executed') ? 'Outcome: done — the method\'s objective check passed.'
        : 'Outcome: ran, but the result is NOT verified — this method has no objective check; inspect the output above.');
    if (r.declared.length) L.push(`Not executed (declared): ${r.declared.map((d) => `${d.step} (${d.reason})`).join('; ')}.`);
  }
  for (const u of r.storage?.unavailable ?? []) L.push(`Unavailable: ${u.what} — ${u.reason}. Local abilities still work; nothing was fetched from a paid service instead.`);
  for (const n of r.storage?.notes ?? []) L.push(`Storage: ${n}.`);
  for (const x of r.storage?.recovered ?? []) L.push(`Storage recovery on drive "${x.drive}": ${x.outcome}${x.dest ? ` (${x.dest})` : ''}.`);
  L.push(`Time: lookup ${r.timings.lookupMs} ms, execution ${r.timings.executionMs} ms (model ${r.timings.modelMs} ms), end-to-end ${r.timings.totalMs} ms. Memory: process ${r.memory.processRssMb} MB; resident models ${r.memory.modelsResident.map((m) => `${m.name} ${m.sizeGb} GB`).join(', ') || 'none'}.`);
  L.push(`Model calls: ${r.modelCalls.inProcess} in Kingmaker + ${r.modelCalls.childProcess} by daemons (${r.modelCalls.childMs} ms, ${r.modelCalls.childTokens} tokens${r.modelCalls.childHosts.length ? `, via ${r.modelCalls.childHosts.join(', ')}` : ''}).`);
  L.push(`Network: ${r.network.requests} request(s) from Kingmaker, ${r.network.external} off-device; inference calls (all processes) local ${r.network.localInference}, external ${r.network.externalInference}.`);
  return L;
}

/**
 * The plain-language reply when no method covers a request (fresh-install experience, 2026-11-16). States the
 * miss plainly (no pretend completion), then offers both paths. The subscribe link appears only when one is
 * configured AND answered when checked; otherwise the reply says it is not configured. It never claims the
 * curated library holds this method unless the hunt actually checked the library.
 */
export function missingMethodReply(r) {
  const L = [`I don't have a method for "${r.parsed.task}" yet, so I haven't done it.`];
  const hunt = r.hunt?.status;
  if (hunt === 'no-remote-coverage') L.push("I checked Ronin's ready-made library with your membership, and it doesn't have one for this either.");
  else if (hunt === 'not-entitled') L.push("Ronin's ready-made library needs a membership, so I couldn't check whether it has one — I won't promise it does.");
  else if (hunt === 'missing') L.push(`I couldn't reach Ronin's ready-made library (${r.hunt?.detail?.replace(/^method hunt: missing — /, '') ?? 'unavailable'}).`);
  const link = r.subscribe?.url && r.subscribe.ok ? r.subscribe.url : null;
  L.push(link
    ? `If you'd like access to Ronin's ready-made methods and Scripture Armor, you can subscribe here: ${link}.`
    : `Access to Ronin's ready-made methods and Scripture Armor is a subscription, but the subscription link is not configured on this install${r.subscribe?.url ? ` (the configured link did not answer: ${r.subscribe.error})` : ''}.`);
  L.push(`Or I can help build a method for you. Point me at the idea or task you'd like to build: kingmaker method new "${r.parsed.task}"${' '}[--source <file>].`);
  return L;
}

/** The configured subscribe link (KINGMAKER_SUBSCRIBE_URL or <state>/subscription.json {url}), checked live. */
export async function subscribeLink(state, { env = process.env, timeoutMs = 4000 } = {}) {
  let url = String(env.KINGMAKER_SUBSCRIBE_URL ?? '').trim();
  if (!url) { try { url = String(JSON.parse(readFileSync(join(state, 'subscription.json'), 'utf8'))?.url ?? ''); } catch { url = ''; } }
  if (!url) return { url: null, ok: false };
  if (!/^https:\/\/[^\s]+$/.test(url)) return { url, ok: false, error: 'not an https URL' };
  try { const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) }); return { url, ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` }; }
  catch (e) { return { url, ok: false, error: e.message }; }
}

/**
 * The bar's METHOD LANE (2026-11-16): the typed bar / voice turn chain hands a turn here when the request is addressed
 * to Kingmaker or imperative AND a method in the user's, fleet or curated-cache layer covers it (built-in catalog
 * methods never claim a bar turn, so ordinary chat routing is unchanged). Tool steps that are not read-only need the
 * owner's approval: the first turn stops and states the exact command; "yes, run it" approves THAT argv once, in the
 * same conversation, within 10 minutes. Every line of the report (and the tool's live output) is shown in the bar;
 * the full report is saved as kingmaker-report.json in the job folder.
 */
/** The steps of a method in the user/fleet/curated stores that will need approval: static argv where it can be known. */
/** A method's declared inputs (defaults), from the same stores approvalPlan reads; {} when not found. */
export async function methodSpecInputs(state, methodId) {
  const { parseMethodFile } = await import('./method-conductor.mjs');
  const stores = abilityStores(state);
  for (const dir of [stores.user, stores.fleet, stores.library]) {
    let idx; try { idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')); } catch { continue; }
    const d = idx.methods.find((m) => m.id === methodId); if (!d) continue;
    return parseMethodFile(readFileSync(join(dir, d.file), 'utf8')).inputs ?? {};
  }
  return {};
}
/** Explicit values for a method's NUMERIC inputs, read from the user's own words ("setpoint 19", "setpoint of 19",
 *  "19 setpoint"). Only declared inputs; nothing is guessed — absent values keep the method's default. */
export function inputsFromRequest(text, specInputs = {}) {
  const out = {};
  for (const [k, def] of Object.entries(specInputs)) {
    if (typeof def !== 'number') continue;
    const name = k.replace(/_/g, '[ _-]?');
    const m = new RegExp(`\\b${name}\\s*(?:of|to|at|=|:|is)?\\s*(-?\\d+(?:\\.\\d+)?)`, 'i').exec(text) ?? new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(?:°|degrees?)?\\s*${name}\\b`, 'i').exec(text);
    if (m) out[k] = Number(m[1]);
  }
  return out;
}
export async function approvalPlan(state, methodId, inputs = {}) {
  const { parseMethodFile } = await import('./method-conductor.mjs');
  const stores = abilityStores(state);
  for (const dir of [stores.user, stores.fleet, stores.library]) {
    let idx; try { idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')); } catch { continue; }
    const d = idx.methods.find((m) => m.id === methodId); if (!d) continue;
    const spec = parseMethodFile(readFileSync(join(dir, d.file), 'utf8'));
    const vals = { ...spec.inputs, ...inputs };
    const sub = (a) => String(a).replace(/\{\{inputs\.(\w+)\}\}/g, (_, k) => String(vals[k] ?? ''));
    return spec.steps.filter((st) => st.type === 'run-tool' && st.readOnly !== true).map((st) => {
      const dynamic = (st.args ?? []).some((a) => /\{\{(?!inputs\.)/.test(String(a)));
      return { step: st.id, tool: st.tool, args: dynamic ? null : (st.args ?? []).map(sub) };
    });
  }
  return [];
}

/**
 * The bar's METHOD LANE (2026-11-16): the typed bar turn chain hands a turn here when the request is addressed to
 * Kingmaker or imperative AND a method in the user's, fleet or curated-cache layer covers it (built-in catalog methods
 * never claim a bar turn, so ordinary chat routing is unchanged). PLAN-FIRST APPROVAL: before anything runs, the lane
 * lists every tool step that needs approval (exact argv where it is static; "arguments chosen at run time, shown live"
 * where the method plans them) and asks once. Nothing executes until "yes, run it"; then the method runs EXACTLY ONCE
 * with exactly those approvals. Everything shown in the bar is also saved as kingmaker-report.json in the job folder.
 */
/** Research sites the USER approved for method writing (<state>/abilities/research-origins.json: ["https://…"]).
 *  None → no research. Only https origins without credentials are accepted. */
/** Model measurements recorded on THIS device (<state>/models/device-measurements.json); {} when none. */
export function deviceMeasurements(state) {
  try { const j = JSON.parse(readFileSync(join(state, 'models', 'device-measurements.json'), 'utf8')); return j && typeof j === 'object' ? (j.models ?? {}) : {}; } catch { return {}; }
}
export function researchOrigins(state) {
  try {
    const list = JSON.parse(readFileSync(join(state, 'abilities', 'research-origins.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).map((o) => { try { const u = new URL(String(o)); return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null; } catch { return null; } }).filter(Boolean).slice(0, 20);
  } catch { return []; }
}
export function createMethodLane({ state, show = () => {}, say = async () => {}, log = () => {}, panel = () => {}, brainOptions = {} } = {}) {
  const pending = new Map();
  const key = (conv) => conv ?? 'bar';
  const YES = /^\s*(yes|yep|approve|approved|go ahead|run it|yes,? run it)\b/i, NO = /^\s*(no|cancel|don'?t|stop)\b/i;
  async function covering(text) {
    const parsed = parseMethodRequest(text);
    if (!parsed.addressed && !parsed.imperative) return null;
    const { scoreMethod, COVERAGE_MIN_RELEVANCE } = await import('./execution-loop.mjs');
    const brain = createLocalBrain({ state, remote: false, ...brainOptions });
    const methods = (await brain.loop.conductor.listMethods()).filter((m) => m.layer < LAYER_NAMES.indexOf('built-in'));
    const ranked = methods.map((m) => ({ m, s: scoreMethod(m, parsed.task) })).sort((a, b) => b.s - a.s);
    // Jev routes the bar's plan-first pick too (same selector the loop uses); a confident "none" claims nothing.
    if (brain.methodSelector && ranked.length && (parsed.addressed || parsed.imperative)) {
      const pool = ranked.slice(0, 7);
      const jev = await brain.methodSelector({ request: parsed.task, candidates: pool.map((r) => ({ id: r.m.id, title: r.m.title, domain: r.m.domain })) }).catch((e) => ({ decided: false, reason: e.message }));
      if (jev?.decided && jev.none) { log('method_lane_jev', { none: true, p: jev.confidence }); return null; }
      if (jev?.decided && jev.id && jev.confidence >= 0.8) { const m = ranked.find((r) => r.m.id === jev.id); log('method_lane_jev', { id: jev.id, p: jev.confidence, model: jev.model }); return { method: jev.id, layer: LAYER_NAMES[m.m.layer], score: Math.max(m.s, COVERAGE_MIN_RELEVANCE), jev }; }
    }
    const best = ranked[0];
    return best && best.s >= COVERAGE_MIN_RELEVANCE ? { method: best.m.id, layer: LAYER_NAMES[best.m.layer], score: best.s } : null;
  }
  async function learnableAttachments(text) {
    const { attachmentsInText } = await import('./method-from-source.mjs');
    return attachmentsInText(text);
  }
  async function learn(text) {
    const M = await import('./method-from-source.mjs');
    const calls = [];
    const model = brainOptions.writerModel ?? process.env.KINGMAKER_METHOD_WRITER_MODEL ?? GRANITE_8GB;
    const complete = brainOptions.complete ?? M.ollamaComplete({ model, calls });
    const origins = researchOrigins(state);
    let research = null;
    if (origins.length) {
      const { createLocalLearningSearch } = await import('./learning-local-adapters.mjs');
      const search = brainOptions.search ?? createLocalLearningSearch({ approvedOrigins: origins });
      research = (args) => M.researchTechnique({ ...args, search, complete, fetchImpl: brainOptions.fetchImpl ?? fetch });
    }
    const panelId = `learn-${Date.now()}`;
    panel({ id: panelId, tool: 'method-writer', state: 'running', activity: 'reading the attachment', progress: null });
    log('method_lane_learn', { request: text.slice(0, 120), model, research: origins.length > 0 });
    let r;
    try { r = await M.learnFromAttachment({ state, text, complete, research, model, loopScript: fileURLToPath(new URL('./observe-act-loop.mjs', import.meta.url)), calls }); }
    catch (e) {
      panel({ id: panelId, tool: 'method-writer', state: 'failed', activity: String(e.message).slice(0, 120) });
      await say(`I could not write a method: ${String(e.message).slice(0, 160)}`); log('method_lane_learn_failed', { error: String(e.message).slice(0, 200) });
      return { status: 'failed', error: String(e.message) };
    }
    for (const n of r.notInterpreted ?? []) show(`  not interpreted: ${n.rel} — ${n.why}`);
    if (r.research) show(`  research: ${r.research.sources.length} source(s) kept, ${r.research.facts} quote-verified fact(s)`);
    show(`  model calls: ${calls.length} local, 0 external`);
    if (r.status === 'draft') {
      panel({ id: panelId, tool: 'method-writer', state: 'unverified', activity: 'draft written — checks required' });
      show(`Draft written: ${r.draftPath}`);
      await say('I wrote a draft method. It is not used yet: it needs its decision checks to pass first.');
    } else {
      panel({ id: panelId, tool: 'method-writer', state: 'failed', activity: 'draft rejected by validation' });
      for (const pr of r.problems ?? []) show(`  problem: ${pr}`);
      await say('I could not write a valid method from that attachment; the problems are listed above. Nothing was saved as usable.');
    }
    log('method_lane_learn_done', { status: r.status, draft: r.draftPath ?? null, problems: (r.problems ?? []).length, calls: calls.length });
    return r;
  }
  async function run(request, methodId, plan, inputs = {}) {
    const workDir = join(state, 'tasks', `bar-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(workDir, { recursive: true });
    const remaining = plan.map((p) => ({ ...p, used: false }));
    const approve = async ({ tool, args }) => {
      const hit = remaining.find((p) => !p.used && p.tool === tool && (p.args === null || JSON.stringify(p.args) === JSON.stringify(args)));
      if (hit) { hit.used = true; return true; }
      return false; // anything outside the approved plan is refused, never run
    };
    log('method_lane', { request: request.slice(0, 120), method: methodId });
    // Tool panel events (lib/tool-sessions.mjs renderToolPanels draws them; the native bar does not yet): live activity
    // per tool, and the method's TRUE final state — never "completed" for an unverified or failed run.
    const panelId = `lane-${Date.now()}`;
    panel({ id: panelId, tool: methodId, state: 'running', activity: 'starting', progress: null });
    const report = await handleMethodRequest(request, { brain: createLocalBrain({ state, ...brainOptions }), workDir, approve, methodHint: methodId, ...(Object.keys(inputs).length ? { inputs: { prompt: parseMethodRequest(request).task, ...inputs } } : {}),
      onOutput: (stream, line) => { show(`${stream === 'stderr' ? '!' : '|'} ${line}`); panel({ id: panelId, tool: methodId, state: 'running', activity: String(line).slice(0, 160), progress: null }); } });
    const verified = report.checks?.some((c) => c.objective && c.status === 'executed');
    panel({ id: panelId, tool: methodId, state: report.outcome !== 'completed' ? 'failed' : verified ? 'completed' : 'unverified', activity: report.lines.find((l) => /^Outcome:/.test(l)) ?? '', progress: null });
    report.approvedPlan = plan;
    writeFileSync(join(workDir, 'kingmaker-report.json'), JSON.stringify(report, null, 2));
    for (const l of report.lines) show(l);
    await say(report.lines.find((l) => /^Outcome:/.test(l)) ?? report.lines[0]);
    log('method_lane_done', { outcome: report.outcome, method: report.method?.id ?? null, report: join(workDir, 'kingmaker-report.json') });
    return report;
  }
  return {
    isApproval: (text) => YES.test(String(text)),
    async wants(text, conv) {
      const p = pending.get(key(conv));
      if (p && Date.now() - p.at < 600_000 && (YES.test(text) || NO.test(text))) return true;
      if (await covering(text)) return true;
      const parsed = parseMethodRequest(text);
      return Boolean((parsed.addressed || parsed.imperative) && (await learnableAttachments(text)).length);
    },
    async handle(text, conv) {
      const k = key(conv); const p = pending.get(k);
      if (p && (YES.test(text) || NO.test(text))) {
        pending.delete(k);
        if (NO.test(text)) { await say('Cancelled. Nothing was run.'); log('method_lane_cancel', {}); return null; }
        if (p.kind === 'learn') return learn(p.text);
        return run(p.text, p.methodId, p.plan, p.inputs ?? {});
      }
      const cover = await covering(text);
      if (!cover) {
        // No method covers it, but the user attached files: offer to WRITE one (nothing runs before "yes").
        const files = await learnableAttachments(text);
        if (!files.length) return null;
        const origins = researchOrigins(state);
        pending.set(k, { kind: 'learn', text, at: Date.now() });
        show(`No method covers this yet. I can write one from ${files.length} attached file(s): ${files.map((f) => f.split('/').pop()).join(', ')}.`);
        show(`They are read as data — nothing in them runs while I write. ${origins.length ? `Research uses your local search and only these sites: ${origins.join(', ')}.` : 'No research sites are approved, so I will use only the attachment.'} The result is a DRAFT that is not used until its checks pass.`);
        await say('I don\'t have a method for this yet. Say "yes" to let me write one from the attachment, or "no".');
        return { status: 'awaiting-learn-approval', attachments: files };
      }
      const inputs = inputsFromRequest(text, await methodSpecInputs(state, cover.method));
      const plan = await approvalPlan(state, cover.method, inputs);
      if (!plan.length) return run(text, cover.method, [], inputs);
      pending.set(k, { text, methodId: cover.method, plan, inputs, at: Date.now() });
      if (Object.keys(inputs).length) show(`Values taken from your request: ${Object.entries(inputs).map(([a, b]) => `${a} = ${b}`).join(', ')}.`);
      show(`Method ${cover.method} (${cover.layer})${cover.jev ? ` — routed by Jev (p=${cover.jev.confidence.toFixed(2)}, ${cover.jev.model})` : ' — keyword pick'} will run these tools — nothing has run yet:`);
      for (const p2 of plan) show(`  ${p2.step}: ${p2.tool} ${p2.args ? p2.args.join(' ') : '(arguments chosen at run time; shown live before output)'}`);
      await say(`I'll use ${cover.method}. It needs your approval for ${plan.length} tool step(s), listed above. Say "yes, run it" to run it once, or "no".`);
      return { status: 'awaiting-approval', method: cover.method, plan };
    },
  };
}
