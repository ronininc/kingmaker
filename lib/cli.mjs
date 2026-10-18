// kingmaker (formerly sol-ghost, still an alias) — an assistant with no window. Your Mac's own apps are the screen, your voice drives it,
// its engine governs every step, the Hands of Horus do the clicking.
//
//   kingmaker start [--no-voice] [--quiet] [--voice-mode auto|voice|text] [--port N]   run it here; this terminal is the owner console
//   kingmaker voice [owner|verified|propose]            what your spoken word can do (default: owner)
//   kingmaker enroll [--forget]                         enroll your voice for the verified mode (typed, here)
//   kingmaker say "<text>"                              one turn from any shell (can only propose)
//   kingmaker installer install <owner/repo|link>       the Ronin Installer: a repo's latest release, checked and installed
//   kingmaker wake                                      launch Kingmaker.app, or wake it (what "Hey Siri, wake Kingmaker" does)
//   kingmaker siri                                      add the "Wake Kingmaker" Siri Shortcut (opens Shortcuts to confirm)
//   kingmaker tour                                      show the first-run tour in the bar again
//   kingmaker background [status|enable|disable]        open-lid, AC-powered, display-off always-on host mode
//   kingmaker key <provider>                            an API key from this terminal into the vault (owner)
//   kingmaker mcp                                       MCP control surface over stdio (can only propose)
//   kingmaker iphone [status|see|tap|open|call|text|trust|dnc|do…]   drive your iPhone through iPhone Mirroring
//   kingmaker status                                    is it up, what is waiting, how much RAM
//   kingmaker stop                                      stop a running Kingmaker
//   kingmaker settings                                  open Kingmaker's settings in your browser, only when asked
//   kingmaker chrome                                    set up / refresh Kingmaker's Chrome connector
//   kingmaker doctor                                    check every piece it needs on this Mac
//   kingmaker scan [--find] [--force] [--json]          inventory this Mac: apps, CLIs, MCP servers, keys (names); --find looks online for tools
//   kingmaker tools                                     what Kingmaker can drive and the tools it proposes (install them at the console)
//   kingmaker craft [status]                            the seven ArtCraft apps: installed, version, or the fix
//   kingmaker craft install [app…] [--jobs N]           build them from source, one at a time, paced (all seven if none named)
//   kingmaker craft <app> [what…] [--input F] [--says T] ask Kingmaker to run one (a write is read back; only the owner's word runs it)
//   kingmaker markets install | status                 TradingAgents (research only, local models): put it on this Mac, or check it
//   kingmaker markets <TICKER> [--date D] [--model M] [--deep-model M] [--analysts a,b] [--rounds N]   its analyst desk rates one ticker

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentStatus, artcraftDoctor, controlStatus, health, ownerCall, pendingProposals, postHealthSnapshot, streamEvents, turn } from './client.mjs';
import { createDuress, liveDuressDeps } from './duress.mjs';
import { createBarGuard, frameBarTurn } from './bar-guard.mjs';
import { followStream } from './announcements.mjs';
import { classifyCraftAsk, cleanCraftWork, CRAFT_APP_IDS, CRAFT_APPS, craftApp, craftBinDir, craftDoctor, craftDoctorLines, craftInboxDir, craftTurnText, craftWorkDir, defaultJobs, installCraftApps, LIGHTCRAFT_LIMITS, engineCraftLine, stageCraftInput } from './artcraft.mjs';
import { openKeyPage, readAnswer, readHidden, readOwnerNonce, runKeyFlow, sealFromKeyField } from './keys.mjs';
import { storeProviderKey, storedLine } from './key-acquire.mjs';
import { buildCatalog, churnScan, createHbClient, ensureHuggingBayMcp, pullModel } from './huggingbay.mjs';
import { createHealthReporter, handsPermissions, peekabooInfo, peekabooPermissions, readFoundation } from './health.mjs';
import { createVoiceTurnLedger, readVoiceTurnTally, voiceTurnsPath } from './voice-ledger.mjs';
import { provisionKnowledge } from './knowledge.mjs';
import { meetingHold, pollMeetingRelease } from './meeting.mjs';
import { createDeskOfDevice, deviceDoctorLines, summaryLines } from './device-desk.mjs';
import { deviceMapPath, readDeviceMap } from './device-scan.mjs';
import { syncChromeConnector } from './chrome.mjs';
import { serveStdio } from './mcp.mjs';
import { createBridge, iphoneDir } from './iphone-bridge.mjs';
import { createChatgptBrain } from './chatgpt-brain.mjs';
import { createGrokBrain } from './grok-brain.mjs';
import { describeBackground, runBackgroundCommand } from './background.mjs';
import { chosenModelEnv, findModel, MODEL_CATALOG, modelLine, modelsFor, readModelChoice, readModelsDir, saveModelChoice, saveModelsDir, scanGguf } from './models.mjs';
import { BRAINS, createClaudeBrain, readBrainChoice, resolveBrain, saveBrainChoice } from './claude-brain.mjs';
import { findGhostBinary, findPeekabooBinary, isolatedRun, pidAlive, resolvePaths } from './paths.mjs';
import { defaultTenant, openLearning } from './learning.mjs';
import { fleetDraft, installationId, openSharing } from './sharing.mjs';
import { homedir, totalmem } from 'node:os';
import { fleetTransport } from './fleet-transport.mjs';
import { newInstallationId, sanitizeForFleet, validatePacket as validateFleetPacket } from '../vendor/fleet/fleet-packet.mjs';
import { routeLane, writerModel } from './fast-route.mjs';
import { installRepo, installRequest, parseRepo } from './ronin-installer.mjs';
import { isEditFollowUp, permissionGrantReply, withFollowUp } from './follow-up.mjs';
import { GAPS_SCAN_ROUTE, createIdleGaps } from './idle-gaps.mjs';
import { FUNCTIONS, readCalibration, withProfile, writeCalibration } from './calibration.mjs';
import { connectorFlowSteps, createFlow, keyFlowSteps } from './flow.mjs';
import { listArtifacts } from './artifacts.mjs';
import { createSkillFolder } from './skill-create.mjs';
import { isAdRequest, makeAdVideo } from './ad-video.mjs';
import { factsFor } from './kingmaker-facts.mjs';
import { imageLaneSetup, makeImage } from './image-lane.mjs';
import { fieldPhotoTurn, visionReady } from './field-photo.mjs';
import { suggestNext } from './next-suggest.mjs';
import { acknowledgeFinding, addConnector, connectorTurn, connectorView, listConnectors, removeConnector } from './connectors.mjs';
import { extensionView, installExtension, loadCatalog, readAccounts, runtimesFor } from './extensions.mjs';
import { absorbConnector, recordUse, sweepIdle } from './absorb.mjs';
import { BRAIN_ROLES, ABLITERATED_CODERS, ABLITERATED_MODELS, abliteratedModelEnv, DESKTOP_NONCE_HEADER, HANDS_NAMES, hostMemoryGb, LARGE_CODER_MIN_GB, mintLaunchSecrets, selectHands } from './profile.mjs';
import { BACKEND_RESPAWN_DELAYS_MS, clearDaemonState, DEFAULT_PORT, portFree, readDaemonState, startBackend, startBlockers, superviseBackend, writeDaemonState } from './runtime.mjs';
import { createOwnerSession, classifyLine, keyArg, resolveVoiceAuthority, VOICE_AUTHORITIES } from './session.mjs';
import { browseTarget, describeBrowse, describeLinks, describeWall, evidenceLinks, evidenceTargets, openDesktopWall } from './evidence.mjs';
import { challengeWords, createConsoleIpc, enrollBlockers, runEnrollment } from './enroll.mjs';
import { embedUtterance, learnSelfPrint, openOwnerVoice, ownerVoiceForLoop, ownerVoiceLine } from './owner-voice.mjs';
import { createSegmenter, extendVocabulary, openMicrophone, readWakePhrases, setMissingVoiceHandler, speak, startVoiceLoop, synthesizeKokoroWav, transcribe, wakeSetup } from './voice.mjs';
import { languageName, warmVoices } from './lang.mjs';
import { tidyDesktop } from './kingmaker-home.mjs';
import { createIntegrity, MODIFIED_NOTE } from './integrity.mjs';
import { companionControl, companionWanted, createCompanion, setCompanionWanted } from './phone-companion.mjs';
import { bridgeMetrics } from './bridge-metrics.mjs';
import { meter, meterDataset, meterFail, meterSnapshot, recordTo } from './token-meter.mjs';
import { crmDatasetId, memoryDatasetId, noteKnowledgeRun } from './datasets.mjs';
import { readInstallConfig } from './install-config.mjs';
import { callOwner, forgetPhone, readPhone, savePhone, TWILIO_CONSOLE } from './phone.mjs';
import { applyUpdate, checkForUpdate, readUpdateConfig, runningVersion, takeUpdateLock, writeUpdateConfig } from './update.mjs';
import { dispatchAddons, listAddons, loadAddons, makeHost, ronin, roninOnly } from './addons.mjs';
import { ADDON_CORE } from './addon-core.mjs';
import { checkPayload, payloadProblem } from './payload.mjs';
import { makeAddonVerifiers } from './addon-entitlement.mjs';
import { findRingApp, startRing, textOnlyFor, voicePlan } from './ring.mjs';
import { startHeadlessHostAssertion, startIdleSleepAssertion, withIdleSleepAssertion } from './power.mjs';
import { createInteractionArbiter } from './interaction-owner.mjs';
import { conductParts, reloadInstructions, sopFor, withInstructions } from './instructions.mjs';
import { commandMenu } from './command-list.mjs';
import { localModelTurn } from './local-turn.mjs';
import { markTour, tourCommand, tourControl, tourMessage } from './first-run.mjs';


/** Opened by Siri (the "Wake Kingmaker" shortcut) or `kingmaker wake`: Kingmaker.app registers the kingmaker:// scheme. */
export const WAKE_LINK = 'kingmaker://wake';
/** The pre-rename link: Kingmaker.app still registers it, so a "Wake Ghost" shortcut made before keeps working. */
export const LEGACY_WAKE_LINK = 'solghost://wake';
const USAGE_LINES = 27;
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

function flagValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function resolvePort(args, paths) {
  const explicit = Number(flagValue(args, '--port') || process.env.SOL_GHOST_PORT);
  if (Number.isInteger(explicit) && explicit >= 1024 && explicit <= 65535) return explicit;
  return readDaemonState(paths)?.port ?? DEFAULT_PORT;
}

// Paid add-ons (docs/addons.md §5): free Kingmaker ships this generic hook and ZERO add-on code. An add-on loads only
// when this Mac holds a valid entitlement — loadAddons re-checks the manifest signature, the file hashes, `requires`
// and (for paid) the entitlement + its /cert-status revocation before importing the entry and calling register(host).
// With no add-on installed the registry below stays empty and nothing else in Kingmaker changes.
const addonCommands = new Map();
const registerCliCommand = (name, fn) => { if (name && typeof fn === 'function') addonCommands.set(String(name), fn); };
/**
 * Where installed add-ons live: the Mac's own state, fixed before an add-on's profile can move the state elsewhere (main
 * loads add-ons first, then applies that profile), so `addons install` and every later load agree on one folder.
 */
let addonRoot = null;
const addonsDir = (paths) => addonRoot ?? join(paths.state, 'addons');
/** What `kingmaker start` hands the add-ons once it knows them (they load earlier, in main): its port and its log. */
let addonPort = null;
// Until `start` hands its log over, add-on events (loaded, skipped and why) wait here, then go to that log in order.
const earlyAddonEvents = [];
let addonLog = (event, fields) => { if (earlyAddonEvents.length < 200) earlyAddonEvents.push([event, fields]); };
const useAddonLog = (log) => { addonLog = log; for (const [event, fields] of earlyAddonEvents.splice(0)) log(event, fields); };
function addonDeps(paths) {
  const root = addonsDir(paths);
  // install:{} — the engine does NOT re-check installId/deviceSha256 here. Those bind to the LAUNCHER's values (set
  // when the entitlement is minted, enforced launcher-side at install), which Kingmaker would read from the
  // handed-over install cert (a follow-up once that handoff format is pinned). The signature, sku, expiry and
  // revocation are all enforced; the verifiers fail closed when the pinned keys are absent.
  const verifiers = makeAddonVerifiers({ install: {}, config: readUpdateConfig(paths.state), cacheDir: join(root, '.cache') });
  return { root, requires: { kingmaker: VERSION, arch: process.arch === 'arm64' ? 'arm64' : process.arch }, install: {}, ...verifiers };
}
function addonServices(livePaths, port) {
  // The narrow core capabilities meeting-notes declared it needs (docs/addons.md §1), built from core only so the hook
  // imports no add-on code. The add-on builds its own speaker (its lib/floor-audio-webrtc.mjs) over `synthesize`.
  return {
    transcriber: (samples, opts = {}) => transcribe(samples, { whisper: livePaths().voice.whisper, model: livePaths().voice.sttModel, language: process.env.SOL_GHOST_LANG || 'auto', prompt: opts?.prompt || '' }),
    synthesize: (line) => synthesizeKokoroWav(line),   // Kokoro → a WAV file ({ out, dir }), or null
    turn: async (text) => { try { return (await turn(port ?? addonPort ?? resolvePort([], livePaths()), { text }))?.spoken ?? null; } catch { return null; } },
    // The core modules an add-on may ask for by name (lib/addon-core.mjs): the Ronin office add-on binds these.
    lib: ADDON_CORE,
  };
}
async function loadInstalledAddons(paths, { port = null, live = false } = {}) {
  // Loaded early (main, live): the paths are read when a service runs, after the add-on's profile is applied.
  const livePaths = live ? () => resolvePaths() : () => paths;
  const log = (event, fields) => addonLog(event, fields);
  const host = makeHost({ version: VERSION, paths: addonsDir(paths), log, command: registerCliCommand, services: addonServices(livePaths, port) });
  await loadCheckoutAddons(host, { log });
  await loadAddons(host, { ...addonDeps(paths), log });
}
/**
 * An owner's checkout carries add-on sources beside lib/ (addons/<id>/addon.json): those load from source, as the rest of
 * the checkout does. The app and the public repo have no addons/ folder, so there only installed, entitled add-ons load.
 */
async function loadCheckoutAddons(host, { log = () => {} } = {}) {
  const dir = fileURLToPath(new URL('../addons/', import.meta.url));
  if (!existsSync(dir) || process.env.KINGMAKER_ADDONS === 'off') return;
  for (const id of readdirSync(dir)) {
    let desc; try { desc = JSON.parse(readFileSync(join(dir, id, 'addon.json'), 'utf8')); } catch { continue; }
    try {
      const mod = await import(new URL(`../addons/${id}/${desc.entry}`, import.meta.url).href);
      await mod.register?.(Object.freeze({ ...host, paths: join(host.paths, id) }));
      log('addon_loaded', { id, from: 'checkout' });
    } catch (error) { log('addon_skip', { id, why: String(error?.message || error).slice(0, 200) }); }
  }
}
/** Add-ons, once per process: before the engine starts (an add-on can set its environment) and before a command needs one. */
let addonsLoading = null;
const ensureAddons = (paths, opts = {}) => (addonsLoading ??= loadInstalledAddons(paths, opts).catch(() => {}));
/** The piped entitlement envelope for `addons install` — read from STDIN, never argv (docs/addons.md §3). '' if none. */
async function readStdinText() {
  try {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  } catch { return ''; }
}

// How long the doctor waits for Ollama. 2000 ms gave a false ✗ on an 8 GB Mac under swap: seen up to
// 6100 ms here (3 times), fleet p95 6000 ms on darwin-arm64-8gb. Sized 1.5 × that, 3–30 s.
export const OLLAMA_PROBE_TIMEOUT_MS = 10_000;

async function ollamaUp() {
  try { return (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS) })).ok; } catch { return false; }
}

/** The models Ollama has installed (names), or [] when it is not answering. */
async function ollamaModels() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS) });
    return r.ok ? ((await r.json())?.models ?? []).map((m) => m.name).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * Pure: the glow for this moment. Speaking wins; then something waiting for your word; then a background project
 * (a studio project finding tools and driving apps) shows as "thinking" while the voice is idle, so the screen
 * edge says Kingmaker is working even when you are not talking to it. Otherwise the voice state.
 */
export function glowState(state, { voiceState, waiting, working }) {
  if (state === 'speaking') return 'speaking';
  if (waiting) return 'waiting';
  if (working && (voiceState === 'asleep' || voiceState === 'awake')) return 'thinking';
  return voiceState;
}

/** Pure: one line about the models Kingmaker will run. */
export function modelsLine(pins, env = process.env, totalMemGb = hostMemoryGb()) {
  if (String(env.SOL_GHOST_ABLITERATED ?? '').trim() === '0') return 'Models: the engine\'s stock models (SOL_GHOST_ABLITERATED=0).';
  const missing = [...new Set(Object.values(ABLITERATED_MODELS))].filter((m) => !Object.values(pins).includes(m));
  const coder = pins.SOLOMON_LOCAL_CODING_MODEL;
  const bigMac = totalMemGb >= LARGE_CODER_MIN_GB;
  const coderPart = !coder ? ` Coder: stock (ollama pull ${ABLITERATED_CODERS.small}).`
    : coder === ABLITERATED_CODERS.large ? ' Coder: the abliterated 7b (this Mac has the memory for it).'
    : ` Coder: the abliterated 1.5b${bigMac ? ` (this Mac can run the 7b: ollama pull ${ABLITERATED_CODERS.large})` : ', sized to this Mac'}.`;
  if (!missing.length) return `Models: abliterated (refusals removed): huihui_ai/qwen3-abliterated 1.7b for chat, decisions, planning and drafts, 0.6b for intent and reflexes; huihui_ai/qwen3.5-abliterated 2b for builds and vision.${coderPart}`;
  return `Models: ${Object.keys(pins).length ? 'partly abliterated' : 'stock'}; not installed: ${missing.join(', ')} (ollama pull ${missing[0]}).${coderPart}`;
}

/**
 * Pure: one line about the wake word. Cemented: the word, how it is also heard, and that only a reinstall changes it.
 * Legacy (no install.json yet): the default word, plus the old Ghost names it still answers to.
 */
export function wakeWordLine(install, setup) {
  if (install?.cemented) {
    const heard = setup.names.filter((n) => n !== setup.word.toLowerCase());
    return `Wake word: "${setup.word}" (cemented at install${heard.length ? `; also heard as "${heard.join('", "')}"` : ''}). To change it, delete Kingmaker and install it again.${setup.ignored.length ? ` (${setup.ignored.join(', ')} is ignored: the word is cemented.)` : ''}`;
  }
  const why = install?.reason === 'invalid' ? ` install.json could not be read (${install.detail}), so this runs as a legacy install.` : '';
  return `Wake word: "${setup.word}" (the default; no word was cemented at install, so "ghost" and "Sol Ghost" still wake it too).${why}`;
}

/** `kingmaker models` (what fits this Mac), `models all`, `models abliterated|stock`, `models use <id>`, `models pull <id>`. */
/** The Hugging Bay catalog this checkout ships (lib/huggingbay-catalog.json), [] when there is none yet. */
function hbCatalog() {
  try { return JSON.parse(readFileSync(new URL('./huggingbay-catalog.json', import.meta.url), 'utf8')).entries ?? []; } catch { return []; }
}

