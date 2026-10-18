// lib/mac-profiles.mjs — Kingmaker's operating profile for each Apple-silicon Mac it runs on. Kingmaker reads the
// hardware (sysctl hw.memsize and machdep.cpu.brand_string, both on every stock Mac) and picks the profile for the RAM
// class; the chip sets the expected speed. The owner can override it in Customize → Mac profile.
//
// The models in each profile were chosen from `kingmaker models bench` results in catalog/bench/ (measured, not
// claimed): the 8 GB profile from the 8 GB simulation on the 24 GB M5 Pro (catalog/bench/m5-pro-24gb-as-8gb.json) and
// the earlier real 8 GB M3 run (catalog/HARDWARE_OUTCOMES.md); 16 and 24 GB from the M5 Pro itself
// (catalog/bench/m5-pro-24gb.json). Classes above 24 GB were not measured on any Mac here: their picks are the 24 GB
// measurements plus each model's measured footprint, and they say so (basis: 'estimate'). The real 8 GB M3 run
// (docs/MAC-PROFILES.md) is what confirms or corrects the 8 GB standard.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

/** Memory bandwidth (GB/s, Apple's published figure for the top configuration of each chip). Generation speed on a
 *  Mac is bound by it, so a measured tok/s scales to another chip by the ratio (an estimate, marked as one). */
export const CHIP_BANDWIDTH = Object.freeze({
  'M1': 68, 'M1 Pro': 200, 'M1 Max': 400, 'M1 Ultra': 800,
  'M2': 100, 'M2 Pro': 200, 'M2 Max': 400, 'M2 Ultra': 800,
  'M3': 100, 'M3 Pro': 150, 'M3 Max': 400, 'M3 Ultra': 819,
  'M4': 120, 'M4 Pro': 273, 'M4 Max': 546,
  'M5': 153, 'M5 Pro': 307, 'M5 Max': 614,
});

/** Pure: "Apple M3 Pro" → { chip: 'M3 Pro', gen: 3, tier: 'Pro', bandwidth: 150 }; unknown → chip null. */
export function parseChip(brand) {
  const m = /\bM(\d+)(?:\s+(Pro|Max|Ultra))?\b/i.exec(String(brand ?? ''));
  if (!m) return { chip: null, gen: null, tier: null, bandwidth: null };
  const tier = m[2] ? m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : 'base';
  const chip = `M${m[1]}${tier === 'base' ? '' : ` ${tier}`}`;
  return { chip, gen: Number(m[1]), tier, bandwidth: CHIP_BANDWIDTH[chip] ?? null };
}

