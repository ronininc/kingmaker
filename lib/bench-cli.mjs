// lib/bench-cli.mjs — `kingmaker models bench` and `kingmaker models profile` (hooked from lib/cli.mjs cmdModels).
//   models profile                           this Mac beside the starter floor (the smallest sufficient model per role)
//   models packs                             retired with the packs: prints the floor, like models profile
//   models setup [--dry-run]                 install the starter floor: its models, disk checked first
//   models bench [--as 8] [--set 8|8-wide|24|all] [--models a,b] [--pull] [--context N] [--cooldown S] [--out DIR]
// One model at a time with a cool-down between (30 s by default), longer while `pmset -g therm` reports a warning.
// The default set is the candidate list named '8' (lib/mac-profiles.mjs BENCH_SETS). --pull downloads the ones
// that are missing, through Ollama's own API, and only while the disk keeps BENCH_DISK_MARGIN_GB free after each one.
// Results go to catalog/bench/ in a checkout, or to the Desktop when Kingmaker runs from its app (never into the
// signed bundle).

import { existsSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_SETS, detectMac, FLOOR_MODELS, FLOOR_ROLES, floorLine, MODEL_GB } from './mac-profiles.mjs';
import { hasModel, runBench, verdict } from './model-bench.mjs';
import { kingmakerHome } from './kingmaker-home.mjs';
import { fetchJson } from './http-json.mjs';