/** kingmaker models hb search <words> | info <id> | pull <id> | catalog [--ram <GB>] */
async function cmdHuggingBay(paths, args) {
  const [verb, ...rest] = args;
  const words = rest.filter((a, i) => !a.startsWith('--') && !String(rest[i - 1] ?? '').startsWith('--')).join(' ').trim();
  const client = createHbClient();
  if (verb === 'search') {
    const { rows, total } = await client.search(words || 'abliterated', { limit: 100 });
    const hits = rows.filter((r) => /gguf/i.test(`${r.name} ${r.id}`) && Number(r.hostedFileCount) > 0);
    console.log(`Hugging Bay: ${total} records for "${words || 'abliterated'}"; hosted GGUF on this page: ${hits.length}.`);
    for (const r of hits.slice(0, 40)) console.log(`  ${r.id}  (${r.license || 'licence unknown'})`);
    console.log('kingmaker models hb info <id> shows the file, its SHA-256 and the RAM it needs; pull downloads it.');
    return 0;
  }
  if (verb === 'info') {
    const m = await client.model(words);
    if (!m?.id) { console.error(`✗ Hugging Bay has no record "${words}".`); return 1; }
    console.log(`${m.name}
  licence ${m.licenseLabel || 'unknown'} (commercial use: ${m.commercialUse || 'unknown'}) · ${m.status || ''}`);
    if (m.mainFile) console.log(`  ${m.mainFile.path}  ${(Number(m.mainFile.sizeBytes) / 1e9).toFixed(2)} GB  needs ~${m.ramNeededGb ?? '?'} GB RAM
  sha256 ${m.mainFile.sha256}`);
    return 0;
  }
  if (verb === 'pull') {
    if (!words) { console.error('kingmaker models hb pull <hugging bay id>'); return 1; }
    let dir = readModelsDir(paths);
    if (!dir) { dir = join(paths.state, 'models', 'gguf'); mkdirSync(dir, { recursive: true }); saveModelsDir(paths, dir); console.log(`Models folder: ${dir} (change it: kingmaker models dir <folder>)`); }
    const capAt = rest.indexOf('--max-gb'), maxBytes = capAt >= 0 ? Number(rest[capAt + 1]) * 1e9 : Infinity;
    const r = await pullModel({ client, id: words, modelsDir: dir, maxBytes, onProgress: (got, all) => process.stdout.write(`\r  ${(got / 1e9).toFixed(2)} / ${(all / 1e9).toFixed(2)} GB`) });
    process.stdout.write('\n');
    if (!r.ok) { console.error(`✗ ${r.why}`); return 1; }
    console.log(`${r.already ? '✓ Already here' : '✓ Downloaded and verified (SHA-256 matches)'}: ${r.path}`);
    const own = scanGguf(dir).find((d) => d.file === r.path);
    if (own) console.log(`Use it: kingmaker models use ${own.id}  (a verified download is not proof it runs; try it once)`);
    return 0;
  }
  if (verb === 'catalog') {
    const i = rest.indexOf('--ram'), ram = i >= 0 ? Number(rest[i + 1]) : Math.round(hostMemoryGb());
    console.log(`Building the abliterated catalog from Hugging Bay (models that need ≤ ${ram} GB)… this takes a few minutes.`);
    const r = await buildCatalog({ client, maxRamGb: ram, log: (event, d) => { if (event === 'hb_catalog_page' && d.page % 10 === 0) console.log(`  ${d.q}: page ${d.page + 1}, ${d.candidates} hosted GGUF so far`); } });
    const out = new URL('./huggingbay-catalog.json', import.meta.url);
    writeFileSync(out, `${JSON.stringify({ source: 'https://huggingbay.xyz', builtAt: new Date().toISOString(), maxRamGb: ram, scanned: r.scanned, candidates: r.candidates, entries: r.entries }, null, 2)}\n`);
    console.log(`✓ ${r.entries.length} abliterated GGUF models (of ${r.candidates} hosted GGUF looked up, ${r.scanned} records scanned) → ${out.pathname}`);
    return 0;
  }
  if (verb === 'churn') {
    // The monthly scan (LaunchAgent org.kingmaker.hb-churn, 1st of the month): reports into catalog/churn/, downloads nothing.
    const dir = new URL('../catalog/churn/', import.meta.url), statePath = new URL('state.json', dir);
    mkdirSync(dir, { recursive: true });
    let state = null; try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* the first scan is a baseline */ }
    // --monthly (the daily LaunchAgent): scan only when the last good scan is 28+ days old, so a day Hugging Bay is down is
    // simply tried again the next morning.
    if (rest.includes('--monthly') && state?.scannedAt && Date.now() - Date.parse(state.scannedAt) < 28 * 86_400_000) {
      console.log(`Hugging Bay churn scan: last scan ${state.scannedAt.slice(0, 10)}; the next is due ${new Date(Date.parse(state.scannedAt) + 28 * 86_400_000).toISOString().slice(0, 10)}.`);
      return 0;
    }
    let picksFile = { picks: [], maxGbPerFile: 16 }; try { picksFile = JSON.parse(readFileSync(new URL('../catalog/kingmaker-picks.json', import.meta.url), 'utf8')); } catch { /* no picks yet */ }
    let r;
    try { r = await churnScan({ client, state, picks: picksFile.picks ?? [], maxGbPerFile: picksFile.maxGbPerFile ?? 16, maxRamGb: Math.round(hostMemoryGb()) }); }
    catch (error) {
      // Nothing is saved from a partial scan: missing pages would read as models "removed".
      const why = String(error?.message ?? error).slice(0, 120);
      console.error(`✗ Hugging Bay churn scan didn't finish (${why}); nothing was saved. It runs again tomorrow.`);
      if (rest.includes('--notify')) { try { execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(`Hugging Bay was unavailable (${why}). Trying again tomorrow.`)} with title "Kingmaker: churn scan"`], { stdio: 'ignore' }); } catch { /* no notification */ } }
      return 1;
    }
    writeFileSync(statePath, `${JSON.stringify(r.state)}\n`);
    const reportPath = new URL(`${r.day}.md`, dir);
    writeFileSync(reportPath, r.report);
    const summary = state ? `${r.added} added, ${r.removed} removed, ${r.worth} worth a look${r.pickChanges.length ? `, ${r.pickChanges.length} pick change(s)` : ''}` : `baseline of ${Object.keys(r.state.entries).length} builds`;
    console.log(`✓ Hugging Bay churn scan: ${summary}. Report: ${reportPath.pathname}`);
    if (rest.includes('--commit')) {
      const repo = new URL('..', import.meta.url).pathname;
      try { execFileSync('git', ['-C', repo, 'add', 'catalog/churn'], { stdio: 'ignore' }); execFileSync('git', ['-C', repo, 'commit', '-m', `Hugging Bay churn scan ${r.day}: ${summary}`, '--', 'catalog/churn'], { stdio: 'ignore' }); console.log('✓ Committed to the repo.'); }
      catch (e) { console.log(`! Not committed (${String(e?.message ?? e).slice(0, 80)}); the report is saved.`); }
    }
    if (rest.includes('--notify')) { try { execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(summary)} with title "Kingmaker: Hugging Bay churn scan"`], { stdio: 'ignore' }); } catch { /* no notification */ } }
    // --refresh (the owner, 2026-10-15: the library rotates itself on the 30-day churn): the new builds worth a look are
    // pulled, measured here and the Brain Library rebuilt and pushed (lib/bench-cli.mjs libraryRefresh). Picks change
    // only by a reviewed commit; the proposal is written beside the report.
    if (rest.includes('--refresh')) return (await import('./bench-cli.mjs')).cmdLibrary(paths, ['refresh', '--publish']);
    return 0;
  }
  console.log('kingmaker models hb search <words> | info <id> | pull <id> [--max-gb N] | catalog [--ram <GB>] | churn [--commit] [--notify]');
  return verb ? 1 : 0;
}

async function cmdModels(args) {
  const paths = resolvePaths();
  const [verb, arg] = args;
  if (verb === 'hb' || verb === 'huggingbay') return cmdHuggingBay(paths, args.slice(1));
  // This Mac's operating profile and the benchmark that sets the profiles (lib/mac-profiles.mjs, lib/model-bench.mjs).
  if (['profile', 'bench', 'packs', 'setup', 'library'].includes(verb)) { const b = await import('./bench-cli.mjs'); return { profile: b.cmdProfile, bench: b.cmdBench, packs: b.cmdPacks, setup: b.cmdSetup, library: b.cmdLibrary }[verb](paths, args.slice(1)); }
  const installed = new Set(await ollamaModels());
  if (verb === 'dir') {
    if (!arg) { console.log(readModelsDir(paths) || 'No models folder yet. kingmaker models dir /Volumes/<SSD>/models'); return 0; }
    if (!existsSync(arg)) { console.error(`✗ ${arg} is not there (is the drive plugged in?).`); return 1; }
    saveModelsDir(paths, arg);
    console.log(`Models folder: ${arg} (${scanGguf(arg).length} .gguf files). kingmaker models lists them.`);
    return 0;
  }
  const drive = scanGguf(readModelsDir(paths));
  if (verb === 'use' || verb === 'pull') {
    const own = drive.find((d) => d.id === arg || d.tag === arg);
    if (own) {
      if (!installed.has(own.tag)) {
        const modelfile = join(paths.state, 'Modelfile.import');
        writeFileSync(modelfile, `FROM ${JSON.stringify(own.file)}\n`);
        console.log(`ollama create ${own.tag} from ${own.file}`);
        const ok = await new Promise((resolve) => { const c = spawn('ollama', ['create', own.tag, '-f', modelfile], { stdio: 'inherit' }); c.on('close', (code) => resolve(code === 0)); c.on('error', () => resolve(false)); });
        if (!ok) { console.error(`✗ Ollama could not load ${own.file}.`); return 1; }
      }
      if (verb === 'use') { saveModelChoice(paths, own.tag); console.log(`Local brain: ${own.tag}. Restart Kingmaker (kingmaker stop, then start).`); }
      return 0;
    }
    const x = findModel(arg ?? '');
    if (!x) { console.error(`Unknown model "${arg ?? ''}". See kingmaker models all.`); return 1; }
    if (x.minGb > Math.round(hostMemoryGb())) console.log(`! ${x.id} wants a ${x.minGb} GB Mac; this one has ${Math.round(hostMemoryGb())} GB. It may swap.`);
    if (verb === 'pull' || !installed.has(x.tag)) {
      console.log(`ollama pull ${x.tag}`);
      const ok = await new Promise((resolve) => { const c = spawn('ollama', ['pull', x.tag], { stdio: 'inherit' }); c.on('close', (code) => resolve(code === 0)); c.on('error', () => resolve(false)); });
      if (!ok) { console.error(`✗ Could not pull ${x.tag} (is Ollama running, and is the tag still on the registry?).`); return 1; }
    }
    if (verb === 'use') { saveModelChoice(paths, x.tag); console.log(`Local brain: ${x.id}. Restart Kingmaker (kingmaker stop, then start); kingmaker brain local makes the local lane the one that answers.`); }
    return 0;
  }
  const filter = verb === 'abliterated' ? { abliterated: true } : verb === 'stock' ? { abliterated: false } : {};
  const list = verb === 'all' ? MODEL_CATALOG : modelsFor(hostMemoryGb(), filter);
  console.log(`Models for this Mac (${Math.round(hostMemoryGb())} GB). ▶ chosen  ✓ installed. kingmaker models use <id> pulls and picks one.`);
  for (const x of list) console.log(`  ${modelLine(x, installed, readModelChoice(paths))}`);
  const own = drive.filter((x) => verb === 'all' || ((filter.abliterated === undefined || x.abliterated === filter.abliterated) && x.minGb <= Math.max(8, Math.round(hostMemoryGb()))));
  if (own.length) { console.log(`On your drive (${readModelsDir(paths)}):`); for (const x of own) console.log(`  ${modelLine(x, installed, readModelChoice(paths))}`); }
  else if (!readModelsDir(paths)) console.log('Your own downloads (huggingbay.xyz, Hugging Face): kingmaker models dir /Volumes/<SSD>/models');
  const hb = hbCatalog().filter((e) => verb === 'all' || !e.ramGb || e.ramGb <= Math.round(hostMemoryGb()));
  if (hb.length) {
    console.log(`From Hugging Bay, abliterated, verified on download (${hb.length}): kingmaker models hb pull <id>`);
    for (const e of hb.slice(0, verb === 'all' ? hb.length : 25)) console.log(`  ${e.id}  ${(e.sizeBytes / 1e9).toFixed(1)} GB, ~${e.ramGb ?? '?'} GB RAM, ${e.license}`);
  }
  return 0;
}

