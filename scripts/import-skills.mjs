#!/usr/bin/env node
// Bring Solomon's and Ronin's skills into Kingmaker's core pack (the owner, 2026-10-16: "so bring them in. they ship
// with it … all of them"). Operator tooling: it reads TSS's project skills and the owner's synced Claude skills on this
// Mac, so it stays out of the public export; what it writes (core/skills/) is public.
//
//   node scripts/import-skills.mjs [--tss ~/Projects/TSS] [--synced <synced skills dir>] [--dry-run]
//
// Every skill keeps its own licence: a third-party skill keeps its LICENSE and gets a SOURCE.md naming where it came
// from; a skill Ronin wrote (no licence file) gets Ronin's LICENSE. What may not be given away is never copied: skills
// under Anthropic's proprietary terms, Anthropic's built-in skills (no licence), and the owner's private engines.
// Nothing is committed: read `git status core/skills` and the leak gate (scripts/public-export.mjs --check) first.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const tilde = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
const TSS = resolve(tilde(arg('--tss', '~/Projects/TSS')));
const syncedBase = join(homedir(), '.claude', 'skills', 'synced');
const SYNCED = resolve(tilde(arg('--synced', existsSync(syncedBase) ? join(syncedBase, readdirSync(syncedBase).find((d) => !d.startsWith('.')) || '') : '')));
const DRY = process.argv.includes('--dry-run');
const TODAY = new Date().toISOString().slice(0, 10);

/** Never copied, with why. */
export const HOLD = Object.freeze({
  docx: "Anthropic's proprietary licence: no redistribution", pdf: "Anthropic's proprietary licence: no redistribution",
  pptx: "Anthropic's proprietary licence: no redistribution", xlsx: "Anthropic's proprietary licence: no redistribution",
  'computer-use': "Anthropic's proprietary licence: no redistribution", 'built-in-browser': "Anthropic's proprietary licence: no redistribution",
  'chrome-browser': "Anthropic's proprietary licence: no redistribution",
  docs: "an Anthropic built-in skill with no licence", 'import-memory': "an Anthropic built-in skill with no licence",
  'google-workspace': "an Anthropic built-in skill with no licence", morning: "an Anthropic built-in skill with no licence",
  'custom-lead-generator': "the owner's private Orosolu engine (kept to the owner's install)", profiler: "the owner's private research engine (kept to the owner's install)",
  'council-conductor': 'drives the Ronin CRM council (owner-only)',
});
/** Kingmaker ships its own version of these: the import leaves them alone. */
export const OWN = Object.freeze({
  'cli-anything': "Kingmaker's own core skill (the complete vendored CLI-Anything with the Kingmaker CLI Hub), not TSS's Codex installer copy",
  ...Object.fromEntries(['doc-author', 'proof-runner', 'proof-authoring', 'readme-sync', 'repo-hygiene', 'engine-verifier', 'flagship-driver', 'native-internet', 'cloudflare-release', 'voice-verification', 'voice-runtime']
    .map((n) => [`solomon-${n}`, `rewritten for Kingmaker as kingmaker-${n} (2026-10-16); TSS's version is not re-imported`])),
});
/** Names that change on the way in: Solomon's skills become Kingmaker's. */
const rename = (n) => n.replace(/^solomon-/, 'kingmaker-');
/**
 * Changes Kingmaker makes to a third-party skill so REA passes it, each noted in its SOURCE.md (Apache-2.0 asks that
 * changes be stated). REA's rules are never loosened for a skill: the skill's text changes instead.
 */
const PATCHES = Object.freeze([
  { skill: 'comfyui', why: 'pretty-printing local JSON through `python -m json.tool` reads to REA as piping a download into an interpreter; the JSON is printed as is',
    edits: [['SKILL.md', ' | python -m json.tool', ''], ['references/rest-api.md', ' | python3 -m json.tool', ''], ['scripts/comfyui_setup.sh', ' | python3 -m json.tool 2>/dev/null || true', ' || true']] },
  { skill: 'security-and-hardening', why: 'one line about stripping fields from HTTP responses read to REA as an instruction to run on every reply; reworded',
    edits: [['SKILL.md', 'reset tokens) before any response.', 'reset tokens) from every API payload a server returns.']] },
]);
const SKIP_FILES = new Set(['.DS_Store', '__pycache__', 'node_modules', '.git', '.pytest_cache']);

const licenceOf = (dir) => {
  for (const f of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT']) {
    if (!existsSync(join(dir, f))) continue;
    const t = readFileSync(join(dir, f), 'utf8').slice(0, 3000);
    if (/Apache License/.test(t)) return 'Apache-2.0';
    if (/MIT License|Permission is hereby granted, free of charge/.test(t)) return 'MIT';
    if (/unencumbered software released into the public domain/.test(t)) return 'Unlicense';
    if (/Ronin Inc/.test(t)) return 'Ronin';
    return 'other';
  }
  return null;
};

