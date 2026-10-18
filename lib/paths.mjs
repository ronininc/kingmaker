// Where everything Kingmaker uses lives. Pure except `exists`.
//
// The runtime, first match wins:
//   bundle       a Kingmaker.app that carries the engine's whole runtime inside itself (the engine build:
//                Contents/MacOS/Solomon = Electron's binary used only as Node, Contents/Resources = the
//                desktop's runtimes), so it needs no other app.
//   fork         a git checkout that carries the engine's source (imported with the UI stripped; an
//                operator-only mode): the server runs from that source on this Mac's Node.
//                Native runtimes the source does not build (voice binaries, guardrails, knowledge venv)
//                come from SOL_GHOST_RESOURCES, else the installed app's Resources.
//   borrowed-app otherwise an installed app's runtime (KINGMAKER_RUNTIME_APP, default /Applications).
// SOL_GHOST_RUNTIME=app skips fork mode. The bundle always wins.
//
// The data: Kingmaker keeps its OWN data folder (~/Library/Application Support/sol-ghost/runtime), so the
// window app and Kingmaker can never write one runtime home at once. Sharing the window app's data is an
// explicit opt-in (KINGMAKER_DESKTOP_USERDATA=<the desktop's userData>), and is still refused while the
// window runs on it (desktop/runtime-lock.mjs in the runtime, desktopAppPid here).

import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forkState } from './fork.mjs';

export const RUNTIME_BINARY = 'Solomon';

/** Real, absolute, case-folded form of a path (APFS is case-insensitive by default); ~ is expanded. */
function canonical(p, home) {
  let s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~' || s.startsWith('~/')) s = join(home, s.slice(1));
  s = resolve(s);
  // Resolve the longest existing prefix through symlinks, so a link into ~/.solomon is caught too.
  let head = s, tail = '';
  while (head && !existsSync(head) && dirname(head) !== head) { tail = join(head.slice(dirname(head).length + 1), tail); head = dirname(head); }
  try { head = realpathSync(head); } catch { /* keep as is */ }
  return (tail ? join(head, tail) : head).toLowerCase();
}

/** True when `p` is the desktop app's own data dir (~/.solomon) or inside it, for any of the given home dirs.
 *  Kingmaker never reads the desktop app's library (operator 2026-10-13). */
