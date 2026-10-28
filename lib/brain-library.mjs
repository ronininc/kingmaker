// lib/brain-library.mjs — the Kingmaker Brain Library (github.com/ronininc/kingmaker-brain-library, private): the models
// suggested for every Apple-silicon Mac, the benchmarks behind each pick, and the weights themselves.
//   • library.json (schema kingmaker.brain-library/1, schema/library.schema.json): every Mac configuration Apple sold
//     (chip × RAM), the profile class it gets (lib/mac-profiles.mjs), each class's picks per role, and every model:
//     where it comes from (the exact Hugging Face file or Ollama tag, SHA-256), its licence, and what it measured.
//   • bench/: every Mac's `kingmaker models bench` result. Each Mac that runs the bench adds one; a class's picks are
//     "measured" once its own results are in, "estimate" until then. More Macs, more measurements.
//   • Weights: each pick whose licence allows redistribution is a GitHub Release (model-<slug>), its GGUF split into
//     parts under 2 GB (GitHub's limit per release file), each part and the whole SHA-256-checked, with the Ollama
//     Modelfile (template and parameters) it was measured with. A model with no licence on its card stays a pointer.
//   • The 30-day churn (`kingmaker models hb churn`) finds new abliterated and uncensored builds; a benchmark decides
//     whether they replace a pick; a replaced pick's release is kept, marked retired.
// Pure builders here; scripts/brain-library.mjs writes the repo and publishes weights; `kingmaker models library` pulls.

import { CHIP_BANDWIDTH, CLASSES, PACKS, PROFILES, ROLES, classFor, parseChip } from './mac-profiles.mjs';
import { verdict } from './model-bench.mjs';
import { execFileSync } from 'node:child_process';

export const LIBRARY_SCHEMA = 'kingmaker.brain-library/1';
export const LIBRARY_REPO = 'ronininc/kingmaker-brain-library';
export const LIBRARY_RAW = `https://raw.githubusercontent.com/${LIBRARY_REPO}/main`;
export const LIBRARY_API = `https://api.github.com/repos/${LIBRARY_REPO}`;
/** Keychain service (generic password) checked for the library token on macOS. */
export const LIBRARY_KEYCHAIN_SERVICE = 'kingmaker-library';

const NO_TOKEN = `The Kingmaker Brain Library (${LIBRARY_REPO}) is private. Give Kingmaker a GitHub token with read access to it: ` +
  `set KINGMAKER_LIBRARY_TOKEN, or store it in the macOS Keychain (security add-generic-password -s ${LIBRARY_KEYCHAIN_SERVICE} -a "$USER" -w), ` +
  'or sign in with `gh auth login` as an account that can read the repo.';

/**
 * The token used to read the private library. Order: KINGMAKER_LIBRARY_TOKEN, GITHUB_TOKEN, GH_TOKEN, the macOS Keychain
 * item `kingmaker-library`, then `gh auth token`. Never logged, never written anywhere. Returns null when none is found.
 */
export function libraryToken({ env = process.env, run = defaultRun } = {}) {
  for (const k of ['KINGMAKER_LIBRARY_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) if (env[k] && env[k].trim()) return env[k].trim();
  if (process.platform === 'darwin') { const t = run('security', ['find-generic-password', '-s', LIBRARY_KEYCHAIN_SERVICE, '-w']); if (t) return t; }
  return run('gh', ['auth', 'token']) || null;
}
function defaultRun(cmd, args) {
  try {
    return String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })).trim();
  } catch { return ''; }
}

function requireToken(opts) {
  const t = (opts.token ?? libraryToken(opts));
  if (!t) throw new Error(NO_TOKEN);
  return t;
}
function explain(status, what) {
  if (status === 401 || status === 403 || status === 404) return new Error(`${what} answered ${status}: the token cannot read ${LIBRARY_REPO}. ${NO_TOKEN}`);
  return new Error(`${what} answered ${status}`);
}