export const BENCH_DISK_MARGIN_GB = 5;
const BASE = () => (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** Pure: where results go: the checkout's catalog/bench, or Bench in Kingmaker's one folder (lib/kingmaker-home.mjs)
 *  when this file is inside an .app bundle. Never the Desktop (the owner, 2026-10-15: no Kingmaker files on it). */
export function benchOutDir(moduleUrl = import.meta.url, home = homedir(), env = process.env) {
  const here = fileURLToPath(new URL('.', moduleUrl));
  return /\.app\/Contents\//.test(here) ? join(kingmakerHome(env, home), 'Bench') : fileURLToPath(new URL('../catalog/bench/', moduleUrl));
}

/** Pure: the tags a `--set` name benches: the named candidate list (lib/mac-profiles.mjs BENCH_SETS),
 *  every candidate for 'all', [] for an unknown name. */
export function benchSet(setName) {
  const name = String(setName);
  if (name === 'all') return [...new Set(Object.values(BENCH_SETS).flat().map((m) => m.tag))];
  if (BENCH_SETS[name]) return BENCH_SETS[name].map((m) => m.tag);
  return [];
}

const freeGb = (path = homedir()) => { try { const s = statfsSync(path); return (s.bavail * s.bsize) / 1e9; } catch { return null; } };

async function installedTags() {
  try { const r = await fetchJson(`${BASE()}/api/tags`, { timeoutMs: 5000 }); return r.ok ? (r.json?.models ?? []).map((m) => m.name) : null; } catch { return null; }
}

async function pull(tag) {
  const r = await fetchJson(`${BASE()}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { model: tag, stream: false }, timeoutMs: 3_600_000 });
  return r.ok;
}

export async function cmdProfile(paths, args) {
  const [want] = args;
  if (want) console.log('Mac profiles are retired: there is no per-Mac tier to set. Every Mac runs the same starter floor; the model a task uses is picked per task — the smallest sufficient — and metered in when it is not resident.');
  const mac = detectMac();
  console.log(`This Mac: ${mac.brand || 'unknown chip'}, ${mac.ramGb} GB (${mac.model || '?'}), ${mac.bandwidth ?? '?'} GB/s.`);
  console.log(floorLine(mac));
  return 0;
}

export async function cmdBench(paths, args) {
  const asGb = flag(args, '--as') ? Number(flag(args, '--as')) : null;
  const mac = detectMac();
  const setName = flag(args, '--set') ?? '8';
  const set = flag(args, '--models') ? flag(args, '--models').split(',').map((s) => s.trim()).filter(Boolean) : benchSet(setName);
  if (!set.length) { console.error(`✗ No bench set "${setName}". Sets: ${Object.keys(BENCH_SETS).join(', ')}, all.`); return 1; }
  const have = await installedTags();
  if (!have) { console.error(`✗ Ollama isn't answering at ${BASE()}. Open Ollama (or start Kingmaker), then run this again.`); return 1; }
  const missing = set.filter((t) => !hasModel(have, t));
  if (missing.length && args.includes('--pull')) {
    const sizes = MODEL_GB;
    for (const tag of missing) {
      const free = freeGb(), need = (sizes[tag] ?? 5) + BENCH_DISK_MARGIN_GB;
      if (free != null && free < need) { console.log(`! Skipping ${tag}: ${free.toFixed(1)} GB free, it needs ~${need.toFixed(1)} GB (download + ${BENCH_DISK_MARGIN_GB} GB kept free).`); continue; }
      console.log(`↓ ${tag} (~${sizes[tag] ?? '?'} GB, ${free?.toFixed(0) ?? '?'} GB free)…`);
      if (!(await pull(tag))) console.log(`! Could not download ${tag}.`);
    }
  } else if (missing.length) console.log(`Not installed here (add --pull to download them, disk permitting): ${missing.join(', ')}`);
  const now = (await installedTags()) ?? [];
  const models = set.filter((t) => hasModel(now, t));
  if (!models.length) { console.error('✗ No candidate model is installed. Add --pull.'); return 1; }
  // A model's fit is judged against the memory of the device being simulated (or this Mac's own) —
  // the device's whole memory is the budget; there is no class table to take a smaller one from.
  const maxResidentGb = asGb ?? mac.ramGb;
  const context = Number(flag(args, '--context') ?? 4096);
  console.log(`Benchmarking ${models.length} model(s) on ${mac.brand}, ${mac.ramGb} GB${asGb ? `, as an ${asGb} GB Mac (software limits only)` : ''}; context ${context}, budget ${maxResidentGb} GB per model.`);
  if (!asGb) console.log('Close other apps for a fair run. Each model takes 1–5 minutes.');
  const { file, report } = await runBench({ models, asGb, context, maxResidentGb, cooldownS: Number(flag(args, '--cooldown') ?? 30), outDir: flag(args, '--out') ?? benchOutDir(), print: (l) => console.log(l) });
  console.log(`\nResults: ${file}`);
  const rows = report.results.map((r) => ({ r, v: verdict(r, { maxResidentGb }) })).sort((a, b) => (b.v.fits - a.v.fits) || ((b.v.tools ?? 0) - (a.v.tools ?? 0)));
  for (const { r, v } of rows) console.log(`  ${v.fits ? '✓' : '✗'} ${r.model.padEnd(60)} tools ${String(v.tools ?? '—').padStart(3)}%  route ${String(v.route ?? '—').padStart(3)}%  ${String(v.genTokS ?? '—').padStart(5)} tok/s  ${r.memory?.peakRssGb ?? '—'} GB  ${v.fits ? '' : v.why}`);
  if (!asGb && mac.ramGb <= 10) console.log('\nThis is the real 8 GB run: send the results file back so the floor is set from it.');
  return 0;
}

/** Pure: the starter floor as lines for the terminal: one line per role, its model marked installed or not. */
export function floorLines({ installed = [] } = {}) {
  return Object.entries(FLOOR_ROLES).map(([role, tag]) => `  ${role.padEnd(9)} ${installed.some((t) => t === tag || t === `${tag}:latest`) ? '✓' : '↓'} ${tag}  (${MODEL_GB[tag] ?? '?'} GB)`);
}

export async function cmdPacks() {
  const mac = detectMac(); const have = (await installedTags()) ?? [];
  console.log('Packs are retired: there is one starter floor, the same on every Mac. Install it with: kingmaker models setup');
  console.log(`This Mac: ${mac.brand || 'unknown chip'}, ${mac.ramGb} GB.`);
  for (const l of floorLines({ installed: have })) console.log(l);
  return 0;
}

/** kingmaker models setup [--dry-run]: the starter floor's models (disk checked first). The floor is the
 *  same on every Mac; anything beyond it is picked per task at runtime and metered in. */
export async function cmdSetup(paths, args) {
  const mac = detectMac();
  const have = await installedTags();
  if (!have) { console.error(`✗ Ollama isn't answering at ${BASE()}. Open Ollama (or start Kingmaker), then run this again.`); return 1; }
  console.log(`This Mac: ${mac.brand || 'unknown chip'}, ${mac.ramGb} GB. The starter floor:`);
  for (const l of floorLines({ installed: have })) console.log(l);
  const missing = FLOOR_MODELS.filter((tag) => !hasModel(have, tag));
  const needGb = missing.reduce((a, tag) => a + (MODEL_GB[tag] ?? 5), 0) + BENCH_DISK_MARGIN_GB, free = freeGb();
  if (free != null && missing.length && free < needGb) { console.error(`✗ ${free.toFixed(1)} GB free; the floor needs ~${needGb.toFixed(1)} GB (its downloads + ${BENCH_DISK_MARGIN_GB} GB kept free). Nothing was downloaded.`); return 1; }
  if (args.includes('--dry-run')) { console.log(`Dry run: would download ${missing.length} model(s), ~${(needGb - BENCH_DISK_MARGIN_GB).toFixed(1)} GB.`); return 0; }
  for (const tag of missing) {
    console.log(`↓ ${tag} (~${MODEL_GB[tag] ?? '?'} GB)…`);
    if (!(await pull(tag))) { console.error(`✗ Could not download ${tag}. Nothing else changed; run this again to resume.`); return 1; }
  }
  console.log(`✓ The starter floor is installed (${FLOOR_MODELS.length} model(s)).`);
  console.log(floorLine(mac));
  console.log('For Ollama on a small Mac, keep one model loaded and one request at a time: Kingmaker sends each request with its own context; set OLLAMA_MAX_LOADED_MODELS=1 and OLLAMA_NUM_PARALLEL=1 if you run Ollama yourself.');
  return 0;
}

// ── The Brain Library (lib/brain-library.mjs, github.com/ronininc/kingmaker-brain-library) ──
//   models library [list]          the picks for this Mac from the published library.json
//   models library pull <tag>      a pick's weights from its release: every part and the whole file SHA-256-checked,
//                                  then loaded into Ollama with the Modelfile it was measured with
//   models library submit <file> --yes   this Mac's bench result as a pull request to the library (gh, signed in)
async function libraryJson() {
  const { LIBRARY_RAW } = await import('./brain-library.mjs');
  const r = await fetchJson(`${LIBRARY_RAW}/library.json`, { timeoutMs: 20_000 });
  if (!r.ok) throw new Error(`the library answered ${r.status}`);
  return r.json;
}

export async function cmdLibrary(paths, args) {
  const [verb = 'list', arg] = args;
  const { LIBRARY_REPO } = await import('./brain-library.mjs');
  if (verb === 'list') {
    const lib = await libraryJson(); const mac = detectMac();
    const picks = new Map((lib.models ?? []).flatMap((m) => (m.picks ?? []).map((p) => [p.role, m.tag])));
    console.log(`Brain Library (${LIBRARY_REPO}), updated ${String(lib.updatedAt).slice(0, 10)}. This Mac: ${mac.chip ?? '?'} ${mac.ramGb} GB. The floor — the smallest sufficient model per role:`);
    for (const [role, tag] of Object.entries(lib.floor?.roles ?? {})) { const m = lib.models.find((x) => x.tag === tag); const better = picks.get(role); console.log(`  ${role.padEnd(9)} ${tag}${m?.weights ? '  (weights in the library)' : m?.redistributable === false ? '  (pointer: pulled from its source)' : ''}${better && better !== tag ? `  — measured better above the floor: ${better} (picked per task)` : ''}`); }
    return 0;
  }
  if (verb === 'pull') {
    if (!arg) { console.error('kingmaker models library pull <tag>'); return 1; }
    const lib = await libraryJson(); const m = lib.models.find((x) => x.tag === arg || x.slug === arg);
    if (!m) { console.error(`✗ The library has no model "${arg}".`); return 1; }
    if (!m.weights) { console.log(`${m.tag} has no weights in the library (${m.redistributable ? 'not published yet' : 'its licence does not allow republishing'}); pulling it from its source.`); return (await pull(m.tag)) ? 0 : 1; }
    const w = m.weights, free = freeGb();
    if (free != null && free < w.size / 1e9 * 2 + BENCH_DISK_MARGIN_GB) { console.error(`✗ ${free.toFixed(1)} GB free; ${m.tag} needs ~${(w.size / 1e9 * 2).toFixed(1)} GB while it is assembled (+ ${BENCH_DISK_MARGIN_GB} GB kept free).`); return 1; }
    const { materializeLibraryModel } = await import('./brain-library-fetch.mjs');
    const { spawnSync } = await import('node:child_process');
    const dir = join(paths.state, 'models', 'library', m.slug);
    try {
      console.log(`↓ ${m.tag} (${(w.size / 1e9).toFixed(2)} GB, SHA-256 checked; parts already on disk with the same checksum are skipped)…`);
      await materializeLibraryModel(m, {
        dir, create: true, run: (bin, args) => spawnSync(bin, args, { stdio: 'inherit' }),
      });
      console.log(`✓ ${m.tag} is in Ollama (SHA-256 ${w.sha256.slice(0, 12)}… matches the library). The file stays in ${dir}. Ollama memory-maps that file; this was a cached download.`);
      return 0;
    } catch (error) { console.error(`✗ ${m.tag} was not loaded: ${String(error.message ?? error).slice(0, 240)}`); return 1; }
  }
  if (verb === 'submit') {
    if (!arg) { console.error('kingmaker models library submit <bench file> --yes'); return 1; }
    // Only the official build submits (lib/integrity.mjs): a copy whose files were changed is cut off from the collective.
    // Running from source ('dev') is the owner's checkout and stays allowed.
    const { checkIntegrity } = await import('./integrity.mjs');
    const sealed = await checkIntegrity();
    if (sealed.state === 'modified') { console.error(`✗ This copy of Kingmaker isn't the official build (${sealed.reason}), so it can't submit to the Brain Library. Install it again from the Ronin Launcher.`); return 1; }
    const { readFileSync } = await import('node:fs'); const { basename } = await import('node:path');
    let b; try { b = JSON.parse(readFileSync(arg, 'utf8')); } catch { console.error(`✗ ${arg} is not a bench result.`); return 1; }
    // The library scans every pull request (lib/library-scan.mjs); the same scan runs here first, on the copy that is
    // sent: contact details the models made up in the tool test are removed, the scores are not touched.
    const { redactBench, scanSubmission } = await import('./library-scan.mjs');
    b = redactBench(b);
    const name = basename(arg).toLowerCase().replace(/[^a-z0-9-]+(?=.*\.json$)/g, '-');
    const scan = scanSubmission([{ filename: `bench/${name}`, status: 'added', content: JSON.stringify(b, null, 1) }]);
    if (!scan.ok) { console.error(`✗ The library's scan would refuse ${name}, so nothing was sent:\n${scan.problems.slice(0, 12).map((p) => `  • ${p}`).join('\n')}`); return 1; }
    console.log(`This sends ${name} (${b.host?.chip}, ${b.host?.ramGb} GB, ${b.results?.length ?? 0} models, no personal data) to ${LIBRARY_REPO} as a public pull request.`);
    if (!args.includes('--yes')) { console.log('Nothing was sent. Add --yes to send it.'); return 0; }
    const { execFileSync } = await import('node:child_process');
    const gh = (a, input) => String(execFileSync('gh', a, { encoding: 'utf8', input }));
    try {
      const me = gh(['api', 'user', '-q', '.login']).trim(); const owner = LIBRARY_REPO.split('/')[0];
      const repo = me === owner ? LIBRARY_REPO : (gh(['repo', 'fork', LIBRARY_REPO, '--clone=false'], ''), `${me}/${LIBRARY_REPO.split('/')[1]}`);
      const branch = `bench/${name.replace(/\.json$/, '')}-${Date.now().toString(36)}`;
      const main = gh(['api', `repos/${repo}/git/ref/heads/main`, '-q', '.object.sha']).trim();
      gh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${main}`]);
      gh(['api', '-X', 'PUT', `repos/${repo}/contents/bench/${name}`, '-f', `message=bench: ${name}`, '-f', `branch=${branch}`, '-f', `content=${Buffer.from(JSON.stringify(b, null, 1)).toString('base64')}`]);
      const url = gh(['pr', 'create', '--repo', LIBRARY_REPO, '--head', `${me}:${branch}`, '--title', `bench: ${b.host?.chip} ${b.host?.ramGb} GB`, '--body', `\`kingmaker models bench\` on ${b.host?.chip}, ${b.host?.ramGb} GB, macOS ${b.host?.macos}, Ollama ${b.host?.ollama}.`]).trim();
      console.log(`✓ Sent: ${url}`);
      return 0;
    } catch (e) { console.error(`✗ Could not send it (${String(e.message).slice(0, 160)}). Is gh installed and signed in? Otherwise send ${arg} to the owner (AirDrop is fine).`); return 1; }
  }
  if (verb === 'refresh') return libraryRefresh(paths, args.slice(1));
  console.log('kingmaker models library [list] | pull <tag> | submit <bench file> --yes | refresh [--max N] [--library DIR] [--publish]');
  return verb ? 1 : 0;
}

