// lib/bench-cli.mjs — `kingmaker models bench` and `kingmaker models profile` (hooked from lib/cli.mjs cmdModels).
//   models profile [auto|8|16|24|32|48|64]   this Mac's detected profile; with a class, the owner's override
//   models packs                             every pack (a profile as an install pack), this Mac's recommended marked
//   models setup [--pack <class>] [--dry-run] install a pack: its models (disk checked first), then the profile
//   models bench [--as 8] [--set 8|8-wide|16|24|all] [--models a,b] [--pull] [--context N] [--cooldown S] [--out DIR]
// One model at a time with a cool-down between (30 s by default), longer while `pmset -g therm` reports a warning.
// The default set is the candidates for this Mac's class (lib/mac-profiles.mjs BENCH_SETS), or that class's own pack
// when it has no candidate list (16, 32, 48, 64). --pull downloads the ones
// that are missing, through Ollama's own API, and only while the disk keeps BENCH_DISK_MARGIN_GB free after each one.
// Results go to catalog/bench/ in a checkout, or to the Desktop when Kingmaker runs from its app (never into the
// signed bundle).

import { existsSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_SETS, classFor, currentProfile, detectMac, MODEL_GB, PACKS, profileLine, recommendedPack, writeProfileOverride } from './mac-profiles.mjs';
import { hasModel, runBench, verdict } from './model-bench.mjs';
import { kingmakerHome } from './kingmaker-home.mjs';

