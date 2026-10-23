// The backend environment for Kingmaker's windowless engine on this Mac. Pure.
//
// The bundled desktop/headless-server.mjs already builds everything that does not need a window. This
// adds what the desktop shell (desktop/main.mjs startBackend) hands its backend on a Mac and the Linux
// launcher cannot know: the macOS profile paths, ghost-os as the hands, and the per-launch authority
// secrets. Those secrets are what make this "same rules": their presence turns principal enforcement on,
// exactly as in the window, so a local program or an MCP client can only PROPOSE, never approve.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { insideDesktopAppData } from './paths.mjs';
import { homeFolder } from './kingmaker-home.mjs';

import { reportsDir } from './evidence.mjs';
import { DEFAULT_WAKE_WORD } from './install-config.mjs';
import { voiceTurnsPath } from './voice-ledger.mjs';
import { classFor, classRole, classSetting, PROFILES } from './mac-profiles.mjs';
import { reflexSeatPlan } from './reflex-seat.mjs';
export const DESKTOP_NONCE_HEADER = 'x-solomon-desktop-nonce';
/** The solvox2 owner-voice attestation header (desktop/owner-voice/voice-attestation.mjs, contract cs-v2 B5). */
export const VOICE_ATTESTATION_HEADER = 'x-solomon-voice-attestation';

/** Two 64-hex secrets, minted once per launch and held only in memory and the backend's env. */
export function mintLaunchSecrets(rand = randomBytes) {
  return { nonce: rand(32).toString('hex'), voiceKey: rand(32).toString('hex') };
}

/**
 * Kingmaker runs on abliterated models (refusals removed) for every role that answers in words: chat, decisions,
 * planning, intent, the always-warm reflex tier, message drafts, the game build loop and vision. They are called by
 * their real names so the engine's model integrity (it pins each Ollama tag's digest on first use and treats a later
 * change as an infection) covers the weights actually running. The broker's gates still decide what runs.
 * The coders stay stock until an abliterated coder is installed. A model is pinned only when it is installed; the
 * operator's own SOLOMON_* pins win; SOL_GHOST_ABLITERATED=0 keeps the engine's stock models.
 */
export const ABLITERATED_MODELS = Object.freeze({
  SOLOMON_OLLAMA_MODEL: 'huihui_ai/qwen3-abliterated:1.7b',            // general chat
  SOLOMON_OLLAMA_DECISION_MODEL: 'huihui_ai/qwen3-abliterated:1.7b',   // decision reasoner
  SOLOMON_AGENT_PLANNER_MODEL: 'huihui_ai/qwen3-abliterated:1.7b',     // the agent loop's next-step planner
  SOLOMON_OLLAMA_CLASSIFIER_MODEL: 'huihui_ai/qwen3-abliterated:0.6b', // fast intent classifier
  SOLOMON_PINNED_FAST_MODEL: 'huihui_ai/qwen3-abliterated:0.6b',       // the always-warm reflex tier
  SOLOMON_DRAFT_MODEL: 'huihui_ai/qwen3-abliterated:1.7b',             // message drafts
  SOLOMON_BUILD_MODEL: 'huihui_ai/qwen3.5-abliterated:2b',             // the game build loop
  SOLOMON_VISION_MODEL: 'huihui_ai/qwen3.5-abliterated:2b',            // screen and camera reads (keeps vision)
});

/**
 * The coder, sized to the machine (operator 2026-10-07: "abliterated 1.5b with adaptive upscalability to abliterated
 * 7b"). With 16 GB or more and the 7b installed, the 7b; otherwise the 1.5b. On 8 GB the 7b (4.7 GB) is never picked:
 * it would thrash with the chat model loaded. Both are Apache-2.0 (the engine's licence gate refuses only the 3b).
 */
export const ABLITERATED_CODERS = Object.freeze({
  small: 'huihui_ai/qwen2.5-coder-abliterate:1.5b',
  large: 'huihui_ai/qwen2.5-coder-abliterate:7b',
});
export const LARGE_CODER_MIN_GB = 16;
/** Coder roles: the engine's local coder (its external coding agent falls back to it) and code snippets. */
const CODER_ROLES = ['SOLOMON_LOCAL_CODING_MODEL', 'SOLOMON_SNIPPET_MODEL'];
export const hostMemoryGb = () => totalmem() / 2 ** 30;

