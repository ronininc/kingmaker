// The local lane's model catalog: models that make Kingmaker worth talking to on an Apple-silicon Mac with 8 GB or more,
// stock and abliterated (refusals removed). All are Ollama tags (`ollama pull <tag>`); abliterated ones are the
// community builds on Ollama's registry, mirrored from Hugging Face. Sizes are the Q4 download, roughly what it holds
// in memory. minGb is the smallest Mac it runs on next to the engine (8 GB leaves ~5 GB for a model, 16 GB ~11 GB).
//
// The owner picks one (`kingmaker models use <id>`); it answers chat, decisions, planning and drafts (BRAIN_ROLES).
// The tags were taken from the registry listings, not pulled here: `kingmaker models pull <id>` is the check, and a
// tag that is gone says so then. Licences are the model maker's; read them before commercial use.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const m = (id, tag, family, gb, minGb, abliterated, note) => Object.freeze({ id, tag, family, gb, minGb, abliterated, note });

export const MODEL_CATALOG = Object.freeze([
  // ── 8 GB Macs ──
  m('qwen3-4b', 'qwen3:4b', 'Qwen3', 2.5, 8, false, 'Best all-rounder at 8 GB; thinks before it answers.'),
  m('qwen3-4b-abl', 'huihui_ai/qwen3-abliterated:4b', 'Qwen3', 2.5, 8, true, 'Qwen3 4B, refusals removed.'),
  m('gemma3-4b', 'gemma3:4b', 'Gemma 3', 3.3, 8, false, 'Strong writing, sees images.'),
  m('gemma3-4b-abl', 'huihui_ai/gemma3-abliterated:4b', 'Gemma 3', 3.3, 8, true, 'Gemma 3 4B, refusals removed.'),
  m('llama3.2-3b', 'llama3.2:3b', 'Llama 3.2', 2.0, 8, false, 'Fast, light, good at following steps.'),
  m('llama3.2-3b-abl', 'huihui_ai/llama3.2-abliterate:3b', 'Llama 3.2', 2.0, 8, true, 'Llama 3.2 3B, refusals removed.'),
  m('phi4-mini', 'phi4-mini:3.8b', 'Phi-4', 2.5, 8, false, 'Good reasoning and math for its size.'),
  m('qwen3-8b', 'qwen3:8b', 'Qwen3', 5.2, 8, false, 'Fits 8 GB only with little else open; much smarter.'),
  m('qwen3-8b-abl', 'huihui_ai/qwen3-abliterated:8b', 'Qwen3', 5.2, 8, true, 'Qwen3 8B, refusals removed (Kingmaker\'s 16 GB default).'),
  m('llama3.1-8b', 'llama3.1:8b', 'Llama 3.1', 4.9, 8, false, 'Solid general chat and tool use.'),
  m('llama3.1-8b-abl', 'mannix/llama3.1-8b-abliterated', 'Llama 3.1', 4.9, 8, true, 'Llama 3.1 8B, refusals removed.'),
  m('mistral-7b', 'mistral:7b', 'Mistral', 4.1, 8, false, 'Plain, quick, few refusals already.'),
  m('dolphin3-8b', 'dolphin3:8b', 'Dolphin 3 (Llama 3.1)', 4.9, 8, true, 'Uncensored fine-tune, good at agent tasks.'),
  m('deepseek-r1-8b', 'deepseek-r1:8b', 'DeepSeek-R1', 5.2, 8, false, 'Reasoner; slow to answer, careful.'),
  m('deepseek-r1-8b-abl', 'huihui_ai/deepseek-r1-abliterated:8b', 'DeepSeek-R1', 5.2, 8, true, 'DeepSeek-R1 8B, refusals removed.'),
  // ── 16 GB Macs ──
  m('gemma3-12b', 'gemma3:12b', 'Gemma 3', 8.1, 16, false, 'Big step up in writing and judgment.'),
  m('gemma3-12b-abl', 'huihui_ai/gemma3-abliterated:12b', 'Gemma 3', 8.1, 16, true, 'Gemma 3 12B, refusals removed.'),
  m('qwen3-14b', 'qwen3:14b', 'Qwen3', 9.3, 16, false, 'Strongest at 16 GB for planning and tools.'),
  m('qwen3-14b-abl', 'huihui_ai/qwen3-abliterated:14b', 'Qwen3', 9.3, 16, true, 'Qwen3 14B, refusals removed.'),
  m('phi4-14b', 'phi4:14b', 'Phi-4', 9.1, 16, false, 'Reasoning-heavy, terse.'),
  m('deepseek-r1-14b', 'deepseek-r1:14b', 'DeepSeek-R1', 9.0, 16, false, 'Reasoner, 14B.'),
  m('deepseek-r1-14b-abl', 'huihui_ai/deepseek-r1-abliterated:14b', 'DeepSeek-R1', 9.0, 16, true, 'DeepSeek-R1 14B, refusals removed.'),
  m('mistral-nemo-12b', 'mistral-nemo:12b', 'Mistral NeMo', 7.1, 16, false, 'Long context (128k), multilingual.'),
  // ── 24 GB+ Macs ──
  m('gpt-oss-20b', 'gpt-oss:20b', 'gpt-oss (OpenAI)', 14, 24, false, 'OpenAI\'s open model; strong tools and reasoning.'),
  m('mistral-small-24b', 'mistral-small:24b', 'Mistral Small', 14, 24, false, 'Fast, capable, Apache-2.0.'),
  m('gemma3-27b', 'gemma3:27b', 'Gemma 3', 17, 32, false, 'Near frontier for writing at home.'),
  m('gemma3-27b-abl', 'huihui_ai/gemma3-abliterated:27b', 'Gemma 3', 17, 32, true, 'Gemma 3 27B, refusals removed.'),
  m('qwen3-30b-a3b', 'qwen3:30b', 'Qwen3 MoE', 19, 32, false, 'Mixture of experts: big-model smarts, small-model speed.'),
  m('qwen3-32b', 'qwen3:32b', 'Qwen3', 20, 32, false, 'Strongest Qwen3 dense model that fits a 32 GB Mac.'),
]);