// ── The Brain Library's tools (catalog/tools/index.json, schema kingmaker.tools/1) ──
//   tools library [list]           every tool item, its platforms and payload staging state
//   tools library pull <id>        pull one tool for this machine through the SAME provider the
//                                  method conductor uses (lib/tool-streaming.mjs): parts pulled
//                                  segment-by-segment, the archive accepted only against the
//                                  catalog SHA-256, unpacked, registered. A declared-not-staged
//                                  tool refuses — staging its payload is the packaging step.
// (lib/cli.mjs dispatches `kingmaker tools …` here, the way cmdModels dispatches `models …`.)
export async function cmdToolsLibrary(paths, args) {
  const [verb = 'list', arg] = args;
  const { loadToolsIndex, toolPlatformKey } = await import('./brain-library.mjs');
  const { createToolStreamingProvider } = await import('./tool-streaming.mjs');
  const tools = loadToolsIndex();
  if (verb === 'list') {
    const platform = toolPlatformKey();
    console.log(`Brain Library tools (kingmaker.tools/1), ${tools.length} item(s). This machine: ${platform}.`);
    for (const t of tools) {
      const p = t.platforms[platform];
      console.log(`  ${t.id} ${t.version} (${t.license}) — provides ${t.provides.join(', ')}${p ? `; ${platform}: ${p.payloadStatus}${p.payloadStatus === 'staged' ? `, ${(p.size / 1e6).toFixed(1)} MB in ${p.parts.length} part(s)` : ''}` : `; no ${platform} build declared (declares: ${Object.entries(t.platforms).map(([k, v]) => `${k}: ${v.payloadStatus}`).join(', ')})`}`);
    }
    return 0;
  }
  if (verb === 'pull') {
    if (!arg) { console.error('kingmaker tools library pull <id>'); return 1; }
    const provider = createToolStreamingProvider({ stateDir: paths.state });
    const tool = provider.toolById(arg);
    if (!tool) { console.error(`✗ The library has no tool "${arg}".`); return 1; }
    try {
      const r = await provider.ensureTool(tool.provides[0]);
      if (!r?.staged) { console.error(`✗ ${r?.reason ?? `${tool.id} is not pullable on this machine`}.`); return 1; }
      console.log(`✓ ${tool.id} ${tool.version} pulled and materialized: ${r.binPath ?? `docker image ${r.image}`}`);
      console.log(`  Archive SHA-256 ${r.receipt.archiveSha256.slice(0, 12)}… verified against the catalog; registered in ${join(provider.toolsDir, 'tools-registry.json')}.`);
      return 0;
    } catch (e) { console.error(`✗ Could not pull ${tool.id}: ${String(e?.message ?? e).slice(0, 240)}`); return 1; }
  }
  console.log('kingmaker tools library [list] | pull <id>');
  return verb ? 1 : 0;
}