/** Candidates: TSS's top-level project skills (bundles carry their nested skills), then the synced ones not already taken. */
export function candidates() {
  const out = [];
  const tssSkills = join(TSS, '.claude', 'skills');
  const tssSha = existsSync(join(TSS, '.git')) ? execFileSync('git', ['-C', TSS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() : '?';
  if (existsSync(tssSkills)) for (const n of readdirSync(tssSkills)) if (existsSync(join(tssSkills, n, 'SKILL.md'))) out.push({ name: n, dir: join(tssSkills, n), from: "Ronin's own skill collection" });
  if (SYNCED && existsSync(SYNCED)) for (const n of readdirSync(SYNCED)) {
    if (!existsSync(join(SYNCED, n, 'SKILL.md')) || out.some((c) => c.name === n)) continue;
    out.push({ name: n, dir: join(SYNCED, n), from: "Ronin's own skills (the owner's synced skill set)" });
  }
  return out;
}

/** The scrubs every Ronin-written skill gets on the way in: no clients, no CRM tenant, no owner, Kingmaker not Claude. */
const SCRUBS = [
  [/The last-mile media piece of the Orosolu build pipeline\./g, 'The last-mile media piece of a website build pipeline.'],
  [/\[\[client-sites\]\] \/ \[\[orosolu\]\] notes/g, 'your notes on the client'],
  [/Already validated with this client base — see your notes on the client for La Tiendita Colombiana\./g, 'Already validated on real client sites.'],
  [/how Claude reasons and acts/g, 'how Kingmaker reasons and acts'],
  [/^Claude may call/gm, 'Kingmaker may call'],
  [/ \(already the house standard per \[\[orosolu\]\]\)/g, ' (the house standard)'],
  [/\bla-carreta\b/g, 'example-restaurant'],
  [/structured like the SLIK build/g, 'structured like the reference build'],
  [/\(SLIK pattern\)/g, '(reference pattern)'],
  [/SLIK Landscaping/g, 'a landscaping client'],
  [/\bslik-motion\b/g, 'site-motion'],
  [/\bthe SLIK build\b/g, 'the reference build'],
  [/\bSLIK\b/g, 'the reference build'],
  [/\/Users\/robbiebrown\//g, '/Users/you/'],
  [/solomon-verification-standard:solomon-/g, 'kingmaker-'],
  [/\bsolomon-(doc-author|proof-runner|proof-authoring|readme-sync|repo-hygiene|engine-verifier|flagship-driver|native-internet|cloudflare-release|voice-verification|voice-runtime)\b/g, 'kingmaker-$1'],
];

function copyTree(from, to) {
  cpSync(from, to, { recursive: true, filter: (src) => !SKIP_FILES.has(basename(src)) && !src.endsWith('.pyc') });
}

function walkText(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkText(p, fn);
    else if (/\.(md|txt|json|ya?ml|py|mjs|js|cjs|sh|ts|css|html?|svg|toml)$/i.test(e.name)) { const t = readFileSync(p, 'utf8'); const u = fn(t, p); if (u !== t) writeFileSync(p, u); }
  }
}

function main() {
  const rows = [];
  for (const c of candidates()) {
    if (HOLD[c.name]) { rows.push({ ...c, action: 'held', why: HOLD[c.name] }); continue; }
    if (OWN[c.name]) { rows.push({ ...c, action: 'kept', why: OWN[c.name] }); continue; }
    const name = rename(c.name), dest = join(root, 'core', 'skills', name);
    const lic = licenceOf(c.dir);
    const ronin = !lic;
    rows.push({ ...c, public: name, licence: lic || 'Ronin', action: existsSync(dest) ? 'replaced' : 'added' });
    if (DRY) continue;
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    copyTree(c.dir, dest);
    if (ronin) {
      writeFileSync(join(dest, 'LICENSE'), "Copyright (c) 2026 Ronin Inc.\nPart of Kingmaker, under Kingmaker's LICENSE (see the repository root).\n");
      walkText(dest, (t) => SCRUBS.reduce((s, [re, to]) => s.replace(re, to), t));
    }
    if (name !== c.name) {
      const f = join(dest, 'SKILL.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace(new RegExp(`^name:\\s*${c.name}\\s*$`, 'm'), `name: ${name}`));
    }
    const patch = PATCHES.find((x) => x.skill === name);
    if (patch) for (const [file, from, to] of patch.edits) { const f = join(dest, file); if (existsSync(f)) writeFileSync(f, readFileSync(f, 'utf8').replaceAll(from, to)); }
    if (!existsSync(join(dest, 'SOURCE.md'))) {
      const vendored = existsSync(join(dest, 'VENDORED.md')) ? ' Its upstream and changes are in VENDORED.md.' : '';
      writeFileSync(join(dest, 'SOURCE.md'), `# Source: ${name}\n\n- From ${c.from}, imported ${TODAY}${name !== c.name ? ` (was \`${c.name}\`)` : ''}.\n- Licence: ${ronin ? "Ronin Inc.'s own, under Kingmaker's LICENSE" : `${lic}, its LICENSE kept in this folder`}.${vendored}\n${patch ? `- Changed by Kingmaker: ${patch.why}.\n` : ''}`);
    }
  }
  for (const r of rows) console.log(`${r.action.padEnd(8)} ${(r.public || r.name).padEnd(36)} ${r.why || r.licence}`);
  const n = (a) => rows.filter((r) => r.action === a).length;
  console.log(`\n${n('added')} added, ${n('replaced')} replaced, ${n('held')} held back${DRY ? ' (dry run: nothing written)' : ''}. Next: node scripts/public-export.mjs --check && node --test test/core-pack.test.mjs`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