async function cmdStart(args) {
  const paths = resolvePaths();
  const install = readInstallConfig(paths.state);
  const port = Number(flagValue(args, '--port') || process.env.SOL_GHOST_PORT) || DEFAULT_PORT;
  const blockers = await startBlockers(paths, port);
  if (blockers.length) { for (const b of blockers) console.error(`✗ ${b}`); return 78; }
  if (!(await ollamaUp())) console.error('! Ollama is not running, so local answers will degrade. Start it with: brew services start ollama');
  if (!findPeekabooBinary() && !findGhostBinary()) console.error('! No hands are installed, so Kingmaker cannot drive apps. Install Hands of Horus: brew install openclaw/tap/peekaboo (then allow it under Accessibility and Screen Recording).');

  const secrets = mintLaunchSecrets();
  // The voice log keeps decisions (woke, slept, ignored N chars, barge-in, the command sent) so a lost
  // command can be traced. What is heard while asleep is never written, only its length.
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const voiceLog = createWriteStream(join(paths.logs, 'voice.log'), { flags: 'a', mode: 0o600 });
  const log = (event, detail = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
    if (/^(wake|sleep|off|ears|heard|ignored|asleep_ignored|barge_in|mic_exit|mic_reopen|mic_stderr|evidence_opened|evidence_chrome_failed|owner_decision|self_print|utterance_failed|key_request|key_request_dropped|key_field|control_events_dropped|mic_silent|ptt|memory_retire|hb_mcp)$/.test(event)) voiceLog.write(`${line}\n`);
    if (process.env.SOL_GHOST_DEBUG === '1') console.error(`[kingmaker] ${line}`);
  };
  const interaction = createInteractionArbiter({ paths, log });
  const headlessHostMode = process.env.KINGMAKER_HEADLESS_HOST_MODE === '1';
  const hostPower = headlessHostMode ? startHeadlessHostAssertion({ log }) : null;
  const installedModels = await ollamaModels();
  // The local lane: the model the owner chose from the catalog (kingmaker models use <id>) answers as Kingmaker's brain.
  const chosenPins = chosenModelEnv(readModelChoice(paths), installedModels, process.env, BRAIN_ROLES);
  Object.assign(process.env, chosenPins);
  if (Object.keys(chosenPins).length) console.log(`  local model: ${readModelChoice(paths)}`);
  console.log(modelsLine(abliteratedModelEnv(installedModels)));
  // Paid add-ons first: load any this Mac is entitled to (none in a free install). register(host) only binds and registers;
  // it never starts anything on its own. Loaded before the engine so an add-on's say in its environment counts.
  addonPort = port; useAddonLog(log);
  await ensureAddons(paths, { port });
  const backend = await startBackend({ paths, port, secrets, log, installedModels });
  writeDaemonState(paths, { pid: process.pid, backendPid: backend.child.pid, port, startedAt: new Date().toISOString(), version: VERSION });
  console.log(`Kingmaker ${VERSION} — starting its engine (${paths.runtimeSource === 'fork' ? 'from the engine\'s source' : paths.runtimeSource === 'bundle' ? `the runtime inside ${paths.app}` : `borrowed from ${paths.app}`}) with no window on 127.0.0.1:${port} (log: ${backend.logPath})`);

  const controller = new AbortController();
  let pairIfNeeded = async () => {};
  let voice = null;
  let owner = null;
  let ring = null;
  let supervisor = null;
  let backgroundPower = null;
  let shuttingDown = false;
  let companionStop = async () => {};
  const shutdown = async (why, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    await companionStop().catch(() => {});
    voice?.stop?.();
    ring?.stop?.();
    backgroundPower?.release();
    backgroundPower = null;
    hostPower?.release();
    try { owner?.dispose(); } catch { /* the sidecar dies with us anyway */ }
    console.log(`\nStopping (${why})…`);
    // Seeker undocks from the CRM before the core goes (the core's own exit cannot wait for a network call).
    if (ronin) await ownerCall(port, `${ronin.APPROVER_ROUTE}/seats/stop`, { nonce: secrets.nonce, method: 'POST', body: {}, timeoutMs: 6_000 }).catch(() => null);
    // The intentional stop: the supervisor never respawns after it.
    await (supervisor ?? backend).stop();
    clearDaemonState(paths);
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try { await backend.ready; } catch (error) {
    console.error(`✗ ${error.message}`);
    await backend.stop(); clearDaemonState(paths); return 1;
  }
  // THE IPHONE COMPANION (lib/phone-companion.mjs) runs inside this process: the bar passes kingmaker://companion?op=…
  // on as `companion start|stop|status` (never showing the bar), the Ronin launcher reads it on its loopback /admin
  // routes, and on/off is remembered in the data folder so it comes back with the engine.
  let phoneTurn = null;   // set once the bar's control lines are read (below); without the app a phone's turn is refused
  const work = { running: 0, queued: 0 };   // the engine's turn queue, for the launcher's machine card
  recordTo(paths.state);                    // every model call from here on, for the launcher's history (lib/token-meter.mjs)
  const companion = createCompanion({ state: paths.state, log: (event, detail) => log(`companion_${event}`, detail),
    onTurn: async (text, meta) => { if (!phoneTurn) throw new Error('Kingmaker runs without its bar'); phoneTurn(text, meta); },
    metrics: () => bridgeMetrics({ state: paths.state, jobs: () => ({ ...work }), tokens: meterSnapshot }) });
  companionStop = () => companion.stop();
  const companionOp = async (op) => {
    let error = null;
    if (op === 'start') { setCompanionWanted(paths.state, true); await companion.start().catch((e) => { error = e.code === 'EADDRINUSE' ? `port ${e.port} is taken` : String(e?.message || e).slice(0, 160); }); }
    else if (op === 'stop') { setCompanionWanted(paths.state, false); await companion.stop(); }
    return { ...companion.status(), ...(error ? { error } : {}) };
  };

  // THE DURESS ("dead man's") SWITCH (lib/duress.mjs): armed OFF. When the owner gives their exact duress password
  // (typed in the bar, sent from the phone, or spoken — all route through routeTurn), it exports a last CSV to a cloud
  // folder, then wipes Kingmaker's whole presence on this Mac. The live wipers refuse to run from a source checkout.
  const duressCloud = async ({ csv, cloud }) => {
    const dirs = cloud ? [cloud] : ['Library/Mobile Documents/com~apple~CloudDocs', 'Library/CloudStorage', 'Dropbox', 'Google Drive'].map((d) => join(homedir(), d));
    for (const d of dirs) { try { if (existsSync(d)) { const f = join(d, `kingmaker-duress-${Date.now()}.csv`); writeFileSync(f, csv, { mode: 0o600 }); return { ok: true, where: f }; } } catch { /* try the next */ } }
    return { ok: false, reason: 'no cloud folder found' };
  };
  const duress = createDuress({ state: paths.state, log, ...liveDuressDeps({ log, cloudSend: duressCloud }) });
  if (companionWanted(paths.state)) void companionOp('start').then((s) => { if (s.error) console.error(`! iPhone companion: ${s.error}`); });
  // The Ronin office (the Ronin office add-on): its desks, owner calls and terminal-free pairing.
  if (ronin) ({ pairIfNeeded } = ronin.startRoninOffice({ paths, port, nonce: secrets.nonce, signal: controller.signal, log, ringer: companion.ringer, version: runningVersion() }));
  // Until the launch is fully up (rules checked, owner session open) a core that exits is a boot failure.
  // After that the supervisor below restarts it (bounded) instead.
  backend.exited.then(({ code, signal }) => { if (!shuttingDown && !supervisor) { console.error(`✗ Kingmaker's engine exited (code ${code}, signal ${signal}). See ${backend.logPath}`); clearDaemonState(paths); process.exit(1); } });

  // Hands of Horus is Peekaboo (github.com/openclaw/Peekaboo, MIT licence), credited here where it is invoked;
  // ghost-os remains the fallback when it is not installed.
  // Warm the hands before saying ready: the mac provider starts its hands (Hands of Horus or ghost-os, ≈2 s cold)
  // and probes them inside the catalog's 4 s listing budget, which a swapping 8 GB host can miss on the first turn.
  // Bounded: 3 tries. Which hands the line names is what the server reports it is using.
  const handsKind = selectHands({ env: backend.backendEnv ?? {}, ghostBin: backend.ghostBin, peekabooBin: backend.peekabooBin });
  const handsBin = { ghost: backend.ghostBin ?? null, peekaboo: handsBinary(backend.backendEnv) ?? backend.peekabooBin ?? null };
  const handsInfo = handsKind === 'peekaboo' ? await peekabooInfo(handsBin.peekaboo).catch(() => ({ version: null, toolCount: null })) : null;
  const hands = await warmHands(port, { [DESKTOP_NONCE_HEADER]: secrets.nonce }, handsInfo);
  console.log(hands);

  // Fail closed: the rules must be the window's rules. If the launch secrets did not reach the server
  // (enforcement off) any local program could approve, so Kingmaker stops instead of running that way.
  const rules = await controlStatus(port, { headers: { [DESKTOP_NONCE_HEADER]: secrets.nonce } }).catch(() => null);
  // Hugging Bay in the engine's MCP hub: its read tools for the brain (find, check and plan local models); the public-posting
  // ones stay off until the owner reviews them. Once a launch, in the background; nothing waits on it.
  if (process.env.KINGMAKER_HUGGINGBAY !== '0') void ensureHuggingBayMcp({ port, nonce: secrets.nonce, log }).catch(() => null);
  const verdict = rulesVerdict(rules?.json?.data);
  if (!verdict.ok) {
    console.error(`✗ ${verdict.line}`);
    await backend.stop(); clearDaemonState(paths); return 78;
  }
  console.log(verdict.line);
  // Keep the Chrome connector current, exactly as the window app does at launch (never sets it up unasked).
  console.log((await syncChromeConnector(paths).catch((e) => ({ line: `Chrome connector: ${e.message}` }))).line);

  const agent = args.includes('--agent');
  // --agent: run under Kingmaker.app. One "@@ghost {json}" line per state change for the menu bar
  // indicator; no console. Approvals are your word: your enrolled voice, never a menu click.
  let voiceState = 'asleep';
  let waiting = false;
  let working = false;
  const emit = (state, extra = {}) => {
    if (state === 'waiting') waiting = true; else if (state === 'clear') waiting = false;
    else if (state === 'working') {
      working = true;
      if (!headlessHostMode) backgroundPower ??= startIdleSleepAssertion({ log });
    } else if (state === 'idle') {
      working = false;
      if (!headlessHostMode) {
        backgroundPower?.release();
        backgroundPower = null;
      }
    }
    else if (state !== 'speaking') voiceState = state;
    const look = glowState(state, { voiceState, waiting, working });
    if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ state: look, ...extra })}\n`);
    else ring?.send?.(look, extra);
  };

  // TEXT ONLY (lib/ring.mjs textOnlyFor): no listening loop and no spoken replies, so no whisper, wake word or Kokoro in
  // memory. The app passes Customize → Voice as --voice-mode; 'auto' is text only on an 8 GB-class Mac and voice above.
  const voiceModeArg = args.includes('--voice-mode') ? args[args.indexOf('--voice-mode') + 1] : null;
  const textOnly = voiceModeArg != null && textOnlyFor(voiceModeArg);
  if (voiceModeArg != null) log('voice_mode', { mode: String(voiceModeArg).slice(0, 10), textOnly });
  const quiet = args.includes('--quiet') || textOnly;
  const voiceAuthority = resolveVoiceAuthority(process.env, savedVoiceAuthority(paths));
  // SELF-CHECK: the voice-turn ledger the core reads (SOLOMON_VOICE_TURNS_PATH) and the health snapshot of what
  // Kingmaker observed (voice, the real microphone, ghost-os's Accessibility), posted on change from this owner
  // process with the nonce, refreshed before a turn when it is about to lapse.
  const voiceTurnsFile = backend.backendEnv?.SOLOMON_VOICE_TURNS_PATH || voiceTurnsPath(paths);
  const voiceLedger = createVoiceTurnLedger({ path: voiceTurnsFile, version: VERSION });
  // LEARNING (lib/learning.mjs): on by default ("learning off" stops it); it learns how the owner likes work done from their turns.
  const learning = openLearning({ state: paths.state, tenant: defaultTenant(paths.state, existsSync, ronin?.LEARNING_TENANTS), log: (event, data) => log(event, data) });
  // COMMUNITY SHARING (lib/sharing.mjs, docs/community-learning.md): on by default with a real choice. The permissions box
  // (@@ghost shareAsk → the bar, in its own colours) is shown once, after a finished turn; nothing leaves the Mac before it.
  // The bar answers with the control line `share yes|no|log`; Customize → Permissions reflects @@ghost {sharing}.
  // The packet is the engine's own (vendored sanitizer and schema): kept preferences go as closed kinds only. The collective's
  // front door (fleet-host) is used only once configured (fleet.json); until then packets are logged here as not sent.
  const fleet = fleetTransport({ state: paths.state });
  const fleetId = () => installationId(paths.state, newInstallationId);
  const sharing = openSharing({
    state: paths.state, learningOn: () => learning.enabled(), log: (event, data) => log(event, data),
    buildPacket: async () => {
      const { packet } = sanitizeForFleet(fleetDraft({ id: fleetId(), version: VERSION, totalMemBytes: totalmem(), preferences: learning.kept() }));
      return packet.artifacts.length ? packet : null;
    },
    validate: validateFleetPacket, send: fleet.send, forgetRemote: fleet.forgetRemote && (() => fleet.forgetRemote(fleetId())),
  });
  // IS THIS THE OFFICIAL KINGMAKER? (lib/integrity.mjs): checked once, in the background, after launch. A changed copy
  // keeps working here but never reaches the collective; the bar says so once.
  const integrity = createIntegrity({ state: paths.state, log: (e, d) => log(e, d),
    onModified: (r) => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: MODIFIED_NOTE(r.reason) })}\n`); } });
  setTimeout(() => void integrity.start(), 15_000).unref?.();
  // Once a day, quietly (the first ten minutes after start): never before the box was shown, never with sharing off,
  // never from a changed copy.
  const shareDaily = () => (!integrity.official() ? log('sharing_daily', { skipped: 'not the official build' }) : void sharing.contribute().then((r) => log('sharing_daily', r)).catch((e) => log('sharing_daily', { error: String(e?.message || e).slice(0, 160) })));
  setTimeout(shareDaily, 10 * 60_000).unref?.(); setInterval(shareDaily, 24 * 3600_000).unref?.();
  const emitSharing = () => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ sharing: sharing.enabled() })}\n`); };
  let shareAsked = false;
  const maybeAskShare = () => {
    if (!agent || shareAsked) return;
    const box = sharing.ask();
    if (box) { shareAsked = true; process.stdout.write(`@@ghost ${JSON.stringify({ shareAsk: box })}\n`); }
  };
  emitSharing();
  // THE COMMAND LIST (lib/command-list.mjs): the bar's Commands pill shows it as a Mac menu.
  if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ commands: commandMenu() })}\n`);
  // FAST THOUGHT (lib/fast-route.mjs): the lightweight abliterated router gives every command a lane first, and this layer
  // drives the local programs itself. Writing goes to the local writer, pictures to the image engine. Only actions and
  // lookups reach the governed brain, so every send, pay or record change keeps its approval. `pin` is the local model
  // pinned in the bar's picker: it takes the write lane's place of WRITER_MODEL, nothing else.
  const imageSetup = imageLaneSetup({ state: paths.state });
  // The writer sees one message at a time, so the last written exchange rides along with a short follow-up ("yes",
  // "make it shorter") for ten minutes (lib/follow-up.mjs).
  let lastWrite = null;
  // CUSTOMIZE (lib/calibration.mjs): each function's model weights and numbers, read again on every turn.
  const cal = () => readCalibration(paths.state);
  let idleTouch = () => {};   // every turn the owner starts resets the idle clock (lib/idle-gaps.mjs)
  // HOW SHOULD KINGMAKER BEHAVE (Customize → Interaction, lib/instructions.mjs): the owner's standing instructions and
  // guardrails, at the core of every lane: in the local models' system brief, and ahead of every turn the governed
  // brain hears (below). They shape how it thinks and answers; the approval gates stay in code, under them.
  // What Kingmaker learned about the owner, read into a local writer turn: a use of that dataset (GET /admin/datasets).
  const briefFor = (text, model = null) => {
    const learned = learning.brief();
    if (learned) meterDataset({ dataset: memoryDatasetId(basename(learning.root)), model, lane: 'writer', kind: 'turn' });
    // Not the absorbed skills: every lane here only writes text, and a writer told about skills it can't call narrates
    // them into its answers ("Kingmaker, using hugging-bay-models-blackboard: …", soak 2026-10-15). Skills are offered
    // where they can run: the connector lane.
    // The system brief stays the same turn after turn (Ollama reuses what it read of it); only what was picked for this
    // turn's words rides with the turn (lib/instructions.mjs conductParts).
    const { stable, turn } = conductParts(paths.state, text, { brief: true });
    return { brief: [learned, stable].filter(Boolean).join('\n\n'), turnBrief: turn };
  };
  // A CRM skill or CRM job reads the connected CRM through the engine's governed brain: a use of that dataset.
  const crmUse = (kind) => { const dataset = crmDatasetId(paths.runtimeHome); if (dataset) meterDataset({ dataset, model: 'kingmaker', lane: null, kind }); };
  const fastLane = async (text, framed = text, pin = null) => {
    const c = cal();
    const route = await routeLane(text, { model: c.router.model });
    const writer = writerModel(pin);   // the picker's pin, else the default writer (one place sets it)
    log('fast_route', { lane: route.lane, by: route.by, ms: route.ms, ...(route.lane === 'write' ? { writer } : {}) });
    if (route.lane === 'write') {
      const answer = await localModelTurn(writer, withFollowUp(framed, text, lastWrite, Date.now(), c.followUp.minutes * 60_000), { ...briefFor(text, writer), temperature: c.writer.temperature, context: c.writer.context });
      lastWrite = { asked: text, answer, at: Date.now() };
      await session.say(answer); return true;
    }
    if (route.lane === 'image' && imageSetup.ready) {
      await session.say('Drawing it on this Mac. About a minute and a half.');
      const r = await makeImage(text, { setup: imageSetup });
      // In the bar the picture shows right in the chat (Preview would open behind the bar); at a terminal, Preview opens it.
      if (r.ok && agent) { process.stdout.write(`@@ghost ${JSON.stringify({ image: { path: r.file } })}\n`); await session.say(`Done in ${Math.round(r.ms / 1000)} seconds. It's above, and saved with Kingmaker's files (Artifacts in the bar).`); }
      else if (r.ok) { execFile('/usr/bin/open', [r.file], () => {}); await session.say(`Done in ${Math.round(r.ms / 1000)} seconds. It's open, and saved with Kingmaker's files (Artifacts in the bar).`); }
      else await session.say(`I couldn't draw it: ${r.reason}.`);
      return true;
    }
    return false;
  };
  const selfCheck = createHealthReporter({
    post: async (desktop, { timeoutMs }) => (await postHealthSnapshot(port, desktop, { headers: { [DESKTOP_NONCE_HEADER]: secrets.nonce }, timeoutMs }).catch(() => null))?.ok === true,
    tally: () => readVoiceTurnTally(voiceTurnsFile),
    foundation: () => readFoundation(join(paths.resources, 'foundation-capabilities.json')),
    log,
  });
  const checkHands = () => handsPermissions({ kind: handsKind, ghostBin: handsBin.ghost, peekabooBin: handsBin.peekaboo }).then((p) => selfCheck.update(p)).catch(() => {});
  void checkHands();
  // A turn that asks for an API key ("connect my GitHub key") reaches this console as a control event. With no
  // terminal attached there is nowhere to paste it, so it is cancelled and said so; with one, keyHandoff (below)
  // takes it at the hidden prompt.
  let keyHandoff = (handoff) => void (async () => {
    await ownerCall(port, `/api/key-handoff/${encodeURIComponent(handoff.handoffId)}/cancel`, { nonce: secrets.nonce, method: 'POST', body: {} }).catch(() => null);
    await session.say(`I take a ${handoff.keyNoun} only typed at a terminal, and this Kingmaker has none. Start it in Terminal with kingmaker start, then type :key ${handoff.provider} there.`);
  })();
  let desk = null;
  // The brain: the engine's own (default), or an explicitly chosen signed-in CLI behind Kingmaker's only MCP.
  const lane = resolveBrain(process.env, readBrainChoice(paths));
  const brain = lane === 'claude' ? createClaudeBrain({ paths, port, say: (line) => session.say(line), log })
    : lane === 'chatgpt' ? createChatgptBrain({ paths, port, say: (line) => session.say(line), log })
      : lane === 'grok' ? createGrokBrain({ paths, port, say: (line) => session.say(line), log }) : null;
  if (brain) console.log(`  brain: ${{ claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' }[lane]} (${brain.bin}), memory ${brain.memoryPath}`);
  let lastSaid = '';
  // NEXT COMMAND (lib/next-suggest.mjs): after a typed turn, the bar's box shows one suggested next command (Tab takes it).
  const suggestAfter = (asked) => { if (!agent) return; maybeAskShare(); const c = cal(); if (!c.suggest.on) return; void suggestNext({ asked, answer: lastSaid, model: c.suggest.model }).then((s) => { if (s) process.stdout.write(`@@ghost ${JSON.stringify({ suggest: s })}\n`); }); };
  const session = createOwnerSession({
    port, secrets, runtimeHome: paths.runtimeHome, voiceOut: !quiet, log, onState: emit, voiceAuthority,
    beforeTurn: () => selfCheck.refresh(), onKeyHandoff: (handoff) => keyHandoff(handoff),
    capabilityLine: (text, spoken) => desk?.capabilityLine(text, spoken) ?? null,
    narrationGate: () => interaction.gate('narration'),
    onNarrationSuppressed: ({ text, owner: leaseOwner }) => interaction.route('narration_suppressed', text, { owner: leaseOwner }),
    // Every line Kingmaker says also goes to the Kingmaker bar as text (muted or not), so it can be used by typing alone.
    onSaid: (line) => { lastSaid = line; if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: line.slice(0, 4000) })}\n`); },
    // The bar lists a turn's sources under its answer as links (nothing opens until the owner clicks one).
    linkLimit: () => cal().sources.max,
    onLinks: agent ? (links) => process.stdout.write(`@@ghost ${JSON.stringify({ sources: links })}\n`) : null,
  });
  // Every turn the governed brain hears carries the owner's instructions (not a bare yes/no: that answers an approval).
  for (const b of [session, brain].filter(Boolean)) {
    const run = b.runTurn.bind(b);
    b.runTurn = (text, ...rest) => run(typeof text === 'string' && !['yes', 'no'].includes(classifyLine(text)) ? withInstructions(paths.state, text) : text, ...rest);
  }
  // THE DEVICE DESK: the first-run scan of this Mac, "scan my Mac", "find tools for my apps", "put my keys in the vault",
  // "install <tool>", "get me a <provider> key", "set up my keys", "save it". Every write is read back and waits for
  // his word (typed here, or spoken when his voice is his word); the paste box is his own act.
  // KINGMAKER OPENS JOBS (lib/crm-jobs.mjs): work requests go on the CRM's board through the engine's sealed CRM connection;
  // Kingmaker on this Mac takes them when it can, Claude or Codex when it can't, and the result comes back to the bar.
  const crmJobs = ronin && ronin.createCrmJobs({
    open: (body) => ownerCall(port, `${ronin.JOBS_ROUTE}/open`, { nonce: secrets.nonce, method: 'POST', body, timeoutMs: 30_000 }).then((r) => { if (r?.ok) crmUse('job'); return r; }),
    read: (taskId) => ownerCall(port, `${ronin.JOBS_ROUTE}/${encodeURIComponent(taskId)}`, { nonce: secrets.nonce, timeoutMs: 20_000 }),
    say: (line) => session.say(line),
    // A job's result is the latest written answer too: "make it shorter" right after it goes to the writer with it.
    show: (text) => { lastWrite = { asked: 'the job just finished', answer: text, at: Date.now() }; if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: text.slice(0, 4000) })}\n`); else console.log(text); },
    log: (event, data) => log(event, data),
  });
  desk = createDeskOfDevice({ paths, port, nonce: secrets.nonce, say: (line) => session.say(line), out: (line) => console.log(line), log, voiceAuthority, voiceApproves: () => voiceApproves });
  // THE OVERNIGHT LOOP (the Ronin office add-on): once a night, with :nightly on (typed; it ships off), the health checks the owner
  // listed and the day's data entry are DRAFTED (the cloud brain reads, never the local model); nothing is written, sent or
  // changed. In the morning the bar shows one card: "Approve all" sends exactly that list to the CRM as jobs.
  // Its own brain (:nightly brain claude|chatgpt; Claude unless the daytime brain is a cloud one), made once, used only to draft.
  let nightly = null, nightlyAnswer = async () => roninOnly('The overnight loop');
  if (ronin) {
    const nightLane = () => ronin.nightBrain(ronin.readSwitch(paths.state).brain, lane);
    const draftBrains = {};
    const draftBrain = (name) => (draftBrains[name] ??= name === lane && brain?.draft ? brain
      : (name === 'chatgpt' ? createChatgptBrain : createClaudeBrain)({ paths, port, say: async () => {}, log }));
    nightly = ronin.createNightly({
      state: paths.state,
      brainName: nightLane,
      draft: (prompt) => draftBrain(nightLane()).draft(prompt),
      sop: () => sopFor(paths.state, 'overnight nightly loop data entry system health monitoring'),
      submit: async (group, items) => {
        const body = { ...ronin.jobRequest(group, items), kind: 'write', asked_by_person: true, request_id: `nightly-${group}-${Date.now().toString(36)}` };
        const r = await ownerCall(port, `${ronin.JOBS_ROUTE}/open`, { nonce: secrets.nonce, method: 'POST', body, timeoutMs: 30_000 }).catch((e) => ({ ok: false, json: { error: String(e?.message || e) } }));
        const d = r?.ok ? r.json?.data : null;
        if (d?.task_id) crmUse('job');
        // The CRM's usage split applies here like to any job: held for allocation means held (never done on this Mac instead).
        if (d?.task_id && ronin.outOfAllocation(d)) return { ok: true, taskId: d.task_id, held: String(d.reason || d.waiting || 'allocation used up') };
        return d?.task_id ? { ok: true, taskId: d.task_id } : { ok: false, error: r?.json?.detail || r?.json?.error || `HTTP ${r?.status ?? '?'}` };
      },
      card: (box) => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify(box ? { approvalAsk: box } : { approvalAskClose: 'nightly' })}\n`); },
      note: (line) => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: line.slice(0, 4000) })}\n`); else console.log(`  ${line}`); },
      meeting: () => meetingHold(paths).active,
      busy: () => work.running > 0 || Boolean(session.isSpeaking?.()),
      log,
    });
    nightly.start();
    setTimeout(() => nightly.resume(), 20_000).unref?.();
    /** :nightly … typed (console or the bar), or the card's own control line. Never from speech. */
    nightlyAnswer = async (cmd) => {
      if (cmd.op === 'on' || cmd.op === 'off') { ronin.writeSwitch(paths.state, { on: cmd.op === 'on' }); log('nightly_switch', { on: cmd.op === 'on' }); return nightly.status(); }
      if (cmd.op === 'status') return nightly.status();
      if (cmd.op === 'brain') { ronin.writeSwitch(paths.state, { brain: cmd.brain }); return nightly.status(); }
      if (cmd.op === 'show') return ronin.listText(nightly.current());
      if (cmd.op === 'later') return 'The list waits; nothing on it changes until you approve it.';
      if (cmd.op === 'run') { const r = await nightly.runNow({ manual: true }); return r.ok ? ronin.listText(r.list) : `Not run: ${r.error}.`; }
      if (cmd.op === 'approve') { const r = await nightly.approve({ hash: cmd.hash, skip: cmd.skip }); return r.ok ? ronin.listText(r.list) : `Not approved: ${r.error}.`; }
      if (cmd.op === 'edit' || cmd.op === 'answer') { const r = nightly[cmd.op](cmd.id, cmd.text); return r.ok ? ronin.listText(r.list) : `Not changed: ${r.error}.`; }
      return 'Overnight loop: :nightly on | off | status | brain claude|chatgpt | show | run | approve <code> [skip 2,3] | edit <n> <value> | answer <n> <text>';
    };
  }
  /** "stop approving": the core pauses the delegated approvals at once (and keeps them off until :approvals on). */
  const stopApprovals = async (via) => {
    const r = await ownerCall(port, `${ronin.APPROVER_ROUTE}/pause`, { nonce: secrets.nonce, method: 'POST', body: { via }, timeoutMs: 10_000 }).catch(() => null);
    log('approvals_paused', { via, ok: Boolean(r?.ok) });
    await session.say(r?.ok ? (r.json?.data?.spoken || 'Approvals are paused.') : 'I could not reach the core to pause approvals. Stop Kingmaker to be sure nothing is approved.');
    return { followUp: false, ok: Boolean(r?.ok) };
  };
  /** "stop forwarding": the core pauses the inbound DM bridge at once (and keeps it paused until :dms on). */
  const stopForwarding = async (via) => {
    const r = await ownerCall(port, `${ronin.DMS_ROUTE}/pause`, { nonce: secrets.nonce, method: 'POST', body: { via }, timeoutMs: 10_000 }).catch(() => null);
    log('dm_forwarding_paused', { via, ok: Boolean(r?.ok) });
    await session.say(r?.ok ? (r.json?.data?.spoken || 'DM forwarding is paused.') : 'I could not reach the core to pause DM forwarding. Stop Kingmaker to be sure nothing more is forwarded.');
    return { followUp: false, ok: Boolean(r?.ok) };
  };
  const barGuard = createBarGuard({ duress, isStopApproving: (x) => Boolean(ronin?.isStopApproving(x)), isStopForwarding: (x) => Boolean(ronin?.isStopForwarding(x)), stopApprovals, stopForwarding, say: (line) => session.say(line), log });
  /** A line for the desk first (its read-back waiting for a yes, or one of its asks), else an engine turn. */
  const routeTurn = async (text, opts, who) => {
    // THE DURESS SWITCH and THE KILL SWITCHES come before everything (lib/bar-guard.mjs): the duress text is never echoed,
    // logged or sent on, and the same guard runs on the bar's raw typed words before any framing.
    const guarded = await barGuard.handle(text, { typed: Boolean(who?.typed) });
    if (guarded) return { followUp: false, ok: true };
    const learnSaid = learning.handle(text, who?.typed ? 'typed' : 'said');
    if (learnSaid) { emitSharing(); return session.say(learnSaid); }
    const shareSaid = await sharing.handle(text, who?.typed ? 'typed' : 'said');
    if (shareSaid) { emitSharing(); return session.say(shareSaid); }
    const learnAsk = learning.learn(text, who?.typed ? 'chat' : 'voice');
    const run = async () => {
      const kind = classifyLine(text);
      if ((kind === 'yes' || kind === 'no') && desk.pending()) return desk.answer(kind, who);
      // A work request ("make an ad…", "write the proposal", "research X") is a job on the CRM's board (lib/crm-jobs.mjs).
      if (kind !== 'yes' && kind !== 'no' && !desk.pending() && crmJobs && cal().crmJobs.on && await crmJobs.handle(text)) return { followUp: false, ok: true, spoke: true, route: 'job' };
      if (kind !== 'yes' && kind !== 'no' && !desk.pending() && await fastLane(text)) return { followUp: false, ok: true, spoke: true, route: 'fast' };
      if (brain) {
        // A spoken yes/no to a cloud-brain proposal is the owner's decision, bound to the proposal id.
        if (kind === 'yes' || kind === 'no') { await session.refreshPending(); if (session.pending.some((p) => p?.status === 'PENDING')) return session.decide(kind, async () => ''); }
        return (await desk.handle(text, who)) ?? brain.runTurn(text);
      }
      return (await desk.handle(text, who)) ?? session.runTurn(text, opts);
    };
    const out = await (headlessHostMode ? run() : withIdleSleepAssertion(run, { log }));
    if (learnAsk) await session.say(learnAsk).catch(() => {});
    return out;
  };
  session.watchControlEvents(controller.signal);
  // Said on Ghost's own initiative, from the server's streams (never polled): a background task's "It's
  // ready" line, and a new capability ask. Both wait for any turn in flight; neither approves anything.
  void session.watchBackgroundTasks(controller.signal);
  void session.watchFeatureWatch(controller.signal);
  // DELEGATED APPROVALS, problems only: printed, said when awake, texted to the owner's own number when phone is set up.
  if (ronin) {
    const onApproverAlert = ronin.createApprovalAlerts({ out: (line) => console.log(line), announce: (line) => session.announce(line), isAwake: () => Boolean(voice?.isAwake?.()), log });
    void followStream({
      name: 'approver_alerts', signal: controller.signal, log,
      open: ({ onOpen }) => streamEvents(port, `${ronin.APPROVER_ROUTE}/events`, { headers: { [DESKTOP_NONCE_HEADER]: secrets.nonce }, signal: controller.signal, onOpen, onEvent: onApproverAlert }),
    });
  }

  // CRASH RESPAWN: from here on a core that dies is started again (1 s, 3 s, 9 s; at most 3 in a minute) with
  // this launch's secrets, and its rules are re-checked before it counts as back. Said once per restart and
  // once if it gives up; never after an intentional stop.
  supervisor = superviseBackend(backend, {
    relaunch: () => startBackend({ paths, port, secrets, log, installedModels, afterCrash: true }),
    isPortFree: () => portFree(port),
    verify: async () => rulesVerdict((await controlStatus(port, { headers: { [DESKTOP_NONCE_HEADER]: secrets.nonce } }).catch(() => null))?.json?.data).ok,
    onEvent: (name, detail) => {
      const { backend: b, ...rest } = detail;
      log(`backend_${name}`, { ...rest, ...(b ? { pid: b.child?.pid } : {}) });
      if (shuttingDown) return;
      if (name === 'restarting') {
        console.error(`✗ Kingmaker's core exited (code ${detail.code}, signal ${detail.signal}); restarting it in ${Math.round(detail.delayMs / 1000)} s (crash ${detail.crashes} of ${BACKEND_RESPAWN_DELAYS_MS.length} allowed within a minute). What it printed is kept in ${paths.logs}.`);
        void session.say("Kingmaker's core stopped unexpectedly. I'm restarting it.");
      } else if (name === 'respawned') {
        writeDaemonState(paths, { pid: process.pid, backendPid: b.child.pid, port, startedAt: new Date().toISOString(), version: VERSION, respawned: true });
      } else if (name === 'recovered') {
        console.log('✓ Kingmaker\'s core is back up.');
        // The new core's health cache is empty: post what Kingmaker observed again.
        void selfCheck.repost();
      } else if (name === 'gave_up') {
        console.error(`✗ Kingmaker's core stopped and will not be restarted: ${detail.reason}. What it printed is in ${paths.logs} (server-crash-*.log). Start Kingmaker again to retry.`);
        void session.say("Kingmaker's core keeps stopping, so I've stopped restarting it. Start Kingmaker again when you're ready.")
          .finally(() => shutdown('the core could not be kept running', 1));
      }
    },
  });

  // Can a spoken yes approve this run? 'owner': yes, anything heard while awake. 'verified': only the enrolled
  // owner's attested voice. 'propose': never.
  // The ring travels with the voice: from a terminal, Kingmaker brings up the ring before it listens, and
  // without a ring it does not listen at all. Under Kingmaker.app (--agent) the app is the ring.
  const wantsVoice = !args.includes('--no-voice') && !textOnly;
  if (wantsVoice && !agent) {
    ring = await startRing({ binary: findRingApp() });
    log('ring', { ok: ring.ok, reason: ring.reason ?? null });
  }
  const plan = voicePlan({ wantsVoice, agent, ring });
  if (plan.line) console.log(plan.line);
  const listening = plan.listening;
  let voiceApproves = listening && voiceAuthority === 'owner';
  if (listening && voiceAuthority === 'verified') {
    // Verified (opt-in): the engine's own gate + this launch's attestation key. Every voice turn carries a token
    // for its exact text; only the enrolled owner's live voice verifies as owner_voice on the server.
    owner = await openOwnerVoice({ paths, attestationKeyHex: secrets.voiceKey, log }).catch((error) => { log('owner_voice_unavailable', { message: String(error?.message || error).slice(0, 160) }); return null; });
    const ownerStatus = owner ? owner.ov.status() : null;
    voiceApproves = ownerStatus?.enrolled === true;
    console.log(ownerVoiceLine(ownerStatus));
    if (voiceApproves) {
      // Warm CAM++ and learn Kingmaker's own voice (the anti-print) off the critical path.
      void owner.ov.supervisor.warm()
        .then(() => learnSelfPrint(owner.ov))
        .then((r) => log('self_print', { ok: r.ok, samples: r.samples ?? 0, reason: r.reason ?? null }))
        .catch((error) => log('self_print', { ok: false, reason: String(error?.message || error).slice(0, 120) }));
    }
  }
  void selfCheck.update({ voice: listening ? 'starting' : 'off' });
  // ANY LANGUAGE (lib/lang.mjs): the Mac's voices listed once now, so switching languages mid-conversation never waits.
  // An answer in a language with no voice installed is spoken anyway, and the bar says how to add one (once).
  setImmediate(() => log('voices', { count: warmVoices() }));
  // ONE HIDDEN KINGMAKER FOLDER (lib/kingmaker-home.mjs): what Kingmaker left in sight (Desktop, ~/Documents/Kingmaker,
  // ~/Pictures/Kingmaker) moves into it.
  setImmediate(() => { const moved = tidyDesktop({ log }); if (moved.length && agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: `Moved ${moved.length} Kingmaker file${moved.length === 1 ? '' : 's'} out of sight into Kingmaker's own hidden folder. Everything it makes goes there now; find it all under Artifacts in the bar.` })}\n`); });
  setMissingVoiceHandler((code) => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: `(This Mac has no ${languageName(code)} voice yet, so that sounded off. Add one: System Settings → Accessibility → Spoken Content → System voice → Manage Voices → ${languageName(code)}.)` })}\n`); });
  if (listening) {
    voice = startVoiceLoop({
      paths, exists: existsSync, log, install,
      interactionOwner: () => interaction.owner,
      onSuppressed: ({ type, owner: leaseOwner, text }) => interaction.route(type, text, { owner: leaseOwner }),
      onMic: (state) => { void selfCheck.update({ mic: state }); },
      onTurn: (t) => { voiceLedger.record(t); void selfCheck.noteTurn(); },
      say: (line) => session.say(line),
      isSpeaking: () => session.isSpeaking(),
      interrupt: () => session.interrupt(),
      onState: emit,
      ownerVoice: owner ? ownerVoiceForLoop(owner.ov, { enrolled: voiceApproves }) : null,
      onCommand: (text, { attestation } = {}) => {
        idleTouch();
        const gate = interaction.gate('voice-command');
        if (!gate.allowed) { interaction.route('voice_command_suppressed', text, { owner: gate.owner }); return { followUp: false, ok: false, spoke: false, suppressed: gate.owner }; }
        console.log(`  🎙 ${text}`);
        return routeTurn(text, { owner: false, mode: 'voice', attestation }, { spoken: true, attested: Boolean(attestation) });
      },
      // "shut down" / "turn yourself off" said to it: the off switch, same as :quit.
      onOff: () => { void shutdown('voice: off'); },
    });
    const spoken = {
      owner: 'Awake, what you say is your word: commands run, and yes approves (RED needs its two words).',
      verified: voiceApproves ? 'Only your enrolled voice is your word: say "yes, go ahead" to approve, "cancel" to cancel.' : 'Verified voice is on but no voice is enrolled, so spoken commands can ask but not act. Run: kingmaker enroll',
      propose: 'Spoken commands only propose; approve here.',
    }[voiceAuthority];
    if (voice.ok) console.log(voice.listenWhileAsleep
      ? `Asleep and listening for its name. Say "${voice.word}" to wake it; "that's all" to put it back to sleep; "shut down" to turn it off. ${spoken}`
      : `Asleep with the microphone off. Wake it: "Hey Siri, wake Kingmaker" (or kingmaker wake); awake, it answers to "${voice.word}". "That's all" puts it back to sleep and "shut down" turns it off. ${spoken}`);
    if (voice.ok) console.log(wakeWordLine(install, wakeSetup({ install, env: process.env })));
    else console.log(`Voice is off: ${voice.reason}.`);
    void selfCheck.update({ voice: voice.ok ? 'listening' : 'failed' });
    if (ring?.ok) {
      if (voice.ok) {
        emit(voiceState);
        // No ring, no voice: if the ring goes away mid-run (closed, crashed), the microphone stops with it.
        ring.exited.then(() => {
          if (shuttingDown) return;
          voice?.stop?.();
          void selfCheck.update({ voice: 'off' });
          log('ring_lost', {});
          console.error('✗ The ring closed, so voice is off: it never runs without the ring. Typing still works.');
        });
      } else ring.stop();
    }
  }
  // KNOWLEDGE AS CONTEXT: build the knowledge index from the sources on this Mac, in the background, paced, into
  // the folder the core reads on every turn; one line when it first becomes context. SOL_GHOST_KNOWLEDGE=0: off.
  if (process.env.SOL_GHOST_KNOWLEDGE !== '0') {
    const provision = () => provisionKnowledge({ paths, env: backend.backendEnv, signal: controller.signal, log, announce: (line) => session.announce(line), out: (line) => console.log(line) })
      .then((r) => {
        noteKnowledgeRun(paths.state, r);   // its status for GET /admin/datasets
        // Deferred for the owner's meeting: try again shortly after the hold ends (it is bounded, so this always fires).
        if (r?.state !== 'deferred-meeting' || controller.signal.aborted) return;
        pollMeetingRelease({ readHold: () => meetingHold(paths), onRelease: () => { void provision(); }, signal: controller.signal });
      })
      .catch((error) => log('knowledge_failed', { message: String(error?.message ?? error).slice(0, 160) }));
    void provision();
  }
  // FIRST-RUN DEVICE SCAN: what on this Mac Ghost can drive and how, the API keys already here (names only), and the
  // free APIs with no key; paced, resumable, read-only. One line when it first finishes. SOL_GHOST_DEVICE_SCAN=0: off.
  if (process.env.SOL_GHOST_DEVICE_SCAN !== '0') {
    void desk.runBackground({ signal: controller.signal, announce: (line) => session.announce(line) })
      .catch((error) => log('device_scan_failed', { message: String(error?.message ?? error).slice(0, 160) }));
  }
  console.log('Type to Kingmaker here. y = approve the waiting action, n = cancel it, :pending, :approvals [on|off], :dms [on|off], :key <provider> (:key ronin-crm takes the one CRM master key), :craft <app> …, :scan, :tools, :key import, :key setup, :quit.');

  if (agent) {
    // Text only is its own state: 'down' tells the app Kingmaker isn't listening, and the app follows it out.
    if (textOnly) emit('text', { textOnly: true });
    else if (!voice?.ok) emit('down', { reason: voice?.reason ?? 'voice is off' });
    else emit(voiceState, { voiceApproves });
    // The app holds our stdin: when it quits (or crashes) the pipe closes and the engine stops with it.
    let typedTurns = Promise.resolve();
    // One turn (or connector add, extension install) at a time, counted for GET /admin/metrics (jobs).
    const queueTurn = (fn) => {
      work.queued++;
      typedTurns = typedTurns.then(async () => { work.queued--; work.running++; try { return await fn(); } finally { work.running--; } });
      return typedTurns;
    };
    // IDLE GAPS (lib/idle-gaps.mjs): after 10 quiet minutes, at most hourly, Kingmaker scans its capability gaps; what its rules
    // allow starts being built, the rest is proposed. Turning anything on stays the owner's tap. A note in the bar, never spoken.
    const idleGaps = createIdleGaps({
      scan: () => ownerCall(port, GAPS_SCAN_ROUTE, { nonce: secrets.nonce, method: 'POST', body: {}, timeoutMs: 120_000 }),
      note: (line) => process.stdout.write(`@@ghost ${JSON.stringify({ said: line.slice(0, 4000) })}\n`),
      busy: () => Boolean(session.isSpeaking?.()),
      timing: () => { const g = cal().idleGaps; return { on: g.on, idleMs: g.idleMinutes * 60_000, everyMs: g.everyMinutes * 60_000 }; },
      log,
    });
    idleTouch = () => idleGaps.touch();
    idleGaps.start();
    let installs = Promise.resolve();   // Ronin Installer jobs, one at a time, beside the turns
    // KINGMAKER'S KEY FIELD: a turn that wants an API key ("connect my CRM at crm.example.com") opens the bar's hidden
    // paste field (@@ghost keyRequest); the pasted key comes back as `key-seal <base64>` and goes to the engine in one
    // owner call (lib/keys.mjs sealFromKeyField). The key is never logged, printed or spoken.
    let fieldKey = null;
    let pttMutedBefore = null; // the mute setting before fn was pressed: restored on release
    const keyField = (request, result) => process.stdout.write(`@@ghost ${JSON.stringify({ keyRequest: request, ...(result ? { keyResult: result } : {}) })}\n`);
    // THE SETUP SCREEN (lib/flow.mjs): every key or connector setup is told to the bar step by step as it happens.
    let keyFlow = null;
    let lastAsk = '';
    const flowEmit = (f) => process.stdout.write(`@@ghost ${JSON.stringify({ flow: f })}\n`);
    const startKeyFlow = (h) => { keyFlow = createFlow({ id: h.handoffId, ask: lastAsk || `Connect ${h.label}`, title: `Connect ${h.label}`, steps: keyFlowSteps(h), emit: flowEmit }); };
    keyHandoff = (handoff) => {
      fieldKey = handoff;
      startKeyFlow(handoff);
      log('key_request', { provider: String(handoff.provider || '').slice(0, 40), crm: Boolean(handoff.crm) });
      keyField({ handoffId: handoff.handoffId, label: handoff.label, keyNoun: handoff.keyNoun, keyPageUrl: handoff.keyPageUrl, crm: Boolean(handoff.crm) });
    };
    // CONNECTORS (lib/connectors.mjs): the bar's Connectors page adds any CLI, Kingmaker CLI Hub CLI, MCP server, skill or
    // repo; REA inspects each first (lib/rea.mjs). The list rides to the bar at launch and after every change.
    const sendConnectors = (result = null) => process.stdout.write(`@@ghost ${JSON.stringify({ connectors: listConnectors(paths.state).map(connectorView), ...(result ? { connectorResult: result } : {}) })}\n`);
    // `headers` (an extension's key) go only in this body: the engine's MCP hub seals them into the vault on arrival.
    const registerMcp = async (c, { headers = null } = {}) => {
      const body = c.url ? { tenantId: 'primary', transport: 'http', label: c.name.slice(0, 80), url: c.url, ...(headers ? { headers } : {}) } : { transport: 'stdio', label: c.name.slice(0, 80), command: c.target, args: c.args || [], env: c.env || {} };
      const r = await ownerCall(port, '/api/mcp/servers', { nonce: secrets.nonce, method: 'POST', timeoutMs: 30_000, body }).catch((e) => ({ ok: false, status: 0, json: { error: String(e?.message || e) } }));
      const proposal = r.json?.decision?.proposal ?? null;
      return r.status === 202 && proposal ? { ok: true, proposal } : { ok: r.ok === true, reason: r.json?.decision?.spoken ?? r.json?.message ?? r.json?.error ?? `HTTP ${r.status}` };
    };
    sendConnectors();
    // EXTENSIONS (lib/extensions.mjs, catalog/extensions.json): one-click MCP extensions on the bar's Extensions page. A key
    // an extension needs is made on its own page, opened BESIDE the bar (@@ghost beside; Swap in the bar flips the front
    // window, only when the owner clicks it); the hidden key box hands it, in memory, to the engine's hub, which seals it in
    // the vault. Nothing here writes a key anywhere. Then, while learning is on, its tools become skills (lib/absorb.mjs).
    const extRuntimes = runtimesFor({ appRoot: join(paths.resources, '..', '..') });
    const sendExtensions = () => {
      const installed = listConnectors(paths.state).map((c) => c.extension).filter(Boolean), acc = readAccounts(paths.state);
      process.stdout.write(`@@ghost ${JSON.stringify({ extensions: loadCatalog().map((e) => extensionView(e, { installed, accounts: Object.fromEntries((e.keys || []).map((k) => [k.id, (acc[e.id] || []).map((a) => a.name)])) })) })}\n`);
    };
    const extProgress = (id) => (stage, pct, line) => process.stdout.write(`@@ghost ${JSON.stringify({ extInstall: { id, stage, pct, line: String(line || '').slice(0, 300) } })}\n`);
    const extAdd = (spec, { headers = null } = {}) => addConnector(spec, { state: paths.state, registerMcp, headers });
    const askExtKey = (id, account = 'default') => {
      const e = loadCatalog().find((x) => x.id === id), key = e?.keys?.[0];
      if (!key) return false;
      process.stdout.write(`@@ghost ${JSON.stringify({ beside: { url: key.getUrl, title: key.label } })}\n`);
      fieldKey = { extension: { id, account }, label: `${e.name}${account !== 'default' ? ` (${account})` : ''}`, keyNoun: key.label, keyPageUrl: key.getUrl, handoffId: `ext-${id}-${Date.now().toString(36)}` };
      keyField({ handoffId: fieldKey.handoffId, label: fieldKey.label, keyNoun: key.label, keyPageUrl: key.getUrl, crm: false });
      void session.say(`I opened the ${key.label} page beside me. ${key.help || ''} Then paste it into my key box: it goes straight into the vault.`).catch(() => {});
      return true;
    };
    // Every tool on the engine's hub becomes a candidate skill (learning on); each new skill is added like any skill
    // connector, so REA reads it and it shows in the / picks. Unused candidates retire after 30 days.
    let absorbing = false;
    const absorbAll = async () => {
      if (absorbing || !learning.enabled()) return; absorbing = true;
      try {
        const list = await ownerCall(port, '/api/mcp/servers', { nonce: secrets.nonce, timeoutMs: 15_000 }).catch(() => null);
        for (const srv of (list?.json?.servers ?? []).slice(0, 40)) {
          const t = await ownerCall(port, `/api/mcp/servers/${encodeURIComponent(srv.serverId)}/tools`, { nonce: secrets.nonce, timeoutMs: 15_000 }).catch(() => null);
          const tools = (t?.json?.tools ?? []).map((x) => ({ name: x.name, description: x.description || x.title || '', inputSchema: x.inputSchema || null }));
          const r = absorbConnector(String(srv.label || srv.serverId), tools, { state: paths.state, learningOn: () => learning.enabled() });
          for (const name of r.minted) await addConnector({ kind: 'skill', name, path: join(paths.state, 'skills', 'absorbed', name) }, { state: paths.state }).catch(() => null);
          if (r.minted.length) log('absorbed', { server: String(srv.label || '').slice(0, 60), minted: r.minted.length });
        }
        sweepIdle({ state: paths.state, learningOn: () => learning.enabled() });
      } finally { absorbing = false; }
    };
    setTimeout(() => void absorbAll(), 5 * 60_000).unref?.(); setInterval(() => void absorbAll(), 3600_000).unref?.();
    const runExtInstall = (id, { account = 'default', secret = null } = {}) => new Promise((done) => {
      queueTurn(async () => {
        const r = await installExtension(id, { state: paths.state, addConnector: extAdd, runtimes: extRuntimes, progress: extProgress(id), account, secret }).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));
        log('ext_install', { id: String(id).slice(0, 40), ok: Boolean(r.ok), needs: r.needs ? Object.keys(r.needs) : null });
        if (!r.ok && r.needs?.key) askExtKey(id, account);
        else await session.say(r.ok ? `${r.connector?.name || id} is in. ${r.connector?.proposal ? 'Its tools turn on when you approve them on the card. ' : ''}${r.needs?.app ? `It needs ${r.needs.app.map((a) => `${a.name}${a.minVersion ? ` ${a.minVersion}+` : ''}`).join(', ')} with its add-on: the steps are on its page.` : ''}` : `It wasn't installed: ${r.error}`).catch(() => {});
        sendExtensions(); sendConnectors();
        if (r.ok) void absorbAll();
        done(r);
      });
    });
    // THE CONNECTORS & KEYS SCREEN (like the CRM's Connections page, written into the bar): every provider Kingmaker
    // takes a key for, with its key page and whether one is stored, then the connected tools. "Add key" opens the bar's
    // hidden key field; the key goes only to Kingmaker's vault (never logged, written or spoken), once.
    let keyCatalog = new Map();
    const connectorsScreen = async () => {
      const [h, f] = await Promise.all(['/api/key-handoff/providers', '/api/key-handoff/free-tier'].map((path) => ownerCall(port, path, { nonce: secrets.nonce, timeoutMs: 15_000 }).catch(() => null)));
      keyCatalog = new Map();
      // The Ronin CRM seats (approver / Seeker / local) are set by the CRM pairing, never on the public keys page: they
      // are internal to a Ronin-bound build, so they never ship as "Add key" rows. (The handoff list already hid crm/ronin-crm.)
      const isCrmSeat = (x) => ['crm', 'ronin-crm', 'ronin-approver', 'ronin-seeker', 'ronin-local'].includes(x.id) || /^ronin[-\s]?crm\b/i.test(String(x.label || ''));
      for (const x of f?.json?.data?.providers ?? []) if (!isCrmSeat(x)) keyCatalog.set(x.id, { kind: 'free', id: x.id, label: x.label, link: x.keyPageUrl || x.signupUrl || null, free: x.freeTier || null, stored: x.stored === true, provider: x });
      for (const x of h?.json?.data?.providers ?? []) if (!keyCatalog.has(x.id) && !isCrmSeat(x)) keyCatalog.set(x.id, { kind: 'handoff', id: x.id, label: x.label, link: x.keyPageUrl || null, keyNoun: x.keyNoun, stored: null, provider: x });
      const keys = [...keyCatalog.values()].map(({ provider, ...k }) => k);
      process.stdout.write(`@@ghost ${JSON.stringify({ screen: { kind: 'connectors', keys, connectors: listConnectors(paths.state).map(connectorView), engine: Boolean(h?.ok || f?.ok) } })}\n`);
    };
    const keyStart = async (id) => {
      const k = keyCatalog.get(id) || (await connectorsScreen(), keyCatalog.get(id));
      if (!k) { await session.say('I don\'t take a key for that yet.'); return; }
      if (k.link) void openKeyPage(k.link).catch(() => null);
      if (k.kind === 'free') {
        fieldKey = { freeTier: k.provider, provider: k.id, label: k.label, keyNoun: `${k.label} key`, keyPageUrl: k.link, handoffId: `free-${k.id}` };
        startKeyFlow(fieldKey);
        keyField({ handoffId: fieldKey.handoffId, label: k.label, keyNoun: fieldKey.keyNoun, keyPageUrl: k.link, crm: false });
        return;
      }
      const started = await ownerCall(port, '/api/key-handoff/start', { nonce: secrets.nonce, method: 'POST', body: { provider: k.id } }).catch(() => null);
      const d = started?.json?.data;
      if (!started?.ok || !d?.id) { await session.say(started?.json?.spoken || `Couldn't start a ${k.label} key (${started?.json?.error || 'no answer'}).`); return; }
      keyHandoff({ handoffId: d.id, provider: k.id, label: k.label, keyNoun: k.keyNoun || `${k.label} key`, keyPageUrl: k.link, crm: false });
    };
    // A connector added through the bar (or a new skill), told to the bar step by step (lib/flow.mjs).
    const addConnectorWithFlow = (spec, ask = null) => {
      const cflow = spec ? createFlow({ id: `conn-${Date.now().toString(36)}`, ask: ask || (lastAsk && /connect|add|plugin|connector|install|skill/i.test(lastAsk) ? lastAsk : `Add ${spec.name || spec.kind || 'a connector'}`), title: 'Add a connector', steps: connectorFlowSteps(spec), emit: flowEmit }) : null;
      queueTurn(async () => {
        const r = spec ? await addConnector(spec, { state: paths.state, registerMcp }).catch((e) => ({ ok: false, error: String(e?.message || e) })) : { ok: false, error: 'invalid connector' };
        log('connector_add', { kind: spec?.kind, ok: r.ok, verdict: r.connector?.verdict || null });
        if (cflow) {
          if (!r.ok) cflow.fail(r.error || 'It wasn\'t added.');
          else {
            const c = r.connector || {};
            cflow.step('read', 'done', { lines: [`› read ${String(c.name || '').slice(0, 60)} ··· ${c.verdict || 'read'}`], caption: c.summary ? String(c.summary).slice(0, 220) : 'REA read it.' });
            if (spec.kind === 'mcp') cflow.step('connect', 'done', { lines: ['› register with the engine\'s MCP hub ··· ✓'], caption: c.proposal ? 'Proposed to Kingmaker: its tools turn on when you approve them.' : 'Connected through Kingmaker.' });
            cflow.step('ready', 'done', { caption: `${c.name || 'It'} is in reach${c.verdict === 'sandboxed' ? ', sandboxed (REA blocked the risky part)' : ''}.` });
          }
        }
        sendConnectors({ ok: r.ok, name: r.connector?.name || null, verdict: r.connector?.verdict || null, summary: r.connector?.summary || null, error: r.ok ? null : r.error });
      });
    };
    const onControlLines = (d) => {
      for (const said of String(d).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        if (/^quit\b/.test(said)) { void shutdown('app quit'); break; }
        // The bar's ":duress arm <password> WIPE" / ":duress off" / status arrive as plain control lines: the duress handler, never a brain, never logged.
        else if (/^:duress\b/i.test(said)) queueTurn(async () => { await barGuard.handle(said, { typed: true }); });
        if (/^interaction-owner\s+/.test(said)) {
          interaction.setOwner(said.replace(/^interaction-owner\s+/, ''), { source: 'app' });
          voice?.ownerChanged?.();
        // solghost://wake (Siri's "Wake Ghost" shortcut) reaches here through the app: wake without a wake word.
        } else if (/^wake\b/.test(said)) void voice?.wakeNow?.();
        else if (/^key-seal\s+/.test(said)) {
          const handoff = fieldKey;
          const keyBytes = Buffer.from(said.replace(/^key-seal\s+/, ''), 'base64');
          if (!handoff) { keyBytes.fill(0); keyField(null, { ok: false, spoken: 'No key is waiting. Say "connect my CRM at" and its address first.' }); continue; }
          const flow = keyFlow;
          flow?.step('secret', 'done', { caption: 'Key pasted (hidden). Saving it…' }); flow?.step('check', 'active');
          // The flow ends the way the seal did: sealed (check ✓, ready), asked again (back to the paste), or failed.
          const flowAfter = (ok, retry, line) => {
            if (!flow) return;
            if (ok) { flow.step('check', 'done', { lines: ['› verify key ··· ✓', '› save credential ··· ✓'] }); flow.step('ready', 'done', { caption: line || 'Connected.' }); keyFlow = null; }
            else if (retry) { flow.step('check', 'waiting'); flow.step('secret', 'active', { caption: line || 'That key didn\'t fit. Paste it again.' }); }
            else { flow.fail(line || 'It wasn\'t stored.'); keyFlow = null; }
          };
          if (handoff.extension) { // an extension's key: in memory to the engine's hub (sealed there), then zeroed here
            fieldKey = null; keyFlow = null;
            const secret = keyBytes.toString('utf8').trim(); keyBytes.fill(0);
            keyField(null, { ok: true, spoken: 'Got it. Connecting…' });
            void runExtInstall(handoff.extension.id, { account: handoff.extension.account, secret });
            continue;
          }
          queueTurn(async () => {
            emit('thinking', {});
            if (handoff.freeTier) { // a free-tier provider's key: its shape checked, then sealed with its read-only probe
              let r; try { r = await storeProviderKey({ port, nonce: secrets.nonce, provider: handoff.freeTier, bytes: keyBytes.subarray(0), source: 'kingmaker-bar', log }); } finally { keyBytes.fill(0); }
              if (r.ok || r.reason !== 'NOT_THIS_PROVIDERS_KEY_SHAPE') fieldKey = null;
              keyField(fieldKey ? { handoffId: handoff.handoffId, label: handoff.label, keyNoun: handoff.keyNoun, keyPageUrl: handoff.keyPageUrl, crm: false } : null, { ok: r.ok, spoken: storedLine(handoff.freeTier, r) });
              flowAfter(r.ok, !r.ok && Boolean(fieldKey), storedLine(handoff.freeTier, r));
              emit('idle'); if (r.ok) void connectorsScreen();
              return;
            }
            const r = await sealFromKeyField({ port, nonce: secrets.nonce, handoff, keyBytes, log });
            if (!r.retry) fieldKey = null;
            keyField(fieldKey ? { handoffId: handoff.handoffId, label: handoff.label, keyNoun: handoff.keyNoun, keyPageUrl: handoff.keyPageUrl, crm: Boolean(handoff.crm) } : null, { ok: r.ok, spoken: r.spoken });
            flowAfter(r.ok, !r.ok && Boolean(r.retry), r.spoken);
            emit('idle');
          });
        }
        else if (/^key-cancel\b/.test(said)) {
          const handoff = fieldKey;
          fieldKey = null;
          if (handoff && !handoff.extension) void ownerCall(port, `/api/key-handoff/${encodeURIComponent(handoff.handoffId)}/cancel`, { nonce: secrets.nonce, method: 'POST', body: {} }).catch(() => null);
          keyField(null, handoff ? { ok: false, spoken: 'Cancelled. Nothing was stored.' } : null);
          keyFlow?.fail('Cancelled. Nothing was stored.'); keyFlow = null;
        }
        else if (/^connector-add\s+/.test(said)) {
          let spec = null; try { spec = JSON.parse(Buffer.from(said.replace(/^connector-add\s+/, ''), 'base64').toString('utf8')); } catch { /* below */ }
          addConnectorWithFlow(spec);
        }
        // A NEW SKILL from the Skills tab (lib/skill-create.mjs): its folder and SKILL.md, then added like any skill (REA first).
        else if (/^skill-create\s+/.test(said)) {
          let v = null; try { v = JSON.parse(Buffer.from(said.replace(/^skill-create\s+/, ''), 'base64').toString('utf8')); } catch { /* below */ }
          const made = v ? createSkillFolder(paths.state, v) : { ok: false, error: 'Nothing to make.' };
          if (!made.ok) createFlow({ id: `skill-${Date.now().toString(36)}`, ask: `New skill${v?.name ? `: ${String(v.name).slice(0, 40)}` : ''}`, title: 'New skill', steps: connectorFlowSteps({ kind: 'skill', name: v?.name }), emit: flowEmit }).fail(made.error);
          else addConnectorWithFlow({ kind: 'skill', path: made.dir, name: made.name }, `New skill: ${made.name}`);
        }
        // THE ARTIFACTS TAB (lib/artifacts.mjs): everything Kingmaker made, from its own folders only, newest first.
        else if (/^artifacts\b/.test(said)) process.stdout.write(`@@ghost ${JSON.stringify({ artifacts: listArtifacts({ runtimeHome: paths.runtimeHome }) })}\n`);
        // The first-run tour (lib/first-run.mjs): the bar asks once it is up (tour-check), the owner asks again (tour-start:
        // the logo's menu, kingmaker://tour), and the bar says how it ended (tour-done done|skipped <step>).
        else if (/^tour-(check|start|done)\b/.test(said)) {
          const t = tourControl(said);
          if (t?.done) markTour(paths.state, t.done, t.step);
          else if (t) { const m = tourMessage(paths.state, { wakeWord: install.wakeWord, force: t.start }); if (m) process.stdout.write(`@@ghost ${JSON.stringify(m)}\n`); }
        }
        else if (/^connector-remove\s+/.test(said)) { removeConnector(paths.state, said.replace(/^connector-remove\s+/, '').trim().slice(0, 80)); sendConnectors(); }
        // The owner clears one REA finding on a connector (connector-allow <id> <finding id>), bound to its code's hash.
        else if (/^connector-allow\s+\S+\s+\S+/.test(said)) { const [, id, finding] = said.split(/\s+/); const r = acknowledgeFinding(paths.state, id.slice(0, 80), finding.slice(0, 300)); sendConnectors({ ok: r.ok, name: r.connector?.name || null, verdict: r.connector?.verdict || null, error: r.ok ? null : r.error }); }
        else if (/^connectors\b/.test(said)) sendConnectors();
        // CRM SKILLS (lib/crm-skills.mjs): the bar asks for them only while its owner-only setting is on. The engine lists the
        // connected CRM's tools with their gates through its sealed CRM connection; the bar shows them as /name picks.
        // A link the owner clicked in the bar (a source under an answer, a URL in the text): base64 so a pasted newline can
        // never become a control line. It opens in the visible Chrome (Apple events, never the headless one), else the
        // default browser. Only http(s) without credentials.
        else if (/^open-url\s+/.test(said)) void (async () => {
          let url = ''; try { url = Buffer.from(said.replace(/^open-url\s+/, ''), 'base64').toString('utf8').trim(); } catch { /* below */ }
          const page = browseTarget({ data: { liveWebBrowse: { url } } });
          if (!page) { log('open_url_refused', {}); return; }
          const wall = await openDesktopWall([page], { log, chromeOnly: true }).catch(() => ({ where: null }));
          if (!wall.where) execFile('/usr/bin/open', [page.target], () => {});
          log('open_url', { via: wall.where || 'browser' });
        })();
        // CUSTOMIZE: the functions, their values and the models on this Mac (for the Customize screen); a save applies next turn.
        else if (/^calibration\b/.test(said) && !/^calibration-set/.test(said)) void (async () => {
          const tags = await fetch(`${(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => ({}));
          const models = (tags?.models || []).map((m) => String(m.name)).filter((n) => !/embed/i.test(n)).sort();
          // The live Mac profile (lib/mac-profiles.mjs) is written under Customize → Mac profile.
          const { currentProfile, profileLine } = await import('./mac-profiles.mjs');
          let profile = ''; try { profile = profileLine(currentProfile(paths.state)); } catch { /* shown without it */ }
          process.stdout.write(`@@ghost ${JSON.stringify({ calibration: { functions: withProfile(FUNCTIONS, profile), values: cal(), models } })}\n`);
        })();
        else if (/^calibration-set\s+/.test(said)) {
          let v = null; try { v = JSON.parse(Buffer.from(said.replace(/^calibration-set\s+/, ''), 'base64').toString('utf8')); } catch { /* below */ }
          if (v) { const saved = writeCalibration(paths.state, v); log('calibration_saved', {}); process.stdout.write(`@@ghost ${JSON.stringify({ calibration: { functions: FUNCTIONS, values: saved, saved: true } })}\n`); }
        }
        else if (/^crm-skills\b/.test(said)) void (async () => {
          if (!ronin) { process.stdout.write(`@@ghost ${JSON.stringify({ crmSkills: [], crmSkillsFrom: null, crmSkillsProblem: roninOnly('CRM skills') })}\n`); return; }
          const r = await ownerCall(port, ronin.SKILLS_ROUTE, { nonce: secrets.nonce, timeoutMs: 20_000 }).catch(() => null);
          const skills = r?.ok ? ronin.skillPicks(r.json?.data) : [];
          log('crm_skills', { ok: Boolean(r?.ok), count: skills.length });
          process.stdout.write(`@@ghost ${JSON.stringify({ crmSkills: skills, crmSkillsFrom: r?.ok ? String(r.json?.data?.crm || '').slice(0, 80) : null, crmSkillsProblem: ronin.skillsProblem(r) })}\n`);
        })();
        else if (/^screen connectors\b/.test(said)) void connectorsScreen();
        // The Extensions page: the directory, one-click install, and a named account for a service with several.
        else if (/^ext-list\b/.test(said)) sendExtensions();
        else if (/^ext-install\s+[a-z0-9-]{1,41}$/.test(said)) void runExtInstall(said.split(/\s+/)[1]);
        else if (/^ext-account\s+[a-z0-9-]{1,41}\s+\S+$/.test(said)) {
          const [, id, b64] = said.split(/\s+/);
          let account = 'default'; try { account = Buffer.from(b64, 'base64').toString('utf8').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'default'; } catch { /* default */ }
          if (!askExtKey(id, account)) void runExtInstall(id, { account });
        }
        // The permissions box's answer (Share / Keep it on this Mac), Customize → Permissions, or "See exactly what's sent".
        else if (/^share\s+(yes|no|log)\b/.test(said)) void (async () => {
          const op = said.split(/\s+/)[1];
          if (op === 'log') { await session.say(sharing.sharedLine()).catch(() => {}); return; }
          const line = sharing.answer(op, 'box'); emitSharing(); await session.say(line).catch(() => {});
        })();
        // Customize → "How should Kingmaker behave?" was saved: read the owner's instructions again (only then).
        else if (/^instructions reload\b/.test(said)) log('instructions_reloaded', reloadInstructions(paths.state));
        // The overnight card's buttons (nightly approve <hash> | later | show): the owner's click in the bar.
        else if (/^nightly\s+(approve|later|show)\b/.test(said)) void nightlyAnswer(ronin?.nightlyCommand(said)).then((line) => process.stdout.write(`@@ghost ${JSON.stringify({ said: line.slice(0, 4000) })}\n`));
        else if (/^key-start\s+[\w.-]{1,40}$/.test(said)) void keyStart(said.replace(/^key-start\s+/, ''));
        // The menu-bar text box frames UTF-8 as base64, so a pasted newline can never become `quit`, `wake`, or
        // another app control message. Typed text has the same governed owner-turn semantics as the terminal.
        else if (/^typed-command\s+/.test(said)) {
          const encoded = said.replace(/^typed-command\s+/, '');
          queueTurn(async () => {
            let text = '';
            try { text = Buffer.from(encoded, 'base64').toString('utf8').trim(); } catch { /* rejected below */ }
            if (!text || Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
              log('typed_command_rejected', { reason: 'invalid payload' }); return;
            }
            if (await barGuard.handle(text, { typed: true })) { emit('idle'); return; }
            emit('thinking', { heard: text }); idleTouch(); lastAsk = text;
            if (text.startsWith(':') && ronin?.nightlyCommand(text)) { process.stdout.write(`@@ghost ${JSON.stringify({ said: (await nightlyAnswer(ronin?.nightlyCommand(text))).slice(0, 4000) })}\n`); return; }
            const learnSaid = learning.handle(text, 'typed');
            if (learnSaid) { emitSharing(); await session.say(learnSaid).catch(() => {}); return; }
            const shareSaid = await sharing.handle(text, 'typed');
            if (shareSaid) { emitSharing(); await session.say(shareSaid).catch(() => {}); return; }
            const learnAsk = learning.learn(text, 'chat');
            try { if (!(crmJobs && cal().crmJobs.on && await crmJobs.handle(text))) await (brain ? brain.runTurn(text) : session.runTurn(text, { owner: true })); }
            catch (error) { console.error(`  ✗ ${error?.message || error}`); }
            if (learnAsk) await session.say(learnAsk).catch(() => {});
          });
        }
        // THE KINGMAKER BAR (app/Kingmaker.swift): one turn as base64 JSON {text, model, pin?, programs, folder, crm}. The model is
        // "kingmaker"/"auto" (the governed brain, which can act, with the fast lanes) or a local one (Ollama); `pin` is the local
        // model pinned in the picker, which the write lane uses instead of WRITER_MODEL. The / programs name what to drive, so a
        // small model doesn't have to guess the route; the folder says which CRM and project the turn is about.
        else if (/^typed-turn\s+/.test(said)) {
          const encoded = said.replace(/^typed-turn\s+/, '');
          queueTurn(async () => {
            let t = null;
            try { t = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { /* rejected below */ }
            const text = String(t?.text || '').trim().slice(0, 8000);
            const skill = ronin ? ronin.skillName(t?.crmSkill) : null;   // a CRM skill picked from the bar's / list (its own words may be empty)
            if (!text && !skill) { log('typed_turn_rejected', { reason: 'invalid payload' }); return; }
            // THE OWNER'S OWN WORDS FIRST (lib/bar-guard.mjs): the kill switches and the duress switch hear the raw text, before any
            // doctrine, personality or folder frame is added, before the bar shows it, and whichever model is picked.
            if (text && await barGuard.handle(text, { typed: true })) { session.setSpokenLimit?.(0); emit('idle'); return; }
            const programs = (Array.isArray(t.programs) ? t.programs : []).map((p) => String(p).slice(0, 60)).filter(Boolean).slice(0, 6);
            // The program rides in the sentence itself ("… using Chrome"): a separate instruction line reads as the request.
            const onThisMac = /\b(my|this)\s+(mac|desktop|downloads|documents|files?|folders?|computer|laptop|screen|apps?)\b/i.test(text) ? ' (on this Mac, not the web)' : '';
            // An ArtCraft app (/VectorCraft, /PhotoCraft…) is addressed by name, the way the engine's ArtCraft lane reads it
            // ("VectorCraft, make a poster …"); "… using VectorCraft" read as a web search.
            const craft = programs.length === 1 ? craftApp(programs[0]) : null;
            const crafted = craft ? craftTurnText(craft, text.split(/\s+/)) : null;
            const ask = crafted?.text ? `${crafted.text}${onThisMac}` : `${text}${programs.length ? ` using ${programs.join(' and ')}` : ''}${onThisMac}`;
            // PROJECT DOCTRINE, PERSONALITY (how Kingmaker sounds; never what may run) and the folder line: lib/bar-guard.mjs.
            const { framed } = frameBarTurn({ doctrine: t.doctrine, project: t.project, personality: t.personality, folder: t.folder, crm: t.crm, ask });
            emit('thinking', { heard: text }); idleTouch(); lastAsk = text;
            session.setSpokenLimit?.(t.speak === 'full' ? 0 : 280); // a typed turn's answer is on the screen: say the start (Customize: in full)
            // :nightly … typed in the bar is the loop's own command, answered by the loop, never by a brain (the Ronin add-on).
            if (text.startsWith(':') && ronin?.nightlyCommand(text)) { process.stdout.write(`@@ghost ${JSON.stringify({ said: (await nightlyAnswer(ronin?.nightlyCommand(text))).slice(0, 4000) })}\n`); return; }
            // "auto" (the picker's default) is the governed brain with the fast lanes; a pin only changes the write lane.
            const model = ['auto', ''].includes(String(t.model || '')) ? 'kingmaker' : String(t.model);
            const pin = typeof t.pin === 'string' && t.pin.trim() ? t.pin.trim().slice(0, 160) : null;
            // A PHONE turn (lib/phone-companion.mjs → phoneTurn) carries a stable per-phone conversationId so a follow-up
            // resumes, and the latest field photo's path as `image`. Both ride the governed turn; a bar turn has neither.
            const phoneConv = typeof t.conversationId === 'string' && t.conversationId.trim() ? t.conversationId.trim().slice(0, 80) : null;
            const img = t.image && typeof t.image === 'object' && typeof t.image.path === 'string' ? {
              path: t.image.path.slice(0, 1000),
              ...(typeof t.image.mimeType === 'string' ? { mimeType: t.image.mimeType.slice(0, 120) } : {}),
              ...(typeof t.image.filename === 'string' ? { filename: t.image.filename.slice(0, 200) } : {}),
              ...(typeof t.image.receivedAt === 'string' ? { receivedAt: t.image.receivedAt.slice(0, 40) } : {}),
            } : null;
            const turnOpts = { owner: true, ...(phoneConv ? { conversationId: phoneConv } : {}), ...(img ? { image: img } : {}) };
            const learnSaid = learning.handle(text, 'typed');
            if (learnSaid) { emitSharing(); await session.say(learnSaid).catch(() => {}); session.setSpokenLimit?.(0); emit('idle'); return; }
            const shareSaid = await sharing.handle(text, 'typed');
            if (shareSaid) { emitSharing(); await session.say(shareSaid).catch(() => {}); session.setSpokenLimit?.(0); emit('idle'); return; }
            const learnAsk = learning.learn(text, 'chat');
            // "retire stale memories": the owner's own cleanup of what Kingmaker remembers that is no longer true.
            if (ronin && /^retire (the )?stale memor(y|ies)\b/i.test(text)) {
              const r = await ronin.retireStaleMemories({ port, nonce: secrets.nonce, log });
              await session.say(r.spoken).catch(() => {});
              session.setSpokenLimit?.(0); emit('idle');
              return;
            }
            try {
              // A work request ("make an ad…", "write the proposal") is a job on the CRM's board, whichever model is picked
              // (lib/crm-jobs.mjs); a turn that names programs to drive keeps its own lane.
              // A turn naming a connected CLI or skill (/name): the local model works it through that connector.
              // A CRM SKILL (/name from the bar's list): the engine's own turn, "CRM skill <tool>: <the rest>", which its CRM bridge
              // runs as that one tool with the CRM's gate. Never a job, the write lane or the cloud brain.
              const conn = !skill && programs.length === 1 ? listConnectors(paths.state).find((c) => c.enabled && c.kind !== 'mcp' && c.name.toLowerCase() === programs[0].toLowerCase().replace(/\s+/g, '-')) : null;
              // A FIELD PHOTO from the phone rides this turn (lib/field-photo.mjs): the tool that can use it takes it — the
              // vision lane (what is it, read it), a copy in Kingmaker's folders, a CRM job with it attached, the image lane
              // drawing from it, or the governed brain with its path. Never the writer, which can't see it.
              // A bare yes / no typed in the bar answers a read-back the desk is holding (a connected CLI's write, delete, send or run),
              // exactly as it does at the console; a phone's turn never does (the owner's word is typed at the Mac or said).
              const deskYesNo = !t.conversationId && !skill ? classifyLine(text) : null;
              if ((deskYesNo === 'yes' || deskYesNo === 'no') && desk?.pending()) await desk.answer(deskYesNo, { typed: true });
              else if (img && !skill) {
                await fieldPhotoTurn({ text, framed, image: img, deps: {
                  governed: (words, image) => session.runTurn(words, { ...turnOpts, image }),
                  say: (line) => session.say(line),
                  brain,
                  crmJob: crmJobs && cal().crmJobs.on ? (words, attachments) => crmJobs.handle(words, { attachments }) : null,
                  edit: imageSetup.ready ? async (words, path) => {
                    const r = await makeImage(words, { setup: imageSetup, initImage: path });
                    if (r.ok && agent) process.stdout.write(`@@ghost ${JSON.stringify({ image: { path: r.file } })}\n`);
                    return r;
                  } : null,
                  visionReady: () => visionReady(),
                  log,
                } });
              }
              else if (skill) { log('crm_skill_turn', { skill }); crmUse('tool'); await session.runTurn(ronin.skillTurnText(skill, text), { owner: true }); }
              // "install owner/repo" or its GitHub link: the Ronin Installer, in the background (it can take minutes) and one
              // at a time, so the bar stays free. "install <tool>" without a repo's shape stays with the device desk.
              else if (!programs.length && installRequest(text)) {
                const target = installRequest(text);
                await session.say(`Installing ${target}… I'll tell you when it's in.`);
                installs = installs.then(async () => {
                  const r = await installRepo(target, { log }).catch((e) => ({ ok: false, line: `${target}: ${String(e?.message || e).slice(0, 200)}` }));
                  log('installer_install', { repo: target.slice(0, 120), ok: r.ok });
                  await session.say(r.line).catch(() => {});
                });
              }
              else if (conn) {
                const t0 = Date.now(), r = await connectorTurn(conn, text, { log, state: paths.state, confirm: desk ? ({ run }) => desk.holdForOwner('connector', async () => { const done = await run(); await session.say(done?.text || `${conn.name} gave nothing back.`); }) : null });
                // An absorbed skill's use is scored: proven ones graduate, failing ones retire (lib/absorb.mjs).
                if (/absorbed/.test(String(conn.target || ''))) recordUse(conn.name, { ok: Boolean(r?.text) && !r?.error, ms: Date.now() - t0 }, { state: paths.state, learningOn: () => learning.enabled() });
                await session.say(r?.text || `${conn.name} gave nothing back.`);
              }
              // AN AD ABOUT KINGMAKER (lib/ad-video.mjs): a real video made here: the chosen model writes the script, Kingmaker
              // performs each scene in this bar while macOS records the screen, Kokoro voices it, and the MP4 lands in Kingmaker's folder.
              else if (!programs.length && isAdRequest(text) && factsFor(text)) {
                const adModel = pin || (model !== 'kingmaker' ? model : writerModel(null));
                // One scene's action, done in the bar as if typed (inside this turn: never queued behind it). The bar shows `line`;
                // a written answer gets `framed` (the facts) and the quick writer, so it lands while the screen is recording.
                const barSay = async (line, framed = line) => { emit('thinking', { heard: line }); if (!(await fastLane(line, framed, null))) await (brain ? brain.runTurn(line) : session.runTurn(line, { owner: true })); };
                // Progress is shown in the bar, not spoken, and Kingmaker's voice is off while the scenes record: an ad request
                // speaks one line, the result or the failure.
                let adWasMuted = false;
                const r = await makeAdVideo({ request: text, model: adModel, facts: factsFor(text), deps: {
                  say: (line) => session.say(line), barSay, synth: (line) => synthesizeKokoroWav(line),
                  show: (line) => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ said: line.slice(0, 4000) })}\n`); else console.log(line); },
                  hush: (on) => { if (on) { adWasMuted = Boolean(session.muted); session.setMuted?.(true); } else session.setMuted?.(adWasMuted); },
                  // The bar on camera (Kingmaker.swift setStage): a fresh unsaved chat, a normal size, staying in front; put back after.
                  stage: (on) => { if (agent) process.stdout.write(`@@ghost ${JSON.stringify({ stage: on === 'aside' ? 'aside' : Boolean(on) })}\n`); },
                  makeImage: (prompt) => (imageSetup.ready ? makeImage(prompt, { setup: imageSetup }) : Promise.resolve({ ok: false })) } });
                log('ad_video', { ok: r.ok, model: adModel, by: r.script?.by, scenes: r.script?.scenes?.length, seconds: r.seconds, why: r.why });
                if (r.ok) { execFile('/usr/bin/open', ['-R', r.file], () => {}); await session.say(`The ad is in Kingmaker's files (Artifacts in the bar): ${basename(r.file)}, ${r.seconds} seconds, ${r.script.scenes.length} scenes, script by ${r.script.by === 'fallback' ? 'the plain facts sheet' : r.script.by}.`); }
                else await session.say(`I couldn't finish the ad: ${r.why}`);
              }
              // "yes you may" to a macOS permission (Kingmaker's last line asked for screen recording…): only the owner can
              // grant it, in System Settings. Say so and show that pane (shown, never changed).
              else if (!programs.length && permissionGrantReply(text, lastSaid)) {
                const p = permissionGrantReply(text, lastSaid);
                log('permission_reply', { pane: p.pane });
                execFile('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${p.pane}`], () => {});
                await session.say(p.line);
              }
              // An edit ("make it shorter", "the second one") to the latest written answer, whichever lane wrote it (the writer or
              // a CRM job's result): straight to the writer with that exchange. Never a yes/no: those may approve something waiting.
              else if (!programs.length && model === 'kingmaker' && lastWrite && Date.now() - lastWrite.at <= cal().followUp.minutes * 60_000 && isEditFollowUp(text)) {
                const c = cal();
                const answer = await localModelTurn(writerModel(pin), withFollowUp(framed, text, lastWrite, Date.now(), c.followUp.minutes * 60_000), { ...briefFor(text, writerModel(pin)), temperature: c.writer.temperature, context: c.writer.context });
                lastWrite = { asked: text, answer, at: Date.now() };
                log('follow_up', { writer: writerModel(pin) });
                await session.say(answer);
              }
              else if (!programs.length && crmJobs && cal().crmJobs.on && await crmJobs.handle(text)) { /* opened: the bar shows the job, then its result */ }
              else if (model === 'kingmaker') { if (programs.length || !(await fastLane(text, framed, pin))) await (brain ? brain.runTurn(framed) : session.runTurn(framed, turnOpts)); }
              else await session.say(await localModelTurn(model, framed, briefFor(text, model)));
            } catch (error) { await session.say(`That didn't work: ${String(error?.message || error).slice(0, 200)}`).catch(() => {}); }
            if (learnAsk) await session.say(learnAsk).catch(() => {});
            session.setSpokenLimit?.(0);
            emit('idle');
            suggestAfter(text);
          });
        }
        // PUSH-TO-TALK (the app's fn key): down = barge in (Kingmaker's voice to zero while you talk) and listen; up = the
        // command is complete and goes in; cancel = fn was part of a shortcut (fn+F1…), nothing is sent.
        else if (/^ptt\s+down\b/.test(said)) {
          if (pttMutedBefore === null) pttMutedBefore = Boolean(session.muted);
          session.interrupt?.(); session.setMuted?.(true);
          if (!voice?.pttDown?.()) { session.setMuted?.(pttMutedBefore); pttMutedBefore = null; }
        }
        else if (/^ptt\s+(up|cancel)\b/.test(said)) {
          if (/cancel/.test(said)) voice?.pttCancel?.(); else voice?.pttUp?.();
          if (pttMutedBefore !== null) { session.setMuted?.(pttMutedBefore); pttMutedBefore = null; }
        }
        else if (/^voice-out\s+/.test(said)) { session.setMuted?.(/\boff\b/.test(said)); process.stdout.write(`@@ghost ${JSON.stringify({ muted: Boolean(session.muted) })}\n`); }
        else if (/^power\s+/.test(said)) {
          const on = /\bon\b/.test(said);
          // OFF = Kingmaker leaves the desktop: no mic, no wake word, nothing spoken. The engine (and so the CRM dock, its
          // agent jobs and desks) keeps running in the background with every ability, like a daemon for the team.
          if (on) { voice?.powerOn?.(); session.setMuted?.(/\bmuted\b/.test(said)); } else { session.interrupt?.(); session.setMuted?.(true); voice?.powerOff?.(); }
          process.stdout.write(`@@ghost ${JSON.stringify({ power: on ? 'on' : 'off' })}\n`);
        }
        else if (/^stop\b/.test(said)) session.interrupt?.();
        // The app sends this at launch and whenever the Mac wakes. A newer build is only ASKED about, the next time
        // Kingmaker is woken; it installs on a spoken yes (operator 2026-10-08: "human must give vocal consent").
        else if (/^update-check\b/.test(said)) void offerUpdate(paths, voice, log);
        // kingmaker://pair (the site's "Pair this Mac" link) reaches here through the app: ask the owner to pair this Mac.
        else if (/^pair\b/.test(said)) { if (ronin) { ronin.markPairingWanted(paths); void pairIfNeeded(); } else log('pair_without_addon', {}); }
        // kingmaker://companion?op=start|stop (the Ronin launcher, `open -g`): the iPhone companion in this process. The
        // answer is @@ghost {companion} for the bar; nothing is shown or spoken, and the bar stays where it is.
        else if (companionControl(said)) void companionOp(companionControl(said)).then((s) => process.stdout.write(`@@ghost ${JSON.stringify({ companion: s })}\n`));
      }
    };
    process.stdin.on('data', onControlLines);
    // A turn from a paired phone is a typed turn, in this process: the same line, the same gates, the same governed brain
    // (base64, so the phone's text can never become a control line). No URL, no `open`, no bar key anywhere.
    phoneTurn = (text, meta = {}) => onControlLines(`typed-turn ${Buffer.from(JSON.stringify({ text, model: 'auto', ...(meta?.conversationId ? { conversationId: meta.conversationId } : {}), ...(meta?.image ? { image: meta.image } : {}) }), 'utf8').toString('base64')}\n`);
    process.stdin.on('end', () => void shutdown('app closed'));
    process.stdin.resume();
    return new Promise(() => {});
  }
  if (!process.stdin.isTTY) {
    console.log(!voiceApproves ? '(No terminal attached and your voice cannot approve in this mode, so nothing can be approved from this run. Start it in a terminal to approve.)'
      : voiceAuthority === 'owner' ? '(No terminal attached: approve by voice; awake, your yes is your word.)' : '(No terminal attached: approve by voice, "yes, go ahead" in your enrolled voice.)');
    return new Promise(() => {});
  }
  let rl = null;
  let suspended = false;
  let challengeResolver = null;
  const readChallenge = (words) => new Promise((resolve) => { console.log(`  type these words to approve: ${words}`); challengeResolver = resolve; rl.prompt(); });
  // An API key: this terminal is handed to the hidden prompt (the console's line editor steps aside so nothing
  // echoes or lands in its history), then the console comes back.
  let keyFlowOpen = false;
  const runKey = async ({ provider = '', handoff = null }) => {
    if (keyFlowOpen) { console.log('  A key prompt is already open.'); return; }
    keyFlowOpen = true;
    suspended = true;
    rl.close();
    try {
      await runKeyFlow({ port, nonce: secrets.nonce, provider, handoff, conversationId: session.conversationId, spokenAlready: Boolean(handoff), log, speak: (line) => void session.say(line, { print: false }) });
    } catch (error) {
      console.error(`  ✗ ${error?.message || error}`);
    } finally {
      keyFlowOpen = false;
      suspended = false;
      openConsole();
    }
  };
  keyHandoff = (handoff) => void runKey({ handoff }).then(() => rl.prompt());
  const onLine = async (line) => {
    if (challengeResolver) { const r = challengeResolver; challengeResolver = null; r(line.trim()); return; }
    const kind = classifyLine(line);
    try {
      if (kind === 'quit') return void shutdown(':quit');
      // :nightly … is typed here or in the bar, never spoken (the Ronin add-on).
      if (line.trim().startsWith(':') && ronin?.nightlyCommand(line)) { console.log(`  ${(await nightlyAnswer(ronin?.nightlyCommand(line))).replace(/\n/g, '\n  ')}`); rl.prompt(); return; }
      // The Ronin add-on's console switches (its delegated approvals and DM bridge); without it these words are ordinary text.
      if (ronin) {
        // :approvals on is the owner's own act, typed here (never spoken); :approvals off and "stop approving" halt it.
        const approvals = ronin.approvalsCommand(line);
        if (approvals === 'on') {
          const r = await ownerCall(port, `${ronin.APPROVER_ROUTE}/enable`, { nonce: secrets.nonce, method: 'POST', body: {}, timeoutMs: 10_000 }).catch(() => null);
          console.log(r?.ok ? `  ✓ ${ronin.statusLine(r.json?.data)}` : `  ✗ Not turned on: ${r?.json?.error ?? 'the core did not answer'}.`);
          rl.prompt(); return;
        }
        if (approvals === 'off' || (kind === 'text' && ronin.isStopApproving(line))) { await stopApprovals('console'); rl.prompt(); return; }
        if (approvals === 'status') {
          const r = await ownerCall(port, `${ronin.APPROVER_ROUTE}/status`, { nonce: secrets.nonce, timeoutMs: 10_000 }).catch(() => null);
          console.log(`  ${ronin.statusLine(r?.json?.data)}`);
          rl.prompt(); return;
        }
        // :dms on is the owner's own act, typed here (never spoken); :dms off and "stop forwarding" pause it.
        const dms = ronin.dmsCommand(line);
        if (dms === 'on') {
          const r = await ownerCall(port, `${ronin.DMS_ROUTE}/enable`, { nonce: secrets.nonce, method: 'POST', body: {}, timeoutMs: 10_000 }).catch(() => null);
          console.log(r?.ok ? `  ✓ ${ronin.dmsStatusLine(r.json?.data)}` : `  ✗ Not turned on: ${r?.json?.error ?? 'the core did not answer'}.`);
          rl.prompt(); return;
        }
        if (dms === 'off' || (kind === 'text' && ronin.isStopForwarding(line))) { await stopForwarding('console'); rl.prompt(); return; }
        if (dms === 'status') {
          const r = await ownerCall(port, `${ronin.DMS_ROUTE}/status`, { nonce: secrets.nonce, timeoutMs: 10_000 }).catch(() => null);
          console.log(`  ${ronin.dmsStatusLine(r?.json?.data)}`);
          rl.prompt(); return;
        }
      }
      // The device desk first: a read-back of its waits for this y / n; its asks (:scan, :tools, :key import, :key setup,
      // "put my keys in the vault", "get me a Groq key", "install …") are its own.
      if ((kind === 'yes' || kind === 'no') && desk.pending()) { await desk.answer(kind, { typed: true }); rl.prompt(); return; }
      if (kind === 'text' || (kind === 'key' && /^(?:import|setup)$/i.test(keyArg(line)))) {
        if (await desk.handle(line.trim(), { typed: true })) { rl.prompt(); return; }
      }
      if (kind === 'help') console.log('  y approve · n cancel · :pending · :approvals [on|off] · :dms [on|off] · :key <provider> (ronin-crm: the one CRM master key) · :key import (keys on this Mac → vault) · :key setup (free API keys) · :scan · :tools · :craft <app> [what…] [--input F] [--says T] · :quit · anything else goes to Kingmaker');
      else if (kind === 'pending') {
        const list = await session.refreshPending();
        console.log(list.length ? list.map((p) => `  ⧗ ${session.describe(p)}`).join('\n') : '  nothing waiting');
      } else if (kind === 'key') await runKey({ provider: keyArg(line) });
      else if (kind === 'craft') {
        // The owner's own ArtCraft ask: inputs staged into the inbox, then the sentence as an owner turn. A write is
        // read back and waits for y, like any other proposal here.
        const asked = await consoleCraftTurn(line, paths);
        if (asked.error) console.log(`  ✗ ${asked.error}`);
        else { for (const note of asked.notes) console.log(`  ${note}`); await session.runTurn(asked.text, { owner: true }); }
      }
      else if (kind === 'yes' || kind === 'no') await session.decide(kind, readChallenge);
      else if (kind === 'text') await (brain ? brain.runTurn(line.trim()) : session.runTurn(line.trim(), { owner: true }));
    } catch (error) {
      console.error(`  ✗ ${error?.message || error}`);
    }
    rl.prompt();
  };
  function openConsole() {
    rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you › ' });
    rl.on('line', onLine);
    rl.on('close', () => { if (!suspended) void shutdown('console closed'); });
  }
  openConsole();
  rl.prompt();
  return new Promise(() => {});
}