const KNOWLEDGE_PROFILE_KEYS = Object.freeze(['SOLOMON_INDEX_DIR', 'SOLOMON_CORPUS_DIR', 'SOLOMON_EXTRACTED_DIR', 'SOLOMON_KNOWLEDGE_FIELDS']);

/**
 * The packaged headless launcher reads runtime/.env after this wrapper has built the child environment.
 * Read only its knowledge paths here so Kingmaker's safe local defaults do not mask a legitimate external
 * library selected in that profile. Shell values still win below, and the ~/.solomon guard covers both.
 */
export function knowledgeProfileEnv(runtimeHome, { exists = existsSync, read = (path) => readFileSync(path, 'utf8') } = {}) {
  const path = join(runtimeHome, '.env');
  if (!exists(path)) return {};
  let profile;
  try { profile = parseEnv(read(path)); } catch { return {}; }
  return Object.fromEntries(KNOWLEDGE_PROFILE_KEYS.flatMap((key) => profile[key] === undefined ? [] : [[key, profile[key]]]));
}

/** The abliterated coder this machine should run, or null when neither is installed. Pure. */
export function abliteratedCoder(installedModels = [], totalMemGb = hostMemoryGb()) {
  const have = new Set((installedModels ?? []).map(String));
  if (totalMemGb >= LARGE_CODER_MIN_GB && have.has(ABLITERATED_CODERS.large)) return ABLITERATED_CODERS.large;
  return have.has(ABLITERATED_CODERS.small) ? ABLITERATED_CODERS.small : null;
}

/**
 * The brain, sized to the machine like the coder (operator 2026-10-08, on a 24 GB M5 Pro: "voice is fully responsive
 * just stupid"; it ran the 1.7b picked for 8 GB). With 16 GB or more and the 8b installed, the 8b answers chat,
 * decisions, planning and drafts; the 0.6b reflex tier, the classifier and the 2b vision/build model stay as they are.
 * On 8 GB the 8b (5.2 GB) is never picked: it would thrash with the coder. SOLOMON_* pins still win.
 */
export const ABLITERATED_LARGE_BRAIN = 'huihui_ai/qwen3-abliterated:8b';
export const LARGE_BRAIN_MIN_GB = 16;
export const BRAIN_ROLES = Object.freeze(['SOLOMON_OLLAMA_MODEL', 'SOLOMON_OLLAMA_DECISION_MODEL', 'SOLOMON_AGENT_PLANNER_MODEL', 'SOLOMON_DRAFT_MODEL']);

/** The abliterated pins for the installed models, the coder sized to the machine. Pure. */
export function abliteratedModelEnv(installedModels = [], env = process.env, totalMemGb = hostMemoryGb()) {
  if (String(env.SOL_GHOST_ABLITERATED ?? '').trim() === '0') return {};
  const have = new Set((installedModels ?? []).map(String));
  const coder = abliteratedCoder(installedModels, totalMemGb);
  return {
    ...Object.fromEntries(Object.entries(ABLITERATED_MODELS).filter(([, model]) => have.has(model))),
    ...(coder ? Object.fromEntries(CODER_ROLES.map((role) => [role, coder])) : {}),
    ...(totalMemGb >= LARGE_BRAIN_MIN_GB && have.has(ABLITERATED_LARGE_BRAIN) ? Object.fromEntries(BRAIN_ROLES.map((role) => [role, ABLITERATED_LARGE_BRAIN])) : {}),
  };
}

/**
 * The engine's model settings from this Mac's profile (lib/mac-profiles.mjs), so Kingmaker and its engine share one
 * router and one budget. The whole-stack soak on the 24 GB M5 Pro (2026-10-15) found two routers resident (the engine's 0.6b
 * reflex tier at a 16k context, 2.4 GB, beside Kingmaker's 1.7b), free memory down to 8% and swap up 3.1 GB:
 *   • the reflex tier and the classifier are the profile's router when it is installed (one router, not two);
 *   • SOLOMON_OLLAMA_NUM_CTX is the profile's context (the engine otherwise sizes it from RAM: 16k on 24 GB);
 *   • OLLAMA_MAX_LOADED_MODELS is the profile's "at once" (the engine unloads the surplus, keeping its warm tier);
 *   • on the one profile with a single slot (8 GB), the reflex seat (lib/reflex-seat.mjs) is the governed
 *     exception: when the decision model is installed and the pair fits the profile's GPU wired budget,
 *     OLLAMA_MAX_LOADED_MODELS is the "at once" + 1 and KINGMAKER_REFLEX_PINNED_MODEL names the seat, so the
 *     engine's surplus-unloading spares it. KINGMAKER_REFLEX_PIN=off restores the strict single slot exactly.
 * The operator's own SOLOMON_* / OLLAMA_* values still win (the merge below). Pure given its arguments.
 */
