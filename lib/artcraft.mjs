// The ArtCraft apps on Kingmaker: the seven open-source creative CLIs the engine's ArtCraft adapter drives,
// installed where that adapter finds them, reported by the doctor, and reached from the CLI and the MCP surface
// only THROUGH Kingmaker's governed engine.
//
// Where they live: Kingmaker's own data root, <runtime home>/data/artcraft/bin, which is also the adapter's own
// fallback folder, so a Kingmaker started before an install finds them too. Every start also hands the backend
// SOLOMON_ARTCRAFT_BIN_DIR (that folder) and, for each app this module installed, SOLOMON_<APP>_CLI_SHA256 (the
// adapter's binary pin: a binary that changed since the install is refused, never run). The operator's own
// environment wins for all of these.
//
// Building: there are no published binaries. `kingmaker craft install` fetches each repo at the commit the
// adapter's evaluation verified, builds `<app>-cli` with cargo ONE AT A TIME at low priority, paced like every
// other Ghost background job (pacer.mjs), and only once nothing else heavy is building (the Kingmaker packager,
// another cargo) and memory pressure is not critical. It waits for room; it never gives up for a busy Mac. While it
// runs it backs off for real distress only (buildSignals): nice already shares the CPU.
//
// Never here: running an app, re-exporting an app's own `<app>-cli mcp` server, or trusting an app's readOnlyHint.
// (`vectorcraft-cli mcp` with no flags attaches to an unauthenticated 127.0.0.1:7979, often the owner's open app;
// VectorCraft `screenshot` and DesignCraft `render_page` say readOnlyHint yet write a file when given a path.)
// Every job is a sentence to the engine, which reads a write back and runs it only on the owner's word.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs';
import { totalmem } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { liveSignalSource, pacerFor, parsePressureLevel } from './pacer.mjs';
import { meetingHold } from './meeting.mjs';

/**
 * The seven apps, at the commits the engine's ArtCraft evaluation built and ran (its verified commits, evaluated
 * 2026-10-06). Each is MIT OR Apache-2.0. PrintCraft's repo was renamed upstream to
 * storytold/pdfcraft; at the pinned commit its CLI is still `printcraft-cli`, the name the adapter looks for.
 * `ask` is the job the adapter does for that app, said the way the operator would say it.
 */
export const CRAFT_APPS = Object.freeze([
  { id: 'photocraft', name: 'PhotoCraft', cli: 'photocraft-cli', repo: 'https://github.com/storytold/photocraft', commit: '909efc0f6df0a684d270019384e355c850642e42', version: '0.2.0', serves: 'blog / Instagram images', ask: 'make a carousel image', input: 'an image' },
  { id: 'vectorcraft', name: 'VectorCraft', cli: 'vectorcraft-cli', repo: 'https://github.com/storytold/vectorcraft', commit: 'aafd565b99f958ede843a357904ef3819df714da', version: '0.3.1', serves: 'thumbnails', ask: 'make a thumbnail', input: null },
  { id: 'filmcraft', name: 'FilmCraft', cli: 'filmcraft-cli', repo: 'https://github.com/storytold/filmcraft', commit: '771b614ad4c3fbefda5d668ce4384504b8c13f6d', version: '0.2.1', serves: 'Ronin Clipper / Content Studio reels', ask: 'cut a 15 second reel', input: 'a video clip' },
  { id: 'lightcraft', name: 'LightCraft', cli: 'lightcraft-cli', repo: 'https://github.com/storytold/lightcraft', commit: '265248c86fa3267709aea45633d0d135331e180c', version: '0.2.1', serves: 'media library', ask: 'ingest the photos', input: 'a folder of photos' },
  { id: 'effectcraft', name: 'EffectCraft', cli: 'effectcraft-cli', repo: 'https://github.com/storytold/effectcraft', commit: '2fadd14f09bb064cab8f1f8fe85af601a08b6e53', version: '0.3.1', serves: 'reel motion graphics', ask: 'make a title card', input: null },
  { id: 'printcraft', name: 'PrintCraft', cli: 'printcraft-cli', repo: 'https://github.com/storytold/pdfcraft', commit: '55c581760ab389b88f08997ab235eecdf1a1b002', version: '0.2.1', serves: 'PDF deliverables', ask: 'make a PDF', input: 'a .txt or .md file (or a PDF to read)' },
  { id: 'designcraft', name: 'DesignCraft', cli: 'designcraft-cli', repo: 'https://github.com/storytold/designcraft', commit: 'd582277cc79c4bc9cee174b25b13fb11e6957aa5', version: '0.2.1', serves: 'one-pagers', ask: 'lay out a one-pager', input: 'a .txt or .md file (headline first)' },
]);
export const CRAFT_APP_IDS = Object.freeze(CRAFT_APPS.map((a) => a.id));