/** The saved voice authority (`kingmaker voice`), or '' when none was chosen. */
export function savedVoiceAuthority(paths, read = (p) => readFileSync(p, 'utf8')) {
  try { return read(join(paths.state, 'voice-authority')).trim(); } catch { return ''; }
}

const VOICE_MODE_LINES = Object.freeze({
  owner: 'owner (default): what Kingmaker hears while awake is your word, the same as typing it. Waking it is the only gate.',
  verified: 'verified: only your enrolled voice (kingmaker enroll) is your word; anyone else can ask but not act.',
  propose: 'propose: spoken commands only propose; approvals are typed at the console.',
});

/** `kingmaker voice [owner|verified|propose]`: show or set (typed at a terminal) what your spoken word can do. */
async function cmdVoice(args) {
  const paths = resolvePaths();
  const want = String(args[0] ?? '').trim().toLowerCase();
  const saved = savedVoiceAuthority(paths);
  const now = resolveVoiceAuthority(process.env, saved);
  if (!want) {
    const from = process.env.SOL_GHOST_VOICE_AUTHORITY ? 'SOL_GHOST_VOICE_AUTHORITY' : saved ? 'saved' : 'default';
    console.log(`voice authority: ${VOICE_MODE_LINES[now]} (${from})`);
    return 0;
  }
  if (!VOICE_AUTHORITIES.includes(want)) { console.error(`usage: kingmaker voice [${VOICE_AUTHORITIES.join('|')}]`); return 2; }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) { console.error('✗ What your voice can do is set by you at a terminal.'); return 78; }
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.state, 'voice-authority'), `${want}\n`, { mode: 0o600 });
  console.log(`voice authority: ${VOICE_MODE_LINES[want]}`);
  if (process.env.SOL_GHOST_VOICE_AUTHORITY && process.env.SOL_GHOST_VOICE_AUTHORITY.trim().toLowerCase() !== want) console.log(`! SOL_GHOST_VOICE_AUTHORITY=${process.env.SOL_GHOST_VOICE_AUTHORITY} in this shell still wins here.`);
  console.log('Takes effect the next time Kingmaker starts.');
  return 0;
}