export function profileRuntimeEnv(installedModels = [], totalMemGb = hostMemoryGb(), env = process.env) {
  if (String(env.SOL_GHOST_PROFILE_ENV ?? '').trim() === '0') return {};
  const bytes = totalMemGb * 2 ** 30, have = new Set((installedModels ?? []).map(String));
  const router = classRole('router', bytes), context = classSetting('context', bytes), concurrent = classSetting('concurrent', bytes);
  // The reflex seat for this Mac's class (lib/reflex-seat.mjs): an inactive plan — every profile but the
  // single-slot one, the kill switch, an uninstalled decision model — leaves the two lines below exactly as
  // they were before the seat existed.
  const seat = reflexSeatPlan({ profile: PROFILES[classFor(bytes / 2 ** 30)], env, installed: [...have] });
  return {
    ...(router && have.has(router) ? { SOLOMON_OLLAMA_CLASSIFIER_MODEL: router, SOLOMON_PINNED_FAST_MODEL: router } : {}),
    ...(context ? { SOLOMON_OLLAMA_NUM_CTX: String(context) } : {}),
    ...(concurrent ? { OLLAMA_MAX_LOADED_MODELS: String(seat.active ? seat.maxLoadedModels : concurrent) } : {}),
    ...(seat.active ? { KINGMAKER_REFLEX_PINNED_MODEL: seat.model } : {}),
  };
}

/** What people call each hands. Peekaboo (github.com/openclaw/Peekaboo, MIT) is shown as "Hands of Horus". */
export const HANDS_NAMES = Object.freeze({ peekaboo: 'Hands of Horus', ghost: 'ghost-os' });

/**
 * Which hands drive the Mac. The operator's own SOLOMON_MAC_HANDS wins; otherwise Peekaboo when it is installed,
 * else ghost-os when it is installed, else none. Pure.
 */
export function selectHands({ env = process.env, ghostBin = null, peekabooBin = null } = {}) {
  const asked = String(env.SOLOMON_MAC_HANDS ?? '').trim().toLowerCase();
  if (asked === 'peekaboo') return 'peekaboo';
  if (asked) return 'ghost';
  return peekabooBin ? 'peekaboo' : ghostBin ? 'ghost' : null;
}

/**
 * `artcraftEnv`: the ArtCraft apps' folder and binary pins (artcraft.mjs craftBackendEnv: SOLOMON_ARTCRAFT_BIN_DIR, and
 * SOLOMON_<APP>_CLI_SHA256 for each app `kingmaker craft install` built). A Finder-launched Kingmaker.app has a minimal
 * PATH and its own data root, so without this the adapter would never find a CLI built into ~/.cargo/bin.
 */