/** What this build of LightCraft cannot do (upstream review 2026-10-07), said wherever LightCraft is offered. */
export const LIGHTCRAFT_LIMITS = 'HEIC and AVIF do not decode in this build, and its folder import skips Nikon .nrw files.';
const LIGHTCRAFT_UNDECODABLE = new Set(['.heic', '.heif', '.avif']);

/** "photocraft", "PhotoCraft", "photo-craft", "photo" → the app, or null. Pure. */
export function craftApp(word) {
  const w = String(word ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return CRAFT_APPS.find((a) => a.id === w || a.id === `${w}craft` || a.cli.replace(/-/g, '') === w || (a.id === 'printcraft' && (w === 'pdfcraft' || w === 'pdf'))) ?? null;
}

// ── Where things are ────────────────────────────────────────────────────────────────────────────────

/** The engine's data root for this Kingmaker (getDataRoot in the core: SOLOMON_DATA_DIR, else <runtime home>/data). */
export function craftDataRoot(paths, env = process.env) {
  const override = String(env.SOLOMON_DATA_DIR ?? '').trim();
  if (override) return isAbsolute(override) ? override : resolve(paths.runtimeHome, override);
  return join(paths.runtimeHome, 'data');
}

/** The Ghost-managed bin folder (the operator's absolute SOLOMON_ARTCRAFT_BIN_DIR wins). */
export function craftBinDir(paths, env = process.env) {
  const own = String(env.SOLOMON_ARTCRAFT_BIN_DIR ?? '').trim();
  return own && isAbsolute(own) ? own : join(craftDataRoot(paths, env), 'artcraft', 'bin');
}

/** Where ArtCraft jobs read their inputs (the adapter only reads inside the data root). */
export const craftInboxDir = (paths, env = process.env) => join(craftDataRoot(paths, env), 'artcraft', 'inbox');

/** Clones and cargo target folders while building (Kingmaker's own state, never the data root). */
export const craftWorkDir = (paths) => join(paths.state, 'artcraft-build');

export const CRAFT_MANIFEST = 'sol-ghost-craft.json';
export const CRAFT_MANIFEST_SCHEMA = 'sol-ghost.artcraft.install/1';

export function readCraftManifest(binDir, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const m = JSON.parse(read(join(binDir, CRAFT_MANIFEST)));
    return m && typeof m === 'object' && m.apps && typeof m.apps === 'object' ? m : { schema: CRAFT_MANIFEST_SCHEMA, apps: {} };
  } catch { return { schema: CRAFT_MANIFEST_SCHEMA, apps: {} }; }
}

function writeCraftManifest(binDir, manifest) {
  const path = join(binDir, CRAFT_MANIFEST);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

const pinKey = (app) => `SOLOMON_${app.id.toUpperCase()}_CLI_SHA256`;
const binKey = (app) => `SOLOMON_${app.id.toUpperCase()}_CLI`;
export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The ArtCraft part of the backend's environment: the bin folder, and a sha256 pin for every app this module
 * installed whose binary is there. The adapter then refuses any binary that changed since (PIN_MISMATCH). No
 * hashing here (a start must stay fast): the adapter hashes the bytes right before every run.
 */
export function craftBackendEnv(paths, env = process.env, { manifest, exists = isFile } = {}) {
  const binDir = craftBinDir(paths, env);
  const m = manifest ?? readCraftManifest(binDir);
  const out = { SOLOMON_ARTCRAFT_BIN_DIR: binDir };
  for (const app of CRAFT_APPS) {
    const rec = m.apps?.[app.id];
    if (rec && /^[0-9a-f]{64}$/.test(String(rec.sha256 ?? '')) && exists(join(binDir, app.cli))) out[pinKey(app)] = rec.sha256;
  }
  return out;
}

/** sha256 of a file, streamed (a release binary is tens of MB; nothing is read whole). */
export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolveHash(hash.digest('hex')));
  });
}