/** A line typed at this terminal (resolves '' on Ctrl-D). */
function askLine(rl, question) {
  return new Promise((resolve) => {
    const onClose = () => resolve('');
    rl.once('close', onClose);
    rl.question(question, (answer) => { rl.off('close', onClose); resolve(answer.trim()); });
  });
}

async function cmdEnroll(args) {
  const paths = resolvePaths();
  const running = readDaemonState(paths);
  const blockers = enrollBlockers({
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    ghostRunningPid: running && pidAlive(running.pid) ? running.pid : null,
    micTool: args.includes('--forget') || existsSync('/opt/homebrew/bin/sox') || existsSync('/opt/homebrew/bin/ffmpeg'),
    sttReady: args.includes('--forget') || (existsSync(paths.voice.whisper) && existsSync(paths.voice.sttModel)),
    speakerReady: args.includes('--forget') || (existsSync(paths.voice.speaker) && existsSync(paths.voice.speakerModel)),
  });
  if (blockers.length) { for (const b of blockers) console.error(`✗ ${b}`); return 78; }

  const ipc = createConsoleIpc({ onProgress: () => {} });
  let owner;
  try {
    // No attestation key here: enrollment mints nothing. The voice path is not running at all.
    owner = await openOwnerVoice({ paths, attestationKeyHex: undefined, ipcMain: ipc.ipcMain, isAuthoritativeSender: ipc.isAuthoritativeSender });
  } catch (error) {
    console.error(`✗ The engine's owner-voice modules did not load from ${paths.ownerVoiceModules}: ${error?.message || error}`);
    return 1;
  }
  const IPC = owner.modules.OWNER_VOICE_IPC;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let mic = null;
  const stop = () => { try { mic?.kill('SIGTERM'); } catch { /* gone */ } try { rl.close(); } catch { /* closed */ } owner.dispose(); };
  // Ctrl-C reaches readline (raw TTY), not the process; a closed terminal or a kill arrives as a signal. Each one
  // cancels: the samples are wiped, the speaker model and the mic stop, nothing is saved.
  let quitting = false;
  const quit = (code) => { if (quitting) return; quitting = true; console.log('\nCancelled. Nothing was saved.'); void ipc.invoke(IPC.enrollCancel).finally(() => { stop(); process.exit(code); }); };
  rl.on('SIGINT', () => quit(130));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => quit(130));
  try {
    const status = await ipc.invoke(IPC.status);
    const words = challengeWords();
    if (args.includes('--forget')) {
      if (!status.enrolled && status.state !== 'corrupt' && status.state !== 'reenroll_required') { console.log('No voiceprint is enrolled.'); }
      const typed = await askLine(rl, `Delete your voiceprint and its Keychain key? Type "${words}" to confirm: `);
      if (typed.toLowerCase() !== words) { console.log('Not deleted.'); return 1; }
      const r = await ipc.invoke(IPC.forget);
      const key = owner.safeStorage.destroyKey();
      console.log(`${r.removed ? 'Voiceprint deleted (zero-filled, then removed)' : 'No voiceprint file was there'}; Keychain key ${key.removed ? 'deleted, so any old copy (a backup) can no longer be opened' : 'was not there'}.`);
      return r.ok && key.ok ? 0 : 1;
    }
    if (status.sealing !== 'available') { console.error('✗ The login Keychain is not available (locked?), so a voiceprint cannot be sealed. Nothing was recorded.'); return 1; }
    console.log(status.enrolled
      ? `You already have a voiceprint (${String(status.enrolledAt).slice(0, 10)}, ${status.sampleCount} samples). Enrolling again replaces it.`
      : 'Enroll your voice so that your spoken "yes, go ahead" approves, and nobody else\'s does.');
    console.log(`You'll read ${status.limits.targetSamples} short sentences aloud. Only a voiceprint (numbers, sealed with a key in your Keychain) is kept; no audio is ever stored.`);
    const typed = await askLine(rl, `Type "${words}" to begin: `);
    if (typed.toLowerCase() !== words) { console.log('Not started.'); return 1; }

    console.log('Loading the speaker model…');
    const warm = await owner.ov.supervisor.warm({ timeoutMs: 90_000 });
    if (!warm.ok) { console.error(`✗ The speaker model did not start (${warm.reason}).`); return 1; }
    console.log("Learning Kingmaker's own voice first, so its echo can never count as you…");
    const self = await learnSelfPrint(owner.ov);
    if (!self.ok) console.log("  ! Could not learn Kingmaker's voice; its echo is still refused while it is talking.");

    mic = openMicrophone({ exists: existsSync });
    if (!mic) { console.error('✗ No microphone tool (brew install sox).'); return 1; }
    const segmenter = createSegmenter({ endSilenceMs: 900 });
    const pending = [];
    let wake = null;
    const push = (item) => { if (wake) { const w = wake; wake = null; w(item); } else pending.push(item); };
    let listening = false;
    mic.stdout.on('data', (chunk) => {
      if (!listening) return;
      for (const utt of segmenter.push(chunk)) { listening = false; push({ kind: 'utterance', utt }); }
    });
    mic.once('exit', () => push({ kind: 'end' }));
    rl.on('line', (text) => push({ kind: 'line', text }));
    rl.on('close', () => { if (!quitting) push({ kind: 'end' }); });
    const next = () => {
      for (const u of pending.splice(0).filter((p) => p.kind === 'utterance')) u.utt.samples.fill(0); // stale audio: never a sample
      segmenter.reset();
      listening = true;
      return new Promise((resolve) => { wake = resolve; });
    };
    console.log('Speak each sentence when it appears. Type "done" to finish after 3, "cancel" to stop.');
    const result = await runEnrollment({
      ov: owner.ov, ipc, channels: IPC, next,
      transcribe: (samples) => transcribe(samples, { whisper: paths.voice.whisper, model: paths.voice.sttModel, language: process.env.SOL_GHOST_LANG || 'en' }),
      embed: (samples) => embedUtterance(owner.ov, samples, { timeoutMs: 20_000 }),
      out: (line) => console.log(line),
    });
    if (!result.ok) { console.error(`✗ Not enrolled: ${result.reason}${result.meanPairwise !== undefined ? ` (consistency ${result.meanPairwise}/${result.minPairwise})` : ''}. Nothing was saved.`); return 1; }
    console.log(`✓ Enrolled: ${result.sampleCount} samples, consistency ${result.meanPairwise} (lowest ${result.minPairwise}). Sealed in ${paths.state}/owner-voice with a key in your login Keychain.`);
    console.log(resolveVoiceAuthority(process.env, savedVoiceAuthority(paths)) === 'verified'
      ? 'Start Kingmaker again; a spoken "yes, go ahead" in your voice now approves.'
      : 'To make only your voice count, run: kingmaker voice verified   (then start Kingmaker again).');
    return 0;
  } finally {
    stop();
  }
}

