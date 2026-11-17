// lib/armor-toolkit.mjs — Kingmaker's view of the tools Scripture Armor ships (owner ruling 2026-11-16): Scripture Armor
// owns the Little Brother toolkit and its binaries; Kingmaker never bundles or copies them. Kingmaker DISCOVERS the
// installed Armor, verifies each tool in place against Armor's own BUNDLE.json pins, and registers it in Kingmaker's
// tool registry as provider "scripture-armor" pointing INTO Armor's bundle. The tool runner re-verifies the pin before
// every run and refuses on mismatch. Absent Armor, absent toolkit, or an unpinned/changed tool is reported plainly.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyInstalledArmor } from './armor-connection.mjs';

export const ARMOR_APP_CANDIDATES = () => ['/Applications/Scripture Armor.app', join(homedir(), 'Applications', 'Scripture Armor.app')];
/** Armor bundle roots (the directory holding BUNDLE.json) per platform. macOS: inside the .app; elsewhere the standalone
 *  install directory (~/scripture-armor, per Armor's build-standalone layout). */
export const ARMOR_BUNDLE_CANDIDATES = (platform = process.platform) => (platform === 'darwin'
  ? ARMOR_APP_CANDIDATES().map((a) => join(a, 'Contents', 'Resources', 'armor'))
  : [join(homedir(), 'scripture-armor'), ...(platform === 'win32' && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'ScriptureArmor')] : [])]);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The Little Brother toolkit manifest Armor is expected to ship (schema scripture-armor.lb-toolkit/1). */
export const LB_TOOLKIT_MANIFEST = 'littlebrother/toolkit.json';
/** Tools Armor ships today, inside armor/ (verified against BUNDLE.json, never assumed). */
const INTRINSIC = [
  { name: 'armor-ghidra-headless', rel: 'tools/ghidra/support/analyzeHeadless', role: 'binary analysis (Ghidra headless)' },
  { name: 'armor-java', rel: 'tools/jdk/bin/java', role: "Ghidra's bundled Java runtime" },
  { name: 'armor-rea', rel: 'rea/rea.mjs', role: 'REA lexical risk scanner (run with node)', runner: 'node' },
];