export const BENCH_DISK_MARGIN_GB = 5;
const BASE = () => (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** Pure: where results go: the checkout's catalog/bench, or Bench in Kingmaker's one folder (lib/kingmaker-home.mjs)
 *  when this file is inside an .app bundle. Never the Desktop (the owner, 2026-10-15: no Kingmaker files on it). */
export function benchOutDir(moduleUrl = import.meta.url, home = homedir(), env = process.env) {
  const here = fileURLToPath(new URL('.', moduleUrl));
  return /\.app\/Contents\//.test(here) ? join(kingmakerHome(env, home), 'Bench') : fileURLToPath(new URL('../catalog/bench/', moduleUrl));
}

/** Pure: the tags a `--set` name benches: a class's candidate list, else that class's own pack (never another class's
 *  candidates), every candidate for 'all', [] for an unknown name. */
export function benchSet(setName) {
  const name = String(setName);
  if (name === 'all') return [...new Set(Object.values(BENCH_SETS).flat().map((m) => m.tag))];
  if (BENCH_SETS[name]) return BENCH_SETS[name].map((m) => m.tag);
  return (PACKS.find((p) => p.id === name)?.models ?? []).map((m) => m.tag);
}

const freeGb = (path = homedir()) => { try { const s = statfsSync(path); return (s.bavail * s.bsize) / 1e9; } catch { return null; } };

async function installedTags() {
  try { const r = await fetch(`${BASE()}/api/tags`, { signal: AbortSignal.timeout(5000) }); return r.ok ? ((await r.json()).models ?? []).map((m) => m.name) : null; } catch { return null; }
}

async function pull(tag) {
  const r = await fetch(`${BASE()}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag, stream: false }), signal: AbortSignal.timeout(3_600_000) });
  return r.ok;
}

export async function cmdProfile(paths, args) {
  const [want] = args;
  if (want) {
    const v = writeProfileOverride(paths.state, want);
    console.log(v === 'auto' ? 'Mac profile: automatic (from this Mac\'s RAM and chip).' : `Mac profile: ${v} GB, your choice.`);
  }
  const mac = detectMac();
  const p = currentProfile(paths.state, { mac });
  console.log(`This Mac: ${mac.brand || 'unknown chip'}, ${mac.ramGb} GB (${mac.model || '?'}), ${mac.bandwidth ?? '?'} GB/s.`);
  console.log(profileLine(p));
  if (p.writerTokSEstimate) console.log(`Writer speed here, estimated from the M5 Pro measurement by memory bandwidth: ~${p.writerTokSEstimate} tok/s.`);
  console.log(`Basis: ${p.basis}. Change it: kingmaker models profile <auto|8|16|24|32|48|64>, or Customize → Mac profile.`);
  return 0;
}

export async function cmdBench(paths, args) {
  const asGb = flag(args, '--as') ? Number(flag(args, '--as')) : null;
  const mac = detectMac();
  const cls = asGb ?? classFor(mac.ramGb);
  const setName = flag(args, '--set') ?? String(cls);
  const set = flag(args, '--models') ? flag(args, '--models').split(',').map((s) => s.trim()).filter(Boolean) : benchSet(setName);
  if (!set.length) { console.error(`✗ No bench set "${setName}". Sets: ${[...new Set([...Object.keys(BENCH_SETS), ...PACKS.map((p) => p.id)])].join(', ')}, all.`); return 1; }
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
  const p = currentProfile(paths.state, { mac });
  const maxResidentGb = asGb ? (await import('./mac-profiles.mjs')).PROFILES[classFor(asGb)].maxResidentGb : p.maxResidentGb;
  const context = Number(flag(args, '--context') ?? (asGb ? 4096 : p.context));
  console.log(`Benchmarking ${models.length} model(s) on ${mac.brand}, ${mac.ramGb} GB${asGb ? `, as an ${asGb} GB Mac (software limits only)` : ''}; context ${context}, budget ${maxResidentGb} GB per model.`);
  if (!asGb) console.log('Close other apps for a fair run. Each model takes 1–5 minutes.');
  const { file, report } = await runBench({ models, asGb, context, maxResidentGb, cooldownS: Number(flag(args, '--cooldown') ?? 30), outDir: flag(args, '--out') ?? benchOutDir(), print: (l) => console.log(l) });
  console.log(`\nResults: ${file}`);
  const rows = report.results.map((r) => ({ r, v: verdict(r, { maxResidentGb }) })).sort((a, b) => (b.v.fits - a.v.fits) || ((b.v.tools ?? 0) - (a.v.tools ?? 0)));
  for (const { r, v } of rows) console.log(`  ${v.fits ? '✓' : '✗'} ${r.model.padEnd(60)} tools ${String(v.tools ?? '—').padStart(3)}%  route ${String(v.route ?? '—').padStart(3)}%  ${String(v.genTokS ?? '—').padStart(5)} tok/s  ${r.memory?.peakRssGb ?? '—'} GB  ${v.fits ? '' : v.why}`);
  if (!asGb && mac.ramGb <= 10) console.log('\nThis is the real 8 GB run: send the results file back so the 8 GB profile is set from it.');
  return 0;
}

/** Pure: one pack as lines for the terminal (the installer draws the same data as cards). */
export function packLines(pack, { recommended = false, installed = [] } = {}) {
  const f = pack.features;
  const head = `${recommended ? '★' : ' '} ${pack.name}${recommended ? '  (recommended for this Mac)' : ''}: ${pack.downloadGb} GB of models · ${f.voice ? 'voice' : 'text only'} · pictures ${f.pictures ? 'on' : 'off'} · ${f.concurrent} model${f.concurrent > 1 ? 's' : ''} at once · ${f.contextK}k context`;
  return [head, ...pack.models.map((m) => `     ${installed.some((t) => t === m.tag || t === `${m.tag}:latest`) ? '✓' : '↓'} ${m.tag}  (${m.roles.join(', ')}${m.gb ? `, ${m.gb} GB` : ''})`)];
}

export async function cmdPacks() {
  const mac = detectMac(); const rec = recommendedPack(mac.ramGb); const have = (await installedTags()) ?? [];
  console.log(`This Mac: ${mac.brand || 'unknown chip'}, ${mac.ramGb} GB. Install one with: kingmaker models setup --pack <class>`);
  for (const p of PACKS) for (const l of packLines(p, { recommended: p.id === rec, installed: have })) console.log(l);
  return 0;
}

/** kingmaker models setup [--pack <class>] [--dry-run]: the pack's models, then the profile (auto when it is this Mac's own). */
export async function cmdSetup(paths, args) {
  const mac = detectMac(); const rec = recommendedPack(mac.ramGb);
  const want = String(flag(args, '--pack') ?? rec);
  const pack = PACKS.find((p) => p.id === want);
  if (!pack) { console.error(`✗ No pack "${want}". Packs: ${PACKS.map((p) => p.id).join(', ')}.`); return 1; }
  const have = await installedTags();
  if (!have) { console.error(`✗ Ollama isn't answering at ${BASE()}. Open Ollama (or start Kingmaker), then run this again.`); return 1; }
  for (const l of packLines(pack, { recommended: pack.id === rec, installed: have })) console.log(l);
  if (Number(pack.id) > classFor(mac.ramGb)) console.log(`! This pack is for a ${pack.id} GB Mac; this one has ${mac.ramGb} GB. Its models may swap.`);
  const missing = pack.models.filter((m) => !hasModel(have, m.tag));
  const needGb = missing.reduce((a, m) => a + (m.gb ?? 5), 0) + BENCH_DISK_MARGIN_GB, free = freeGb();
  if (free != null && missing.length && free < needGb) { console.error(`✗ ${free.toFixed(1)} GB free; this pack needs ~${needGb.toFixed(1)} GB (its downloads + ${BENCH_DISK_MARGIN_GB} GB kept free). Nothing was downloaded.`); return 1; }
  if (args.includes('--dry-run')) { console.log(`Dry run: would download ${missing.length} model(s), ~${(needGb - BENCH_DISK_MARGIN_GB).toFixed(1)} GB, and set the profile to ${pack.id === rec ? 'auto' : pack.id}.`); return 0; }
  for (const m of missing) {
    console.log(`↓ ${m.tag} (~${m.gb ?? '?'} GB)…`);
    if (!(await pull(m.tag))) { console.error(`✗ Could not download ${m.tag}. Nothing else changed; run this again to resume.`); return 1; }
  }
  const v = writeProfileOverride(paths.state, pack.id === rec ? 'auto' : pack.id);
  console.log(`✓ ${pack.name} is installed. Mac profile: ${v === 'auto' ? 'auto (this Mac\'s own)' : `${v} GB, your choice`}.`);
  console.log(profileLine(currentProfile(paths.state, { mac })));
  if (pack.id === '8') console.log('For Ollama on an 8 GB Mac, keep one model loaded and one request at a time: Kingmaker sends each request with its 4k context; set OLLAMA_MAX_LOADED_MODELS=1 and OLLAMA_NUM_PARALLEL=1 if you run Ollama yourself.');
  return 0;
}

// ── The Brain Library (lib/brain-library.mjs, github.com/ronininc/kingmaker-brain-library) ──
//   models library [list]          the picks for this Mac from the published library.json
//   models library pull <tag>      a pick's weights from its release: every part and the whole file SHA-256-checked,
//                                  then loaded into Ollama with the Modelfile it was measured with
//   models library submit <file> --yes   this Mac's bench result as a pull request to the library (gh, signed in)
async function libraryJson() {
  const { libraryFetchFile } = await import('./brain-library.mjs');
  return (await libraryFetchFile('library.json')).json();
}

/** Download one URL to a file, hashing as it streams; resolves the sha256. */
async function downloadHashed(url, dest, headers = {}) {
  const { createWriteStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(3_600_000) });
  if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
  const h = createHash('sha256'), out = createWriteStream(dest);
  for await (const chunk of r.body) { h.update(chunk); if (!out.write(chunk)) await new Promise((res) => out.once('drain', res)); }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  return h.digest('hex');
}

export async function cmdLibrary(paths, args) {
  try { return await cmdLibraryInner(paths, args); }
  catch (e) { console.error(`✗ ${e.message}`); return 1; }
}

async function cmdLibraryInner(paths, args) {
  const [verb = 'list', arg] = args;
  const { LIBRARY_REPO } = await import('./brain-library.mjs');
  if (verb === 'list') {
    const lib = await libraryJson(); const mac = detectMac(); const cls = classFor(mac.ramGb);
    const c = lib.classes.find((x) => x.class === cls);
    console.log(`Brain Library (${LIBRARY_REPO}), updated ${String(lib.updatedAt).slice(0, 10)}. This Mac: ${mac.chip ?? '?'} ${mac.ramGb} GB → ${c?.pack} (${c?.status}).`);
    for (const [role, tag] of Object.entries(c?.roles ?? {})) { const m = lib.models.find((x) => x.tag === tag); console.log(`  ${role.padEnd(9)} ${tag}${m?.weights ? '  (weights in the library)' : m?.redistributable === false ? '  (pointer: pulled from its source)' : ''}`); }
    return 0;
  }
  if (verb === 'pull') {
    if (!arg) { console.error('kingmaker models library pull <tag>'); return 1; }
    const lib = await libraryJson(); const m = lib.models.find((x) => x.tag === arg || x.slug === arg);
    if (!m) { console.error(`✗ The library has no model "${arg}".`); return 1; }
    if (!m.weights) { console.log(`${m.tag} has no weights in the library (${m.redistributable ? 'not published yet' : 'its licence does not allow republishing'}); pulling it from its source.`); return (await pull(m.tag)) ? 0 : 1; }
    const w = m.weights, free = freeGb();
    if (free != null && free < w.size / 1e9 * 2 + BENCH_DISK_MARGIN_GB) { console.error(`✗ ${free.toFixed(1)} GB free; ${m.tag} needs ~${(w.size / 1e9 * 2).toFixed(1)} GB while it is assembled (+ ${BENCH_DISK_MARGIN_GB} GB kept free).`); return 1; }
    const { mkdirSync, readFileSync, writeFileSync, createReadStream, createWriteStream, rmSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const dir = join(paths.state, 'models', 'library', m.slug); mkdirSync(dir, { recursive: true });
    const { libraryReleaseAssets } = await import('./brain-library.mjs');
    const assets = await libraryReleaseAssets(w.release);
    const asset = (n) => { const a = assets[n]; if (!a) throw new Error(`release ${w.release} has no asset ${n}`); return a; };
    for (const p of w.parts) {
      process.stdout.write(`↓ ${p.name} (${(p.size / 1e9).toFixed(2)} GB)… `);
      const got = await downloadHashed(asset(p.name).url, join(dir, p.name), asset(p.name).headers);
      if (got !== p.sha256) { console.error(`✗ ${p.name} does not match its SHA-256; deleted.`); rmSync(join(dir, p.name), { force: true }); return 1; }
      console.log('✓');
    }
    const gguf = join(dir, w.gguf), out = createWriteStream(gguf), h = createHash('sha256');
    for (const p of w.parts) { for await (const chunk of createReadStream(join(dir, p.name))) { h.update(chunk); if (!out.write(chunk)) await new Promise((res) => out.once('drain', res)); } rmSync(join(dir, p.name), { force: true }); }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (h.digest('hex') !== w.sha256) { console.error(`✗ The joined file does not match ${w.sha256.slice(0, 12)}…; deleted.`); rmSync(gguf, { force: true }); return 1; }
    const mfR = await fetch(asset(w.modelfile).url, { headers: asset(w.modelfile).headers, redirect: 'follow' });
    if (!mfR.ok) throw new Error(`Modelfile answered ${mfR.status}`);
    const mfText = await mfR.text();
    writeFileSync(join(dir, 'Modelfile'), mfText.replace(/^FROM .*$/m, `FROM ${JSON.stringify(gguf)}`));
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.env.OLLAMA_BIN || 'ollama', ['create', m.tag, '-f', join(dir, 'Modelfile')], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('✗ Ollama could not load it.'); return 1; }
    void readFileSync;
    console.log(`✓ ${m.tag} is in Ollama (SHA-256 ${w.sha256.slice(0, 12)}… matches the library). The file stays in ${dir}.`);
    return 0;
  }
  if (verb === 'submit') {
    if (!arg) { console.error('kingmaker models library submit <bench file> --yes'); return 1; }
    // Only the official build submits (lib/integrity.mjs): a copy whose files were changed is cut off from the collective.
    // Running from source ('dev') is the owner's checkout and stays allowed.
    const { checkIntegrity } = await import('./integrity.mjs');
    const sealed = await checkIntegrity();
    if (sealed.state === 'modified') { console.error(`✗ This copy of Kingmaker isn't the official build (${sealed.reason}), so it can't submit to the Brain Library. Install it again from Kingmaker Installer.`); return 1; }
    const { readFileSync } = await import('node:fs'); const { basename } = await import('node:path');
    let b; try { b = JSON.parse(readFileSync(arg, 'utf8')); } catch { console.error(`✗ ${arg} is not a bench result.`); return 1; }
    // The library scans every pull request (lib/library-scan.mjs); the same scan runs here first, on the copy that is
    // sent: contact details the models made up in the tool test are removed, the scores are not touched.
    const { redactBench, scanSubmission } = await import('./library-scan.mjs');
    b = redactBench(b);
    const name = basename(arg).toLowerCase().replace(/[^a-z0-9-]+(?=.*\.json$)/g, '-');
    const scan = scanSubmission([{ filename: `bench/${name}`, status: 'added', content: JSON.stringify(b, null, 1) }]);
    if (!scan.ok) { console.error(`✗ The library's scan would refuse ${name}, so nothing was sent:\n${scan.problems.slice(0, 12).map((p) => `  • ${p}`).join('\n')}`); return 1; }
    console.log(`This sends ${name} (${b.host?.chip}, ${b.host?.ramGb} GB, ${b.results?.length ?? 0} models, no personal data) to ${LIBRARY_REPO} (private) as a pull request.`);
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

/** Pure: a Hugging Face GGUF file's Ollama quant tag ("Qwen3.5-4B-heretic.i1-Q4_K_M.gguf" → "i1-Q4_K_M"), or null. */
export function quantTag(file) {
  return /[.-]((?:i1-)?(?:IQ|Q|BF|F)\d[\w]*?)\.gguf$/i.exec(String(file ?? ''))?.[1] ?? null;
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
  const mac = detectMac(), p = currentProfile(paths.state, { mac }), max = Number(flag(args, '--max') ?? 4);
  console.log(`Churn report ${day}: ${ids.length} build(s) worth a look. This Mac: ${mac.ramGb} GB, budget ${p.maxResidentGb} GB per model.`);
  const client = createHbClient(), tags = [];
  for (const id of ids) {
    if (tags.length >= max) break;
    let m; try { m = await client.model(id); } catch { continue; }
    const q = quantTag(m?.mainFile?.path), gb = Number(m?.mainFile?.sizeBytes ?? 0) / 1e9;
    if (!m?.name || !q || gb > p.maxResidentGb * 0.9) { console.log(`  skip ${id} (${!q ? 'no GGUF quant' : `${gb.toFixed(1)} GB, over this Mac's budget`})`); continue; }
    const free = freeGb();
    if (free != null && free < gb + 50) { console.log(`  stop: ${free.toFixed(0)} GB free (50 GB kept free)`); break; }
    const tag = `hf.co/${m.name}:${q}`;
    console.log(`↓ ${tag} (${gb.toFixed(1)} GB)…`);
    if (await pull(tag)) tags.push(tag); else console.log(`  ! could not pull ${tag}`);
  }
  if (tags.length) await runBench({ models: tags, context: p.context, maxResidentGb: p.maxResidentGb, outDir: benchOutDir(), cooldownS: 45, print: (l) => console.log(l) });
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