/**
 * Pure: one line about the mac provider from the /api/agent/status body. The hands named are the ones the server
 * says it is driving with (its mac detail): Hands of Horus, with its version and tool count when known, or ghost-os.
 */
export function handsLine(body, horus = null) {
  const mac = (body?.providers ?? []).find((p) => p.providerId === 'mac');
  if (!mac) return { live: false, line: 'Hands: no Mac provider in this build.' };
  const live = mac.state === 'LIVE' && mac.toolCount > 0;
  if (!live) return { live, line: `Hands: not live yet — ${mac.state}: ${mac.detail}.` };
  if (/Hands of Horus/.test(String(mac.detail ?? ''))) {
    const version = horus?.version ? ` ${horus.version}` : '';
    const tools = horus?.toolCount ? `${horus.toolCount} tools, ` : '';
    return { live, line: `Hands: ${HANDS_NAMES.peekaboo}${version} live (${tools}${mac.toolCount} Mac tools, ${body.toolCount} tools in all).` };
  }
  return { live, line: `Hands: ghost-os live (${mac.toolCount} Mac tools, ${body.toolCount} tools in all).` };
}

/** The Peekaboo binary the backend env launches (SOLOMON_PEEKABOO_MCP_CMD's first word), or null. Pure. */
export function handsBinary(backendEnv) {
  const raw = String(backendEnv?.SOLOMON_PEEKABOO_MCP_CMD ?? '').trim();
  if (!raw) return null;
  try { const argv = JSON.parse(raw); return Array.isArray(argv) && argv[0] ? String(argv[0]) : null; } catch { return raw.split(/\s+/)[0] || null; }
}

