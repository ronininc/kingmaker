#!/usr/bin/env node
// The Kingmaker Brain Library repo (lib/brain-library.mjs), written and published from this checkout.
//   node scripts/brain-library.mjs build <library checkout>             library.json, the schema, bench/, README, NOTICE
//   node scripts/brain-library.mjs weights <library checkout> [--models tag,…] [--dry-run]
//        each redistributable pick's GGUF (from this Mac's Ollama, the exact file that was measured) as a GitHub
//        Release model-<slug>: parts under 2 GB, each SHA-256'd, plus the Modelfile it ran with; weights.json records it.
// Publishing is the owner's decision (2026-10-15: "a github repo of its own that is public with the weights and
// suggested models for hardware"; catalog + split release weights, the current winners only).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { buildLibrary, LIBRARY_JSON_SCHEMA, LIBRARY_REPO, modelSlug, planParts } from '../lib/brain-library.mjs';
import { CHIP_BANDWIDTH } from '../lib/mac-profiles.mjs';

const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || !dir) { console.error('usage: node scripts/brain-library.mjs build|weights <library checkout> [--models a,b] [--dry-run]'); process.exit(2); }
const here = new URL('..', import.meta.url).pathname;
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const weightsFile = join(dir, 'weights.json');

function benchFiles() {
  const out = {};
  for (const sub of ['catalog/bench', 'catalog/bench/vm']) {
    const d = join(here, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => /^m\d.*\.json$/.test(x))) out[`${sub === 'catalog/bench' ? '' : 'vm/'}${f}`] = readJson(join(d, f), null);
  }
  // Results other Macs sent in (bench/ in the library itself) count too.
  const lib = join(dir, 'bench');
  if (existsSync(lib)) for (const f of readdirSync(lib).filter((x) => /^m\d.*\.json$/.test(x))) out[f] ??= readJson(join(lib, f), null);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