/** Pure: the catalog entry for an id or tag. */
export const findModel = (idOrTag) => MODEL_CATALOG.find((x) => x.id === idOrTag || x.tag === idOrTag) ?? null;

/** Pure: what fits this Mac, optionally only abliterated / only stock. */
export function modelsFor(memGb, { abliterated = null } = {}) {
  return MODEL_CATALOG.filter((x) => x.minGb <= Math.max(8, Math.round(memGb)) && (abliterated === null || x.abliterated === abliterated));
}

/** Pure: one listing line. */
export function modelLine(x, installed = new Set(), chosen = '') {
  const mark = x.tag === chosen ? '▶' : installed.has(x.tag) ? '✓' : ' ';
  return `${mark} ${x.id.padEnd(20)} ${(x.abliterated ? 'abliterated' : 'stock').padEnd(11)} ${String(x.gb).padStart(4)} GB  ${x.minGb}GB+  ${x.note}`;
}

const choiceFile = (paths) => join(paths.state, 'local-model.txt');
export function readModelChoice(paths) { try { return readFileSync(choiceFile(paths), 'utf8').trim(); } catch { return ''; } }
export function saveModelChoice(paths, tag) { mkdirSync(paths.state, { recursive: true }); writeFileSync(choiceFile(paths), `${tag}\n`); }

/** Pure: the env pins for the chosen model, only when it is installed and the operator set no pins of their own. */
export function chosenModelEnv(tag, installed = [], env = process.env, roles = []) {
  if (!tag || !installed.map(String).includes(tag)) return {};
  return Object.fromEntries(roles.filter((r) => !String(env[r] ?? '').trim()).map((r) => [r, tag]));
}

// ── The owner's own library on a drive (models downloaded from huggingbay.xyz, Hugging Face, anywhere) ──
// `kingmaker models dir /Volumes/<SSD>/models` remembers the folder; every .gguf under it (two levels deep) is listed
// beside the catalog, and `kingmaker models use <file id>` loads it into Ollama with `ollama create` (FROM the file).
// That copies the weights into Ollama's store; set OLLAMA_MODELS to a folder on the SSD to keep that copy off the Mac.

const dirFile = (paths) => join(paths.state, 'models-dir.txt');
export function readModelsDir(paths) { try { return readFileSync(dirFile(paths), 'utf8').trim(); } catch { return ''; } }
export function saveModelsDir(paths, dir) { mkdirSync(paths.state, { recursive: true }); writeFileSync(dirFile(paths), `${dir}\n`); }

/** Pure: an Ollama-safe name for a GGUF file ("Qwen3-8B-abliterated.Q4_K_M.gguf" → "local/qwen3-8b-abliterated.q4_k_m"). */
export function ggufName(file) {
  return `local/${basename(file).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Pure: is a file name abliterated / uncensored by its own words. */
export const looksAbliterated = (name) => /abliterat|uncensor|dolphin|heretic|norefus/i.test(name);

/** The .gguf files under a folder (two levels), as catalog-shaped entries. Split shards (-00002-of-) are skipped. */
export function scanGguf(dir, { readdir = readdirSync, stat = statSync } = {}) {
  const out = [];
  const walk = (d, depth) => {
    let names = [];
    try { names = readdir(d); } catch { return; }
    for (const name of names) {
      const full = join(d, name);
      let st; try { st = stat(full); } catch { continue; }
      if (st.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (/\.gguf$/i.test(name) && !/-0000[2-9]-of-/i.test(name) && !/mmproj/i.test(name)) {
        const gb = Math.round((st.size / 2 ** 30) * 10) / 10;
        out.push({ id: ggufName(name).slice(6), tag: ggufName(name), file: full, family: 'your drive', gb, minGb: gb <= 5.5 ? 8 : gb <= 11 ? 16 : gb <= 15 ? 24 : 32, abliterated: looksAbliterated(name), note: full });
      }
    }
  };
  if (dir) walk(dir, 0);
  return out.sort((a, b) => a.gb - b.gb);
}