/** Pure: is this the window's rule set, with this terminal as the owner? */
export function rulesVerdict(data) {
  if (!data) return { ok: false, line: 'The engine did not report its rules (/api/control/status). Not starting.' };
  if (data.enforced !== true) return { ok: false, line: 'The engine started WITHOUT principal enforcement, so any local program could approve. Not starting.' };
  if (data.principal?.kind !== 'operator_typed') return { ok: false, line: `This console is not recognised as the owner (${data.principal?.kind ?? 'unknown'}). Not starting.` };
  return { ok: true, line: 'Rules: enforced, same as the window. This terminal is the owner console.' };
}

async function warmHands(port, headers, horus = null) {
  let last = { live: false, line: 'Hands: no answer from /api/agent/status.' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await agentStatus(port, { headers }).catch(() => null);
    if (r?.json?.ok) last = handsLine(r.json, horus);
    if (last.live) return last.line;
    await new Promise((res) => setTimeout(res, 3_000));
  }
  return last.line;
}

// kingmaker update            check and install a newer published build (asks nothing: publishing is the operator's go)
// kingmaker update --check    only say whether one is waiting
// kingmaker update --auto     what the menu bar agent runs at launch and on wake: quiet when there is nothing to do
// kingmaker update --setup    store the update host and key (both read from stdin, one per line; never argv)
async function cmdUpdate(args) {
  const paths = resolvePaths();
  const quiet = args.includes('--auto');
  if (args.includes('--setup')) {
    const lines = readFileSync(0, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    writeUpdateConfig(paths.state, { url: lines[0], key: lines[1] });
    console.log(`Updates will come from ${lines[0]}.`);
    return 0;
  }
  const config = readUpdateConfig(paths.state);
  if (!config) { if (!quiet) console.log('No update host set up on this Mac (kingmaker update --setup).'); return quiet ? 0 : 1; }
  let offer;
  try { offer = await checkForUpdate(config); } catch (e) { if (!quiet) console.error(`Couldn't check for updates: ${e.message}`); return quiet ? 0 : 1; }
  if (!offer.available) { if (!quiet) console.log(`Kingmaker ${offer.current} is the latest.`); return 0; }
  if (args.includes('--check') || quiet) { console.log(`Kingmaker ${offer.latest} is ready (this Mac has ${offer.current}).`); return 0; }
  const install = readInstallConfig(paths.state);
  if (!install.cemented) { console.error('This Kingmaker has no cemented wake word; install it with the installer first.'); return 1; }
  if (!takeUpdateLock(paths.state)) { if (!quiet) console.log('An update is already running.'); return 0; }
  try {
    const r = await applyUpdate(config, offer, { dataDir: paths.state, wakeWord: install.wakeWord });
    console.log(`Updating Kingmaker ${offer.current} → ${offer.latest}. It restarts on its own. Log: ${r.log}`);
    return 0;
  } catch (e) { console.error(`Update not started: ${e.message}`); return 1; }
}

// kingmaker phone setup | test | off, and kingmaker call me "<text>": see lib/phone.mjs. Only ever the owner's number.
async function cmdPhone(args) {
  const sub = args[0];
  if (sub === 'off') { forgetPhone(); console.log('Phone calls are off; the saved numbers and keys are gone.'); return 0; }
  if (sub === 'test') {
    const install = readInstallConfig(resolvePaths().state);
    const r = await callOwner(`This is ${install.wakeWord || 'Kingmaker'}. Phone updates are working.`);
    console.log(r.ok ? 'Calling your phone now.' : `No call: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  if (sub !== 'setup') { console.log(readPhone() ? 'Phone calls are set up. kingmaker phone test | off' : 'Phone calls are not set up: kingmaker phone setup'); return 0; }
  console.log('Opening Twilio in Chrome. Sign in (or sign up), then copy each item when asked.');
  await openKeyPage(TWILIO_CONSOLE).catch(() => null);
  const ask = async (label) => { const b = await readHidden({ prompt: `${label} (hidden, then Enter): ` }); process.stdout.write('\n'); const v = Buffer.from(b).toString('utf8').trim(); b.fill?.(0); return v; };
  try {
    const sid = await ask('Account SID (starts with AC)');
    const token = await ask('Auth Token');
    const from = await readAnswer({ prompt: 'Your Twilio phone number (to call from): ' });
    const to = await readAnswer({ prompt: 'YOUR phone number (the only number Kingmaker will ever call): ' });
    const r = savePhone({ sid, token, from, to });
    console.log(`Saved. Kingmaker calls ${r.to} from ${r.from}. Try it: kingmaker phone test`);
    return 0;
  } catch (e) { console.error(String(e?.message ?? e)); return 1; }
}

async function cmdCall(args) {
  if (args[0] !== 'me') { console.error('Kingmaker only calls you: kingmaker call me "<what to say>"'); return 2; }
  const text = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!text) { console.error('usage: kingmaker call me "<what to say>"'); return 2; }
  const r = await callOwner(text);
  console.log(r.ok ? 'Calling your phone now.' : `No call: ${r.error}`);
  return r.ok ? 0 : 1;
}

async function offerUpdate(paths, voice, log = () => {}) {
  if (!voice?.ok || !voice.setOffer) return; // no voice, no consent: the update waits for `kingmaker update`
  const config = readUpdateConfig(paths.state);
  if (!config) return;
  let offer;
  try { offer = await checkForUpdate(config); } catch (e) { log('update_check_failed', { message: String(e?.message ?? e).slice(0, 120) }); return; }
  if (!offer.available) return;
  log('update_offered', { from: offer.current, to: offer.latest });
  // A phone call about it, once per version, when phone updates are set up.
  try {
    const mark = join(paths.state, 'update-called.txt');
    const last = existsSync(mark) ? readFileSync(mark, 'utf8').trim() : '';
    if (last !== offer.latest && readPhone()) {
      const word = readInstallConfig(paths.state).wakeWord || 'Kingmaker';
      const r = await callOwner(`Hi, it's ${word}. A new update, version ${offer.latest}, is ready. ${offer.notes || ''} Wake me and say yes when you want it installed.`);
      log('update_call', { ok: r.ok });
      if (r.ok) writeFileSync(mark, offer.latest);
    }
  } catch { /* a missed call never blocks the spoken offer */ }
  voice.setOffer({
    id: `update-${offer.latest}`,
    prompt: `There's a new Kingmaker update, version ${offer.latest}. Want me to install it now? Say yes, no, or what's in it.`,
    details: offer.notes ? `Version ${offer.latest}: ${offer.notes}` : `Version ${offer.latest} has no notes.`,
    reprompt: 'Want me to install it now? Say yes or no.',
    onYes: async () => {
      const install = readInstallConfig(paths.state);
      if (!install.cemented || !takeUpdateLock(paths.state)) return "I can't start the update right now.";
      try {
        await applyUpdate(config, offer, { dataDir: paths.state, wakeWord: install.wakeWord });
        return "Updating now. I'll be back in a few minutes.";
      } catch (e) { log('update_failed', { message: String(e?.message ?? e).slice(0, 120) }); return "The update didn't start. I'll ask again next time."; }
    },
    onNo: async () => "Okay. I'll ask next time.",
  });
}

async function cmdSay(args) {
  const paths = resolvePaths();
  const port = resolvePort(args, paths);
  const text = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port' && args[i - 1] !== '--conversation').join(' ').trim();
  if (!text) { console.error('usage: kingmaker say "<text>" [--conversation <id>] [--open]'); return 2; }
  const r = await turn(port, { text, conversationId: flagValue(args, '--conversation') });
  // The turn's sources and what Kingmaker made are listed under the answer (nothing opens by itself); --open opens them on
  // the desktop as before. A page the turn was asked to open ("open bbc.com") still opens. SOL_GHOST_OPEN_EVIDENCE=0
  // keeps the desktop untouched.
  let opened = '';
  let links = [];
  if (r.ok && process.env.SOL_GHOST_OPEN_EVIDENCE !== '0') {
    if (args.includes('--open')) {
      const targets = evidenceTargets(r.raw, { port, runtimeHome: paths.runtimeHome });
      if (targets.length) opened = describeWall(await openDesktopWall(targets));
    } else { links = evidenceLinks(r.raw, { port, runtimeHome: paths.runtimeHome }); opened = describeLinks(links, { where: 'below' }); }
    const page = browseTarget(r.raw);
    if (page) opened = [opened, describeBrowse(await openDesktopWall([page], { chromeOnly: true }))].filter(Boolean).join(' ');
  }
  console.log(r.spoken ? `${r.spoken}${opened ? ` ${opened}` : ''}` : `(HTTP ${r.status})`);
  if (links.length) console.log(['Sources:', ...links.map((l) => `  ${l.title} — ${l.url}`)].join('\n'));
  if (r.readBack && !r.proposalId) console.log('↳ read back, not made. This shell cannot make it go: the owner asks Kingmaker for the same thing (by voice or at the console) and says go ahead.');
  else if (r.confirmationRequired) console.log('↳ proposed. Approve it at the Kingmaker console (y), or it expires.');
  if (r.conversationId) console.log(`conversation: ${r.conversationId}`);
  return r.ok ? 0 : 1;
}

/**
 * `kingmaker key <provider>`: an API key from this terminal into Kingmaker's vault, as the owner. Owner calls need
 * the launch nonce. A running Kingmaker keeps it in its console's memory and nowhere else, so then the key is
 * taken there (`:key <provider>`, or say "connect my <provider> key"). A headless engine that minted its own
 * (the Linux service, desktop/headless-server.mjs) left it in a 0600 file for its owner; this reads that.
 */
async function cmdKey(args) {
  const paths = resolvePaths();
  const word = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port' && args[i - 1] !== '--runtime-home').join(' ').trim();
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) { console.error('✗ A key is pasted at a terminal: run this in one.'); return 78; }
  const explicitHome = flagValue(args, '--runtime-home');
  const running = readDaemonState(paths);
  if (!explicitHome && running && pidAlive(running.pid)) {
    console.error(`✗ Kingmaker (pid ${running.pid}) holds this launch's owner secret in its console, and nowhere else. Type  :key ${word || '<provider>'}  in that console, or say "connect my ${word || 'GitHub'} key".`);
    return 78;
  }
  const secret = readOwnerNonce(explicitHome || paths.runtimeHome);
  if (!secret.ok) { console.error(`✗ ${secret.reason} Start Kingmaker (kingmaker start) and type :key ${word || '<provider>'} in its console, or point --runtime-home at a headless engine's runtime home.`); return 78; }
  const port = resolvePort(args, paths);
  if (!(await health(port).catch(() => null))?.ok) { console.error(`✗ Kingmaker is not answering on 127.0.0.1:${port}.`); return 1; }
  const r = await runKeyFlow({ port, nonce: secret.value, provider: word, speak: args.includes('--quiet') ? () => {} : (line) => { speak(line); } });
  return r.ok ? 0 : 1;
}

/** Pure: a console line's words, honouring "double" and 'single' quotes. */
export function splitConsoleWords(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(line ?? '').matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `:craft <app> …` typed at the owner console → { text, notes } or { error }. */
export async function consoleCraftTurn(line, paths, stage = stageCraftInput) {
  const [, appWord, ...rest] = splitConsoleWords(line);
  const app = craftApp(appWord);
  if (!app) return { error: `:craft <app> [what to do…] [--input <file>] [--says "<words>"]; the seven: ${CRAFT_APP_IDS.join(', ')}` };
  const { words, inputs, says } = parseCraftArgs(rest);
  const notes = app.id === 'lightcraft' ? [`! LightCraft: ${LIGHTCRAFT_LIMITS}`] : [];
  let inputName = null;
  for (const src of inputs) {
    try {
      const staged = await stage(src.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'), craftInboxDir(paths), { app });
      notes.push(`${staged.reused ? 'already in' : 'copied into'} the ArtCraft inbox: ${staged.name}`, ...staged.notes.map((n) => `! ${n}`));
      inputName ??= staged.name;
    } catch (error) { return { error: error.message }; }
  }
  const asked = craftTurnText(app, words, { says, inputName });
  return asked.error ? asked : { text: asked.text, notes };
}

/** Pure: `craft` arguments → words, inputs (--input, repeatable), --says, --conversation, --jobs and bare flags. */
export function parseCraftArgs(args) {
  const parsed = { words: [], inputs: [], says: null, conversation: undefined, jobs: undefined, flags: new Set() };
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--input' || a === '-i') { if (args[i + 1] !== undefined) parsed.inputs.push(String(args[++i])); continue; }
    if (a === '--says') { parsed.says = args[i + 1] !== undefined ? String(args[++i]) : null; continue; }
    if (a === '--conversation') { parsed.conversation = args[++i]; continue; }
    if (a === '--jobs') { parsed.jobs = Number(args[++i]); continue; }
    if (a === '--port') { i += 1; continue; }
    if (a.startsWith('--')) { parsed.flags.add(a); continue; }
    parsed.words.push(a);
  }
  return parsed;
}

/** Pure: what an ArtCraft turn made (data.output of a run), as lines. */
export function craftOutputLines(raw) {
  const o = raw?.data?.output;
  if (!o || typeof o !== 'object' || !/^artcraft_job/.test(String(o.kind ?? ''))) return [];
  const lines = (o.outputs ?? []).map((f) => `  ⇢ ${f.role}: ${f.url ?? '?'} (${f.mime}, ${f.bytes} bytes, sha256 ${String(f.sha256 ?? '').slice(0, 12)}…)`);
  if (o.receiptUrl) lines.push(`  ⇢ receipt: ${o.receiptUrl}${o.receiptSigned ? ' (signed)' : ' (unsigned)'}; network ${o.networkKernelBlocked ? 'kernel-blocked' : 'NOT kernel-blocked'}`);
  if (o.status && o.kind === 'artcraft_job_unavailable') lines.push(`  ⇢ ${o.status}${o.reason ? `: ${o.reason}` : ''}`);
  return lines;
}

async function craftStatus(paths, port) {
  const report = await craftDoctor(paths);
  for (const line of craftDoctorLines(report)) console.log(line);
  const r = await artcraftDoctor(port).catch(() => null);
  console.log(r?.ok ? engineCraftLine(r.json?.data, port) : `The engine on :${port}: ${r ? `no ArtCraft report (HTTP ${r.status})` : 'not answering (kingmaker start)'}.`);
  return 0;
}

/**
 * `kingmaker craft <app> …`: one sentence to the engine's ArtCraft lane, never a run of the app itself. Inputs are
 * copied into the ArtCraft inbox first (the adapter reads only inside its data root). Authority is the caller's:
 * with a headless engine's owner secret (and no Kingmaker console holding this launch's) the turn is the owner's
 * and a write runs after a typed "go ahead" here; otherwise it is a local program's, so a write is only proposed.
 */
async function craftJob(paths, app, args, port) {
  const { words, inputs, says, conversation, flags } = parseCraftArgs(args);
  let inputName = null;
  for (const src of inputs) {
    try {
      const staged = await stageCraftInput(src, craftInboxDir(paths), { app });
      console.log(`${staged.reused ? 'Already in' : 'Copied into'} the ArtCraft inbox: ${staged.name}`);
      for (const note of staged.notes) console.log(`! ${note}`);
      inputName ??= staged.name;
    } catch (error) { console.error(`✗ ${error.message}`); return 1; }
  }
  const asked = craftTurnText(app, words, { says, inputName });
  if (asked.error) { console.error(`✗ ${asked.error}`); return 2; }
  if (app.id === 'lightcraft') console.log(`! LightCraft: ${LIGHTCRAFT_LIMITS}`);
  const running = readDaemonState(paths);
  const consoleHolds = Boolean(running && pidAlive(running.pid));
  const secret = flags.has('--propose') || consoleHolds ? null : readOwnerNonce(paths.runtimeHome);
  const owner = secret?.ok === true;
  const headers = owner ? { [DESKTOP_NONCE_HEADER]: secret.value } : {};
  const kind = classifyCraftAsk(app, asked.text);
  console.log(`→ Kingmaker (${owner ? 'as the owner' : 'propose-only'}, ${kind}): ${asked.text}`);
  // A read runs on this turn and a go-ahead runs the job inside its turn: FilmCraft can wait for the heavy slot.
  let r = await turn(port, { text: asked.text, conversationId: conversation, headers, timeoutMs: 20 * 60_000 }).catch((error) => ({ ok: false, status: 0, spoken: `Kingmaker is not answering on 127.0.0.1:${port} (${error.message}). Start it: kingmaker start` }));
  console.log(r.spoken || `(HTTP ${r.status})`);
  if (r.ok && r.confirmationRequired) {
    if (owner && process.stdin.isTTY === true) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = await askLine(rl, 'Type "go ahead" to make it (anything else cancels): ');
      rl.close();
      const go = /^(?:yes,?\s*)?go ahead[.!]?$/i.test(typed);
      r = await turn(port, { text: go ? 'go ahead' : 'cancel', conversationId: r.conversationId, headers, timeoutMs: 20 * 60_000 });
      console.log(r.spoken || `(HTTP ${r.status})`);
    } else {
      if (r.proposalId) console.log(`↳ proposed (${r.proposalId}). The owner approves it at the Kingmaker console (y) or by voice; this shell cannot.`);
      else console.log(`↳ read back, not made. This shell cannot make it go. The owner makes it by saying or typing to Kingmaker${consoleHolds ? ` (pid ${running.pid})` : ''}:  ${asked.text}  then go ahead (at the console: y).`);
    }
  }
  for (const line of craftOutputLines(r.raw)) console.log(line);
  if (r.ok && !flags.has('--no-open') && process.env.SOL_GHOST_OPEN_EVIDENCE !== '0') {
    const targets = evidenceTargets(r.raw, { port, runtimeHome: paths.runtimeHome });
    if (targets.length) console.log(describeWall(await openDesktopWall(targets)));
  }
  if (r.conversationId) console.log(`conversation: ${r.conversationId}`);
  return r.ok ? 0 : 1;
}

