// lib/brain-library.mjs — the Kingmaker Brain Library (github.com/ronininc/kingmaker-brain-library, public): the models
// suggested for every Apple-silicon Mac, the benchmarks behind each pick, and the weights themselves.
//   • library.json (schema kingmaker.brain-library/1, schema/library.schema.json): every Mac configuration Apple sold
//     (chip × RAM — information, never a gate), the starter floor (the same smallest-sufficient picks on every
//     device, lib/mac-profiles.mjs FLOOR_ROLES), and every model as a MEASURED RECORD: its size, its bench
//     speeds and scores, and the roles it can fill — the input the per-task smallest-sufficient selector
//     (lib/execution-loop.mjs) reads. No per-class pick tables: capability is task-driven, and a model's
//     size never disqualifies it — delivery is metered in verified portions.
//     where it comes from (the exact Hugging Face file or Ollama tag, SHA-256), its licence, and what it measured.
//   • bench/: every Mac's `kingmaker models bench` result. Each Mac that runs the bench adds one; a class's picks are
//     "measured" once its own results are in, "estimate" until then. More Macs, more measurements.
//   • Weights: each pick whose licence allows redistribution is a GitHub Release (model-<slug>), its GGUF split into
//     parts under 2 GB (GitHub's limit per release file), each part and the whole SHA-256-checked, with the Ollama
//     Modelfile (template and parameters) it was measured with. A model with no licence on its card stays a pointer.
//   • The 30-day churn (`kingmaker models hb churn`) finds new abliterated and uncensored builds; a benchmark decides
//     whether they replace a pick; a replaced pick's release is kept, marked retired.
// Pure builders here; scripts/brain-library.mjs writes the repo and publishes weights; `kingmaker models library` pulls.

import { readFileSync } from 'node:fs';
import { BENCH_SETS, CHIP_BANDWIDTH, FLOOR_MODELS, FLOOR_ROLES, MODEL_GB, ROLES, knownModelTags, parseChip } from './mac-profiles.mjs';
import { verdict } from './model-bench.mjs';

export const LIBRARY_SCHEMA = 'kingmaker.brain-library/1';
export const LIBRARY_REPO = 'ronininc/kingmaker-brain-library';
export const LIBRARY_RAW = `https://raw.githubusercontent.com/${LIBRARY_REPO}/main`;
/** GitHub refuses a release file over 2 GiB; parts stay under that with room. */
export const PART_BYTES = 1_900_000_000;
/** Licences whose terms allow republishing the weights (with the notice). Anything else is a pointer only. */
export const REDISTRIBUTABLE = Object.freeze(['apache-2.0', 'mit', 'gemma', 'llama3.1', 'llama3.2', 'qwen']);

/** Every Apple-silicon Mac configuration, as sold (chip → RAM sizes). Bandwidth: lib/mac-profiles.mjs CHIP_BANDWIDTH. */
export const DEVICES = Object.freeze({
  'M1': [8, 16], 'M1 Pro': [16, 32], 'M1 Max': [32, 64], 'M1 Ultra': [64, 128],
  'M2': [8, 16, 24], 'M2 Pro': [16, 32], 'M2 Max': [32, 64, 96], 'M2 Ultra': [64, 128, 192],
  'M3': [8, 16, 24], 'M3 Pro': [18, 36], 'M3 Max': [36, 48, 64, 96, 128], 'M3 Ultra': [96, 256, 512],
  'M4': [16, 24, 32], 'M4 Pro': [24, 48, 64], 'M4 Max': [36, 48, 64, 128],
  'M5': [16, 24, 32], 'M5 Pro': [24, 48, 64], 'M5 Max': [36, 48, 64, 128],
});
const MACS = Object.freeze({ base: 'MacBook Air, MacBook Pro 13/14, Mac mini, iMac', Pro: 'MacBook Pro 14/16, Mac mini', Max: 'MacBook Pro 14/16, Mac Studio', Ultra: 'Mac Studio, Mac Pro' });