export function discoverArmorToolkit({ candidates = null, roots = null, authenticate = candidates === null && roots === null } = {}) {
  // The real install is AUTHENTICATED first (lib/armor-connection.mjs: pinned Developer ID signature, or the owner's
  // pin), so BUNDLE.json's tool pins are only trusted when BUNDLE.json itself is. Explicit roots/candidates are test seams.
  if (authenticate) {
    try { const a = verifyInstalledArmor(); roots = [a.root]; }
    catch (e) { return { status: e.code === 'ARMOR_MISSING' ? 'armor-not-installed' : 'armor-unauthenticated', code: e.code, detail: e.message, tools: [] }; }
  }
  candidates ??= ARMOR_APP_CANDIDATES();
  // `roots` (bundle roots) takes precedence; `candidates` (.app paths, macOS) is kept for existing callers.
  const rootList = roots ?? candidates.map((c) => (c.endsWith('.app') ? join(c, 'Contents', 'Resources', 'armor') : c));
  const root = rootList.find((r) => existsSync(join(r, 'BUNDLE.json')));
  if (!root) return { status: 'armor-not-installed', detail: `Scripture Armor is not installed (looked in ${rootList.join(', ')}). Kingmaker cannot use Armor's tools until it is.`, tools: [] };
  const app = root.endsWith(join('Contents', 'Resources', 'armor')) ? root.slice(0, -join('Contents', 'Resources', 'armor').length - 1) : null;
  let version = null; try { version = app ? (readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8').match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1] ?? null) : null; } catch { /* unknown */ }
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
  // Little Brother is verified ONLY by Armor's own verifier (discoverLittleBrother, async). The sync path never trusts
  // the manifest by itself: it reports the toolkit present-but-unverified and registers none of its tools.
  const lb = existsSync(join(root, LB_TOOLKIT_MANIFEST))
    ? { status: 'present-unverified', detail: 'Little Brother toolkit present; run discoverLittleBrother() so Armor\'s own verifier checks it in place.', tools: [] }
    : { status: 'absent', detail: `This Scripture Armor ${version ?? ''} build ships no Little Brother toolkit (${LB_TOOLKIT_MANIFEST} missing): only the integration bridge. Little Brother tools are unavailable to Kingmaker until Armor ships them.`, tools: [] };
  return { status: 'armor-installed', app, version, root, bundleRoot: root, bundleFiles: bundle.files?.length ?? 0, tools: [...tools, ...lb.tools], littleBrother: { status: lb.status, detail: lb.detail ?? null } };
}

/** Register Armor's VERIFIED tools in Kingmaker's tool registry, pointing into Armor's bundle (no copies). */
export function registerArmorTools(state, found = discoverArmorToolkit()) {
  const regPath = join(state, 'abilities', 'tools.json');
  let reg = { schema: 'kingmaker.selected-tools/1', tools: {} }; try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { /* new */ }
  for (const k of Object.keys(reg.tools)) if (reg.tools[k].provider === 'scripture-armor') delete reg.tools[k];
  const registered = [];
  // 2026-11-17: Armor's Ghidra/JDK are never run in place from Kingmaker — Ghidra writes *.sla.lock beside its language files
  // whenever their folder is writable, which breaks the signed Armor app's seal (observed: 135 files in the installed
  // 1.2.3). Binary analysis goes through Armor's own scan, which runs Ghidra from a verified per-user copy.
  const IN_PLACE_REFUSED = new Set(['armor-ghidra-headless', 'armor-java']);
  for (const t of found.tools.filter((x) => x.verified && !IN_PLACE_REFUSED.has(x.name))) {
    // REA is a library: a tiny shim calls its inspect() on the given targets and prints the verdict as JSON.
    const shim = `const m = await import(${JSON.stringify('file://' + t.path)}); const r = m.inspect(process.argv.slice(1)); console.log(JSON.stringify({ verdict: r.verdict, findings: (r.findings ?? []).map((f) => f.rule) }));`;
    reg.tools[t.name] = { path: t.runner === 'node' ? process.execPath : t.path, args0: t.runner === 'node' ? ['--input-type=module', '-e', shim, '--'] : [],
      // Armor's own non-secret settings for its tools: Ghidra finds Armor's bundled JDK, as Armor itself configures it.
      env: { JAVA_HOME: join(found.root, 'tools', 'jdk') }, provider: 'scripture-armor', armorApp: found.app, armorRoot: found.root, armorRel: relative(found.root, t.path), sha256: t.sha256, role: t.role, usage: 'provided by Scripture Armor' };
    registered.push(t.name);
  }
  mkdirSync(join(state, 'abilities'), { recursive: true, mode: 0o700 }); writeFileSync(regPath, JSON.stringify(reg, null, 2), { mode: 0o600 });
  return { registered, skipped: [...found.tools.filter((x) => !x.verified).map((x) => ({ name: x.name, reason: x.reason })), ...found.tools.filter((x) => x.verified && IN_PLACE_REFUSED.has(x.name)).map((x) => ({ name: x.name, reason: 'runs only inside Scripture Armor (running it in place would write into Armor\'s signed app)' }))] };
}

/** Re-verify an Armor-provided registry entry right before it runs (the runner refuses on mismatch). */
export function verifyArmorEntry(entry) {
  if (entry?.provider !== 'scripture-armor') return { ok: true };
  const p = join(entry.armorRoot ?? join(entry.armorApp, 'Contents', 'Resources', 'armor'), entry.armorRel);
  if (!existsSync(p)) return { ok: false, reason: `Scripture Armor's ${entry.armorRel} is no longer installed` };
  const got = sha(p);
  return got === entry.sha256 ? { ok: true } : { ok: false, reason: `Scripture Armor's ${entry.armorRel} changed since it was verified (sha256 ${got.slice(0, 12)}…) — refused; rerun discovery` };
}

/** Import one of Armor's OWN modules only after its bytes match Armor's BUNDLE.json pin (Kingmaker never runs unpinned
 *  Armor code). Returns the module or throws ARMOR_MODULE_UNPINNED. */
export async function importPinnedArmorModule(bundleRoot, rel) {
  const bundle = JSON.parse(readFileSync(join(bundleRoot, 'BUNDLE.json'), 'utf8'));
  const pin = (bundle.files ?? []).find((f) => f.path === rel);
  const file = join(bundleRoot, rel);
  if (!pin || !existsSync(file) || sha(file) !== pin.sha256) { const e = new Error(`Scripture Armor's ${rel} is ${!pin ? 'not pinned in BUNDLE.json' : !existsSync(file) ? 'missing' : 'modified (does not match its pin)'} — refused`); e.code = 'ARMOR_MODULE_UNPINNED'; throw e; }
  return import(`${pathToFileURL(file).href}?sha=${pin.sha256.slice(0, 16)}`);
}

/** Little Brother through ARMOR'S verifier (lb-toolkit.mjs loadPackagedToolkit), in place. Pointers only, no copies. */
export async function discoverLittleBrother({ found = discoverArmorToolkit(), platform = `${process.platform}-${process.arch}` } = {}) {
  if (found.status !== 'armor-installed') return { status: found.status, detail: found.detail, tools: [] };
  if (!existsSync(join(found.root, LB_TOOLKIT_MANIFEST))) return { status: 'absent', detail: found.littleBrother?.detail, tools: [] };
  let mod; try { mod = await importPinnedArmorModule(found.root, 'lb-toolkit.mjs'); } catch (e) { return { status: 'refused', reasons: [e.message], tools: [] }; }
  const tk = mod.loadPackagedToolkit({ bundleRoot: found.root, platform });
  if (tk.status !== 'verified') return { status: tk.status, reasons: tk.reasons, tools: [] };
  return { status: 'verified', platform, bundleRoot: found.root, binDir: tk.binDir,
    tools: Object.entries(tk.tools).map(([name, t]) => ({ name: `lb-${name}`, path: t.path, rel: relative(found.root, t.path), sha256: t.sha256, version: t.version, licence: t.licence, provider: 'scripture-armor', verified: true, role: 'Little Brother tool (run through Armor\'s engine)' })) };
}

/** Run Little Brother ONLY through Armor's packaged engine (scope enforcement and PATH isolation stay Armor's). */
/** REMOVED PATH (2026-11-17): Kingmaker no longer imports Armor's Little Brother engine into its own process — that would
 *  run Armor's tools without Armor's entitlement + scope boundary. Use lib/armor-little-brother.mjs (lb-host/2 as a
 *  separate Armor process: littleBrotherAccess / runLittleBrother). */
export async function armorLittleBrotherEngine() {
  throw new Error('LB_IN_PROCESS_REFUSED: Little Brother runs only as a separate Scripture Armor process (lib/armor-little-brother.mjs, scripture-armor.lb-host/2), where Armor checks entitlement and the approved scope');
}