export function insideDesktopAppData(p, homes = [homedir()]) {
  const target = canonical(p, homes[0]);
  if (!target) return false;
  return homes.filter(Boolean).some((h) => {
    const base = canonical(join(h, '.solomon'), h);
    const rel = relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}
const BUNDLE_MARKER = `${sep}Contents${sep}Resources${sep}sol-ghost${sep}`;

/** The Kingmaker.app this code runs from, or null (a git checkout). Pure. */
export function ownBundle(modulePath = fileURLToPath(import.meta.url)) {
  const at = modulePath.indexOf(BUNDLE_MARKER);
  if (at < 0) return null;
  const app = modulePath.slice(0, at);
  return app.endsWith('.app') ? app : null;
}

/**
 * Which engine runtime to run (see the top of this file).
 * { source: 'bundle' | 'fork' | 'borrowed-app', app, binary, resources, fork }. Pure except `exists`.
 */
export function resolveRuntime(env = process.env, { modulePath, exists = existsSync } = {}) {
  const bundle = ownBundle(modulePath);
  if (bundle) {
    const resources = join(bundle, 'Contents', 'Resources');
    const binary = join(bundle, 'Contents', 'MacOS', RUNTIME_BINARY);
    if (exists(binary) && exists(join(resources, 'solomon-runtime'))) return { source: 'bundle', app: bundle, binary, resources };
  }
  const app = resolve(String(env.KINGMAKER_RUNTIME_APP || '/Applications/Kingmaker.app'));
  const appResources = join(app, 'Contents', 'Resources');
  // Fork mode is for a git checkout only: never inside an app bundle (a thin dev build of Kingmaker.app
  // carries no engine source and borrows the installed app). The checkout is the one this code runs from.
  const fork = bundle ? null : forkState(modulePath ? join(dirname(modulePath), '..') : undefined, exists);
  if (fork?.present && env.SOL_GHOST_RUNTIME !== 'app') {
    const resources = String(env.SOL_GHOST_RESOURCES || '').trim() ? resolve(String(env.SOL_GHOST_RESOURCES)) : appResources;
    return { source: 'fork', app, binary: join(app, 'Contents', 'MacOS', 'Solomon'), resources, fork };
  }
  return { source: 'borrowed-app', app, binary: join(app, 'Contents', 'MacOS', 'Solomon'), resources: appResources, fork };
}

export function resolvePaths(env = process.env, home = homedir(), { modulePath, exists = existsSync } = {}) {
  const runtime = resolveRuntime(env, { modulePath, exists });
  const { resources } = runtime;
  const state = String(env.SOL_GHOST_HOME || join(home, 'Library', 'Application Support', 'sol-ghost'));
  // The desktop's userData: only ever READ here (the operator's wake word), unless the operator opts in to
  // sharing its data with KINGMAKER_DESKTOP_USERDATA.
  const desktopUserData = join(home, 'Library', 'Application Support', 'solomon-desktop');
  const sharedUserData = String(env.KINGMAKER_DESKTOP_USERDATA || '').trim();
  const userData = sharedUserData ? resolve(sharedUserData) : state;
  const voice = join(resources, 'voice-runtime');
  const isFork = runtime.source === 'fork';
  // The engine's plain-Node desktop modules (chrome connector, owner voice, headless launcher): from the
  // imported source in fork mode, from the app's asar otherwise. Used as shipped either way.
  const desktopModules = isFork ? runtime.fork.layout.desktop : join(resources, 'app.asar', 'desktop');
  return {
    runtimeSource: runtime.source,
    app: runtime.app,
    binary: runtime.binary,
    resources,
    fork: runtime.fork?.layout ?? null,
    forkInstalled: Boolean(runtime.fork?.installed),
    desktopModules,
    headlessEntry: join(resources, 'app.asar', 'desktop', 'headless-server.mjs'),
    ownerVoiceModules: desktopModules,
    buildStamp: join(resources, 'solomon-runtime', 'solomon-build.json'),
    userData,
    sharesDesktopData: Boolean(sharedUserData),
    runtimeHome: String(env.SOL_GHOST_RUNTIME_HOME || join(userData, 'runtime')),
    // Machine-level installs (managed Playwright browsers, the DimOS venv) are tools, not governed data:
    // shared with the desktop so nothing is downloaded twice.
    managedRuntimes: join(desktopUserData, 'runtimes'),
    singletonLock: join(userData, 'SingletonLock'),
    voice: {
      whisper: join(voice, 'stt', 'whisper-cli'),
      // Kokoro on the Neural Engine: the reply voice the desktop app speaks with (voice.mjs speak()).
      kokoro: join(voice, 'tts', 'kokoro-ane-server'),
      sttModel: join(voice, 'models', 'stt', 'ggml-base.bin'),
      // The bundled CAM++ speaker-embedding sidecar the owner gate compares against the sealed print.
      speaker: join(voice, 'speaker', 'solomon-speaker-id'),
      speakerModel: join(voice, 'models', 'speaker-id', 'speaker-embedding-campplus-zh-en.onnx'),
      // The operator's wake word: Kingmaker's own file, then the desktop spotter's (read-only), then the
      // bundled default.
      wakeKeywords: [...new Set([join(userData, 'solomon-wake-keywords.txt'), join(desktopUserData, 'solomon-wake-keywords.txt'), join(voice, 'solomon-wake-keywords.txt')])],
      // The plain wake PHRASE the server reads (assistant-identity.ts ownWakePhrase, SOLOMON_WAKE_WORD_PATH):
      // Kingmaker's own wake-word.txt, else the desktop's (read-only); never the tokenized spotter file.
      wakePhraseFile: [join(userData, 'wake-word.txt'), join(desktopUserData, 'wake-word.txt')].find((p) => exists(p)) ?? join(userData, 'wake-word.txt'),
    },
    state,
    // A run given its own runtime home (a sandbox, a verification run) keeps its daemon file and logs there,
    // so `status`, `stop` and the app never mistake it for the operator's Kingmaker. Its runtime is already
    // separate; before this, its daemon.json overwrote the real one. SOL_GHOST_HOME still moves everything.
    logs: isolatedRun(env) ? join(String(env.SOL_GHOST_RUNTIME_HOME), 'sol-ghost-logs') : join(state, 'logs'),
    stateFile: isolatedRun(env) ? join(String(env.SOL_GHOST_RUNTIME_HOME), 'sol-ghost-daemon.json') : join(state, 'daemon.json'),
  };
}

/** A run with its own runtime home and no SOL_GHOST_HOME of its own: its daemon state must stay in that home. */
export function isolatedRun(env = process.env) {
  return Boolean(String(env.SOL_GHOST_RUNTIME_HOME ?? '').trim()) && !String(env.SOL_GHOST_HOME ?? '').trim();
}

export function findGhostBinary(env = process.env, exists = existsSync) {
  const explicit = String(env.SOL_GHOST_GHOST_BIN || '').trim();
  if (explicit) return exists(explicit) ? explicit : null;
  return ['/opt/homebrew/bin/ghost', '/usr/local/bin/ghost'].find((p) => exists(p)) ?? null;
}

/**
 * The Peekaboo binary (github.com/openclaw/Peekaboo, MIT) — the hands people know as "Hands of Horus". An explicit
 * SOL_GHOST_PEEKABOO_BIN must exist; otherwise Homebrew's two prefixes, then PATH. Null when it is not installed.
 */
export function findPeekabooBinary(env = process.env, exists = existsSync) {
  const explicit = String(env.SOL_GHOST_PEEKABOO_BIN || '').trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const dirs = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', ...String(env.PATH || '').split(':').filter(Boolean)])];
  return dirs.map((d) => join(d, 'peekaboo')).find((p) => exists(p)) ?? null;
}

/**
 * An Ollama that only Kingmaker knows about: the installer puts Ollama.app in ~/Applications when /Applications is not
 * writable, and the engine looks only in /Applications, Homebrew and PATH. Null when the engine finds one on its own.
 */
export function findUserOllama(env = process.env, home = homedir(), exists = existsSync) {
  if (String(env.SOLOMON_OLLAMA_BIN || '').trim()) return null;
  const engineFinds = ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', ...String(env.PATH || '').split(':').filter(Boolean).map((d) => join(d, 'ollama'))];
  if (engineFinds.some((p) => exists(p))) return null;
  const mine = join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama');
  return exists(mine) ? mine : null;
}

/** Chromium's SingletonLock points at "<host>-<pid>". The pid, or null. Pure. */
export function singletonPid(target) {
  const m = /-(\d+)$/.exec(String(target ?? ''));
  return m ? Number(m[1]) : null;
}

/** Is the desktop app holding this data folder right now? */
export function desktopAppPid(paths, { readlink = readlinkSync, alive = pidAlive } = {}) {
  let target;
  try { target = readlink(paths.singletonLock); } catch { return null; }
  const pid = singletonPid(target);
  return pid && alive(pid) ? pid : null;
}

/** Another headless runtime (a second Kingmaker, solomon-server) holding this runtime home: { pid, launcher } or null. */
export function headlessHolder(paths, { read = (p) => readFileSync(p, 'utf8'), alive = pidAlive } = {}) {
  let held;
  try { held = JSON.parse(read(join(paths.runtimeHome, 'runtime.lock'))); } catch { return null; }
  const pid = Number(held?.pid);
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? { pid, launcher: String(held?.launcher ?? 'headless') } : null;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