/** Where each model comes from and under what licence (checked on Hugging Face, 2026-10-15). */
export const PROVENANCE = Object.freeze({
  'hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M': { from: 'huihui-ai/Huihui-granite-4.1-3b-abliterated', base: 'ibm-granite/granite-4.1-3b', license: 'apache-2.0', kind: 'abliterated' },
  'granite4.1:3b': { from: 'ollama library granite4.1:3b', base: 'ibm-granite/granite-4.1-3b', license: 'apache-2.0', kind: 'stock' },
  'huihui_ai/qwen3-abliterated:0.6b': { from: 'huihui-ai/Qwen3-0.6B-abliterated', base: 'Qwen/Qwen3-0.6B', license: 'apache-2.0', kind: 'abliterated' },
  'huihui_ai/qwen3-abliterated:1.7b': { from: 'huihui-ai/Qwen3-1.7B-abliterated', base: 'Qwen/Qwen3-1.7B', license: 'apache-2.0', kind: 'abliterated' },
  'huihui_ai/qwen3-abliterated:8b': { from: 'huihui-ai/Qwen3-8B-abliterated', base: 'Qwen/Qwen3-8B', license: 'apache-2.0', kind: 'abliterated' },
  'huihui_ai/qwen3.5-abliterated:2b': { from: 'huihui-ai/Huihui-Qwen3.5-2B-abliterated', base: 'Qwen/Qwen3.5-2B', license: 'apache-2.0', kind: 'abliterated' },
  'huihui_ai/qwen3.5-abliterated:4b': { from: 'huihui-ai/Huihui-Qwen3.5-4B-abliterated', base: 'Qwen/Qwen3.5-4B', license: 'apache-2.0', kind: 'abliterated' },
  'huihui_ai/qwen2.5-coder-abliterate:1.5b': { from: 'ollama huihui_ai/qwen2.5-coder-abliterate (the Hugging Face repo is gone)', base: 'Qwen/Qwen2.5-Coder-1.5B-Instruct', license: 'apache-2.0', kind: 'abliterated' },
  'huihui_ai/qwen2.5-coder-abliterate:7b': { from: 'ollama huihui_ai/qwen2.5-coder-abliterate (the Hugging Face repo is gone)', base: 'Qwen/Qwen2.5-Coder-7B-Instruct', license: 'apache-2.0', kind: 'abliterated' },
  'hf.co/TrevorJS/gemma-4-12B-it-uncensored-GGUF:Q4_K_M': { from: 'TrevorJS/gemma-4-12B-it-uncensored', base: 'Gemma 4 12B', license: 'apache-2.0', kind: 'uncensored' },
  'hf.co/mradermacher/Qwen3.8-9B-heretic-uncensored-i1-GGUF:i1-Q4_K_M': { from: 'rohit267/Qwen3.8-9B-heretic-uncensored', base: 'Qwen3.8-9B', license: null, kind: 'heretic', note: 'No licence on its model card: listed and measured, weights not republished.' },
});

/**
 * Options for Macs bigger than any profile class (the owner, 2026-10-16: "i just need it in the github as an option for
 * when i get a bigger setup"). Listed, never picked, never downloaded or measured here; no weights republished (linked
 * upstream). Checked on Hugging Face 2026-10-16: the repos, licences and file sizes below.
 */
export const BIG_OPTIONS = Object.freeze([
  { tag: 'DeepSeek-V4.1-Flash-UNCENSORED', kind: 'abliterated', license: 'mit', base: 'deepseek-ai/DeepSeek-V4.1-Flash',
    from: 'dealignai/DeepSeek-V4.1-Flash-UNCENSORED-FP8', gguf: 'Adolphsson/DeepSeek-V4.1-Flash-UNCENSORED-GGUF',
    params: '763B total, ~16B active per token (MoE)', context: '1M tokens', forRamGb: [512],
    files: [['Q2_K', 270.6], ['Q3_K_M', 351.7], ['Q4_K_M', 426.1], ['Q8_0', 508.0], ['mmproj-BF16 (vision projector)', 1.0]],
    runtime: 'Not Ollama: antirez\'s ds4 engine, or a llama.cpp build with DeepSeek V4/V4.1 support.',
    note: 'Weight-level abliteration. For a 512 GB Mac (M3 Ultra Mac Studio): Q4_K_M (426 GB) is the largest that leaves room for macOS; Q8_0 (508 GB) does not fit.' },
  { tag: 'Huihui-DeepSeek-V4-Flash-abliterated', kind: 'abliterated', license: 'mit', base: 'deepseek-ai/DeepSeek-V4-Flash',
    from: 'huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-ds4-GGUF', gguf: 'huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-ds4-GGUF',
    params: 'DeepSeek V4 Flash (MoE)', context: null, forRamGb: [192, 256],
    files: [['ds4-Q2', 86.7], ['Q2_K', 99.7], ['Q4_K', 164.6], ['MTP draft (speculative decoding)', 3.8]],
    runtime: 'Not Ollama: antirez\'s ds4 engine, or a llama.cpp build with DeepSeek V4 support.',
    note: 'For 192–256 GB Macs (M2 Ultra 192 GB, M3 Ultra 256 GB): ds4-Q2 or Q4_K.' },
  { tag: 'Kimi-K3', kind: 'stock', license: 'kimi-k3', base: 'moonshotai/Kimi-K3',
    from: 'moonshotai/Kimi-K3', gguf: 'unsloth/Kimi-K3-GGUF',
    params: '2.8T total, ~104B active per token (MoE: 896 experts, 16 + 2 shared); multimodal (MoonViT-V2)', context: '1M tokens', forRamGb: [512],
    files: [['UD-Q1_0 (community, Unsloth)', 466], ['UD-Q8_K_XL (full)', 1560]],
    runtime: 'Not Ollama: a llama.cpp or vLLM build with Kimi K3 support; Moonshot suggests ~64 accelerators to serve.',
    note: 'Custom "Kimi K3 License": open-weight, not open source (resale / revenue-share terms), so a pointer only — weights are never republished here. No abliterated build exists yet. The smallest quant (466 GB) nominally fits a 512 GB M3 Ultra but leaves too little for macOS and a real 1M-token context; the intended home is the owner\'s planned NVIDIA DGX Spark + M5 Studio rig. Weights released 2026-07-27.' },
]);