function readme(lib) {
  const short = (t) => t.replace(/^huihui_ai\//, '').replace(/^hf\.co\//, '');
  let md = `# Kingmaker Brain Library

The local models [Kingmaker](https://github.com/ronininc/Kingmaker) suggests for every Apple-silicon Mac, the
benchmarks behind each pick, and the weights. Abliterated and uncensored builds are preferred wherever one measured
well. Machine-readable: [\`library.json\`](library.json) (schema: [\`schema/library.schema.json\`](schema/library.schema.json)).

**Picks come from measurements, not claims.** Every Mac that runs \`kingmaker models bench\` adds its results to
[\`bench/\`](bench/). A class is **measured** once its own results are in, and an **estimate** until then. So the more
Macs that test, the more of this table is measured. A 30-day churn scan finds new builds, and a benchmark decides
whether one replaces a pick.

## Picks per Mac class

| Pack | Macs | Router | Writer | Coder | Vision | Reasoning | Per model | Context | At once | Voice | Pictures | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;
  for (const c of lib.classes) md += `| ${c.pack} | ${c.label} | ${['router', 'writer', 'coder', 'vision', 'reasoning'].map((r) => `\`${short(c.roles[r])}\``).join(' | ')} | ${c.maxResidentGb} GB | ${c.context / 1024}k | ${c.concurrent} | ${c.voice === 'on' ? 'on' : 'text only'} | ${c.pictures ? 'on' : 'off'} | ${c.status}${c.measuredOn.length ? ` (${c.measuredOn.join(', ')})` : ''} |\n`;
  md += `\n## Every Mac\n\n| Chip | RAM | GB/s | Pack |\n|---|---|---|---|\n`;
  for (const d of lib.devices) md += `| ${d.chip} | ${d.ramGb} GB | ${d.bandwidthGBs ?? '?'} | ${d.class} GB |\n`;
  md += `\n## Models\n\n| Model | Kind | Licence | Status | Weights here | Best measured |\n|---|---|---|---|---|---|\n`;
  for (const m of lib.models) {
    const best = m.bench.filter((b) => !b.error).sort((a, b) => (b.tools ?? 0) - (a.tools ?? 0))[0];
    md += `| \`${short(m.tag)}\` | ${m.kind} | ${m.license ?? 'none on its card'} | ${m.status}${m.picks.length ? ` (${m.picks.map((p) => `${p.class} GB ${p.role}`).join(', ')})` : ''} | ${m.weights ? `[${m.weights.release}](https://github.com/${LIBRARY_REPO}/releases/tag/${m.weights.release})` : m.redistributable ? 'not yet' : 'pointer only'} | ${best ? `${best.tokS} tok/s, holds ${best.holdsGb} GB, tools ${best.tools}%, route ${best.route}%, write ${best.write}% (${best.file})` : '—'} |\n`;
  }
  md += `\n## For bigger Macs (options, not measured here)\n\nListed for when a bigger Mac arrives. Never picked automatically, not benchmarked here, and the weights are linked upstream, not republished. These do not run in Ollama.\n\n| Model | Licence | For | Files | Runtime |\n|---|---|---|---|---|\n`;
  for (const o of lib.bigOptions ?? []) md += `| [${o.tag}](${o.links[0]})${o.links[1] ? ` · [GGUF](${o.links[1]})` : ''}<br><small>${o.params}${o.context ? `, ${o.context} context` : ''}. ${o.note}</small> | ${o.license} | ${o.forRamGb.join(' / ')} GB Macs | ${o.files.map((f) => `${f.quant} ${f.gb} GB`).join(', ')} | ${o.runtime} |\n`;
  md += `\n## Install a pick with Kingmaker\n\n\`\`\`\nkingmaker models library pull <tag>      # downloads the parts, checks every SHA-256, loads it into Ollama\nkingmaker models setup --pack <class>    # a whole pack\nkingmaker models bench                   # measure this Mac; then: kingmaker models library submit\n\`\`\`\n\nSubmissions are scanned, then reviewed by the owner: see [CONTRIBUTING.md](CONTRIBUTING.md).\n\nEach model keeps its own licence: see [NOTICE.md](NOTICE.md). A model without a licence on its card is listed and\nmeasured here, but its weights are not republished.\n`;
  return md;
}

function notice(lib) {
  let md = '# Notices\n\nThe weights published in this repo\'s releases keep their own licences:\n\n';
  for (const m of lib.models.filter((x) => x.redistributable)) md += `- \`${m.tag}\`: ${m.license}. From ${m.from}${m.base ? `, based on ${m.base}` : ''}. Changes: abliteration or quantization by the builders named, not by Ronin Inc.\n`;
  md += '\nApache-2.0: https://www.apache.org/licenses/LICENSE-2.0. The library\'s own files (library.json, the schema, the bench results) are published by Ronin Inc for anyone to use.\n';
  return md;
}

// Only the owner commits here; anyone may submit a bench result as a pull request, and every one is scanned first
// (owner 2026-10-15). The scan is lib/library-scan.mjs, run by the library's own workflow from its own main.
const SCAN_WORKFLOW = `name: scan
# Every pull request is scanned before the owner looks at it. pull_request_target runs the library's own main (the
# scan can't be changed by the pull request it scans); the submitted files are fetched as text and only read.
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
concurrency:
  group: scan-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  scan:
    name: scan
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2, the library's main, never the submission
        with:
          persist-credentials: false
          sparse-checkout: .github/scan
      - name: Scan the submission (read as data, never run)
        run: node .github/scan/run.mjs
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          PR: \${{ github.event.pull_request.number }}
`;
const CONTRIBUTING = `# Submitting to the Kingmaker Brain Library

Only the owner commits to this library. Anyone can **submit a bench result** from their own Mac, as a pull request:

\`\`\`
kingmaker models bench                          # measures this Mac (about 1–5 minutes a model)
kingmaker models library submit <bench file> --yes
\`\`\`

\`submit\` scans the result on your Mac first, removes contact details the models made up during the tool test, and opens
the pull request. Then:

1. **The scan** runs on every pull request (\`.github/workflows/scan.yml\`). A submission may only add new files in
   \`bench/\`, each one a result \`kingmaker models bench\` writes: every field known, numbers in range, no links, keys,
   tokens, hidden characters or real contact details. Anything else fails it, with the reason on the pull request.
2. **The owner reviews** what passed and merges it by hand. Nothing is merged automatically.
3. **Picks** (the models each Mac class installs) change only through the owner's monthly rotation commit. A
   submission adds evidence; it never changes a pick by itself.

Model weights, the catalog (\`library.json\`), the README and the scan itself are not open to submissions.
`;
function writeGuard(dir) {
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true }); mkdirSync(join(dir, '.github', 'scan'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'scan.yml'), SCAN_WORKFLOW);
  copyFileSync(join(here, 'lib', 'library-scan.mjs'), join(dir, '.github', 'scan', 'library-scan.mjs'));
  copyFileSync(join(here, 'scripts', 'library-scan-ci.mjs'), join(dir, '.github', 'scan', 'run.mjs'));
  writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @ronininc\n');
  writeFileSync(join(dir, 'CONTRIBUTING.md'), CONTRIBUTING);
}