export function ghostBackendEnv({ env = process.env, paths, port, secrets, ghostBin, peekabooBin = null, installedModels = [], artcraftEnv = {}, ollamaBin = null, crmLock = null, addon = null, totalMemGb = hostMemoryGb() }) {
  const path = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', ...String(env.PATH || '').split(':').filter(Boolean)])].join(':');
  const defaults = {
    // Native app control over MCP stdio: Peekaboo ("Hands of Horus") when it is installed, else ghost-os as before.
    // Every committing step still stops for the owner's yes; perception (reading an app's accessibility tree) is the
    // only thing that runs unasked. ghost-os stays configured beside Peekaboo, so SOLOMON_MAC_HANDS=ghost switches back.
    ...(ghostBin ? { SOLOMON_GHOST_MCP_CMD: JSON.stringify([ghostBin, 'mcp']) } : {}),
    ...(peekabooBin ? { SOLOMON_MAC_HANDS: 'peekaboo', SOLOMON_PEEKABOO_MCP_CMD: JSON.stringify([peekabooBin, 'mcp']) } : {}),
    ...(ghostBin || peekabooBin ? { SOLOMON_DEVICE_MAC_CONTROL_ENABLED: 'true' } : {}),
    // Ronin Atlas (God's Eye internally) stays: it is driven in the browser. Only its boot prewarm is skipped
    // (~670 MB held ~20 min on 8 GB; it starts on first use instead). SOL_GHOST_GODS_EYE=0 turns it off entirely.
    SOLOMON_GODS_EYE_PREWARM: '0',
    ...abliteratedModelEnv(installedModels, env, totalMemGb),
    // One router, one context and one budget with Kingmaker's own (this Mac's profile).
    ...profileRuntimeEnv(installedModels, totalMemGb, env),
    // The operator's money rule for Ghost (2026-10-07): a payment is possible by voice while Ghost is awake,
    // after a yes and then a second confirmation that repeats the amount and payee the engine reads back.
    // A missing amount or payee is refused; credentials stay prohibited; local programs/MCP can't confirm.
    // SOLOMON_MONEY_POLICY=prohibited in the environment restores the window app's rule (no payments).
    SOLOMON_MONEY_POLICY: 'spoken-second-confirm',
    // Sending by voice (a WhatsApp, an ack release) is live in Ghost: it is still read back first and goes only on
    // The owner's spoken yes (operator 2026-10-07: "send <a contact> (x)… just like Siri"). Set it to false to stop.
    SOLOMON_DEVICE_SEND_ENABLED: 'true',
    // THE PHONE'S FIELD PHOTOS (lib/phone-companion.mjs): an upload is renameSync'd into this exact dir, and the engine
    // attaches the latest one to the next turn by path (client.mjs → GovernedConversationTurnInput.image.path). The
    // runtime confines a body-supplied image.path to this allowlisted dir (realpath-checked, anti-LFI), so without this
    // the attachment is silently dropped (vision → NO_IMAGE). Same derivation the companion uses (homeFolder('field')
    // against this install's state dir), so both processes agree on the path.
    SOLOMON_FIELD_UPLOAD_DIR: homeFolder('field', { env: { ...env, SOL_GHOST_HOME: paths.state }, make: false }),
    ...(env.SOL_GHOST_GODS_EYE === '0' ? { SOLOMON_GODS_EYE_APP_ROOT: join(paths.state, 'gods-eye-off') } : {}),
    // Kingmaker ships with NO CRM attached (operator 2026-10-08): "my CRM" means only what this owner connects
    // ("connect my CRM"), never the operator's Ronin CRM. The server reads this as its default.
    SOLOMON_CRM_DEFAULT: 'none',
    // A paid add-on's own settings (the Ronin add-on: its one-company CRM lock and Kingmaker's seats on that CRM).
    ...(addon?.backendDefaults?.(crmLock) ?? {}),
    SOLOMON_SYSTEM_TTS_EXECUTABLE: join(paths.resources, 'voice-runtime', 'tts', 'solomon-system-tts'),
    // Its name is its wake word (assistant-identity.ts): the installer's <data dir>/wake-word.txt ("Hey <cemented word>"),
    // else the desktop's; with neither, the default word.
    SOLOMON_WAKE_WORD_PATH: paths.voice.wakePhraseFile,
    SOLOMON_WAKE_PHRASE: `Hey ${DEFAULT_WAKE_WORD}`,
    SOLOMON_HEADLESS_LAUNCHER: 'kingmaker',
    // Ollama the installer put in ~/Applications (when /Applications was not writable), which the engine does not look in.
    ...(ollamaBin ? { SOLOMON_OLLAMA_BIN: ollamaBin } : {}),
    // The desktop is the UI: a turn's report is written into a folder on the Desktop and opened in Chrome there.
    SOLOMON_REPORTS_DIR: reportsDir(env),
    // Self-diagnosis reads ITS app's folder (voice log, launch timings), never the window app's.
    SOLOMON_DESKTOP_USER_DATA: paths.userData,
    // The per-turn voice ledger Kingmaker's voice loop appends to (voice-ledger.mjs): the self-assessment judges
    // voice by real completed turns from it, exactly as the window app's backend does with its own.
    SOLOMON_VOICE_TURNS_PATH: voiceTurnsPath(paths),
    // The credentials vault and the engine's keys live in the secure root, outside every app bundle: rebuilding or
    // reinstalling Kingmaker (or the desktop app) keeps every key, so a key is asked for once per vault. This is the
    // core's own default (runtime-paths.ts getSecureRoot), named here so a bundle can never move it.
    SOLOMON_SECURE_ROOT: join(env.HOME || homedir(), '.solomon-secure'),
    // Kingmaker thinks only with local models: a claude or codex CLI on this Mac is never offered as a secondary brain
    // (the core would otherwise ask "Route it to Claude?" on every writing task).
    SOLOMON_SECONDARY_BRAINS: 'off',
    // The core's own outbound list plus "mcp": a remote MCP server the owner console added (Hugging Bay, for local model
    // files: lib/huggingbay.mjs) can be reached. Adding a server stays owner-only, and its tools stay off until reviewed.
    SOLOMON_APPROVED_OUTBOUND_CHANNELS: 'search,external-llm,rest,crm,github-capability-search,osv-advisories,openssf-scorecard,feature-watch,mcp',
    // Kingmaker's knowledge library is its own (operator 2026-10-13). Explicit roots stop the provision module's
    // shared fallback to the desktop app's ~/.solomon/knowledge, so the core never serves the desktop app's library by accident.
    SOLOMON_INDEX_DIR: join(paths.runtimeHome, 'data', 'knowledge', 'index'),
    SOLOMON_CORPUS_DIR: join(paths.runtimeHome, 'data', 'knowledge', 'sources'),
    SOLOMON_EXTRACTED_DIR: join(paths.runtimeHome, 'data', 'knowledge', 'extracted'),
    ...artcraftEnv,
  };
  const merged = { ...defaults, ...knowledgeProfileEnv(paths.runtimeHome) };
  // The operator's own environment wins for anything not fixed below (same rule as the desktop).
  for (const [key, value] of Object.entries(env)) if (value !== undefined && /^(SOLOMON_|OLLAMA_)/.test(key)) merged[key] = value;
  // ...except into the desktop app's own data: an override pointing the library (or the data dir) inside ~/.solomon is
  // dropped back to Kingmaker's own, so the core and knowledgePlan always agree and never read the desktop app's library.
  const homes = [...new Set([env.HOME, homedir()].filter(Boolean))];
  const dropped = [];
  for (const key of ['SOLOMON_INDEX_DIR', 'SOLOMON_CORPUS_DIR', 'SOLOMON_EXTRACTED_DIR', 'SOLOMON_DATA_DIR']) {
    if (merged[key] !== undefined && insideDesktopAppData(merged[key], homes)) { if (key in defaults) merged[key] = defaults[key]; else { delete merged[key]; dropped.push(key); } }
  }
  // An add-on's lock is not the operator's to override (addon.enforceLock puts its CRM back and drops the rest).
  if (crmLock && addon?.enforceLock) {
    addon.enforceLock(merged, crmLock, dropped);
  } else {
    // A launcher environment cannot invent a lock: the authoritative marker comes only from crm-lock.json / desk.
    delete merged.SOLOMON_CRM_LOCK_TENANT;
    delete merged.SOLOMON_CRM_LOCK_HOSTS;
    delete merged.SOLOMON_CRM_LOCK_MCP_URL;
  }
  const base = { ...env };
  // Lock markers are launcher-owned in both modes. Without an active file/desk lock, stale or injected markers must
  // not survive via the raw environment projection; ordinary unlocked CRM URL/token overrides remain untouched.
  if (!crmLock) {
    delete base.SOLOMON_CRM_LOCK_TENANT;
    delete base.SOLOMON_CRM_LOCK_HOSTS;
    delete base.SOLOMON_CRM_LOCK_MCP_URL;
  }
  for (const key of dropped) delete base[key]; // the raw env must not bring a dropped value back
  return {
    ...base,
    ...merged,
    PATH: path,
    ELECTRON_RUN_AS_NODE: '1',
    SOLOMON_HEADLESS_HOME: paths.runtimeHome,
    SOLOMON_MANAGED_RUNTIME_ROOT: paths.managedRuntimes,
    SOLOMON_PORT: String(port),
    // Fixed: never taken from the environment, never logged, never written to disk.
    SOLOMON_DESKTOP_CONTROL_NONCE: secrets.nonce,
    SOLOMON_VOICE_ATTESTATION_KEY: secrets.voiceKey,
  };
}

/** Env keys safe to print (doctor / --print-env). */
export function redactedEnv(backendEnv) {
  const out = {};
  for (const [key, value] of Object.entries(backendEnv)) {
    if (!/^(SOLOMON_|OLLAMA_)/.test(key)) continue;
    out[key] = /KEY|TOKEN|SECRET|PASSWORD|NONCE/i.test(key) ? '<set>' : value;
  }
  return out;
}
