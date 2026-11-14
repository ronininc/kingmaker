// lib/mac-profiles.mjs — this Mac's measured facts, the model tables, and the starter floor.
//
// DOCTRINE (owner, 2026-11-14): "The architectural intent is smallest base required model for each
// task over a metered connection. It is not 'ooh, that doesn't load on this device.'" Per task the
// router selects the SMALLEST BASE MODEL the task requires (lib/execution-loop.mjs
// pickSmallestSufficient), delivered over a metered connection — 1 MiB pin-verified portions via
// lib/brain-library-access.mjs. Capability is task-driven; device RAM tier gates NOTHING.
//
// What this module is, after the metered-doctrine rework: MEASUREMENT and TABLES only.
//   • detectMac / parseChip — what this machine is (chip, RAM, memory bandwidth). Facts, used for
//     delivery planning (resident vs metered-stream) and honest reporting — never as a gate.
//   • MODEL_GB / BENCH_SETS / referenceSpeeds — the measured numbers the picks stand on. A size or
//     speed is never invented here: bench-measured (catalog/bench), the maker's figure, or the
//     Ollama library's own listing, each noted where it is used.
//   • FLOOR_ROLES / floorRole — the starter floor: the smallest bench-validated model per role,
//     IDENTICAL ON EVERY DEVICE. It is what a fresh install carries and what the pre-pick defaults
//     (fast route, reflex seat, metrics) fall back to. It is a floor, not a ceiling: any task whose
//     requirement exceeds the floor gets a bigger model picked for that task and metered in.
//
// What this module no longer holds: the class table (CLASSES / PROFILES / PACKS and everything
// derived from them). A Mac's RAM used to choose its models at install time and cap them at
// runtime; that machinery is retired end to end — installer, manifest, calibration, catalog,
// governor — because it contradicted the doctrine above: it refused by tier what the metered
// connection exists to deliver.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

/** Memory bandwidth (GB/s) by chip — the number that sets local generation speed. Apple's published
 *  figures; M5 from Apple's October 2025 announcements (base M5 153, Pro 307, Max 460/614 by core
 *  count — the plain figure is used, the scheduler measures the truth anyway). */
export const CHIP_BANDWIDTH = Object.freeze({
  'M1': 68, 'M1 Pro': 200, 'M1 Max': 400, 'M1 Ultra': 800,
  'M2': 100, 'M2 Pro': 200, 'M2 Max': 400, 'M2 Ultra': 800,
  'M3': 100, 'M3 Pro': 150, 'M3 Max': 400, 'M3 Ultra': 819,
  'M4': 120, 'M4 Pro': 273, 'M4 Max': 546,
  'M5': 153, 'M5 Pro': 307, 'M5 Max': 614,
});

/** "Apple M3 Pro" → { chip: 'M3 Pro', gen: 3, tier: 'Pro', bandwidth }. Unrecognised → nulls. */
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

// ── The models (tags are exact Ollama names) ──
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

export const ROLES = Object.freeze(['router', 'writer', 'coder', 'vision', 'reasoning']);

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

/** Download sizes (GB, the Ollama registry / Hugging Face file) of every tabled model. */
export const MODEL_GB = Object.freeze({
  ...Object.fromEntries(Object.values(BENCH_SETS).flat().map((m) => [m.tag, m.gb])),
  'huihui_ai/qwen3.5-abliterated:2b': 2.0, 'huihui_ai/qwen2.5-coder-abliterate:7b': 4.7, 'huihui_ai/deepseek-r1-abliterated:14b': 9.0,
  'huihui_ai/qwen3.5-abliterated:4b': 3.3, [QWEN38_9B]: 5.6, [GEMMA4_12B]: 7.4, [QWEN36_27B]: 15.1, [QWEN3_CODER_30B]: 13.5, 'gemma4:e4b': 6.6,
});

// ── The starter floor ─────────────────────────────────────────────────────────────────────────────
// The smallest bench-validated model per role, identical on every device. Writer and reasoning are
// the 8 GB profile's picks (the abliterated Granite 4.1 3B: the set measured on the weakest
// hardware Kingmaker runs on, so the floor suffices everywhere by construction). The router is the
// smallest model tabled FOR the router role (the 1.7b — every larger profile's router pick too);
// the 8 GB profile routed through the granite only because one-model-at-a-time co-residency made a
// separate router thrash there, a residency fact the metered delivery plan now handles per task.
// The floor is what a fresh install carries and the fallback wherever a default is needed before
// a per-task pick exists. It never caps anything: the selector picks per task.
export const FLOOR_ROLES = Object.freeze({
  router: 'huihui_ai/qwen3-abliterated:1.7b',
  writer: GRANITE_8GB,
  coder: 'huihui_ai/qwen2.5-coder-abliterate:1.5b',
  vision: 'huihui_ai/qwen3.5-abliterated:2b',
  reasoning: GRANITE_8GB,
});

/** The floor's pick for one role (null for an unknown role). */
export const floorRole = (role) => FLOOR_ROLES[role] ?? null;

/** Every model the floor names, once each, in role order. */
export const FLOOR_MODELS = Object.freeze([...new Set(ROLES.map((r) => FLOOR_ROLES[r]))]);

/** Every model tag this module tables (bench candidates ∪ floor picks) — the catalog's seed list. */
export const knownModelTags = () => [...new Set([...Object.values(BENCH_SETS).flat().map((m) => m.tag), ...FLOOR_MODELS])];

/** One line for status surfaces: this Mac's facts + the floor it starts from. Information, not a gate. */
export function floorLine(mac = detectMac()) {
  const roles = ROLES.map((r) => `${r} ${FLOOR_ROLES[r]}`).join(' · ');
  return `${mac.chip ?? 'This Mac'} · ${mac.ramGb} GB — starter floor (the same on every Mac): ${roles}. Bigger work is picked per task and metered in.`;
}
