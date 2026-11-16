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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createExecutionLoop } from './execution-loop.mjs';
import { localModelTurn } from './local-turn.mjs';
import { resolvePaths } from './paths.mjs';
import { detectDevice, firstRunModelPlan } from './mac-profiles.mjs';
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

export function createLocalBrain({ state = resolvePaths().state, remote = undefined, model = null, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', methodHunt = undefined, entitlement = undefined, reasoner: injectedReasoner = null } = {}) {
  const stores = abilityStores(state);
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
    plan ??= firstRunModelPlan(detectDevice(), { installed });
    let use = model ?? picked;
    let why = model ? 'pinned for this run' : 'the loop\'s smallest-sufficient pick';
    if (!model && !installed.includes(use)) { why = `the pick ${picked} is not on this device's runner, so the device plan's starting brain is used`; use = plan.use?.tag ?? picked; }
    const t0 = performance.now();
    const answer = await localModelTurn(use, prompt, { brief: preamble, temperature: 0 , base });
    calls.push({ model: use, picked, why, ms: Math.round(performance.now() - t0) });
    return answer;
  };
  const loop = createExecutionLoop({ methodStore: stores.library, userMethodStore: stores.user, fleetMethodStore: stores.fleet, remote: source ?? false, reasoner: injectedReasoner ? async (call) => { const a = await injectedReasoner(call); calls.push({ model: call.model, picked: call.model, why: 'injected reasoner', ms: 0 }); return a; } : reasoner, methodHunt, iterationStore: null });
  return { loop, stores, calls, base, state };
}

function stepDispatch(trace = []) {
  return trace.map((s) => ({ step: s.step ?? s.id, type: s.type, status: s.status, detail: String(s.detail ?? '').slice(0, 200) }));
}

/** Run one plain-language request end to end and build the user-visible report. */
/** The runner for user-selected tools: registry from <state>/abilities/tools.json; live output to onOutput. */
export function toolRunnerFor(state, { approve = null, onOutput = () => {} } = {}) {
  return createToolRunner({ registry: readToolRegistry(state), approve, onOutput });
}

export async function handleMethodRequest(text, { brain, workDir, inputs = null, approve = null, onOutput = () => {} } = {}) {
  const parsed = parseMethodRequest(text);
  const { loop } = brain;
  const t = { lookupMs: 0, huntMs: 0, executionMs: 0, totalMs: 0 };
  const orig = { conduct: loop.conductor.conduct, list: loop.conductor.listMethods };
  loop.conductor.conduct = async (...a) => { const s = performance.now(); try { return await orig.conduct(...a); } finally { t.executionMs += performance.now() - s; } };
  loop.conductor.listMethods = async (...a) => { const s = performance.now(); try { return await orig.list(...a); } finally { t.lookupMs += performance.now() - s; } };
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const { value: run, ledger } = await withNetworkLedger(() => loop.run(parsed.task, { workDir, inputs: inputs ?? { prompt: parsed.task }, toolRunner: toolRunnerFor(brain.state, { approve, onOutput }) }));
  t.totalMs = performance.now() - t0;
  Object.assign(loop.conductor, { conduct: orig.conduct, listMethods: orig.list });
  const huntPhase = run.trace.find((x) => x.phase === 'method-hunt');
  if (huntPhase?.result?.network) t.huntMs = null; // hunt timing is inside lookup; reported via its own network ledger
  const methods = await orig.list.call(loop.conductor);
  const chosen = methods.find((m) => m.id === run.picks?.method?.id) ?? null;
  const loaded = await loadedModels(brain.base);
  const report = {
    request: text, parsed,
    outcome: run.refused ? 'refused' : run.escalated ? 'escalated' : run.conduction?.status ?? 'unknown',
    method: chosen ? { id: chosen.id, version: chosen.version, title: chosen.title, layer: LAYER_NAMES[chosen.layer] ?? `layer ${chosen.layer}`, sha256: chosen.sha256, coverage: run.coverage?.score } : null,
    hunt: huntPhase ? { status: huntPhase.result?.status, detail: huntPhase.detail, network: huntPhase.result?.network } : null,
    model: brain.calls.at(-1) ?? null,
    steps: stepDispatch(run.conduction?.trace),
    checks: (run.conduction?.trace ?? []).filter((s) => s.type === 'verify' || s.type === 'guard').map((s) => ({ step: s.step ?? s.id, status: s.status, detail: s.detail })),
    declared: run.conduction?.declared ?? [],
    toolRuns: Object.values(run.conduction?.outputs ?? {}).filter((v) => v && typeof v === 'object' && 'exitCode' in v && Array.isArray(v.lines)).map((v) => ({ path: v.path, argv: v.argv, exitCode: v.exitCode, ms: v.ms, lines: v.lines })),
    outputs: run.conduction?.outputs ?? null,
    failure: run.conduction && run.conduction.status !== 'completed' ? `${run.conduction.haltedAt ?? ''}: ${run.conduction.reason ?? ''}` : null,
    refusal: run.refused ? { reason: run.reason, unblock: run.unblock, closest: run.closest } : null,
    timings: { lookupMs: Math.round(t.lookupMs), executionMs: Math.round(t.executionMs), modelMs: brain.calls.reduce((a, c) => a + c.ms, 0), totalMs: Math.round(t.totalMs) },
    memory: { processRssMb: Math.round(process.memoryUsage().rss / 2 ** 20), processRssDeltaMb: Math.round((process.memoryUsage().rss - rssBefore) / 2 ** 20), modelsResident: loaded },
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
    L.push(`Task "${r.parsed.task}" → method ${r.method?.id} v${r.method?.version} from ${r.method?.layer} (coverage ${r.method?.coverage}, sha256 ${r.method?.sha256?.slice(0, 12)}…).`);
    if (r.hunt) L.push(`It was not on this device: ${r.hunt.detail}`);
    if (r.model) L.push(`Local model: ${r.model.model} (${r.model.why}).`);
    for (const s of r.steps) L.push(`  ${s.status.padEnd(8)} ${String(s.step).padEnd(18)} ${s.type.padEnd(12)} ${s.detail}`);
    for (const t of r.toolRuns ?? []) {
      L.push(`Output of ${t.path} ${t.argv.join(' ')} (exit ${t.exitCode}, ${t.ms} ms):`);
      for (const ln of t.lines.slice(0, 200)) L.push(`  ${ln.stream === 'stderr' ? '!' : '|'} ${ln.line}`);
    }
    if (r.outcome !== 'completed' && r.failure) L.push(`Stopped: ${r.failure}`);
    L.push(`Checks: ${r.checks.length ? r.checks.map((c) => `${c.step} ${c.status}`).join(', ') : 'none declared by this method'}. Outcome: ${r.outcome}.`);
    if (r.declared.length) L.push(`Not executed (declared): ${r.declared.map((d) => `${d.step} (${d.reason})`).join('; ')}.`);
  }
  L.push(`Time: lookup ${r.timings.lookupMs} ms, execution ${r.timings.executionMs} ms (model ${r.timings.modelMs} ms), end-to-end ${r.timings.totalMs} ms. Memory: process ${r.memory.processRssMb} MB; resident models ${r.memory.modelsResident.map((m) => `${m.name} ${m.sizeGb} GB`).join(', ') || 'none'}.`);
  L.push(`Network: ${r.network.requests} request(s), ${r.network.external} off-device; inference calls local ${r.network.localInference}, external ${r.network.externalInference}.`);
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