/** Pure: a model tag → a release-safe slug ("huihui_ai/qwen3-abliterated:8b" → "huihui-ai-qwen3-abliterated-8b"). */
export const modelSlug = (tag) => String(tag).replace(/^hf\.co\//, '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
export const redistributable = (license) => Boolean(license) && REDISTRIBUTABLE.includes(String(license).toLowerCase());

/** Pure: part i of n for a file of `size` bytes, each at most PART_BYTES. */
export function planParts(size, partBytes = PART_BYTES) {
  const parts = [];
  for (let start = 0, i = 0; start < size; start += partBytes, i += 1) parts.push({ index: i, start, size: Math.min(partBytes, size - start) });
  return parts;
}

/** Pure: every device row (chip × RAM). Information for planning and reporting — never a gate. */
export function libraryDevices() {
  return Object.entries(DEVICES).flatMap(([chip, rams]) => rams.map((ramGb) => {
    const tier = chip.split(' ')[1] ?? 'base';
    return { id: `${chip.toLowerCase().replace(/\s+/g, '-')}-${ramGb}gb`, chip, ramGb, bandwidthGBs: CHIP_BANDWIDTH[chip] ?? null, macs: MACS[tier] };
  }));
}

/** Pure: the summary of one benchmark result for the library. */
const benchSummary = (file, r, budget) => {
  const v = verdict(r, { maxResidentGb: budget });
  return { file, context: r.context, tokS: r.speed?.genTokS ?? null, loadS: r.loadS ?? null, holdsGb: r.memory?.steadyRssGb ?? null, tools: v.tools, nativeTools: v.nativeTools, route: v.route, write: v.write, fits: v.fits, why: v.fits ? null : v.why, error: r.error ?? null };
};

/**
 * Pure: library.json from the profiles and every bench file ({ name: parsed json }). `weights` is { tag: release info }
 * for the picks already published (scripts/brain-library.mjs fills it). `tools` is the normalized tools index
 * (loadToolsIndex) — tool items ride in the same library.json, under their own schema lineage (kingmaker.tools/1).
 */
export function buildLibrary({ benches = {}, weights = {}, capabilities = {}, tools = [], source = null, now = new Date().toISOString() } = {}) {
  const models = new Map();
  const touch = (tag) => {
    if (!models.has(tag)) {
      const p = PROVENANCE[tag] ?? {};
      models.set(tag, { tag, slug: modelSlug(tag), from: p.from ?? (tag.startsWith('hf.co/') ? tag.slice(6).split(':')[0] : `ollama ${tag}`), base: p.base ?? null, license: p.license ?? null, kind: p.kind ?? (/abliterat/i.test(tag) ? 'abliterated' : /heretic|uncensor/i.test(tag) ? 'uncensored' : 'stock'),
        redistributable: redistributable(p.license), note: p.note ?? null, capabilities: capabilities[tag] ?? null, downloadGb: MODEL_GB[tag] ?? null, roles: [], picks: [], status: 'option', bench: [], weights: weights[tag] ?? null });
    }
    return models.get(tag);
  };
  // The starter floor's picks — one set for every device (status 'pick', the role recorded plainly).
  for (const role of ROLES) { const m = touch(FLOOR_ROLES[role]); m.picks.push({ role }); m.roles.push(role); m.status = 'pick'; }
  // Every tabled candidate is listed; the selector, not this catalog, decides what a task gets.
  for (const tag of knownModelTags()) touch(tag);
  for (const [file, b] of Object.entries(benches)) {
    // A bench result's `fits` is judged against the device it was measured on (or simulated as) —
    // a measurement about that run, never a budget a class table imposes on other devices.
    const budget = b.simulated?.asGb ?? b.host?.ramGb ?? Infinity;
    for (const r of b.results ?? []) touch(r.model).bench.push({ ...benchSummary(file, r, budget), host: b.host?.chip ?? null, ramGb: b.host?.ramGb ?? null, simulatedAsGb: b.simulated?.asGb ?? null });
  }
  // Role evidence: the bench candidate tabling's own role for the model (lib/mac-profiles.mjs
  // BENCH_SETS — the tree's curated, measurement-backed assignment of what each candidate is FOR),
  // plus declared capability: Ollama's vision capability evidences the vision role, a coder build
  // the coder role. A bench SCORE alone never evidences a role: every benched model has a write
  // score, so score-derived roles would make the smallest model "sufficient" for everything and
  // the selector's role screen meaningless (found by the rework's own proof run, 2026-11-14: the
  // 0.6b classifier out-picked the granite writer on size for a writing task).
  const tabledRole = new Map();
  for (const set of Object.values(BENCH_SETS)) for (const e of set) { if (!tabledRole.has(e.tag)) tabledRole.set(e.tag, e.role); }
  for (const m of models.values()) {
    const add = (role) => { if (role && !m.roles.includes(role)) m.roles.push(role); };
    add(tabledRole.get(m.tag));
    if ((m.capabilities ?? []).includes('vision')) add('vision');
    if (/\b(code|coder)\b/i.test(m.tag)) add('coder');
    m.roles = ROLES.filter((r) => m.roles.includes(r));
  }
  return {
    schema: LIBRARY_SCHEMA, repo: LIBRARY_REPO, updatedAt: now, source,
    devices: libraryDevices(),
    floor: { roles: { ...FLOOR_ROLES }, models: [...FLOOR_MODELS], note: 'the starter floor: the smallest bench-validated model per role, identical on every device. Per-task picks are the smallest-sufficient selector\'s, made from the measured model records below.' },
    models: [...models.values()].sort((a, b) => (a.status === b.status ? a.tag.localeCompare(b.tag) : a.status === 'pick' ? -1 : 1)),
    tools,
    bigOptions: BIG_OPTIONS.map((o) => ({ ...o, slug: modelSlug(o.tag), status: 'option', basis: 'estimate', redistributable: false, weights: null,
      links: [`https://huggingface.co/${o.from}`, ...(o.gguf !== o.from ? [`https://huggingface.co/${o.gguf}`] : [])], files: o.files.map(([quant, gb]) => ({ quant, gb })) })),
    bench: Object.keys(benches).sort(),
  };
}

/** The JSON Schema of library.json (draft 2020-12), published beside it. */
export const LIBRARY_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `${LIBRARY_RAW}/schema/library.schema.json`, title: 'Kingmaker Brain Library',
  type: 'object', required: ['schema', 'devices', 'floor', 'models'],
  properties: {
    schema: { const: LIBRARY_SCHEMA }, repo: { type: 'string' }, updatedAt: { type: 'string' }, source: { type: ['string', 'null'] },
    devices: { type: 'array', items: { type: 'object', required: ['id', 'chip', 'ramGb'], properties: { id: { type: 'string' }, chip: { type: 'string' }, ramGb: { type: 'integer' }, bandwidthGBs: { type: ['number', 'null'] }, macs: { type: 'string' } } } },
    floor: { type: 'object', required: ['roles', 'models'], properties: {
      roles: { type: 'object', additionalProperties: { type: 'string' } }, models: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } },
    models: { type: 'array', items: { type: 'object', required: ['tag', 'slug', 'status'], properties: {
      tag: { type: 'string' }, slug: { type: 'string' }, from: { type: 'string' }, base: { type: ['string', 'null'] }, license: { type: ['string', 'null'] }, kind: { type: 'string' },
      redistributable: { type: 'boolean' }, note: { type: ['string', 'null'] }, capabilities: { type: ['array', 'null'], items: { type: 'string' } }, status: { enum: ['pick', 'option', 'retired'] },
      downloadGb: { type: ['number', 'null'] }, roles: { type: 'array', items: { type: 'string' } },
      picks: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' } } } },
      bench: { type: 'array', items: { type: 'object' } },
      weights: { type: ['object', 'null'], properties: { release: { type: 'string' }, gguf: { type: 'string' }, sha256: { type: 'string' }, size: { type: 'integer' }, modelfile: { type: 'string' },
        parts: { type: 'array', items: { type: 'object', required: ['name', 'size', 'sha256'], properties: { name: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' } } } } } } } } },
    tools: { type: 'array', description: 'Tool items (schema kingmaker.tools/1, catalog/tools/index.json): engines that stream and materialize like weights — see normalizeToolsIndex.',
      items: { type: 'object', required: ['id', 'version', 'license', 'provides', 'platforms'], properties: {
        id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, license: { type: 'string' }, homepage: { type: ['string', 'null'] },
        provides: { type: 'array', items: { type: 'string' } }, note: { type: ['string', 'null'] },
        platforms: { type: 'object', additionalProperties: { type: 'object', required: ['release', 'archive', 'format', 'bin', 'payloadStatus'], properties: {
          release: { type: 'string' }, archive: { type: 'string' }, format: { enum: ['zip', 'docker-image-tar'] }, bin: { type: 'string' },
          payloadStatus: { enum: ['staged', 'declared-not-staged'] }, size: { type: ['integer', 'null'] }, sha256: { type: ['string', 'null'] },
          parts: { type: 'array', items: { type: 'object', required: ['name', 'size', 'sha256'], properties: { name: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' } } } } } } } } } },
    bench: { type: 'array', items: { type: 'string' } },
    bigOptions: { type: 'array', description: 'Listed for Macs bigger than any profile class; never picked, never measured here, weights linked upstream.',
      items: { type: 'object', required: ['tag', 'license', 'from', 'forRamGb', 'files', 'runtime', 'status', 'basis'], properties: {
        tag: { type: 'string' }, license: { type: 'string' }, from: { type: 'string' }, gguf: { type: 'string' }, forRamGb: { type: 'array', items: { type: 'integer' } },
        files: { type: 'array', items: { type: 'object', properties: { quant: { type: 'string' }, gb: { type: 'number' } } } }, runtime: { type: 'string' },
        status: { const: 'option' }, basis: { const: 'estimate' }, redistributable: { const: false }, links: { type: 'array', items: { type: 'string' } } } } },
  },
});

// ── The rotation: which measured model should hold each role (the 30-day churn's decision rule) ──
// Reviewed 2026-10-15 (the bar session): a tool-call floor, no proposal against an unmeasured pick, speed floors,
// two runs (or a doubled margin), simulated speeds scaled to the real chip, vision reported but never proposed until
// an image suite exists, a censored winner shown but not proposed, and an anchored coder match.
/** The slowest a role may be on the class's own chip (tok/s), so a smarter but slow model never takes a role the
 *  owner waits on. */
export const SPEED_FLOOR = Object.freeze({ router: 40, writer: 25, coder: 20, reasoning: 12, vision: 15 });
/** A proposal must score at least this, whatever the margin. */
export const MIN_PROPOSAL_SCORE = 85;
/** Pure: the speed a result stands for on a real Mac of its class: a simulated 8 GB result ran on a bigger chip, so it
 *  is scaled by bandwidth to an 8 GB-class chip (M3, 100 GB/s). */
export function effectiveTokS(b) {
  if (!b?.tokS) return 0;
  if (!b.simulatedAsGb) return b.tokS;
  const host = parseChip(b.host).bandwidth;
  return host ? b.tokS * (100 / host) : b.tokS;
}

/** Pure: a model's score for a role from one bench summary (0–100), -1 when it can't hold the role. Text roles weigh
 *  tool calls, routing and writing; the router weighs routing and speed. */
export function roleScore(role, b) {
  if (!b || b.error || !b.fits) return -1;
  const tokS = effectiveTokS(b);
  if (tokS && tokS < (SPEED_FLOOR[role] ?? 0)) return -1;
  const t = b.tools ?? 0, r = b.route ?? 0, w = b.write ?? 0, speed = Math.min(100, tokS / 2);
  if (role === 'router') return 0.6 * r + 0.25 * t + 0.15 * speed;
  if (role === 'coder') return 0.6 * t + 0.2 * r + 0.2 * w;
  return 0.45 * t + 0.25 * r + 0.3 * w;
}

/** Pure: may this model hold this role? Pullable (never a local/ import), vision only with Ollama's 'vision'
 *  capability, the coder only a coding model (the bench has no code suite yet). No device class is
 *  consulted: eligibility is about the model and the role, never about which Mac asks. */
export function eligible(m, role) {
  if (/^local\//.test(m.tag)) return false;
  if (role === 'vision') return (m.capabilities ?? []).includes('vision');
  if (role === 'coder') return /\b(code|coder)\b/i.test(m.tag);
  return true;
}

const TOOL_ROLES = ['writer', 'coder', 'reasoning'];
/**
 * Pure: for each role, the best measured model across every bench file against the floor's current
 * pick for that role (the rotation maintains the FLOOR — per-task picks above the floor are the
 * selector's, made per task from these same records). A change is proposed only when the challenger
 *   • leads by `margin` points (twice that when it was measured only once),
 *   • scores at least MIN_PROPOSAL_SCORE and clears the role's speed floor (inside roleScore),
 *   • for a tool role, calls tools at least as well (within 2 points of the pick, or ≥ 95%),
 *   • is abliterated/uncensored when the pick is (a better censored model is reported, not proposed),
 * and never when the current pick was not measured at all, or for vision (no image suite yet).
 * Ties go to the abliterated/uncensored build, then the one that holds less memory.
 */
export function proposePicks(lib, { margin = 5 } = {}) {
  const out = [];
  const uncensored = (m) => /abliterated|uncensored|heretic/.test(m.kind);
  for (const role of ROLES) {
    const current = lib.floor?.roles?.[role] ?? FLOOR_ROLES[role];
    const scored = lib.models.filter((m) => eligible(m, role)).map((m) => {
      const runs = m.bench ?? [];
      const best = runs.map((b) => ({ b, s: roleScore(role, b) })).sort((x, y) => y.s - x.s)[0];
      return { m, score: best?.s ?? -1, b: best?.b, runs: runs.length };
    }).filter((x) => x.score >= 0).sort((a, b) => (b.score - a.score) || (uncensored(b.m) - uncensored(a.m)) || ((a.b.holdsGb ?? 99) - (b.b.holdsGb ?? 99)));
    const cur = scored.find((x) => x.m.tag === current), top = scored[0];
    if (!top) continue;
    const row = { role, current, currentScore: Math.round(cur?.score ?? -1), best: top.m.tag, bestScore: Math.round(top.score), change: false, why: '' };
    const topUncensored = scored.find((x) => uncensored(x.m));
    if (!cur) row.why = 'the current pick was not measured';
    else if (top.m.tag === current) row.why = 'the pick leads';
    else if (role === 'vision') row.why = 'reported only: the bench has no image suite yet';
    else if (top.score < cur.score + (top.runs >= 2 ? margin : margin * 2)) row.why = `lead under ${top.runs >= 2 ? margin : margin * 2} points${top.runs < 2 ? ' (one run)' : ''}`;
    else if (top.score < MIN_PROPOSAL_SCORE) row.why = `scores under ${MIN_PROPOSAL_SCORE}`;
    else if (TOOL_ROLES.includes(role) && !((top.b.tools ?? 0) >= (cur.b.tools ?? 0) - 2 || (top.b.tools ?? 0) >= 95)) row.why = `calls tools worse (${top.b.tools}% vs ${cur.b.tools}%)`;
    else if (uncensored(cur.m) && !uncensored(top.m)) row.why = `best overall is censored (${top.m.tag}); ${topUncensored && topUncensored.m.tag !== current ? `best uncensored ${topUncensored.m.tag} at ${Math.round(topUncensored.score)}` : 'the pick is the best uncensored'}`;
    else { row.change = true; row.why = `leads by ${Math.round(top.score - cur.score)} on ${top.runs} run(s)`; }
    out.push(row);
  }
  return out;
}

/** Pure: the proposal as markdown (catalog/churn/<day>-proposal.md). */
export function proposalReport(rows, day) {
  const changes = rows.filter((r) => r.change);
  const lines = [`# Pick proposal, ${day}`, '', changes.length ? `${changes.length} change(s) proposed from measured results. Each needs a reviewed commit to lib/mac-profiles.mjs (the floor) before it ships.` : 'No change proposed.', '', '| Role | Current pick | Score | Best measured | Score | Change | Why |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.role} | \`${r.current}\` | ${r.currentScore < 0 ? 'not measured' : r.currentScore} | \`${r.best}\` | ${r.bestScore} | ${r.change ? '**propose**' : '—'} | ${r.why} |`);
  return `${lines.join('\n')}\n`;
}

// ── Training modules (owner item 4, 2026-11-05): continuity-of-reasoning text in the Brain Library ──
// The model stream above carries selection and pinned weights only; training modules are the library's TEXT
// holdings — doctrine a session loads to reason consistently. The catalog index is catalog/training/index.json
// (schema kingmaker.training-modules/1). Index and module manifests carry headings, keywords and QUALITY
// metadata only; part body text lives in per-part files and is read selectively by lib/module-reader.mjs
// (MemPalace architecture, owner item 10). Discovery goes through here, never a hardcoded path in the reader.
export const TRAINING_SCHEMA = 'kingmaker.training-modules/1';
export const TRAINING_INDEX_URL = new URL('../catalog/training/index.json', import.meta.url);
/** Quality tiers, lowest to highest. Selection by quality (not just source count) is the reader's contract. */
export const QUALITY_TIERS = Object.freeze(['draft', 'community', 'vetted', 'canonical']);
export const qualityRank = (tier) => QUALITY_TIERS.indexOf(String(tier ?? '').toLowerCase());

/** Pure: validate + normalize a parsed training index into module descriptors (manifests not yet loaded). */
export function normalizeTrainingIndex(index) {
  if (!index || index.schema !== TRAINING_SCHEMA || !Array.isArray(index.modules)) {
    throw new Error(`brain-library: training index is not ${TRAINING_SCHEMA}`);
  }
  return index.modules.map((m) => {
    if (!m.id || !m.dir || !m.quality || qualityRank(m.quality.tier) < 0 || !Number.isFinite(m.quality.score)) {
      throw new Error(`brain-library: training module entry is malformed (id=${m?.id ?? '?'})`);
    }
    return { id: m.id, title: m.title ?? m.id, dir: m.dir, quality: { tier: m.quality.tier, score: m.quality.score, basis: m.quality.basis ?? null } };
  });
}

/** The training catalog index, read from the library's own catalog tree. `read` is injectable for tests. */
export function loadTrainingIndex({ indexUrl = TRAINING_INDEX_URL, read = null } = {}) {
  const raw = read ? read(indexUrl) : readFileSync(indexUrl, 'utf8');
  return normalizeTrainingIndex(JSON.parse(raw));
}

// ── Method files (owner item 15, 2026-11-05): the CAPABILITY layer of the Brain Library ──
// Training modules teach how to reason; method files script what to do. A method file is an
// executable-structured markdown document (a fenced ```kingmaker-method JSON block: inputs +
// numbered typed steps) that lib/method-conductor.mjs pulls through this catalog, digests and
// conducts. Capability therefore arrives as DATA: a future update is a new or edited method file
// in catalog/methods/, never a code change — every install runs the exact same baseline system.
// The catalog index is catalog/methods/index.json (schema kingmaker.methods/1), parallel in
// spirit to the training index above: discovery goes through here, never a hardcoded path in
// the conductor.
export const METHODS_SCHEMA = 'kingmaker.methods/1';
export const METHODS_INDEX_URL = new URL('../catalog/methods/index.json', import.meta.url);

/** Pure: validate + normalize a parsed methods index into method descriptors (files not yet read). */
export function normalizeMethodsIndex(index) {
  if (!index || index.schema !== METHODS_SCHEMA || !Array.isArray(index.methods)) {
    throw new Error(`brain-library: methods index is not ${METHODS_SCHEMA}`);
  }
  return index.methods.map((m) => {
    if (!m.id || !m.file || !m.quality || qualityRank(m.quality.tier) < 0 || !Number.isFinite(m.quality.score)) {
      throw new Error(`brain-library: method entry is malformed (id=${m?.id ?? '?'})`);
    }
    return { id: m.id, title: m.title ?? m.id, domain: m.domain ?? null, file: m.file, quality: { tier: m.quality.tier, score: m.quality.score, basis: m.quality.basis ?? null } };
  });
}

/** The methods catalog index, read from the library's own catalog tree. `read` is injectable for tests. */
export function loadMethodsIndex({ indexUrl = METHODS_INDEX_URL, read = null } = {}) {
  const raw = read ? read(indexUrl) : readFileSync(indexUrl, 'utf8');
  return normalizeMethodsIndex(JSON.parse(raw));
}

// ── Tools (tool streaming, 2026-11-11): the ENGINE layer of the Brain Library ──
// Models stream as weights; training modules and method files stream as text. Tools — the
// engines a method step invokes (a renderer, a CAD binary) — were the missing item type:
// the catalog had no shape for them, so a node without the binary could only declare the
// step, never pull the tool. A tool item carries its platform binaries the same way a model
// carries weights: one release archive per platform, split into hashed parts planned by
// planParts (the same machinery as model weights), the whole archive SHA-256-pinned. The
// catalog index is catalog/tools/index.json (schema kingmaker.tools/1), parallel in spirit
// to the training and methods indexes: discovery goes through here.
//
// A platform payload is either STAGED (parts named, sized and hashed; the pull path in
// lib/brain-library-access.mjs serves it and lib/brain-library-fetch.mjs materializes it)
// or DECLARED-NOT-STAGED (the part layout contract is declared, the payload packaging step
// has not run: size/sha256 are null, parts is empty, and every pull path REFUSES it —
// fail closed, never a half-served tool).
//
// A platform's FORMAT is 'zip' (the library zip: unpacked at materialize time into a
// binary tree, `bin` a path inside it) or 'docker-image-tar' (owner order 2026-11-13: a
// `docker save` archive — the tool IS a Docker image; `bin` names the image, never a
// path, and materializing means hash-verified parts → `docker load` → the image
// registered, with adoption of an already-local image first). The parts/hash contract
// is identical for both formats; only the materialize step differs.
export const TOOLS_SCHEMA = 'kingmaker.tools/1';
export const TOOLS_INDEX_URL = new URL('../catalog/tools/index.json', import.meta.url);
export const TOOL_PAYLOAD_STATUSES = Object.freeze(['staged', 'declared-not-staged']);

/** This machine's tool-platform key ("macos-arm64", "linux-x64", "windows-x64"). */
export function toolPlatformKey(platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;
  return `${os}-${arch}`;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The tool payload formats the library distributes (see the tools-section note above). */
export const TOOL_FORMATS = Object.freeze(['zip', 'docker-image-tar']);

/** Pure: validate + normalize one tool item's platform payload. Throws on anything malformed. */
function normalizeToolPlatform(toolId, key, p) {
  if (!p || typeof p !== 'object') throw new Error(`brain-library: tool ${toolId} platform ${key} is malformed`);
  if (!TOOL_FORMATS.includes(p.format)) throw new Error(`brain-library: tool ${toolId} platform ${key}: format must be "zip" or "docker-image-tar" (the library's distribution formats — upstream archives are repacked at staging)`);
  if (!p.release || !p.archive || !p.bin) throw new Error(`brain-library: tool ${toolId} platform ${key} needs release, archive and bin`);
  // For docker-image-tar, `bin` names a Docker image (name[:tag], registry paths and
  // all) — never a path inside an archive — so: no whitespace, no backslashes, and it
  // never starts like a filesystem path ("/…", "./…", "../…").
  if (p.format === 'docker-image-tar' && (typeof p.bin !== 'string' || /[\s\\]/.test(p.bin) || p.bin.startsWith('/') || p.bin.startsWith('.'))) {
    throw new Error(`brain-library: tool ${toolId} platform ${key}: a docker-image-tar bin must name a docker image (e.g. "name:tag"), not a path`);
  }
  const payloadStatus = p.payloadStatus ?? 'declared-not-staged';
  if (!TOOL_PAYLOAD_STATUSES.includes(payloadStatus)) throw new Error(`brain-library: tool ${toolId} platform ${key}: unknown payloadStatus "${payloadStatus}"`);
  if (payloadStatus === 'declared-not-staged') {
    return { release: p.release, archive: p.archive, format: p.format, bin: p.bin, payloadStatus, size: null, sha256: null, parts: [] };
  }
  // Staged: the whole archive and every part carry real sizes and SHA-256 pins, and the
  // parts tile the archive exactly (planParts' contract, checked rather than trusted).
  if (!Number.isInteger(p.size) || p.size <= 0 || !SHA256_HEX.test(p.sha256 ?? '')) {
    throw new Error(`brain-library: tool ${toolId} platform ${key} is staged but lacks a size / sha256 pin for the whole archive`);
  }
  if (!Array.isArray(p.parts) || !p.parts.length) throw new Error(`brain-library: tool ${toolId} platform ${key} is staged but declares no parts`);
  let sum = 0;
  const names = new Set();
  const parts = p.parts.map((part) => {
    if (!part.name || names.has(part.name) || !Number.isInteger(part.size) || part.size <= 0 || !SHA256_HEX.test(part.sha256 ?? '')) {
      throw new Error(`brain-library: tool ${toolId} platform ${key} has a malformed part (${part?.name ?? '?'})`);
    }
    names.add(part.name); sum += part.size;
    return { name: part.name, size: part.size, sha256: part.sha256 };
  });
  if (sum !== p.size) throw new Error(`brain-library: tool ${toolId} platform ${key}: parts sum to ${sum}, not the archive's ${p.size}`);
  return { release: p.release, archive: p.archive, format: p.format, bin: p.bin, payloadStatus, size: p.size, sha256: p.sha256, parts };
}

/** Pure: validate + normalize a parsed tools index into tool descriptors (payloads not yet pulled). */
export function normalizeToolsIndex(index) {
  if (!index || index.schema !== TOOLS_SCHEMA || !Array.isArray(index.tools)) {
    throw new Error(`brain-library: tools index is not ${TOOLS_SCHEMA}`);
  }
  return index.tools.map((t) => {
    if (!t.id || !/^[a-z0-9][a-z0-9-]*$/.test(t.id) || !t.version || !t.license
      || !Array.isArray(t.provides) || !t.provides.length || t.provides.some((c) => typeof c !== 'string' || !c)
      || !t.quality || qualityRank(t.quality.tier) < 0 || !Number.isFinite(t.quality.score)
      || !t.platforms || typeof t.platforms !== 'object' || !Object.keys(t.platforms).length) {
      throw new Error(`brain-library: tool entry is malformed (id=${t?.id ?? '?'})`);
    }
    const platforms = Object.fromEntries(Object.entries(t.platforms).map(([key, p]) => [key, normalizeToolPlatform(t.id, key, p)]));
    return {
      id: t.id, name: t.name ?? t.id, version: String(t.version), license: t.license,
      homepage: t.homepage ?? null, provides: [...t.provides], note: t.note ?? null,
      quality: { tier: t.quality.tier, score: t.quality.score, basis: t.quality.basis ?? null },
      platforms,
    };
  });
}

/** The tools catalog index, read from the library's own catalog tree. `read` is injectable for tests. */
export function loadToolsIndex({ indexUrl = TOOLS_INDEX_URL, read = null } = {}) {
  const raw = read ? read(indexUrl) : readFileSync(indexUrl, 'utf8');
  return normalizeToolsIndex(JSON.parse(raw));
}

/** Pure: the tool item providing `command`, or null (the conductor's catalog lookup). */
export function toolForCommand(tools, command) {
  return (tools ?? []).find((t) => t.provides.includes(command)) ?? null;
}