// ── The doctor ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Every app's state as the engine will see it from the environment Kingmaker starts it with: the adapter's own order
 * (SOLOMON_<APP>_CLI → SOLOMON_ARTCRAFT_BIN_DIR → <data root>/artcraft/bin → PATH). Filesystem and hashing only:
 * nothing is run. Version and commit come from the install record; a binary that no longer matches that record (or
 * the operator's pin) is named, with the line that fixes it.
 */
export async function craftDoctor(paths, env = process.env, { exists = isFile, hash = sha256File, manifest } = {}) {
  const binDir = craftBinDir(paths, env);
  const m = manifest ?? readCraftManifest(binDir);
  const ownBin = join(craftDataRoot(paths, env), 'artcraft', 'bin');
  const searchPath = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', ...String(env.PATH ?? '').split(delimiter).filter(Boolean)])];
  const rows = [];
  for (const app of CRAFT_APPS) {
    const fix = `kingmaker craft install ${app.id}`;
    const explicit = String(env[binKey(app)] ?? '').trim();
    let bin = null;
    let source = null;
    if (explicit) {
      if (isAbsolute(explicit) && exists(explicit)) { bin = explicit; source = binKey(app); }
      else { rows.push({ app: app.id, name: app.name, state: 'missing', line: `${app.name}: ${binKey(app)} is set to ${explicit}, which is not a file`, fix: `unset ${binKey(app)}, then: ${fix}` }); continue; }
    }
    if (!bin && exists(join(binDir, app.cli))) { bin = join(binDir, app.cli); source = 'sol-ghost'; }
    if (!bin && exists(join(ownBin, app.cli))) { bin = join(ownBin, app.cli); source = 'data root'; }
    if (!bin) { const dir = searchPath.find((d) => isAbsolute(d) && exists(join(d, app.cli))); if (dir) { bin = join(dir, app.cli); source = 'PATH'; } }
    if (!bin) { rows.push({ app: app.id, name: app.name, state: 'missing', line: `${app.name}: not installed (${app.serves})`, fix }); continue; }
    let sha = null;
    try { sha = await hash(bin); } catch { /* reported below */ }
    const rec = bin === join(binDir, app.cli) ? m.apps?.[app.id] ?? null : null;
    const operatorPin = String(env[pinKey(app)] ?? '').trim().toLowerCase();
    const pin = operatorPin || rec?.sha256 || null;
    const short = sha ? `${sha.slice(0, 12)}…` : 'unreadable';
    const version = rec ? `${rec.version} (${String(rec.commit).slice(0, 7)})` : 'version unknown (not installed by Kingmaker)';
    if (!sha) { rows.push({ app: app.id, name: app.name, state: 'unreadable', bin, source, line: `${app.name}: ${bin} could not be read`, fix }); continue; }
    if (pin && pin !== sha) {
      const whose = operatorPin ? `the pin ${pinKey(app)}` : 'what Kingmaker installed';
      rows.push({ app: app.id, name: app.name, state: 'pin-mismatch', bin, source, sha256: sha, line: `${app.name}: ${bin} is ${short}, not ${whose} (${pin.slice(0, 12)}…), so the engine will refuse to run it`, fix: operatorPin ? `set ${pinKey(app)}=${sha}, or: ${fix}` : fix });
      continue;
    }
    rows.push({ app: app.id, name: app.name, state: 'found', bin, source, sha256: sha, pinned: Boolean(pin), version: rec?.version ?? null, commit: rec?.commit ?? null, line: `${app.name} ${version}: ${bin} (sha256 ${short}${pin ? ', pinned' : ''}) — ${app.serves}` });
  }
  return { binDir, rows, found: rows.filter((r) => r.state === 'found').length };
}

/** Pure: the doctor's lines (✓ found, ✗ with its fix), like the engine's own "ArtCraft status". */
export function craftDoctorLines(report) {
  const lines = [`${report.found === CRAFT_APPS.length ? '✓' : '·'} ArtCraft apps: ${report.found} of ${CRAFT_APPS.length} installed (${report.binDir})`];
  for (const r of report.rows) {
    lines.push(r.state === 'found' ? `  ✓ ${r.line}` : `  ✗ ${r.line}\n      → ${r.fix}`);
    if (r.app === 'lightcraft' && r.state === 'found') lines.push(`      ! LightCraft: ${LIGHTCRAFT_LIMITS}`);
  }
  const missing = report.rows.filter((r) => r.state === 'missing').map((r) => r.app);
  if (missing.length > 1) lines.push(`  → all missing ones, one at a time: kingmaker craft install ${missing.join(' ')}`);
  return lines;
}

/** Pure: the engine's own view (GET /api/artcraft/doctor data) in one line. */
export function engineCraftLine(data, port) {
  if (!Array.isArray(data)) return `The engine on :${port}: no ArtCraft report (is this build older than the ArtCraft adapter?)`;
  const ready = data.filter((r) => r?.ok);
  const refused = data.filter((r) => r?.state === 'PIN_MISMATCH');
  return `The engine on :${port} sees ${ready.length} of ${data.length}${ready.length ? `: ${ready.map((r) => `${r.name}${r.pinned ? ' (pinned)' : ''}`).join(', ')}` : ''}${refused.length ? `; refused (pin mismatch): ${refused.map((r) => r.name).join(', ')}` : ''}.`;
}

// ── Asking the engine (the only way a job runs) ─────────────────────────────────────────────────────

const ACTION_VERB = /\b(?:cut|trim|clip|make|create|generate|build|render|edit|resize|crop|lay\s+out|layout|design|draw|turn|convert|export|probe|inspect|check|read|open|ingest|import|give\s+me|do)\b/i;
/** First words that would mean "run the app's own CLI or MCP server": never passed through. */
const RAW_SUBCOMMAND = /^(?:mcp|run|exec|serve|script|--?[a-z])/i;

/**
 * Pure: the sentence the engine hears for `craft <app> …`. Its ArtCraft lane takes an app NAMED with an action
 * ("PhotoCraft, make a carousel image from beach.jpg that says "Summer""). No words → the app's own job.
 * Returns { text } or { error }.
 */
export function craftTurnText(app, words = [], { says = null, inputName = null } = {}) {
  const asked = (Array.isArray(words) ? words.join(' ') : String(words ?? '')).replace(/\s+/g, ' ').trim();
  if (RAW_SUBCOMMAND.test(asked)) {
    return { error: `kingmaker craft speaks to the engine in words; it never runs ${app.cli} or its MCP server directly. Say what to make, e.g.: kingmaker craft ${app.id} ${app.ask}` };
  }
  // "what's in proposal.pdf" is the app's read, though it has no verb (the adapter reads it that way too).
  let text = asked ? (ACTION_VERB.test(asked) || /\bwhat(?:'s|\s+is)\s+in\b/i.test(asked) ? asked : `${app.ask} ${asked}`) : app.ask;
  if (inputName && !text.toLowerCase().includes(inputName.toLowerCase())) text += ` from ${inputName}`;
  const quote = String(says ?? '').replace(/["“”]/g, '').trim();
  if (quote) text += ` that says "${quote}"`;
  return { text: `${app.name}, ${text}` };
}

/**
 * Pure: what a request does, from its words (never from a tool's own readOnlyHint): 'status' (the install check),
 * 'read' (PrintCraft reading a PDF, FilmCraft probing a clip: the engine runs it contained and answers) or 'write'
 * (anything that makes a file: the engine reads it back and it waits for the owner's word). Unknown → 'write'.
 */
export function classifyCraftAsk(app, text) {
  const t = String(text ?? '');
  if (/\bstatus\b/i.test(t) && !/\bstatus\s+(?:report|update|card|page|sheet|post|board)\b/i.test(t)) return 'status';
  if (app?.id === 'filmcraft' && /\b(?:probe|inspect|check|what(?:'s| is)\s+in)\b/i.test(t) && !/\b(?:cut|trim|reel)\b/i.test(t)) return 'read';
  if (app?.id === 'printcraft' && /\b(?:what(?:'s| is)\s+in|read|inspect|check|open)\b/i.test(t) && /\.pdf\b|\bpdf\b/i.test(t) && !/\b(?:make|create|turn|generate|build)\b/i.test(t)) return 'read';
  return 'write';
}

/**
 * Copy an input into the ArtCraft inbox, where the engine's adapter may read it (it reads nothing outside its data
 * root). The same bytes already there under that name are reused; a different file keeps both (name-2.ext).
 * LightCraft's limits are counted and said, never discovered later. → { name, path, reused, notes }
 */
export async function stageCraftInput(src, inbox, { app } = {}) {
  const from = resolve(String(src ?? ''));
  let st;
  try { st = statSync(from); } catch { throw new Error(`${src} does not exist.`); }
  if (app?.id === 'lightcraft' ? !st.isDirectory() : !st.isFile()) throw new Error(`${src} is not a ${app?.id === 'lightcraft' ? 'folder' : 'file'}${app ? ` for ${app.name}` : ''}.`);
  mkdirSync(inbox, { recursive: true });
  const notes = [];
  if (app?.id === 'lightcraft') {
    const names = readdirSync(from);
    const undecodable = names.filter((n) => LIGHTCRAFT_UNDECODABLE.has(extname(n).toLowerCase())).length;
    const nrw = names.filter((n) => extname(n).toLowerCase() === '.nrw').length;
    if (undecodable) notes.push(`${undecodable} HEIC/AVIF file${undecodable === 1 ? '' : 's'} will not import: LightCraft cannot decode them in this build.`);
    if (nrw) notes.push(`${nrw} Nikon .nrw file${nrw === 1 ? '' : 's'} will be skipped: LightCraft's folder import does not take .nrw yet.`);
  }
  const ext = st.isDirectory() ? '' : extname(from);
  const stem = basename(from, ext);
  for (let n = 1; n < 1000; n += 1) {
    const name = n === 1 ? basename(from) : `${stem}-${n}${ext}`;
    const dest = join(inbox, name);
    if (!existsSync(dest)) {
      if (st.isDirectory()) cpSync(from, dest, { recursive: true });
      else copyFileSync(from, dest);
      return { name, path: dest, reused: false, notes };
    }
    if (st.isFile() && isFile(dest) && statSync(dest).size === st.size && await sha256File(dest) === await sha256File(from)) return { name, path: dest, reused: true, notes };
  }
  throw new Error(`The ArtCraft inbox already holds too many files named like ${basename(from)}.`);
}

// ── Building ────────────────────────────────────────────────────────────────────────────────────────

/** The disk a build needs (one cargo target folder at a time, removed after its binary is copied). Physics, not a budget. */
export const DISK_FLOOR_BYTES = 4 * 2 ** 30;
/** Waiting for room: the busy job and the pressure are re-read on this backoff. No OS event reports "another
 *  program's build finished" or "memory pressure changed" to Node, so this bounded fallback is the only way; it
 *  never gives up (a busy Mac makes a build wait, never fail). */
export const ROOM_BACKOFF_MS = Object.freeze([5_000, 15_000, 30_000, 60_000]);

const BUSY = [
  { re: /\bpackage:ghost\b/, label: 'npm run package:ghost' },
  { re: /solomon-package-ghost/, label: 'the Kingmaker packager' },
  { re: /^(?:\S*\/)?cargo\s+(?:build|install|rustc|test|run|bench|check|clippy|doc)\b/, label: 'another cargo build' },
  { re: /^(?:\S*\/)?rustc\s/, label: 'rustc' },
  // A background Blender render (the engine's Titan lane). The always-warm Ollama runner is not waited on: it never ends.
  { re: /\/Blender(?:\.app\/Contents\/MacOS\/Blender)?\s(?:.*\s)?(?:-b|--background)\b/i, label: 'a Blender render' },
];

/** Pure: heavy jobs in `ps -axo pid=,command=` output that a build must not run beside (never our own pids). */
export function busyJobs(psText, selfPids = new Set()) {
  const out = [];
  for (const raw of String(psText ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(raw);
    if (!m || selfPids.has(Number(m[1]))) continue;
    const command = m[2].trim();
    if (/^(?:\S*\/)?(?:ps|grep|pgrep)\s/.test(command)) continue;
    const hit = BUSY.find((b) => b.re.test(command));
    if (hit && !out.some((o) => o.label === hit.label)) out.push({ pid: Number(m[1]), label: hit.label });
  }
  return out;
}

/** Pure: why a build cannot start right now ([] = room). */
export function roomReasons({ busy = [], pressure = 'normal', freeBytes = Infinity, meeting = false } = {}) {
  const reasons = busy.map((b) => `${b.label} is running (pid ${b.pid})`);
  if (meeting) reasons.unshift('the owner meeting hold is on');
  if (pressure === 'critical') reasons.push('memory pressure is critical');
  return { wait: reasons, diskLow: freeBytes < DISK_FLOOR_BYTES };
}

const execText = (file, args) => new Promise((done) => {
  execFile(file, args, { timeout: 10_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => done(error ? '' : String(stdout)));
});

/** The live host reading: other heavy jobs, the kernel's memory-pressure level, free disk where we build. */
export async function sampleHost(workDir, { selfPids = new Set([process.pid]) } = {}) {
  const [ps, level] = await Promise.all([execText('/bin/ps', ['-axo', 'pid=,command=']), execText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])]);
  let freeBytes = Infinity;
  try { mkdirSync(workDir, { recursive: true }); const s = statfsSync(workDir); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* unknown: no floor applied */ }
  return { busy: busyJobs(ps, selfPids), pressure: parsePressureLevel(level), freeBytes };
}

/** Wait until nothing else heavy runs and memory pressure is not critical. Never gives up; `signal` ends it. */
export async function waitForRoom({ sample, out = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal } = {}) {
  let said = '';
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new Error('cancelled');
    const s = await sample();
    const room = roomReasons(s);
    if (room.diskLow) return { ok: false, freeBytes: s.freeBytes };
    if (!room.wait.length) return { ok: true, freeBytes: s.freeBytes, waited: attempt > 0 };
    const why = room.wait.join('; ');
    if (why !== said) { out(`  waiting for room: ${why}. The build starts when it is done.`); said = why; }
    await sleep(ROOM_BACKOFF_MS[Math.min(attempt, ROOM_BACKOFF_MS.length - 1)]);
  }
}

/** Parallel rustc jobs: 2 on an 8 GB Mac (each can take ~1 GB), up to 4 with more memory. */
export function defaultJobs(memBytes = totalmem()) {
  return Math.max(1, Math.min(4, Math.floor(memBytes / 2 ** 30 / 4)));
}

export function findCargo(env = process.env, exists = isFile) {
  const own = String(env.SOL_GHOST_CARGO ?? '').trim();
  if (own) return exists(own) ? own : null;
  const home = String(env.HOME ?? '');
  const dirs = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', ...(home ? [join(home, '.cargo', 'bin')] : []), ...String(env.PATH ?? '').split(delimiter).filter(Boolean)])];
  return dirs.map((d) => join(d, 'cargo')).find((p) => exists(p)) ?? null;
}

/** Pure: the build's argv: low priority (nice 15), release, the locked dependency set, only the CLI package. */
export function cargoBuildArgv(app, { cargo, jobs }) {
  return ['/usr/bin/nice', '-n', '15', cargo, 'build', '--release', '--locked', '-p', app.cli, '-j', String(jobs)];
}

/** Pure: the build's environment. No LTO and 16 codegen units (as the evaluation built six of the seven): far less
 *  memory per rustc on an 8 GB Mac, same code, slightly slower binaries. */
export function cargoBuildEnv(env, targetDir) {
  return {
    ...env,
    CARGO_TARGET_DIR: targetDir,
    CARGO_PROFILE_RELEASE_LTO: 'off',
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
    CARGO_INCREMENTAL: '0',
    CARGO_TERM_COLOR: 'never',
    CARGO_TERM_PROGRESS_WHEN: 'never',
  };
}
export const BUILD_PROFILE = 'release, lto off, codegen-units 16, nice 15, paced on distress';

/** Pure: the workspace version from a Cargo.toml ([workspace.package] version, else [package] version). */
export function cargoVersion(toml) {
  let section = '';
  const found = {};
  for (const line of String(toml ?? '').split('\n')) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) { section = head[1].trim(); continue; }
    const v = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (v && (section === 'workspace.package' || section === 'package') && !found[section]) found[section] = v[1];
  }
  return found['workspace.package'] ?? found.package ?? null;
}

/** One git command (argv only, never a shell). */
function liveGit(args, { cwd }) {
  return new Promise((done) => {
    execFile('git', ['-c', 'advice.detachedHead=false', ...args], { cwd, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') });
    });
  });
}

/**
 * Pure: the signals a build is paced on. A build already runs at nice 15, so sharing the CPU is the scheduler's job
 * (and the pacer's "CPU busy" reading would count the build's own rustc and saw it down to the floor). The kernel's
 * "warning" pressure level is this 8 GB Mac's steady state with the engine up: pacing on it held a build at the 10% floor
 * (6 crates in 7 minutes, measured 2026-10-08) while paging was ~4 MB/s. So a build backs off for real distress:
 * critical pressure (straight to the floor), paging over 8 MB/s, or heat; it grows back with headroom.
 */
export function buildSignals(s) {
  return { ...s, pressureLevel: s.pressureLevel === 'warning' ? 'normal' : s.pressureLevel, cpuIdle: null };
}

/** The live signal source, filtered for a build (buildSignals). */
function buildSignalSource(source = liveSignalSource()) {
  return { subscribe: (fn) => source.subscribe((s) => fn(buildSignals(s))) };
}

/**
 * Run cargo in its own process group, paced (pacer.mjs: a duty cycle that halves under distress and grows back with
 * headroom; buildSignals says what distress is for a build). Calls onLine per output line. Resolves { code, tail }.
 * The group is always left RUNNING and is killed if Kingmaker's CLI exits first.
 */
function liveBuild({ argv, cwd, env, onLine = () => {}, onPace = () => {} }) {
  return new Promise((done) => {
    let child;
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { done({ code: -1, tail: String(error?.message ?? error) }); return; }
    const pacer = pacerFor(child.pid, { source: buildSignalSource(), onChange: onPace });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGCONT'); process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
    process.once('exit', killGroup);
    const onSignal = () => { killGroup(); process.exit(130); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    pacer.start();
    const tail = [];
    let buffer = '';
    const take = (chunk) => {
      buffer += String(chunk);
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).trimEnd();
        buffer = buffer.slice(cut + 1);
        tail.push(line); if (tail.length > 40) tail.shift();
        try { onLine(line); } catch { /* reporting only */ }
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (code) => {
      pacer.stop();
      process.off('exit', killGroup);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      done({ code, tail: tail.join('\n') });
    };
    child.on('error', (error) => { tail.push(String(error?.message ?? error)); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });
}

const minutes = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const gb = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** The source at exactly the pinned commit: reused when it is already there and clean, else fetched (depth 1). */
async function fetchSource(app, srcDir, git) {
  if (existsSync(join(srcDir, '.git'))) {
    const head = await git(['rev-parse', 'HEAD'], { cwd: srcDir });
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'], { cwd: srcDir });
    if (head.code === 0 && head.stdout.trim() === app.commit && dirty.code === 0 && !dirty.stdout.trim()) return { ok: true, reused: true };
    rmSync(srcDir, { recursive: true, force: true });
  }
  mkdirSync(srcDir, { recursive: true });
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', app.repo], ['fetch', '-q', '--depth', '1', 'origin', app.commit], ['checkout', '-q', '--detach', 'FETCH_HEAD']]) {
    const r = await git(args, { cwd: srcDir });
    if (r.code !== 0) return { ok: false, reason: `git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}` };
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: srcDir });
  if (head.code !== 0 || head.stdout.trim() !== app.commit) return { ok: false, reason: `the clone is at ${head.stdout.trim() || '?'}, not the pinned ${app.commit}` };
  return { ok: true, reused: false };
}

/**
 * Install apps, one at a time: wait for room → fetch the pinned commit → `cargo build --release -p <app>-cli` (nice,
 * paced) → copy the binary into the bin folder (atomic rename) → record its sha256, commit and version → remove the
 * clone and target folder (unless keepBuild). A failed app is reported and the next one still runs; a disk below the
 * floor stops the run with the apps still to do.
 * `deps` (tests): git, build, sample, sleep, now, alive, hash.
 */
export async function installCraftApps(ids, { binDir, workDir, out = (line) => console.log(line), jobs = defaultJobs(), keepBuild = false, env = process.env, deps = {} } = {}) {
  const git = deps.git ?? liveGit;
  const build = deps.build ?? liveBuild;
  const sample = deps.sample ?? (() => sampleHost(workDir));
  const inMeeting = deps.inMeeting ?? (() => meetingHold({ state: dirname(workDir) }).active);
  const admissionSample = async () => ({ ...(await sample()), meeting: Boolean(inMeeting()) });
  const now = deps.now ?? Date.now;
  const hash = deps.hash ?? sha256File;
  const alive = deps.alive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } });
  const apps = ids.map((id) => craftApp(id)).filter(Boolean);
  const result = { ok: true, installed: [], failed: [], notStarted: [] };
  const cargo = deps.build ? 'cargo' : findCargo(env);
  if (!cargo) { out('✗ cargo is not installed. Install Rust (brew install rust), then run this again.'); return { ...result, ok: false, notStarted: apps.map((a) => a.id) }; }

  mkdirSync(workDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // One installer at a time (two would build in parallel, which is exactly what an 8 GB Mac cannot take).
  const lockPath = join(workDir, 'install.lock');
  try {
    const held = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(held?.pid) && held.pid !== process.pid && alive(held.pid)) {
      out(`✗ Another kingmaker craft install (pid ${held.pid}) is building. It installs one app at a time; run this again when it is done.`);
      return { ...result, ok: false, notStarted: apps.map((a) => a.id) };
    }
  } catch { /* no lock */ }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString(), apps: apps.map((a) => a.id) }));
  try {
    for (const [i, app] of apps.entries()) {
      const tag = `[${i + 1}/${apps.length}] ${app.name}`;
      out(`${tag}: checking for room to build…`);
      const room = await waitForRoom({ sample: admissionSample, out, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
      if (!room.ok) {
        out(`✗ ${tag}: only ${gb(room.freeBytes)} free on this disk; a build needs about ${gb(DISK_FLOOR_BYTES)}. Free some space, then: kingmaker craft install ${apps.slice(i).map((a) => a.id).join(' ')}`);
        result.ok = false;
        result.notStarted.push(...apps.slice(i).map((a) => a.id));
        break;
      }
      const srcDir = join(workDir, 'src', app.id);
      const targetDir = join(workDir, 'target', app.id);
      const started = now();
      const fail = (reason) => { out(`✗ ${tag}: ${reason}`); result.ok = false; result.failed.push({ id: app.id, reason }); };
      try {
        out(`${tag}: fetching ${app.repo} at ${app.commit.slice(0, 7)}…`);
        const src = await fetchSource(app, srcDir, git);
        if (!src.ok) { fail(src.reason); continue; }
        if (src.reused) out(`  ${app.name}: the clone from the last attempt is already at ${app.commit.slice(0, 7)}, kept.`);
        // Fetching can outlast the first admission reading. Recheck immediately before the first heavy process is
        // spawned, closing the pacer's pre-first-sample window.
        const buildRoom = await waitForRoom({ sample: admissionSample, out, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
        if (!buildRoom.ok) {
          result.ok = false; result.notStarted.push(...apps.slice(i).map((a) => a.id));
          break;
        }
        let version = null;
        try { version = cargoVersion(readFileSync(join(srcDir, 'Cargo.toml'), 'utf8')); } catch { /* recorded as unknown */ }
        out(`${tag}: building ${app.cli} ${version ?? app.version} (${jobs} job${jobs === 1 ? '' : 's'}, low priority, paced; this takes minutes)…`);
        let crates = 0;
        let lastSaid = now();
        let lastPace = 0;
        const built = await build({
          argv: cargoBuildArgv(app, { cargo, jobs }), cwd: srcDir, env: cargoBuildEnv(env, targetDir), app,
          onLine: (line) => {
            if (!/^\s*Compiling\s/.test(line)) return;
            crates += 1;
            if (crates % 50 === 0 || now() - lastSaid >= 120_000) { lastSaid = now(); out(`  ${app.name}: ${crates} crates compiled (${minutes(now() - started)})`); }
          },
          onPace: (d) => { if (now() - lastPace >= 60_000) { lastPace = now(); out(`  ${app.name}: paced to ${Math.round(d.duty * 100)}% (${d.why})`); } },
        });
        if (built.code !== 0) { fail(`cargo build exited ${built.code}: ${String(built.tail ?? '').trim().split('\n').filter((l) => /error|warning: unused|failed/i.test(l)).slice(-3).join(' | ') || String(built.tail ?? '').trim().split('\n').slice(-2).join(' | ')}`); continue; }
        const produced = join(targetDir, 'release', app.cli);
        if (!isFile(produced)) { fail(`cargo finished but ${produced} is not there`); continue; }
        const dest = join(binDir, app.cli);
        const staging = `${dest}.${process.pid}.new`;
        copyFileSync(produced, staging);
        chmodSync(staging, 0o755);
        const sha256 = await hash(staging);
        renameSync(staging, dest);
        const bytes = statSync(dest).size;
        const manifest = readCraftManifest(binDir);
        manifest.schema = CRAFT_MANIFEST_SCHEMA;
        manifest.apps[app.id] = { cli: app.cli, repo: app.repo, commit: app.commit, version: version ?? app.version, sha256, bytes, builtAt: new Date(now()).toISOString(), buildMs: now() - started, profile: BUILD_PROFILE, licence: 'MIT OR Apache-2.0' };
        writeCraftManifest(binDir, manifest);
        result.installed.push({ id: app.id, sha256, version: version ?? app.version, commit: app.commit, ms: now() - started, bytes });
        out(`✓ ${tag} ${version ?? app.version} (${app.commit.slice(0, 7)}) installed in ${minutes(now() - started)}: ${dest} (${(bytes / 2 ** 20).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`);
      } catch (error) {
        fail(String(error?.message ?? error));
      } finally {
        if (!keepBuild) { rmSync(targetDir, { recursive: true, force: true }); rmSync(srcDir, { recursive: true, force: true }); }
      }
    }
  } finally {
    rmSync(lockPath, { force: true });
    for (const sub of ['src', 'target']) { try { if (!readdirSync(join(workDir, sub)).length) rmSync(join(workDir, sub), { recursive: true }); } catch { /* not there */ } }
  }
  if (result.installed.length) {
    out(`The engine finds ${result.installed.length === 1 ? 'it' : 'them'} in ${binDir}. A Kingmaker already running finds ${result.installed.length === 1 ? 'it' : 'them'} there now; from its next start each one is also pinned to the sha256 above (a changed binary is refused, never run). Check: kingmaker craft status`);
  }
  return result;
}

/** Remove what a kept build left (`--keep-build`). */
export function cleanCraftWork(workDir) {
  let had = false;
  for (const sub of ['src', 'target']) { const p = join(workDir, sub); if (existsSync(p)) { had = true; rmSync(p, { recursive: true, force: true }); } }
  return had;
}