async function cmdCraft(args) {
  const paths = resolvePaths();
  const port = resolvePort(args, paths);
  const [sub = 'status', ...rest] = args.filter((a, i) => !(a === '--port' || args[i - 1] === '--port'));
  if (sub === 'status' || sub === 'doctor' || sub === 'list') return craftStatus(paths, port);
  if (sub === 'install') {
    const { words, jobs, flags } = parseCraftArgs(rest);
    const wanted = !words.length || (words.length === 1 && words[0] === 'all') ? [...CRAFT_APP_IDS] : words;
    const unknown = wanted.filter((w) => !craftApp(w));
    if (unknown.length) { console.error(`✗ Not an ArtCraft app: ${unknown.join(', ')}. The seven: ${CRAFT_APP_IDS.join(', ')}`); return 2; }
    const ids = [...new Set(wanted.map((w) => craftApp(w).id))];
    const r = await installCraftApps(ids, { binDir: craftBinDir(paths), workDir: craftWorkDir(paths), jobs: Number.isInteger(jobs) && jobs > 0 ? jobs : defaultJobs(), keepBuild: flags.has('--keep-build') });
    return r.ok ? 0 : 1;
  }
  if (sub === 'clean') { console.log(cleanCraftWork(craftWorkDir(paths)) ? `Removed the kept build folders in ${craftWorkDir(paths)}.` : 'No kept build folders.'); return 0; }
  const app = craftApp(sub);
  if (!app) {
    console.error(`usage: kingmaker craft [status] | install [app…] [--jobs N] [--keep-build] | clean | <app> [what to do…] [--input <file>] [--says "<words>"] [--propose] [--no-open]\nThe seven: ${CRAFT_APPS.map((a) => `${a.id} (${a.serves}${a.input ? `; needs ${a.input}` : ''})`).join(', ')}`);
    return 2;
  }
  return craftJob(paths, app, rest, port);
}

/**
 * `kingmaker scan`: the inventory now (read-only, paced), the key names on this Mac, and with --find the online
 * search for tools for the gaps (typing --find is the owner's consent, kept for later scans). Never installs, never
 * imports a key: those wait for his yes at the console.
 */
async function cmdScan(args) {
  const paths = resolvePaths();
  const desk = createDeskOfDevice({ paths, port: null, nonce: null, say: async (line) => console.log(line), out: (line) => console.log(line) });
  const t0 = Date.now();
  await desk.runScan({ force: args.includes('--force') });
  if (args.includes('--find')) {
    // Typing --find is his consent to the online search (only app names leave), kept for later scans.
    desk.setConsent(true, 'typed');
    const r = await desk.runFind({});
    if (r?.stoppedFor) console.log(`(online search stopped: ${r.stoppedFor}; the next scan resumes it)`);
  }
  const now = desk.map();
  if (args.includes('--json')) { console.log(JSON.stringify(now, null, 2)); return 0; }
  for (const line of summaryLines(now)) console.log(line);
  for (const e of now?.keys?.entries ?? []) console.log(`  · key ${e.name} (${e.label}) in ${e.file}`);
  console.log(`(${Math.round((Date.now() - t0) / 100) / 10} s; map: ${desk.file})`);
  return 0;
}

function rssMb(pid) {
  try {
    const line = execFileSync('/usr/bin/top', ['-l', '1', '-pid', String(pid), '-stats', 'mem'], { encoding: 'utf8' }).trim().split('\n').at(-1).trim();
    const m = /^([\d.]+)([KMG])/.exec(line);
    if (!m) return null;
    return Math.round(Number(m[1]) * (m[2] === 'G' ? 1024 : m[2] === 'K' ? 1 / 1024 : 1));
  } catch { return null; }
}

function childPids(pid) {
  try { return execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}

async function cmdStatus(args) {
  const paths = resolvePaths();
  const state = readDaemonState(paths);
  const port = resolvePort(args, paths);
  const h = await health(port).catch(() => null);
  console.log(`runtime  ${h?.ok ? `up on 127.0.0.1:${port}` : `not answering on 127.0.0.1:${port}`}`);
  if (state && pidAlive(state.pid)) {
    const tree = [state.pid, ...childPids(state.pid)];
    for (const p of [...tree]) tree.push(...childPids(p));
    const total = [...new Set(tree)].reduce((n, p) => n + (rssMb(p) ?? 0), 0);
    console.log(`process  pid ${state.pid}, started ${state.startedAt}, ${total} MB across ${new Set(tree).size} processes (incl. compressed)`);
  } else console.log('process  no Kingmaker running from this profile');
  if (h?.ok) {
    const c = await controlStatus(port).catch(() => null);
    const p = await pendingProposals(port).catch(() => null);
    const cd = c?.json?.data ?? {};
    console.log(`control  armed=${cd.armed ?? '?'} enforced=${cd.enforced ?? '?'} this shell=${cd.principal?.kind ?? '?'} (approvals only at the kingmaker start terminal)`);
    const list = p?.json?.data?.proposals ?? [];
    console.log(`waiting  ${Array.isArray(list) ? list.length : 0} proposal(s)`);
  }
  return 0;
}

async function cmdStop() {
  const paths = resolvePaths();
  const state = readDaemonState(paths);
  if (!state?.pid || !pidAlive(state.pid)) { console.log('No Kingmaker is running.'); clearDaemonState(paths); return 0; }
  // Only signal a process that is really Kingmaker (a stale state file must never kill a reused pid).
  let command = '';
  try { command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(state.pid)], { encoding: 'utf8' }); } catch { /* gone */ }
  if (!command.includes(fileURLToPath(import.meta.url)) && !/(?:sol-ghost|kingmaker)[^/\\]*[/\\]lib[/\\]cli\.mjs/i.test(command)) { console.log(`pid ${state.pid} is not Kingmaker; clearing the stale state file.`); clearDaemonState(paths); return 0; }
  process.kill(state.pid, 'SIGTERM');
  console.log(`Asked Kingmaker (pid ${state.pid}) to stop.`);
  return 0;
}

async function cmdBackground(args) {
  const action = String(args[0] || 'status').toLowerCase();
  const result = await runBackgroundCommand(action);
  const line = describeBackground(result);
  (result.ok ? console.log : console.error)(line);
  if (result.ok && action === 'disable') await cmdStop();
  return result.ok ? 0 : 1;
}

async function cmdDoctor() {
  const paths = resolvePaths();
  const rows = [];
  const check = (ok, label, fix) => rows.push(`${ok ? '✓' : '✗'} ${label}${ok || !fix ? '' : `\n    → ${fix}`}`);
  let build = null;
  try { build = JSON.parse(readFileSync(paths.buildStamp, 'utf8')); } catch { /* missing */ }
  if (paths.runtimeSource === 'fork') {
    let from = null;
    try { from = JSON.parse(readFileSync(join(paths.fork.root, 'IMPORTED_FROM.json'), 'utf8')); } catch { /* none */ }
    check(true, `the engine's source in this checkout (import ${from?.sha?.slice(0, 9) ?? '?'}, UI stripped)`);
    check(paths.forkInstalled, 'server dependencies installed', `npm ci --prefix ${paths.fork.root}/server`);
    check(existsSync(join(paths.resources, 'voice-runtime')), `native runtimes (voice, guardrails) from ${paths.resources}`, 'Install Kingmaker.app once, or set SOL_GHOST_RESOURCES to a built Resources folder.');
  } else {
    const runtimeLabel = paths.runtimeSource === 'bundle' ? `Kingmaker's engine inside ${paths.app} (no other app needed)` : `engine runtime borrowed from ${paths.app}`;
    check(existsSync(paths.binary), `${runtimeLabel}${build ? ` (build ${build.buildId}, ${build.builtAt})` : ''}`, paths.runtimeSource === 'bundle' ? 'Rebuild Kingmaker.app (the engine build).' : 'Use the built Kingmaker.app (the engine build), or install the desktop app.');
    check(existsSync(paths.headlessEntry), 'headless launcher inside the runtime', 'Rebuild it from the engine\'s current source (desktop/headless-server.mjs).');
  }
  rows.push(`· data: ${paths.runtimeHome}${paths.sharesDesktopData ? " (SHARED with the window app: opt-in; never both at once)" : " (Kingmaker's own; the window app's data is never written)"}`);
  const ghost = findGhostBinary();
  const horusBin = findPeekabooBinary();
  const handsKind = selectHands({ env: process.env, ghostBin: ghost, peekabooBin: horusBin });
  if (handsKind === 'peekaboo') {
    // Hands of Horus is Peekaboo (github.com/openclaw/Peekaboo, MIT): its own permission report, from its Bridge.
    const [info, perms] = await Promise.all([peekabooInfo(horusBin), peekabooPermissions(horusBin)]);
    const fix = perms.accessibility === 'unavailable' ? 'brew install openclaw/tap/peekaboo' : 'System Settings ▸ Privacy & Security ▸ Accessibility and Screen Recording: allow the Bridge entry, then check: peekaboo permissions status';
    check(Boolean(horusBin) && perms.accessibility === 'granted', `hands: ${HANDS_NAMES.peekaboo}${info.version ? ` ${info.version}` : ''}${horusBin ? ` (${horusBin})` : ''}${info.toolCount ? `, ${info.toolCount} tools` : ''} — Accessibility ${perms.accessibility}, Screen Recording ${perms.screen}`, fix);
    rows.push(`· ghost-os: ${ghost ? `installed (${ghost}), standing by (SOLOMON_MAC_HANDS=ghost switches to it)` : 'not installed (not needed)'}`);
  } else {
    check(Boolean(ghost), `ghost-os${ghost ? ` (${ghost})` : ''}`, 'brew install ghostwright/ghost-os/ghost-os && ghost setup   (grants Accessibility)');
    rows.push(`· ${HANDS_NAMES.peekaboo}: ${horusBin ? `installed (${horusBin}), not selected (SOLOMON_MAC_HANDS=${process.env.SOLOMON_MAC_HANDS})` : 'not installed (brew install openclaw/tap/peekaboo); ghost-os is the hands'}`);
  }
  check(await ollamaUp(), 'Ollama answering on :11434', 'brew services start ollama');
  rows.push(`· ${modelsLine(abliteratedModelEnv(await ollamaModels()))}`);
  check(existsSync(paths.voice.whisper) && existsSync(paths.voice.sttModel), 'bundled whisper.cpp + model', 'Rebuild Kingmaker.app (voice-runtime is part of the bundle).');
  check(existsSync('/opt/homebrew/bin/sox') || existsSync('/opt/homebrew/bin/ffmpeg'), 'microphone capture tool (sox or ffmpeg)', 'brew install sox');
  const install = readInstallConfig(paths.state);
  const desktopWakeWords = install.cemented ? [] : readWakePhrases(paths.voice.wakeKeywords);
  const wake = wakeSetup({ install, env: process.env, spotter: desktopWakeWords });
  rows.push(`✓ ${wakeWordLine(install, wake).replace(/^Wake word/, 'wake word')}${desktopWakeWords.length ? ` Your desktop wake word "${desktopWakeWords[0]}" wakes it too.` : ''} (starts asleep)`);
  const voiceMode = resolveVoiceAuthority(process.env, savedVoiceAuthority(paths));
  rows.push(`· voice authority: ${VOICE_MODE_LINES[voiceMode]}`);
  const ownerVoice = await openOwnerVoice({ paths, attestationKeyHex: undefined }).catch(() => null);
  const ownerStatus = ownerVoice ? ownerVoice.ov.status() : null;
  ownerVoice?.dispose();
  if (voiceMode === 'verified') check(ownerStatus?.enrolled === true, ownerVoiceLine(ownerStatus).replace(/^Owner voice: /, 'owner voice: '), ownerStatus?.sealing === 'unavailable' ? 'Unlock your login Keychain, then: kingmaker enroll' : 'kingmaker enroll   (typed at a terminal, with Kingmaker quit)');
  else rows.push(`· voiceprint: ${ownerStatus?.enrolled ? `enrolled (${ownerStatus.sampleCount} samples), used only by: kingmaker voice verified` : 'not enrolled (only the verified mode uses one)'}`);
  const chrome = await syncChromeConnector(paths).catch((e) => ({ status: { state: 'error' }, line: `Chrome connector: ${e.message}` }));
  check(!['not-set-up', 'missing', 'error'].includes(chrome.status?.state), chrome.line.replace(/^Chrome connector: /, 'Chrome connector: '), 'kingmaker chrome   (then Load unpacked once in chrome://extensions)');
  // The ArtCraft apps, as the engine will look for them from the environment Kingmaker starts it with.
  // Kingmaker's own files, all of them, against the list the release carries (lib/payload.mjs).
  { const r = checkPayload(fileURLToPath(new URL('..', import.meta.url)), { deep: true });
    check(r.ok, r.listed ? `Kingmaker's files: all ${r.checked} as released` : `Kingmaker's files: a checkout (its ${r.checked} essential files are here)`, payloadProblem(r) ?? ''); }
  rows.push(...craftDoctorLines(await craftDoctor(paths)));
  { const installed = listAddons({ root: addonsDir(paths) }).map((a) => `${a.id} ${a.version}`); rows.push(`· add-ons: ${installed.length ? installed.join(', ') : 'none installed (the free edition)'}${ronin ? '; Ronin office loaded' : ''}`); }
  rows.push(...deviceDoctorLines(readDeviceMap(deviceMapPath(paths), undefined, ronin?.activeCrmLock(paths) ?? null)));
  const blockers = await startBlockers(paths, DEFAULT_PORT);
  const running = readDaemonState(paths);
  check(blockers.length === 0 || (running && pidAlive(running.pid)), running && pidAlive(running.pid) ? `Kingmaker running (pid ${running.pid})` : 'free to start', blockers.join('\n    → '));
  try {
    const swap = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim();
    const free = execFileSync('/usr/bin/memory_pressure', [], { encoding: 'utf8' }).trim().split('\n').at(-1);
    rows.push(`· memory: ${free.replace('System-wide memory free percentage:', 'free')} · swap ${swap.replace(/\s+\(encrypted\)/, '')}`);
  } catch { /* informational */ }
  console.log(rows.join('\n'));
  return 0;
}

/** The CLI (lib/kingmaker.mjs, the entry, checks the payload first and then calls this). */
export async function main(argv) {
  const [cmd, ...args] = argv;
  // Add-ons first, from the Mac's own state, so an add-on's profile (its own state, runtime and port) is in place before
  // any command resolves its paths. Not for `addons` itself (installing never runs add-on code first) or `version`.
  if (!['addons', 'version', '--version'].includes(cmd)) {
    const base = resolvePaths();
    addonRoot = join(base.state, 'addons');
    await ensureAddons(base, { live: true });
  }
  // The Ronin office's own profile, when the add-on set one; never over an explicit isolated run (a runtime home with no
  // state of its own), which must keep its own data, logs and daemon record.
  if (!isolatedRun(process.env)) ronin?.applyActiveAppProfile(process.env);
  if (ronin) extendVocabulary(ronin.VOCABULARY);   // its people and products, so whisper hears them right
  switch (cmd) {
    case 'start': return cmdStart(args);
    case 'enroll': return cmdEnroll(args);
    case 'voice': return cmdVoice(args);
    case 'say': return cmdSay(args);
    case 'update': return cmdUpdate(args);
    case 'phone': return cmdPhone(args);
    case 'call': return cmdCall(args);
    case 'version': console.log(runningVersion()); return 0;
    // Speak a line in the reply voice (Kokoro, else `say`), no turn: hear the voice after an install or update.
    case 'speak': { await speak(args.filter((x) => !x.startsWith('--')).join(' ') || 'Kingmaker is speaking with its own voice.').done; return 0; }
    // "Hey Siri, wake Kingmaker": build + sign the Shortcut and open it so Shortcuts asks to add it.
    case 'siri': return import('./siri.mjs').then(async ({ installSiriShortcut, SIRI_SHORTCUT_NAME }) => {
      try {
        await installSiriShortcut();
        console.log(`Shortcuts is asking to add "${SIRI_SHORTCUT_NAME}". Click Add Shortcut, then say "Hey Siri, ${SIRI_SHORTCUT_NAME}". (Siri must be on: System Settings → Apple Intelligence & Siri.)`);
        return 0;
      } catch (error) { console.error(`✗ ${error.message}`); return 1; }
    });
    // The same link Siri's "Wake Ghost" shortcut opens: launches Kingmaker.app if needed, else wakes it.
    // A Mac still on the old Sol Ghost.app registers only solghost://, so that is tried when kingmaker:// has no app.
    // The first-run tour again (lib/first-run.mjs): shown in the bar now, or at the next start.
    case 'tour': { console.log(await tourCommand(resolvePaths().state)); return 0; }
    case 'wake': return new Promise((resolve) => execFile('/usr/bin/open', [WAKE_LINK], (error) => {
      if (!error) return resolve(0);
      execFile('/usr/bin/open', [LEGACY_WAKE_LINK], (legacyError) => { if (legacyError) console.error(`✗ ${error.message}`); resolve(legacyError ? 1 : 0); });
    }));
    case 'background': return cmdBackground(args);
    case 'meeting': return import('./meeting.mjs').then(({ setMeetingHold, clearMeetingHold, meetingHold }) => {
      // The owner's call comes first: pause paced background work (never kill it) until `off` or the hold expires.
      const paths = resolvePaths(process.env);
      const [verb = 'status', minutes] = args;
      if (verb === 'on') {
        let h;
        try { h = setMeetingHold(paths, { minutes: minutes ?? undefined }); } catch (error) { console.log(`✗ ${error.message}`); return 2; }
        console.log(`Meeting hold on until ${h.until}: background work is paused, nothing is killed.`); return 0;
      }
      if (verb === 'off') { clearMeetingHold(paths); console.log('Meeting hold off: background work resumes gently.'); return 0; }
      console.log(JSON.stringify(meetingHold(paths), null, 2)); return 0;
    });
    case 'office': case 'crm-lock': case 'pair': case 'owner-call': case 'text-watch':
      await ensureAddons(resolvePaths());
      if (!ronin) { console.error(roninOnly(`kingmaker ${cmd}`)); return 2; }
      return ronin.roninCommand(cmd, args, { resolvePaths, readDaemonState, pidAlive, readAnswer, readHidden, runningVersion, DEFAULT_PORT });
    case 'key': case 'keys': return cmdKey(args);
    case 'iphone': await ensureAddons(resolvePaths()); return import('./iphone-cli.mjs').then(({ cmdIphone }) => cmdIphone(args, { paths: resolvePaths() }));
    case 'mcp': {
      const paths = resolvePaths();
      await serveStdio({ port: resolvePort(args, paths), version: VERSION, inbox: craftInboxDir(paths), mapFile: deviceMapPath(paths), iphone: createBridge({ stateDir: iphoneDir(paths) }) });
      return 0;
    }
    case 'models': return cmdModels(args);
    case 'brain': {
      const paths = resolvePaths();
      const want = String(args[0] ?? '').toLowerCase();
      if (BRAINS.includes(want)) {
        saveBrainChoice(paths, want);
        const setup = want === 'grok' ? ' First install the official Grok Build CLI and run grok login once.' : '';
        console.log(`Brain: ${want}.${setup} Restart Kingmaker (kingmaker stop, then start) to use it.`);
        return 0;
      }
      console.log(`Brain: ${resolveBrain(process.env, readBrainChoice(paths))}. Set it with: kingmaker brain claude | chatgpt | grok | local (local = the local model, see kingmaker models)`);
      return 0;
    }
    case 'status': return cmdStatus(args);
    case 'stop': return cmdStop();
    case 'doctor': await ensureAddons(resolvePaths()); return cmdDoctor();
    case 'craft': return cmdCraft(args);
    case 'markets': return import('./trading-agents-cli.mjs').then(({ cmdMarkets }) => cmdMarkets(args, { paths: resolvePaths(), runtimes: runtimesFor({ appRoot: join(resolvePaths().resources, '..', '..') }) }));
    // THE RONIN INSTALLER (lib/ronin-installer.mjs): a linked repo's latest release, never source, SHA-256-checked,
    // quarantined so Gatekeeper still checks it, read by REA, then into /Applications (a .pkg opens for the owner).
    case 'installer': {
      const [verb, target] = args;
      if (verb !== 'install' || !target || !parseRepo(target)) { console.error('usage: kingmaker installer install <owner/repo | https://github.com/owner/repo>'); return 2; }
      console.log(`Installing ${target}…`);
      const r = await installRepo(target, { log: () => {} });
      console.log(r.line);
      return r.ok ? 0 : 1;
    }
    case 'scan': return cmdScan(args);
    case 'tools': { const p = resolvePaths(); await ensureAddons(p); for (const line of summaryLines(readDeviceMap(deviceMapPath(p), undefined, ronin?.activeCrmLock(p) ?? null))) console.log(line); console.log('Install one at the Kingmaker console ("install <name>", read back first), never from here.'); return 0; }
    case 'chrome': {
      const r = await syncChromeConnector(resolvePaths(), { setup: true });
      if (r.created) console.log(`Set up. Now in Chrome: chrome://extensions → Developer mode → Load unpacked → ${r.created.folder}\n(extension id ${r.created.extensionId}; it talks to the engine on 127.0.0.1:3001, so keep Kingmaker on that port)`);
      console.log(r.line);
      return 0;
    }
    case 'settings': {
      // Kingmaker's settings are its own screen in the menu bar (connectors, keys, and what it may reach on this Mac). The
      // engine serves no web pages, and the CLI never drives the bar (no kingmaker:// link from here), so it says where.
      console.log("Kingmaker's settings are in the menu bar: click the logo, then the gear (or type /connectors in the bar).");
      return 0;
    }
    case '--version': case 'version': console.log(VERSION); return 0;
    case 'addons': {
      // install | list | remove, for the launcher and the owner. The entitlement for a paid install comes on STDIN.
      const paths = resolvePaths();
      const deps = addonDeps(paths);
      if (args[0] === 'install') {
        const piped = await readStdinText();
        if (piped) { try { deps.entitlement = JSON.parse(piped); } catch { console.error('addons install: the entitlement on stdin is not valid JSON.'); return 1; } }
      }
      const r = await dispatchAddons(args, deps);
      if (r.output) console.log(r.output);
      return r.ok ? 0 : (r.handled ? 1 : 2); // exit code the launcher reads: 0 installed, non-zero shown to the owner
    }
    default:
      // Add-on commands (e.g. meeting-notes' `floor`) are NOT dispatched from this one-shot CLI: a command like the
      // floor participant holds live sockets and must run in the resident daemon, which stays alive — running it here
      // would start it and then exit, tearing it down. loadAddons registers such commands into `addonCommands` at
      // daemon start (cmdStart); routing them to a persistent context is the daemon's command surface (follow-up).
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, USAGE_LINES).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      return cmd ? 2 : 0;
  }
}

function invokedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { if (typeof code === 'number') process.exit(code); }, (error) => { console.error(error); process.exit(1); });
}