/** This Mac: RAM (GiB, as sold: 8, 16, 18, 24 …), the chip, the model id. `exec` is injectable for tests. */
export function detectMac({ exec = execFileSync, memBytes = null } = {}) {
  const get = (key) => { try { return String(exec('/usr/sbin/sysctl', ['-n', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { return ''; } };
  const bytes = memBytes ?? (Number(get('hw.memsize')) || totalmem());
  const brand = get('machdep.cpu.brand_string');
  return { ramGb: Math.round(bytes / 2 ** 30), memBytes: bytes, brand, model: get('hw.model'), ...parseChip(brand) };
}

/** The RAM classes with a profile. A Mac gets the largest class at or under its RAM (18 → 16, 36 → 32, 96 → 64). */
export const CLASSES = Object.freeze([8, 16, 24, 32, 48, 64]);
/** Pure: the profile class for a RAM size in GiB (anything under 8 is treated as 8, with a warning in the profile). */
export const classFor = (ramGb) => [...CLASSES].reverse().find((c) => Number(ramGb) >= c - 0.5) ?? 8;

const ABL = 'huihui_ai/qwen3-abliterated';
/** The 8 GB pick (measured, catalog/bench/m5-pro-24gb-as-8gb.json): IBM Granite 4.1 3B, abliterated (huihui-ai's build,
 *  mradermacher's i1-Q4_K_M GGUF via Hugging Face). Holds 2.5 GB at 4k, 16/18 tool cases two-step, 11/12 routes, 3/3
 *  writing; Apache-2.0. */
export const GRANITE_8GB = 'hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M';
/** The 24 GB reasoner (measured): Qwen3.8-9B heretic, the owner's Hugging Bay "everyday writer" pick (the same file,
 *  SHA-256 c951f9e4…). 17/18 tool cases two-step, 12/12 routes, 3/3 writing, holds 6.4 GB at 16k. */
export const QWEN38_9B = 'hf.co/mradermacher/Qwen3.8-9B-heretic-uncensored-i1-GGUF:i1-Q4_K_M';
/** 32 GB and up (measured on the M5 Pro as the same files, SHA-256 checked against these Hugging Face builds):
 *  Qwen3.6-27B heretic, 17/18 tools, 12/12 routes, 3/3 writing, holds 14.8 GB at 16k, 12 tok/s on the M5 Pro;
 *  Qwen3-Coder-30B-A3B heretic, 16/18 tools, 86 tok/s, holds 5.2 GB (its experts page in; swap grew 418 MB on 24 GB). */
/** The 24 GB reasoner from round 2 (measured twice; the first run overlapped heavy downloads and swapped): Gemma 4 12B
 *  uncensored (TrevorJS, Apache-2.0). 18/18 tool cases two-step, 12/12 routes, 3/3 writing, holds 8.4 GB at 16k, 33 tok/s;
 *  it replaces Qwen3.8-9B heretic (17/18, holds 10.4 GB, and no licence on its card, so the library can't carry it). */
export const GEMMA4_12B = 'hf.co/TrevorJS/gemma-4-12B-it-uncensored-GGUF:Q4_K_M';
export const QWEN36_27B = 'hf.co/mradermacher/Qwen3.6-27B-heretic-i1-GGUF:i1-IQ4_XS';
export const QWEN3_CODER_30B = 'hf.co/mradermacher/Qwen3-Coder-30B-A3B-Instruct-Heretic-i1-GGUF:i1-IQ3_M';
/**
 * The profiles. Each role is one Ollama tag (or a Hugging Bay GGUF imported as local/…). maxResidentGb is the most
 * Kingmaker lets one model hold (weights + context, measured as the runner's peak RSS); context is num_ctx sent with
 * every request; concurrent is how many models may stay loaded together; voice 'off' means text only by default
 * (Customize → Voice can still turn it on); imageLane is the local picture engine.
 */
export const PROFILES = Object.freeze({
  8: Object.freeze({
    class: 8, label: '8 GB standard (M1/M2/M3 base)',
    // One model does the routing, the tool picks, the writing and the reasoning: with one model loaded at a time, a
    // separate router would be unloaded and reloaded on every turn (measured 1–5 s per switch on the real 8 GB M3).
    router: GRANITE_8GB, writer: GRANITE_8GB, coder: 'huihui_ai/qwen2.5-coder-abliterate:1.5b', vision: 'huihui_ai/qwen3.5-abliterated:2b', reasoning: GRANITE_8GB,
    maxResidentGb: 3.3, context: 4096, concurrent: 1, voice: 'off', imageLane: false,
    basis: 'measured: 8 GB simulation on an M5 Pro (4.8 GiB GPU budget, as the real M3 reports) + the 2026-10-09 real 8 GB M3 run; the real 8 GB M3 bench is pending',
    notes: 'One model loaded at a time. Text only by default (whisper, the wake word and Kokoro would take ~1 GB the model needs). Every 4B tried holds 3.6–5.3 GB at 4k and is over the budget.',
  }),
  16: Object.freeze({
    class: 16, label: '16 GB (and 18 GB M3 Pro)',
    router: `${ABL}:1.7b`, writer: `${ABL}:8b`, coder: 'huihui_ai/qwen2.5-coder-abliterate:7b', vision: 'huihui_ai/qwen3.5-abliterated:4b', reasoning: `${ABL}:8b`,
    maxResidentGb: 7.5, context: 8192, concurrent: 2, voice: 'on', imageLane: false,
    basis: 'measured on the M5 Pro 24 GB (each model\'s footprint at 16k, larger than at the 8k this profile uses); not run on a 16 GB Mac',
    notes: 'The router stays warm beside one big model (8b ~7.3 GB + 1.7b ~1.8 GB). The writer also reasons, so a third model never loads. Pictures off: the image engine wants ~7.5 GB free on top of macOS and voice.',
  }),
  24: Object.freeze({
    class: 24, label: '24 GB (M2/M3/M4/M5, M4/M5 Pro)',
    router: `${ABL}:1.7b`, writer: `${ABL}:8b`, coder: 'huihui_ai/qwen2.5-coder-abliterate:7b', vision: 'huihui_ai/qwen3.5-abliterated:4b', reasoning: GEMMA4_12B,
    // The whole-stack soak (2026-10-15: the engine, voice, router, writer, a picture render) fell to 8% free memory with
    // 11 GB per model and a 16k context: the budget is now 8.5 GB per model, 8k context, the router plus one worker.
    maxResidentGb: 8.5, context: 8192, concurrent: 2, voice: 'on', imageLane: true,
    basis: 'measured on the M5 Pro 24 GB (catalog/bench/m5-pro-24gb.json), budget set from the whole-stack soak',
    notes: 'Every feature on, all day: voice (Kokoro + mic), pictures, the ad pipeline. One small router stays warm and one worker is swapped in per role (~9 GB together); the image engine unloads the models before it draws. Measured and left out: DeepSeek-R1 (28% tools, 0% routing; the 14b holds 11.6 GB). From the per-engine blueprint the owner forwarded: kept, governance and audit as code (the gates and ledger) and one request at a time; replaced, gemma2/phi4/granite-code with today\'s measured models; rejected, four models resident at once (one router plus one swapped worker leaves room for voice and pictures).',
  }),
  32: Object.freeze({
    class: 32, label: '32 GB (and 36 GB M3 Pro / M4 Max / M5 Max)',
    router: `${ABL}:1.7b`, writer: QWEN38_9B, coder: QWEN3_CODER_30B, vision: 'huihui_ai/qwen3.5-abliterated:4b', reasoning: QWEN36_27B,
    maxResidentGb: 18, context: 32768, concurrent: 3, voice: 'on', imageLane: true,
    basis: 'estimate: models measured on the 24 GB M5 Pro, sized by their measured footprint; not run on a 32 GB Mac',
    notes: 'The 9B heretic writes (94% tools, 100% routing and writing); the 27B reasons when asked (12 tok/s on an M5 Pro, faster on a Max). The 30B-A3B coder is fast (86 tok/s) because only 3B are active.',
  }),
  48: Object.freeze({
    class: 48, label: '48 GB (M3 Max, M4 Pro/Max, M5 Pro/Max)',
    router: `${ABL}:1.7b`, writer: QWEN36_27B, coder: QWEN3_CODER_30B, vision: 'huihui_ai/qwen3.5-abliterated:4b', reasoning: QWEN36_27B,
    maxResidentGb: 26, context: 32768, concurrent: 3, voice: 'on', imageLane: true,
    basis: 'estimate: models measured on the 24 GB M5 Pro, sized by their measured footprint; not run on a 48 GB Mac',
    notes: 'The 27B heretic writes and reasons; the coder stays loaded beside it.',
  }),
  64: Object.freeze({
    class: 64, label: '64 GB and up (Max, Ultra, Studio)',
    router: `${ABL}:1.7b`, writer: QWEN36_27B, coder: QWEN3_CODER_30B, vision: 'gemma4:e4b', reasoning: QWEN36_27B,
    maxResidentGb: 40, context: 65536, concurrent: 4, voice: 'on', imageLane: true,
    basis: 'estimate: models measured on the 24 GB M5 Pro, sized by their measured footprint; not run on a 64 GB Mac',
    notes: 'Everything stays loaded. Vision is the stock Gemma 4 E4B, the best vision model measured (94% tools, 100% routing and writing; no abliterated build with vision exists yet).',
  }),
});
export const ROLES = Object.freeze(['router', 'writer', 'coder', 'vision', 'reasoning']);

/** Measured generation speed of the writer on the reference Mac (tok/s, from catalog/bench), for the estimate below. */
const REFERENCE = Object.freeze({ chip: 'M5 Pro', bandwidth: CHIP_BANDWIDTH['M5 Pro'] });

/** Pure: the override the owner set in Customize ('auto' or a class as a string), validated. */
export function normalizeOverride(v) {
  const s = String(v ?? 'auto').trim().toLowerCase();
  return CLASSES.map(String).includes(s) ? s : 'auto';
}

/**
 * Pure: the profile for a Mac. `override` is Customize → Mac profile ('auto' or a class). An override above the
 * Mac's own class is allowed (the owner's call) but flagged, since it can swap. `measured` is { model: genTokS } on the
 * reference Mac, used to estimate this Mac's writer speed.
 */
export function profileFor(mac, { override = 'auto', measured = {} } = {}) {
  const own = classFor(mac?.ramGb ?? 8);
  const o = normalizeOverride(override);
  const cls = o === 'auto' ? own : Number(o);
  const p = PROFILES[cls];
  const ratio = mac?.bandwidth && REFERENCE.bandwidth ? mac.bandwidth / REFERENCE.bandwidth : null;
  const ref = measured[p.writer];
  return {
    ...p, id: String(cls), ownClass: own, override: o, overridden: o !== 'auto',
    aboveThisMac: cls > own,
    underMinimum: (mac?.ramGb ?? 8) < 7.5,
    mac: mac ? { chip: mac.chip, ramGb: mac.ramGb, model: mac.model } : null,
    writerTokSEstimate: ref && ratio ? Math.round(ref * ratio) : null,
  };
}

/** Pure: a short line for Customize and `kingmaker models profile`. */
export function profileLine(p) {
  const voice = p.voice === 'off' ? 'text only' : 'voice on';
  const pick = (m) => (m === 'PENDING' ? '—' : m.replace(/^huihui_ai\//, '').replace(/^hf\.co\//, ''));
  return `${p.label}${p.overridden ? ' (your choice)' : ' (detected)'}: writer ${pick(p.writer)}, router ${pick(p.router)}, coder ${pick(p.coder)}, vision ${pick(p.vision)}, reasoning ${pick(p.reasoning)}; up to ${p.maxResidentGb} GB per model, ${p.concurrent} at once, ${p.context / 1024}k context, ${voice}, pictures ${p.imageLane ? 'on' : 'off'}.`
    + (p.aboveThisMac ? ` This is above this Mac's ${p.ownClass} GB class: it may swap.` : '')
    + (p.underMinimum ? ' This Mac has under 8 GB: Kingmaker needs at least 8.' : '');
}

/** Pure: the model a role should use, given what is installed: the profile's pick, else the same family's smaller
 *  pick from the classes below, else null (the caller keeps its own default). */
export function roleModel(p, role, installed = []) {
  const have = new Set((installed ?? []).map(String));
  for (const c of [...CLASSES].reverse().filter((c) => c <= p.class)) {
    const m = PROFILES[c][role];
    if (m && m !== 'PENDING' && have.has(m)) return m;
  }
  return null;
}

// ── The owner's override: Customize → Mac profile, kept in calibration.json (lib/calibration.mjs, macProfile.profile).
// Read and written here as plain JSON so this module never imports calibration.mjs (which imports fast-route.mjs,
// which imports this). `kingmaker models profile <class>` writes the same key.
const CAL_FILE = 'calibration.json';
export function readProfileOverride(stateDir) {
  try { return normalizeOverride(JSON.parse(readFileSync(join(stateDir, CAL_FILE), 'utf8'))?.macProfile?.profile); } catch { return 'auto'; }
}
export function writeProfileOverride(stateDir, override) {
  const v = normalizeOverride(override);
  const path = join(stateDir, CAL_FILE), temp = `${path}.${process.pid}.tmp`;
  let cal = {}; try { cal = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { /* a first calibration */ }
  writeFileSync(temp, `${JSON.stringify({ ...cal, schema: cal.schema ?? 1, macProfile: { ...(cal.macProfile ?? {}), profile: v } }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); renameSync(temp, path);
  return v;
}

/** A role's model for this Mac's class by RAM alone (sync, no Ollama call), or null. The write lane and the router use
 *  it as their default when nothing is pinned or calibrated. */
export function classRole(role, memBytes = totalmem()) {
  const m = PROFILES[classFor(memBytes / 2 ** 30)][role];
  return m && m !== 'PENDING' ? m : null;
}
/** A profile number for this Mac's class by RAM alone (context, maxResidentGb, concurrent …). */
export const classSetting = (key, memBytes = totalmem()) => PROFILES[classFor(memBytes / 2 ** 30)][key];
/** The writer for this Mac's class: WRITER_MODEL on 16 GB and up, the measured 8 GB writer on an 8 GB Mac. */
export const classWriter = (memBytes = totalmem()) => classRole('writer', memBytes);

/** The measured writer speeds from this checkout's reference bench file ({ model: genTokS }), {} when absent. */
export function referenceSpeeds(file = new URL('../catalog/bench/m5-pro-24gb.json', import.meta.url)) {
  try { return Object.fromEntries((JSON.parse(readFileSync(file, 'utf8')).results ?? []).filter((r) => r.speed?.genTokS).map((r) => [r.model, r.speed.genTokS])); } catch { return {}; }
}

/** This Mac's profile, the owner's override applied. */
export function currentProfile(stateDir, { mac = detectMac() } = {}) {
  return profileFor(mac, { override: stateDir ? readProfileOverride(stateDir) : 'auto', measured: referenceSpeeds() });
}

// ── What `kingmaker models bench` measures by default (gb = download size, checked against free disk before a pull) ──
const c = (tag, gb, role, source) => Object.freeze({ tag, gb, role, source });
const GGUF = (file) => `local/${file.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
export const BENCH_SETS = Object.freeze({
  // Every 8 GB candidate checked on the M5 Pro (the 8 GB simulation): Gemini's list where it exists, its abliterated
  // builds where Hugging Bay / Hugging Face have them, and the Qwen3 routers.
  '8-wide': Object.freeze([
    c(`${ABL}:0.6b`, 0.4, 'router', 'ollama'), c(`${ABL}:1.7b`, 1.1, 'router', 'ollama'), c('huihui_ai/qwen3.5-abliterated:0.8b', 1.0, 'router', 'ollama'),
    c('qwen3.5:4b', 3.3, 'writer', 'ollama (stock, vision)'), c('huihui_ai/qwen3.5-abliterated:4b', 3.3, 'writer', 'ollama'),
    c(GGUF('Qwen3.5-4B-heretic.i1-Q4_K_M.gguf'), 2.7, 'writer', 'hugging bay: mradermacher/Qwen3.5-4B-heretic-i1-GGUF'),
    c('granite4.1:3b', 2.1, 'writer', 'ollama (stock)'), c('hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M', 2.1, 'writer', 'hugging face / hugging bay'),
    c('ministral-3:3b', 3.0, 'writer', 'ollama (stock)'), c('hf.co/Abiray/Huihui-Ministral-3B-Instruct-2512-abliterated-GGUF:Q4_K_M', 2.2, 'writer', 'hugging face'),
    c('gemma3:4b', 3.4, 'vision', 'ollama (stock, vision)'), c('gemma4:e2b', 4.6, 'vision', 'ollama (stock, vision)'),
    c(`${ABL}:4b`, 2.5, 'writer', 'ollama'), c('huihui_ai/llama3.2-abliterate:3b', 2.2, 'writer', 'ollama'),
    c('huihui_ai/qwen2.5-coder-abliterate:1.5b', 1.1, 'coder', 'ollama'), c('huihui_ai/qwen3.5-abliterated:2b', 2.0, 'vision', 'ollama'),
  ]),
  // The small set the real 8 GB Mac runs by default (`kingmaker models bench --pull`): the simulation's best, ~10 GB.
  8: Object.freeze([
    c(GRANITE_8GB, 2.1, 'writer', 'hugging face (abliterated)'), c('granite4.1:3b', 2.1, 'writer', 'ollama (stock)'),
    c(`${ABL}:1.7b`, 1.1, 'router', 'ollama'), c(`${ABL}:0.6b`, 0.4, 'router', 'ollama'),
    c('huihui_ai/qwen3.5-abliterated:2b', 2.0, 'vision', 'ollama'), c('huihui_ai/qwen2.5-coder-abliterate:1.5b', 1.1, 'coder', 'ollama'),
  ]),
  24: Object.freeze([
    c(`${ABL}:1.7b`, 1.1, 'router', 'ollama'), c(`${ABL}:8b`, 5.0, 'writer', 'ollama'), c('huihui_ai/qwen3.5-abliterated:9b', 6.6, 'writer', 'ollama'),
    c(GGUF('Qwen3.8-9B-heretic-uncensored.i1-Q4_K_M.gguf'), 5.6, 'writer', 'hugging bay pick: everyday writer'),
    c(GEMMA4_12B, 7.4, 'reasoning', 'hugging face (TrevorJS, Apache-2.0)'), c(QWEN38_9B, 5.6, 'reasoning', 'hugging face (same file as the hugging bay pick)'), c('huihui_ai/qwen3.5-abliterated:4b', 3.3, 'vision', 'ollama'),
    c('huihui_ai/qwen2.5-coder-abliterate:7b', 4.7, 'coder', 'ollama'), c('huihui_ai/deepseek-r1-abliterated:8b', 5.0, 'reasoning', 'ollama'), c('huihui_ai/deepseek-r1-abliterated:14b', 9.0, 'reasoning', 'ollama'),
    c('gemma4:e4b', 6.6, 'vision', 'ollama (stock, vision)'), c(GGUF('gemma-4-E4B-it-ultra-uncensored-heretic-Q4_K_M.gguf'), 4.9, 'vision', 'hugging bay pick: small multimodal'),
    c(GGUF('Qwen3-Coder-30B-A3B-Instruct-Heretic.i1-IQ3_M.gguf'), 13.5, 'coder', 'hugging bay pick: coder (fast MoE)'),
    c(GGUF('Qwen3.6-27B-heretic.i1-IQ4_XS.gguf'), 15.1, 'writer', 'hugging bay pick: coding alternate'),
    c(GGUF('RVN-IQ4_XS-mtp.gguf'), 15.6, 'writer', 'hugging bay pick: best overall (Qwen3.8-27B heretic)'),
    c(GGUF('gemma-4-31B-it-heretic.i1-IQ3_M.gguf'), 14.4, 'vision', 'hugging bay pick: big multimodal'),
  ]),
});

// ── Packs: each profile as an install pack (the installer's launcher shows them like a game's packs, this Mac's
// recommended one selected; `kingmaker models setup --pack <class>` installs one from the command line). ──
/** Download sizes (GB, the Ollama registry / Hugging Face file) of every model a pack can name. */
export const MODEL_GB = Object.freeze({
  ...Object.fromEntries(Object.values(BENCH_SETS).flat().map((m) => [m.tag, m.gb])),
  'huihui_ai/qwen3.5-abliterated:2b': 2.0, 'huihui_ai/qwen2.5-coder-abliterate:7b': 4.7, 'huihui_ai/deepseek-r1-abliterated:14b': 9.0,
  'huihui_ai/qwen3.5-abliterated:4b': 3.3, [QWEN38_9B]: 5.6, [GEMMA4_12B]: 7.4, [QWEN36_27B]: 15.1, [QWEN3_CODER_30B]: 13.5, 'gemma4:e4b': 6.6,
});
const PACK_NAMES = Object.freeze({ 8: 'Lean', 16: 'Standard', 24: 'Full', 32: 'Pro', 48: 'Studio', 64: 'Max' });

/** Pure: one profile as a pack: its models (each with the roles it fills and its size), the download, the features. */
export function packFor(cls) {
  const p = PROFILES[cls];
  const byTag = new Map();
  for (const role of ROLES) { const tag = p[role]; if (!tag || tag === 'PENDING') continue; if (!byTag.has(tag)) byTag.set(tag, { tag, roles: [], gb: MODEL_GB[tag] ?? null }); byTag.get(tag).roles.push(role); }
  const models = [...byTag.values()];
  return {
    id: String(cls), name: `${cls} GB · ${PACK_NAMES[cls]}`, label: p.label, models,
    downloadGb: +models.reduce((a, m) => a + (m.gb ?? 0), 0).toFixed(1),
    features: { voice: p.voice === 'on', pictures: p.imageLane, concurrent: p.concurrent, contextK: p.context / 1024, maxResidentGb: p.maxResidentGb },
    basis: p.basis,
  };
}
export const PACKS = Object.freeze(CLASSES.map((c) => Object.freeze(packFor(c))));
/** Pure: the pack this Mac should take (its own class). */
export const recommendedPack = (ramGb) => String(classFor(ramGb));