/** One file from the library's main branch, via the authenticated contents API. Resolves the Response (ok). */
export async function libraryFetchFile(path, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = requireToken(opts);
  const r = await fetchImpl(`${LIBRARY_API}/contents/${path}?ref=main`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw', 'x-github-api-version': '2022-11-28', 'user-agent': 'kingmaker' },
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw explain(r.status, `the library (${path})`);
  return r;
}

/** Download URLs + headers for a release's assets (private repo: the asset API, octet-stream, auth dropped on redirect). */
export async function libraryReleaseAssets(release, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = requireToken(opts);
  const h = { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'kingmaker' };
  const r = await fetchImpl(`${LIBRARY_API}/releases/tags/${encodeURIComponent(release)}`, { headers: { ...h, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw explain(r.status, `the library release ${release}`);
  const rel = await r.json();
  const headers = { ...h, accept: 'application/octet-stream' };
  return Object.fromEntries((rel.assets ?? []).map((a) => [a.name, { url: a.url, headers }]));
}
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

/** Pure: every device row (chip × RAM) with its class and pack. */
export function libraryDevices() {
  return Object.entries(DEVICES).flatMap(([chip, rams]) => rams.map((ramGb) => {
    const tier = chip.split(' ')[1] ?? 'base';
    return { id: `${chip.toLowerCase().replace(/\s+/g, '-')}-${ramGb}gb`, chip, ramGb, bandwidthGBs: CHIP_BANDWIDTH[chip] ?? null, macs: MACS[tier], class: classFor(ramGb), pack: String(classFor(ramGb)) };
  }));
}

/** Pure: the summary of one benchmark result for the library. */
const benchSummary = (file, r, budget) => {
  const v = verdict(r, { maxResidentGb: budget });
  return { file, context: r.context, tokS: r.speed?.genTokS ?? null, loadS: r.loadS ?? null, holdsGb: r.memory?.steadyRssGb ?? null, tools: v.tools, nativeTools: v.nativeTools, route: v.route, write: v.write, fits: v.fits, why: v.fits ? null : v.why, error: r.error ?? null };
};

/**
 * Pure: library.json from the profiles and every bench file ({ name: parsed json }). `weights` is { tag: release info }
 * for the picks already published (scripts/brain-library.mjs fills it).
 */
export function buildLibrary({ benches = {}, weights = {}, capabilities = {}, source = null, now = new Date().toISOString() } = {}) {
  const models = new Map();
  const touch = (tag) => {
    if (!models.has(tag)) {
      const p = PROVENANCE[tag] ?? {};
      models.set(tag, { tag, slug: modelSlug(tag), from: p.from ?? (tag.startsWith('hf.co/') ? tag.slice(6).split(':')[0] : `ollama ${tag}`), base: p.base ?? null, license: p.license ?? null, kind: p.kind ?? (/abliterat/i.test(tag) ? 'abliterated' : /heretic|uncensor/i.test(tag) ? 'uncensored' : 'stock'),
        redistributable: redistributable(p.license), note: p.note ?? null, capabilities: capabilities[tag] ?? null, picks: [], status: 'option', bench: [], weights: weights[tag] ?? null });
    }
    return models.get(tag);
  };
  for (const c of CLASSES) for (const role of ROLES) { const tag = PROFILES[c][role]; if (tag && tag !== 'PENDING') { const m = touch(tag); m.picks.push({ class: c, role }); m.status = 'pick'; } }
  for (const [file, b] of Object.entries(benches)) {
    const cls = b.simulated ? classFor(b.simulated.asGb) : classFor(b.host?.ramGb ?? 8);
    const budget = PROFILES[cls].maxResidentGb;   // the current budget, not the one at bench time
    for (const r of b.results ?? []) touch(r.model).bench.push({ ...benchSummary(file, r, budget), host: b.host?.chip ?? null, ramGb: b.host?.ramGb ?? null, simulatedAsGb: b.simulated?.asGb ?? null });
  }
  return {
    schema: LIBRARY_SCHEMA, repo: LIBRARY_REPO, updatedAt: now, source,
    devices: libraryDevices(),
    classes: CLASSES.map((c) => {
      const p = PROFILES[c], pack = PACKS.find((x) => x.id === String(c));
      const measuredOn = Object.entries(benches).filter(([, b]) => (b.simulated ? classFor(b.simulated.asGb) : classFor(b.host?.ramGb ?? 0)) === c).map(([f]) => f);
      return { class: c, pack: pack.name, label: p.label, roles: Object.fromEntries(ROLES.map((r) => [r, p[r]])), maxResidentGb: p.maxResidentGb, context: p.context, concurrent: p.concurrent, voice: p.voice, pictures: p.imageLane, downloadGb: pack.downloadGb, basis: p.basis, status: measuredOn.length ? 'measured' : 'estimate', measuredOn };
    }),
    models: [...models.values()].sort((a, b) => (a.status === b.status ? a.tag.localeCompare(b.tag) : a.status === 'pick' ? -1 : 1)),
    bigOptions: BIG_OPTIONS.map((o) => ({ ...o, slug: modelSlug(o.tag), status: 'option', basis: 'estimate', redistributable: false, weights: null,
      links: [`https://huggingface.co/${o.from}`, ...(o.gguf !== o.from ? [`https://huggingface.co/${o.gguf}`] : [])], files: o.files.map(([quant, gb]) => ({ quant, gb })) })),
    bench: Object.keys(benches).sort(),
  };
}

/** The JSON Schema of library.json (draft 2020-12), published beside it. */
export const LIBRARY_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `${LIBRARY_RAW}/schema/library.schema.json`, title: 'Kingmaker Brain Library',
  type: 'object', required: ['schema', 'devices', 'classes', 'models'],
  properties: {
    schema: { const: LIBRARY_SCHEMA }, repo: { type: 'string' }, updatedAt: { type: 'string' }, source: { type: ['string', 'null'] },
    devices: { type: 'array', items: { type: 'object', required: ['id', 'chip', 'ramGb', 'class'], properties: { id: { type: 'string' }, chip: { type: 'string' }, ramGb: { type: 'integer' }, bandwidthGBs: { type: ['number', 'null'] }, macs: { type: 'string' }, class: { type: 'integer' }, pack: { type: 'string' } } } },
    classes: { type: 'array', items: { type: 'object', required: ['class', 'roles', 'maxResidentGb', 'context', 'concurrent', 'status'], properties: {
      class: { type: 'integer' }, pack: { type: 'string' }, label: { type: 'string' }, roles: { type: 'object', additionalProperties: { type: 'string' } },
      maxResidentGb: { type: 'number' }, context: { type: 'integer' }, concurrent: { type: 'integer' }, voice: { enum: ['on', 'off'] }, pictures: { type: 'boolean' },
      downloadGb: { type: 'number' }, basis: { type: 'string' }, status: { enum: ['measured', 'estimate'] }, measuredOn: { type: 'array', items: { type: 'string' } } } } },
    models: { type: 'array', items: { type: 'object', required: ['tag', 'slug', 'status'], properties: {
      tag: { type: 'string' }, slug: { type: 'string' }, from: { type: 'string' }, base: { type: ['string', 'null'] }, license: { type: ['string', 'null'] }, kind: { type: 'string' },
      redistributable: { type: 'boolean' }, note: { type: ['string', 'null'] }, capabilities: { type: ['array', 'null'], items: { type: 'string' } }, status: { enum: ['pick', 'option', 'retired'] },
      picks: { type: 'array', items: { type: 'object', properties: { class: { type: 'integer' }, role: { type: 'string' } } } },
      bench: { type: 'array', items: { type: 'object' } },
      weights: { type: ['object', 'null'], properties: { release: { type: 'string' }, gguf: { type: 'string' }, sha256: { type: 'string' }, size: { type: 'integer' }, modelfile: { type: 'string' },
        parts: { type: 'array', items: { type: 'object', required: ['name', 'size', 'sha256'], properties: { name: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' } } } } } } } } },
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
 *  capability, the coder only a coding model (the bench has no code suite yet), and above 8 GB the router small
 *  enough to stay loaded beside a worker. */
export function eligible(m, role, c) {
  if (/^local\//.test(m.tag)) return false;
  if (role === 'vision') return (m.capabilities ?? []).includes('vision');
  if (role === 'coder') return /\b(code|coder)\b/i.test(m.tag);
  if (role === 'router' && c.class > 8) return m.bench.some((b) => c.measuredOn.includes(b.file) && b.holdsGb != null && b.holdsGb <= 3.5);
  return true;
}

const TOOL_ROLES = ['writer', 'coder', 'reasoning'];
/**
 * Pure: for each class and role, the best measured model on that class's own bench files against the current pick.
 * A change is proposed only when the challenger
 *   • leads by `margin` points (twice that when it was measured only once on this class),
 *   • scores at least MIN_PROPOSAL_SCORE and clears the role's speed floor (inside roleScore),
 *   • for a tool role, calls tools at least as well (within 2 points of the pick, or ≥ 95%),
 *   • is abliterated/uncensored when the pick is (a better censored model is reported, not proposed),
 * and never when the current pick was not measured on this class, or for vision (no image suite yet).
 * Ties go to the abliterated/uncensored build, then the one that holds less memory.
 */
export function proposePicks(lib, { margin = 5 } = {}) {
  const out = [];
  const uncensored = (m) => /abliterated|uncensored|heretic/.test(m.kind);
  for (const c of lib.classes) {
    if (!c.measuredOn.length) continue;
    for (const [role, current] of Object.entries(c.roles)) {
      const scored = lib.models.filter((m) => eligible(m, role, c)).map((m) => {
        const runs = m.bench.filter((b) => c.measuredOn.includes(b.file));
        const best = runs.map((b) => ({ b, s: roleScore(role, b) })).sort((x, y) => y.s - x.s)[0];
        return { m, score: best?.s ?? -1, b: best?.b, runs: runs.length };
      }).filter((x) => x.score >= 0).sort((a, b) => (b.score - a.score) || (uncensored(b.m) - uncensored(a.m)) || ((a.b.holdsGb ?? 99) - (b.b.holdsGb ?? 99)));
      const cur = scored.find((x) => x.m.tag === current), top = scored[0];
      if (!top) continue;
      const row = { class: c.class, role, current, currentScore: Math.round(cur?.score ?? -1), best: top.m.tag, bestScore: Math.round(top.score), change: false, why: '' };
      const topUncensored = scored.find((x) => uncensored(x.m));
      if (!cur) row.why = 'the current pick was not measured on this class';
      else if (top.m.tag === current) row.why = 'the pick leads';
      else if (role === 'vision') row.why = 'reported only: the bench has no image suite yet';
      else if (top.score < cur.score + (top.runs >= 2 ? margin : margin * 2)) row.why = `lead under ${top.runs >= 2 ? margin : margin * 2} points${top.runs < 2 ? ' (one run)' : ''}`;
      else if (top.score < MIN_PROPOSAL_SCORE) row.why = `scores under ${MIN_PROPOSAL_SCORE}`;
      else if (TOOL_ROLES.includes(role) && !((top.b.tools ?? 0) >= (cur.b.tools ?? 0) - 2 || (top.b.tools ?? 0) >= 95)) row.why = `calls tools worse (${top.b.tools}% vs ${cur.b.tools}%)`;
      else if (uncensored(cur.m) && !uncensored(top.m)) row.why = `best overall is censored (${top.m.tag}); ${topUncensored && topUncensored.m.tag !== current ? `best uncensored ${topUncensored.m.tag} at ${Math.round(topUncensored.score)}` : 'the pick is the best uncensored'}`;
      else { row.change = true; row.why = `leads by ${Math.round(top.score - cur.score)} on ${top.runs} run(s)`; }
      out.push(row);
    }
  }
  return out;
}

/** Pure: the proposal as markdown (catalog/churn/<day>-proposal.md). */
export function proposalReport(rows, day) {
  const changes = rows.filter((r) => r.change);
  const lines = [`# Pick proposal, ${day}`, '', changes.length ? `${changes.length} change(s) proposed from measured results. Each needs a reviewed commit to lib/mac-profiles.mjs before it ships.` : 'No change proposed.', '', '| Class | Role | Current pick | Score | Best measured | Score | Change | Why |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.class} GB | ${r.role} | \`${r.current}\` | ${r.currentScore < 0 ? 'not measured here' : r.currentScore} | \`${r.best}\` | ${r.bestScore} | ${r.change ? '**propose**' : '—'} | ${r.why} |`);
  return `${lines.join('\n')}\n`;
}