/** Pure: a Hugging Face GGUF file's Ollama quant tag ("Qwen3.5-4B-heretic.i1-Q4_K_M.gguf" → "i1-Q4_K_M"), or null. */
export function quantTag(file) {
  return /[.-]((?:i1-)?(?:IQ|Q|BF|F)\d[\w]*?)\.gguf$/i['exec'](String(file ?? ''))?.[1] ?? null;
}
/** Pure: the "Worth a look" ids in a churn report (catalog/churn/<day>.md). */
export function worthIds(report) {
  const sec = String(report).split(/^## /m).find((x) => /^Worth a look/.test(x)) ?? '';
  return [...sec.matchAll(/^- (hf-model-[\w.-]+)/gm)].map((m) => m[1]);
}

/**
 * The monthly rotation, after the churn scan: the newest report's "worth a look" builds are pulled from Hugging Face
 * through Ollama (disk checked, at most --max, each within this Mac's per-model budget), benchmarked here with the
 * thermal guard, the library rebuilt, and a pick proposal written (catalog/churn/<day>-proposal.md). Picks change only
 * by a reviewed commit. --publish also pushes the rebuilt library (the public repo).
 */
/** Where scripts/brain-library.mjs lives. A source checkout has it next to lib/; the packaged app (Contents/Resources/
 *  sol-ghost) carries only lib/, bin/, vendor/, catalog/, core/ and assets/, so there we look in the Kingmaker source
 *  checkout ($KINGMAKER_SOURCE, else ~/Projects/sol-ghost). Returns {path} or {missing: <the checkout path looked for>}. */
export function brainLibraryScript(moduleUrl = import.meta.url, env = process.env, home = homedir(), exists = existsSync) {
  const beside = fileURLToPath(new URL('../scripts/brain-library.mjs', moduleUrl));
  if (exists(beside)) return { path: beside };
  const viaSource = join(env.KINGMAKER_SOURCE || join(home, 'Projects', 'sol-ghost'), 'scripts', 'brain-library.mjs');
  return exists(viaSource) ? { path: viaSource } : { missing: viaSource };
}

async function libraryRefresh(paths, args) {
  const { readdirSync, readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { createHbClient } = await import('./huggingbay.mjs');
  const { proposePicks, proposalReport } = await import('./brain-library.mjs');
  const churnDir = fileURLToPath(new URL('../catalog/churn/', import.meta.url));
  const reports = existsSync(churnDir) ? readdirSync(churnDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : [];
  if (!reports.length) { console.error('✗ No churn report yet (kingmaker models hb churn).'); return 1; }
  const day = reports.at(-1).slice(0, 10), ids = worthIds(readFileSync(join(churnDir, reports.at(-1)), 'utf8'));
  const mac = detectMac(), max = Number(flag(args, '--max') ?? 4);
  const budgetGb = mac.ramGb;   // a candidate is benched against this Mac's own memory — the whole of it
  console.log(`Churn report ${day}: ${ids.length} build(s) worth a look. This Mac: ${mac.ramGb} GB, budget ${budgetGb} GB per model.`);
  const client = createHbClient(), tags = [];
  for (const id of ids) {
    if (tags.length >= max) break;
    let m; try { m = await client.model(id); } catch { continue; }
    const q = quantTag(m?.mainFile?.path), gb = Number(m?.mainFile?.sizeBytes ?? 0) / 1e9;
    if (!m?.name || !q || gb > budgetGb * 0.9) { console.log(`  skip ${id} (${!q ? 'no GGUF quant' : `${gb.toFixed(1)} GB, over this Mac's budget`})`); continue; }
    const free = freeGb();
    if (free != null && free < gb + 50) { console.log(`  stop: ${free.toFixed(0)} GB free (50 GB kept free)`); break; }
    const tag = `hf.co/${m.name}:${q}`;
    console.log(`↓ ${tag} (${gb.toFixed(1)} GB)…`);
    if (await pull(tag)) tags.push(tag); else console.log(`  ! could not pull ${tag}`);
  }
  if (tags.length) await runBench({ models: tags, context: 4096, maxResidentGb: budgetGb, outDir: benchOutDir(), cooldownS: 45, print: (l) => console.log(l) });
  const lib = flag(args, '--library') ?? join(homedir(), 'Projects', 'kingmaker-brain-library');
  if (!existsSync(join(lib, '.git'))) { console.log(`No library checkout at ${lib}: measured, nothing published.`); return 0; }
  const script = brainLibraryScript();
  if (script.missing) { console.error(`✗ Measured, but not published: the library build script needs a Kingmaker source checkout (looked for ${script.missing}). Set KINGMAKER_SOURCE to your checkout and run this again.`); return 1; }
  execFileSync(process.execPath, [script.path, 'build', lib], { stdio: 'inherit' });
  const rows = proposePicks(JSON.parse(readFileSync(join(lib, 'library.json'), 'utf8')));
  const out = join(churnDir, `${day}-proposal.md`); writeFileSync(out, proposalReport(rows, day));
  console.log(`Proposal: ${out} (${rows.filter((r) => r.change).length} change(s); picks change only by a reviewed commit).`);
  if (args.includes('--publish')) {
    execFileSync('git', ['-C', lib, 'add', '-A']);
    try { execFileSync('git', ['-C', lib, 'commit', '-q', '-m', `Refresh ${day}: ${tags.length} new build(s) measured on ${mac.chip} ${mac.ramGb} GB`]); execFileSync('git', ['-C', lib, 'push', '-q']); console.log('✓ Library pushed.'); }
    catch { console.log('Library unchanged.'); }
  }
  return 0;
}
