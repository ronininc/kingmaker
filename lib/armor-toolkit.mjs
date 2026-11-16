// lib/armor-toolkit.mjs — Kingmaker's view of the tools Scripture Armor ships (owner ruling 2026-11-16): Scripture Armor
// owns the Little Brother toolkit and its binaries; Kingmaker never bundles or copies them. Kingmaker DISCOVERS the
// installed Armor, verifies each tool in place against Armor's own BUNDLE.json pins, and registers it in Kingmaker's
// tool registry as provider "scripture-armor" pointing INTO Armor's bundle. The tool runner re-verifies the pin before
// every run and refuses on mismatch. Absent Armor, absent toolkit, or an unpinned/changed tool is reported plainly.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

export const ARMOR_APP_CANDIDATES = () => ['/Applications/Scripture Armor.app', join(homedir(), 'Applications', 'Scripture Armor.app')];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The Little Brother toolkit manifest Armor is expected to ship (schema scripture-armor.lb-toolkit/1). */
export const LB_TOOLKIT_MANIFEST = 'littlebrother/toolkit.json';
/** Tools Armor ships today, inside armor/ (verified against BUNDLE.json, never assumed). */
const INTRINSIC = [
  { name: 'armor-ghidra-headless', rel: 'tools/ghidra/support/analyzeHeadless', role: 'binary analysis (Ghidra headless)' },
  { name: 'armor-java', rel: 'tools/jdk/bin/java', role: "Ghidra's bundled Java runtime" },
  { name: 'armor-rea', rel: 'rea/rea.mjs', role: 'REA lexical risk scanner (run with node)', runner: 'node' },
];

export function discoverArmorToolkit({ candidates = ARMOR_APP_CANDIDATES() } = {}) {
  const app = candidates.find((c) => existsSync(join(c, 'Contents', 'Resources', 'armor', 'BUNDLE.json')));
  if (!app) return { status: 'armor-not-installed', detail: `Scripture Armor is not installed (looked in ${candidates.join(', ')}). Kingmaker cannot use Armor's tools until it is.`, tools: [] };
  const root = join(app, 'Contents', 'Resources', 'armor');
  let version = null; try { version = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8').match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1] ?? null; } catch { /* unknown */ }
  const bundle = JSON.parse(readFileSync(join(root, 'BUNDLE.json'), 'utf8'));
  const pins = new Map((bundle.files ?? []).map((f) => [f.path, f]));
  const check = (rel) => {
    const p = join(root, rel);
    if (!existsSync(p)) return { present: false, verified: false, reason: 'not in this Armor build' };
    const pin = pins.get(rel);
    if (!pin) return { present: true, verified: false, reason: 'present but not pinned in BUNDLE.json — refused' };
    const got = sha(p);
    return got === pin.sha256 ? { present: true, verified: true, sha256: got } : { present: true, verified: false, reason: `sha256 ${got.slice(0, 12)}… does not match Armor's pin` };
  };
  const tools = INTRINSIC.map((t) => ({ ...t, path: join(root, t.rel), provider: 'scripture-armor', ...check(t.rel) }));
  const lb = existsSync(join(root, LB_TOOLKIT_MANIFEST))
    ? (() => { const m = JSON.parse(readFileSync(join(root, LB_TOOLKIT_MANIFEST), 'utf8')); return { status: 'present', tools: (m.tools ?? []).map((t) => ({ name: `lb-${t.name}`, rel: t.path, role: t.role ?? 'Little Brother tool', version: t.version ?? null, path: join(root, t.path), provider: 'scripture-armor', ...check(t.path) })) }; })()
    : { status: 'absent', detail: `This Scripture Armor ${version ?? ''} build ships no Little Brother toolkit (${LB_TOOLKIT_MANIFEST} missing): only the integration bridge. Little Brother tools are unavailable to Kingmaker until Armor ships them.`, tools: [] };
  return { status: 'armor-installed', app, version, root, bundleFiles: bundle.files?.length ?? 0, tools: [...tools, ...lb.tools], littleBrother: { status: lb.status, detail: lb.detail ?? null } };
}

/** Register Armor's VERIFIED tools in Kingmaker's tool registry, pointing into Armor's bundle (no copies). */
export function registerArmorTools(state, found = discoverArmorToolkit()) {
  const regPath = join(state, 'abilities', 'tools.json');
  let reg = { schema: 'kingmaker.selected-tools/1', tools: {} }; try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { /* new */ }
  for (const k of Object.keys(reg.tools)) if (reg.tools[k].provider === 'scripture-armor') delete reg.tools[k];
  const registered = [];
  for (const t of found.tools.filter((x) => x.verified)) {
    // REA is a library: a tiny shim calls its inspect() on the given targets and prints the verdict as JSON.
    const shim = `const m = await import(${JSON.stringify('file://' + t.path)}); const r = m.inspect(process.argv.slice(1)); console.log(JSON.stringify({ verdict: r.verdict, findings: (r.findings ?? []).map((f) => f.rule) }));`;
    reg.tools[t.name] = { path: t.runner === 'node' ? process.execPath : t.path, args0: t.runner === 'node' ? ['--input-type=module', '-e', shim, '--'] : [],
      // Armor's own non-secret settings for its tools: Ghidra finds Armor's bundled JDK, as Armor itself configures it.
      env: { JAVA_HOME: join(found.root, 'tools', 'jdk') }, provider: 'scripture-armor', armorApp: found.app, armorRel: relative(found.root, t.path), sha256: t.sha256, role: t.role, usage: 'provided by Scripture Armor' };
    registered.push(t.name);
  }
  mkdirSync(join(state, 'abilities'), { recursive: true, mode: 0o700 }); writeFileSync(regPath, JSON.stringify(reg, null, 2), { mode: 0o600 });
  return { registered, skipped: found.tools.filter((x) => !x.verified).map((x) => ({ name: x.name, reason: x.reason })) };
}

/** Re-verify an Armor-provided registry entry right before it runs (the runner refuses on mismatch). */
export function verifyArmorEntry(entry) {
  if (entry?.provider !== 'scripture-armor') return { ok: true };
  const p = join(entry.armorApp, 'Contents', 'Resources', 'armor', entry.armorRel);
  if (!existsSync(p)) return { ok: false, reason: `Scripture Armor's ${entry.armorRel} is no longer installed` };
  const got = sha(p);
  return got === entry.sha256 ? { ok: true } : { ok: false, reason: `Scripture Armor's ${entry.armorRel} changed since it was verified (sha256 ${got.slice(0, 12)}…) — refused; rerun discovery` };
}