if (cmd === 'build') {
  mkdirSync(join(dir, 'schema'), { recursive: true }); mkdirSync(join(dir, 'bench'), { recursive: true });
  const benches = benchFiles();
  for (const f of Object.keys(benches)) { const src = f.startsWith('vm/') ? join(here, 'catalog/bench', f) : join(here, 'catalog/bench', f); if (existsSync(src)) { mkdirSync(join(dir, 'bench', f.startsWith('vm/') ? 'vm' : ''), { recursive: true }); copyFileSync(src, join(dir, 'bench', f)); } }
  let source = null; try { source = `ronininc/Kingmaker sol-ghost ${String(execFileSync('git', ['-C', here, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })).trim()}`; } catch { /* not a checkout */ }
  // What each model can do (vision, tools, thinking), from this Mac's Ollama where it is installed; kept from the last
  // build otherwise.
  const prev = readJson(join(dir, 'library.json'), { models: [] });
  const capabilities = Object.fromEntries(prev.models.filter((m) => m.capabilities).map((m) => [m.tag, m.capabilities]));
  const tags = new Set([...Object.values(benches).flatMap((b) => (b.results ?? []).map((r) => r.model))]);
  for (const t of tags) { try { const r = await fetch('http://127.0.0.1:11434/api/show', { method: 'POST', body: JSON.stringify({ model: t }), signal: AbortSignal.timeout(5000) }); const j = await r.json(); if (Array.isArray(j.capabilities)) capabilities[t] = j.capabilities; } catch { /* not installed here */ } }
  const lib = buildLibrary({ benches, weights: readJson(weightsFile, {}), capabilities, source });
  writeFileSync(join(dir, 'library.json'), `${JSON.stringify(lib, null, 1)}\n`);
  writeFileSync(join(dir, 'schema', 'library.schema.json'), `${JSON.stringify(LIBRARY_JSON_SCHEMA, null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), readme(lib));
  writeFileSync(join(dir, 'NOTICE.md'), notice(lib));
  writeGuard(dir);
  console.log(`✓ ${dir}: ${lib.devices.length} Mac configurations, ${lib.classes.length} classes (${lib.classes.filter((c) => c.status === 'measured').length} measured), ${lib.models.length} models (${lib.models.filter((m) => m.status === 'pick').length} picks), ${lib.bench.length} bench files.`);
  void CHIP_BANDWIDTH;
} else if (cmd === 'weights') {
  const lib = readJson(join(dir, 'library.json'), null);
  if (!lib) { console.error('build the library first'); process.exit(1); }
  const only = flag('--models')?.split(',');
  const published = readJson(weightsFile, {});
  const todo = lib.models.filter((m) => m.status === 'pick' && m.redistributable && !published[m.tag] && (!only || only.includes(m.tag)));
  for (const m of todo) {
    const mf = String(execFileSync('ollama', ['show', '--modelfile', m.tag], { encoding: 'utf8' }));
    const blob = /^FROM (\S+sha256-[0-9a-f]{64})/m.exec(mf)?.[1];
    if (!blob) { console.log(`! ${m.tag}: no GGUF blob in its Modelfile; skipped`); continue; }
    const sha = /sha256-([0-9a-f]{64})/.exec(blob)[1], size = statSync(blob).size, release = `model-${m.slug}`, gguf = `${m.slug}.gguf`;
    const modelfile = mf.split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/^FROM .*$/m, `FROM ./${gguf}`);
    const parts = planParts(size).map((p) => ({ ...p, name: `${gguf}.part-${String(p.index).padStart(3, '0')}` }));
    console.log(`${m.tag}: ${(size / 1e9).toFixed(2)} GB, sha256 ${sha.slice(0, 12)}…, ${parts.length} part(s) → release ${release}`);
    if (rest.includes('--dry-run')) continue;
    const stage = join(dir, '.parts', m.slug); mkdirSync(stage, { recursive: true });
    const fd = openSync(blob, 'r');
    try {
      // 64 MB at a time: a part is never held whole in memory (the Mac is benchmarking beside this).
      const buf = Buffer.allocUnsafe(64 << 20);
      for (const p of parts) {
        const h = createHash('sha256'), out = openSync(join(stage, p.name), 'w');
        for (let done = 0; done < p.size;) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, p.size - done), p.start + done);
          writeSync(out, buf, 0, n); h.update(buf.subarray(0, n)); done += n;
        }
        closeSync(out); p.sha256 = h.digest('hex');
      }
    } finally { closeSync(fd); }
    const info = { tag: m.tag, release, gguf, sha256: sha, size, license: m.license, from: m.from, base: m.base, modelfile: 'Modelfile', parts: parts.map(({ name, size: s, sha256 }) => ({ name, size: s, sha256 })) };
    writeFileSync(join(stage, 'Modelfile'), modelfile); writeFileSync(join(stage, 'model.json'), `${JSON.stringify(info, null, 1)}\n`);
    const notes = `${m.tag}\n\nLicence: ${m.license} (from ${m.from}${m.base ? `, based on ${m.base}` : ''}).\nGGUF sha256 ${sha} (${size} bytes), in ${parts.length} part(s): join them in order (cat ${gguf}.part-* > ${gguf}), check the sha256, then ollama create with the Modelfile. Or: kingmaker models library pull ${m.tag}`;
    execFileSync('gh', ['release', 'create', release, '--repo', LIBRARY_REPO, '--title', m.tag, '--notes', notes, ...parts.map((p) => join(stage, p.name)), join(stage, 'Modelfile'), join(stage, 'model.json')], { stdio: 'inherit' });
    published[m.tag] = info; writeFileSync(weightsFile, `${JSON.stringify(published, null, 1)}\n`);
    rmSync(stage, { recursive: true, force: true });
    console.log(`✓ ${release}`);
  }
} else { console.error(`unknown command ${cmd}`); process.exit(2); }
