// light-runtime/server.mjs — the light runtime's server: no dependencies, bound to 127.0.0.1
// only (this is the owner's own machine surface; there is no auth because there is no network).
//
//   GET  /               the window (light-runtime/index.html)
//   GET  /state          the canonical state (light-runtime/state-schema.mjs), assembled live from the tree's own
//                        sources: lib/mac-profiles.mjs (this Mac's profile), lib/reflex-seat.mjs (the seat plan),
//                        the token meter's own log (<state>/metrics/model-calls-YYYY-MM.jsonl, lib/token-meter.mjs's
//                        file) when a Kingmaker state dir is given, and the light state dir's proof-report.json +
//                        verdicts.json + control.json.
//   GET  /control        the owner's three switches as they stand.
//   POST /control        a patch of those switches — it writes intent flags (proofRun for
//                        scripts/run-10m-proof.mjs, the two reflex switches); it approves nothing,
//                        sends nothing, and starts nothing itself.
//   POST /ask            THE ASK PATH (v2): one question for Kingmaker, routed by the same lane
//                        router the bar uses (light-runtime/ask.mjs) onto a seat — a registered
//                        in-tab browser engine for a write-lane ask, else the native engine
//                        through its job inbox (the fallback seat). Propose-only, inherited
//                        from the job inbox: decisions and bar/console commands are refused.
//   GET  /ask/<id>       the ask's state, its answer when it lands, and its diagnostics.
//   GET  /asks           this server's recent asks, newest first.
//   GET  /failures       THE TURN REGISTRY (light-runtime/failures.mjs): every failed or held
//                        turn the engine's own transcript records — bar, app window, console,
//                        phone — as a FAILED/HELD card carrying the question, the engine's
//                        reason verbatim, and the timing. Turns this wall already carries as
//                        its own ask cards are excluded here (the ask card is their card).
//   POST /seat/register  a browser seat (light-runtime/seat/seat.mjs, loaded in the tab)
//   POST /seat/poll      registers once its model is loaded in-tab; poll is its heartbeat and
//   POST /seat/result    its work queue; result carries its answer + labelled self-report.
//   GET  /seat/status    the seats this router knows, and their states.
//   GET  /engine/manifest  the engine artifact's manifest: sha256 pins for every byte the seat
//                        runs, the weights pin, the sealing signer's fingerprints.
//   GET  /engine/artifact  the Scripture Armor package itself (the hosted leg: sealed bytes).
//   GET  /engine/session/<file>  one file of the OPENED bundle (the seat's code), served only
//                        after this layer verified + opened the package in memory — the page's
//                        session handoff. The page never receives key material of any kind.
//                        A build refusal on any artifact leg answers 500 with the coded body
//                        { error, errors } (artifactRefusal below), so the page can print the
//                        diagnosis on its status lines instead of a bare fetch failure.
//   GET  /engine/file/<path>     one manifest-pinned byte stream (wllama runtime, weights)
//                        from the device-held store; the seat verifies its pin in-page.
//   GET  /voice/manifest the voice artifact's manifest (light-runtime/voice-artifact.mjs):
//                        sha256 pins for every byte the voice runs + the per-model offers
//                        (the ear / the mouth, each present, incomplete or absent — the
//                        manifest says which, truthfully).
//   GET  /voice/artifact the sealed voice package itself (the hosted leg).
//   GET  /voice/session/<path>   one file of the OPENED voice bundle (voice.mjs, model meta)
//                        or a manifest-pinned weight, served only after this layer verified
//                        + opened the package in memory — the voice module's session handoff.
//                        Refusals carry the same coded body as the engine legs.
//   GET  /voice/file/<path>  one manifest-pinned byte stream (vendored runtimes, weights);
//                        the voice module verifies its pin in-page before running it.
//   POST /voice/failure  the voice module's report of a failure that happened BEFORE any
//                        transcript existed (no mic, ear will not load, empty transcript):
//                        recorded through the ask router as a FAILED ask with its true
//                        reason, so it lands on the wall as a card, never as silence.
//   GET  /api/conversations[/<id>/turns]  THE DAEMON FEEDS (light-runtime/feeds.mjs): the
//                        governed-turn daemon's own persistence, read-only — its SQLite
//                        store (hash-chained ledger + conversation_turns) at $SOLOMON_DATA_DIR
//                        else <runtime home>/data, its background-task registry, and this
//                        runtime's own per-turn timing records. /api/activity merges those
//                        sources into what the machine did; /api/router carries per-turn
//                        routes + the ledger's tool activations; /api/gates the guardrail
//                        decisions the ledger carries, beside the proposals + switches the
//                        wall already reads; /api/audit the ledger itself (the chain the
//                        Audit Chain pane renders — payloads summarized, never dumped);
//                        /api/library Scripture Armor as an active item (bundle state,
//                        signer fingerprints, the sealed-bundle inventories) + the catalog
//                        indexes read as data; /api/health the daemon's state, the token
//                        meter, the voice-turn tally where its env names one; /api/models
//                        the seat plan + browser-seat status + the artifact manifests'
//                        model offers. Every feed answers its honest absent state (real
//                        zeros, labeled) when its source does not exist on this machine —
//                        never a fabricated row.
//
// It lives here, inside light-runtime/, so the payload carries it (lib/payload.mjs PAYLOAD_PARTS):
// scripts/light-runtime-server.mjs remains as the documented door and re-exports this module.
// Run: node light-runtime/server.mjs   (LIGHT_RUNTIME_PORT, KINGMAKER_LIGHT_DIR, KINGMAKER_STATE_DIR)
// or:  kingmaker light
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentProfile } from '../lib/mac-profiles.mjs';
import { reflexSeatPlan, reflexPinEnabled } from '../lib/reflex-seat.mjs';
import { reflexEnabled } from '../lib/reflex-layer.mjs';
import { meterSnapshot } from '../lib/token-meter.mjs';
import {
  assembleState, readControl, writeControl, CONTROL_FILE, PROOF_REPORT_FILE, VERDICTS_FILE,
} from './state-schema.mjs';
import { createAskRouter } from './ask.mjs';
import { createArtifactService } from './artifact.mjs';
import { createVoiceArtifactService } from './voice-artifact.mjs';
import { createProposalsClient } from './proposals.mjs';
import { createFailureRegistry } from './failures.mjs';
import { createDaemonFeeds, FEEDS_SCHEMA } from './feeds.mjs';
import { armorBundleState } from '../lib/armor-bundle.mjs';

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** The meter's totals from its own monthly log: every recorded call's prompt + generated tokens. Rates are
 *  NOT derived from the log — a rate needs the meter's live window; totals are what the file honestly holds. */
export function meterTotalsFromLog(stateDir, d = new Date()) {
  if (!stateDir) return null;
  const f = join(stateDir, 'metrics', `model-calls-${d.toISOString().slice(0, 7)}.jsonl`);
  if (!existsSync(f)) return null;
  let generated = 0, prompt = 0, seen = false;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.generated === 'number') { generated += r.generated; seen = true; }
      if (typeof r.prompt === 'number') { prompt += r.prompt; seen = true; }
    } catch { /* a torn last line is not data */ }
  }
  return seen ? { decodeTokS: null, prefillTokS: null, generated, prompt, since: null } : null;
}

/** Assemble the live state from this machine's real sources. Every input is allowed to be absent; the
 *  schema renders an absent source as nulls and UNMEASURED, never as invented numbers. */
export function assembleLiveState({ stateDir, profileDir = null, env = process.env, now = new Date() } = {}) {
  let profile = null, seatPlan = null;
  try { profile = currentProfile(profileDir); } catch { profile = null; }
  if (profile) { try { seatPlan = reflexSeatPlan({ profile, env }); } catch { seatPlan = null; } }
  const control = readControl(stateDir);
  return assembleState({
    meter: meterTotalsFromLog(profileDir, now) ?? meterSnapshot(),
    profile, seatPlan,
    report: readJson(join(stateDir, PROOF_REPORT_FILE)),
    verdicts: readJson(join(stateDir, VERDICTS_FILE)),
    control,
    reflexOn: control.reflex && reflexEnabled({ env }),
    pinOn: control.reflexPin && reflexPinEnabled({ env }),
    now,
  });
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(`${JSON.stringify(body)}\n`); };
// The browser-engine serving requirements (spec: kingmaker-browser-runtime-spec.md): cross-origin
// isolation for multithreaded Wasm / SharedArrayBuffer, same-origin only — this surface has no
// cross-origin story at all.
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
const bytes = (res, code, buf, type, extra = {}) => { res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', ...extra }); res.end(buf); };
const MIME = (p) => (p.endsWith('.mjs') || p.endsWith('.js') ? 'text/javascript; charset=utf-8' : p.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
// The voice session leg also serves the models' meta files, which the in-tab loaders parse
// as JSON / text — name those types honestly; everything else stays octet-stream.
const VMIME = (p) => (p.endsWith('.json') ? 'application/json; charset=utf-8' : p.endsWith('.txt') ? 'text/plain; charset=utf-8' : MIME(p));
const readBody = (req, limit = 65536) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('TOO_LARGE')); req.destroy(); } });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('BAD_JSON')); } });
  req.on('error', reject);
});

/** An artifact layer refusal, in the one shape every artifact leg answers with:
 *  { error: <code>, errors: [<verbatim message>] }. The code is the error's own when it
 *  carries one (ARTIFACT_* from the artifact services, the armor bundle loader's coded
 *  refusals). Armor's own gate errors are uncoded prose, so the PQ gate — the refusal that
 *  names Node >= 24 / ML-KEM / ML-DSA in its own words — is coded from those words
 *  (ARMOR_PQ_UNAVAILABLE), never invented for any other failure; ARTIFACT_FAILED is the
 *  honest remainder. The message always rides along verbatim: it is the diagnosis the
 *  wall's seat/voice status lines print (a dynamic import that fails in the page reports
 *  only that the fetch failed — the status and this body are the whole explanation). */
export function artifactRefusal(e) {
  const message = String(e?.message ?? e);
  let code = typeof e?.code === 'string' && e.code ? e.code : null;
  if (!code && /ML-KEM|ML-DSA|Node >= 24/.test(message)) code = 'ARMOR_PQ_UNAVAILABLE';
  return { code: code || 'ARTIFACT_FAILED', message };
}
const artifactJson = (res, status, e) => { const r = artifactRefusal(e); return json(res, status, { ok: false, error: r.code, errors: [r.message] }); };

/**
 * The server. `assetsDir` holds index.html + seat/ (this folder); `stateDir` holds control.json,
 * proof-report.json and verdicts.json (default: the same folder; KINGMAKER_LIGHT_DIR separates them).
 * `profileDir` is the Kingmaker engine's state dir (meter log, profiles); `engineStateDir` is where
 * the job inbox lives (default: profileDir). `stateProvider` replaces live assembly (tests);
 * `askRouter` / `artifactService` replace the ask path / engine artifact layer (tests).
 */
export function createLightRuntimeServer({ assetsDir, stateDir = assetsDir, profileDir = null, engineStateDir = null, stateProvider = null, askRouter = null, artifactService = null, voiceService = null, proposalsClient = null, failuresRegistry = null, feedsService = null, env = process.env } = {}) {
  const pagePath = join(assetsDir, 'index.html');
  const engState = engineStateDir ?? profileDir;
  let router = askRouter;
  const getRouter = () => (router ??= createAskRouter({ engineStateDir: engState }));
  let failures = failuresRegistry;
  const getFailures = () => (failures ??= createFailureRegistry({ engineStateDir: engState }));
  let proposals = proposalsClient;
  const getProposals = () => (proposals ??= createProposalsClient({ engineStateDir: engState, env }));
  let artifacts = artifactService;
  const getArtifacts = () => (artifacts ??= createArtifactService({
    seatDir: join(assetsDir, 'seat'),
    artifactsDir: env.KINGMAKER_LIGHT_ARTIFACTS || join(stateDir, 'engine-artifacts'),
    identityDir: join(stateDir, 'armor-identity'),
  }));
  let voice = voiceService;
  const getVoice = () => (voice ??= createVoiceArtifactService({
    voiceDir: join(assetsDir, 'voice'),
    storeDir: env.KINGMAKER_LIGHT_VOICE_MODELS || join(stateDir, 'voice-models'),
    identityDir: join(stateDir, 'armor-identity'),
  }));
  let feeds = feedsService;
  const getFeeds = () => (feeds ??= createDaemonFeeds({ engineStateDir: engState, env }));
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        if (!existsSync(pagePath)) return json(res, 500, { ok: false, errors: ['light-runtime/index.html is missing'] });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...ISOLATION });
        return res.end(readFileSync(pagePath));
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        try { return json(res, 200, stateProvider ? stateProvider() : assembleLiveState({ stateDir, profileDir })); }
        catch (e) { return json(res, 500, { ok: false, errors: [String(e?.message ?? e)] }); }
      }
      if (req.method === 'GET' && url.pathname === '/control') return json(res, 200, { ok: true, control: readControl(stateDir) });
      if (req.method === 'POST' && url.pathname === '/control') {
        let patch;
        try { patch = await readBody(req, 16384); } catch { return json(res, 400, { ok: false, errors: ['body must be JSON'] }); }
        const clean = {};
        for (const k of ['proofRun', 'reflex', 'reflexPin']) if (k in patch) clean[k] = patch[k];
        try { return json(res, 200, { ok: true, control: writeControl(stateDir, clean) }); }
        catch (e) { return json(res, 400, { ok: false, errors: [String(e?.message ?? e)] }); }
      }
      // ── The ask path ──────────────────────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/ask') {
        let body;
        try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
        try {
          const v = await getRouter().submitAsk(typeof body.text === 'string' ? body.text : '', { conversation: body.conversation ?? null, surface: body.surface === 'voice' ? 'voice' : 'window' });
          return json(res, 202, v);
        } catch (e) {
          const code = e?.code || 'ASK_FAILED';
          const status = code === 'DECISION_NOT_ALLOWED' || code === 'COMMAND_NOT_ALLOWED' ? 403 : 400;
          return json(res, status, { ok: false, error: code });
        }
      }
      if (req.method === 'GET' && url.pathname === '/asks') return json(res, 200, { ok: true, asks: await getRouter().listAsks() });
      if (req.method === 'GET' && url.pathname === '/failures') {
        // The wall's own failed/held asks are already cards on this page; the registry skips
        // their transcript turns so no failure is ever shown twice.
        const views = await getRouter().listAsks();
        const exclude = views
          .filter((v) => v.state === 'failed' || v.state === 'held')
          .map((v) => ({ text: v.text, submittedAtMs: Date.parse(v.submittedAt), endedAtMs: v.endedAt ? Date.parse(v.endedAt) : null }));
        // The answered reconciliation (failures.mjs): an ask the engine's turn feed settled
        // as answered — its card reads done, so it is NOT in the exclude list above — must
        // also suppress its transcript turn, whose bar line is the client-side timeout the
        // bar session spoke while the turn was still running. Only feed-settled asks count
        // (diagnostics.settledBy is set exactly when the feed's outcome settled the card).
        const answered = views
          .filter((v) => v.state === 'done' && v.diagnostics?.settledBy)
          .map((v) => ({ text: v.text, submittedAtMs: Date.parse(v.submittedAt), endedAtMs: v.endedAt ? Date.parse(v.endedAt) : null }));
        // The completion reconciliation (failures.mjs, 2026-10-28 second registry defect):
        // EVERY ask that settled done is a completion record for its transcript turn —
        // feed-settled or plain inbox-settled alike. Before this, an ask that answered
        // normally through the job inbox left its transcript turn exposed: if the bar
        // session had spoken a timeout line for it and no later answer line landed in the
        // retained transcript tail, the wall showed an Answered ask card AND a FAILED
        // registry card for the same turn.
        const completed = views
          .filter((v) => v.state === 'done')
          .map((v) => ({ text: v.text, submittedAtMs: Date.parse(v.submittedAt), endedAtMs: v.endedAt ? Date.parse(v.endedAt) : null }));
        return json(res, 200, { ok: true, failures: getFailures().listFailures({ exclude, answered, completed }) });
      }
      const askOne = /^\/ask\/([A-Za-z0-9_-]{1,60})$/.exec(url.pathname);
      if (req.method === 'GET' && askOne) {
        const v = await getRouter().getAsk(askOne[1]);
        return v ? json(res, 200, v) : json(res, 404, { ok: false, error: 'NO_SUCH_ASK' });
      }
      // ── Browser seats ───────────────────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/seat/register') {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { ok: false, error: 'BAD_JSON' });
        const r = getRouter().registerSeat({ label: body.label, capabilities: body.capabilities ?? {} });
        return json(res, 200, { ok: true, ...r });
      }
      if (req.method === 'POST' && url.pathname === '/seat/poll') {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { ok: false, error: 'BAD_JSON' });
        const r = getRouter().seatPoll(body.seatId, body.token);
        return json(res, r.ok ? 200 : 401, r);
      }
      if (req.method === 'POST' && url.pathname === '/seat/result') {
        const body = await readBody(req, 262144).catch(() => null);
        if (!body) return json(res, 400, { ok: false, error: 'BAD_JSON' });
        const r = getRouter().seatResult(body.seatId, body.token, body.askId, { answer: body.answer, diagnostics: body.diagnostics, error: body.error });
        return json(res, r.ok ? 200 : 401, r);
      }
      if (req.method === 'GET' && url.pathname === '/seat/status') return json(res, 200, { ok: true, seats: getRouter().seatStatus() });
      // ── The approval loop (proposals.mjs): the owner's word, inside the window ──
      if (req.method === 'GET' && url.pathname === '/proposals') return json(res, 200, await getProposals().list());
      const proposalDecision = /^\/proposals\/([A-Za-z0-9_-]{1,80})\/(approve|cancel)$/.exec(url.pathname);
      if (req.method === 'POST' && proposalDecision) {
        const body = await readBody(req).catch(() => ({}));
        const r = proposalDecision[2] === 'approve'
          ? await getProposals().approve(proposalDecision[1], { typedChallenge: typeof body?.typedChallenge === 'string' ? body.typedChallenge : undefined })
          : await getProposals().cancel(proposalDecision[1]);
        return json(res, r.ok ? 200 : 400, r);
      }
      // ── The daemon feeds (feeds.mjs): the panes' real records ─────────────
      if (req.method === 'GET' && url.pathname === '/api/conversations') {
        return json(res, 200, getFeeds().conversations({ limit: url.searchParams.get('limit') }));
      }
      const convTurns = /^\/api\/conversations\/([A-Za-z0-9._-]{1,120})\/turns$/.exec(url.pathname);
      if (req.method === 'GET' && convTurns) {
        return json(res, 200, getFeeds().conversationTurns(decodeURIComponent(convTurns[1]), { limit: url.searchParams.get('limit') }));
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        return json(res, 200, getFeeds().activity({ limit: url.searchParams.get('limit') }));
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        return json(res, 200, getFeeds().audit({ limit: url.searchParams.get('limit') }));
      }
      if (req.method === 'GET' && url.pathname === '/api/router') {
        const records = getFeeds().routerRecords();
        const views = await getRouter().listAsks();
        return json(res, 200, {
          ok: true, schema: FEEDS_SCHEMA,
          asks: views.map((v) => ({
            id: v.id, state: v.state, seat: v.seat, submittedAt: v.submittedAt, endedAt: v.endedAt,
            diagnostics: {
              lane: v.diagnostics?.lane ?? null, by: v.diagnostics?.by ?? null, model: v.diagnostics?.model ?? null,
              routeMs: v.diagnostics?.routeMs ?? null, queueMs: v.diagnostics?.queueMs ?? null, turnMs: v.diagnostics?.turnMs ?? null,
            },
          })),
          asksSource: "this server's ask router — the live session's own records",
          timing: records.timing, timingSource: records.timingSource,
          actions: records.actions, actionsPresent: records.actionsPresent,
          actionsSource: `the daemon's ledger ACTION records (tool activations) — ${getFeeds().dbPath}`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/gates') {
        const guardrail = getFeeds().guardrailDecisions({});
        return json(res, 200, {
          ok: true, schema: FEEDS_SCHEMA,
          proposals: await getProposals().list(),
          guardrail: {
            present: guardrail.present, decisions: guardrail.decisions,
            source: `guardrail decisions carried on the daemon's ledger response payloads — ${getFeeds().dbPath}`,
          },
          switches: readControl(stateDir), switchesSource: `the light state's own ${CONTROL_FILE}`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const h = getFeeds().health();
        return json(res, 200, {
          ok: true, schema: FEEDS_SCHEMA,
          daemon: h.daemon, store: h.store, tasks: h.tasks, voiceTurns: h.voiceTurns,
          meter: meterTotalsFromLog(profileDir) ?? meterSnapshot(),
          meterSource: "the token meter's own log / live snapshot (lib/token-meter.mjs)",
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        let profile = null, seatPlan = null;
        try { profile = currentProfile(profileDir); } catch { profile = null; }
        if (profile) { try { seatPlan = reflexSeatPlan({ profile, env }); } catch { seatPlan = null; } }
        let engine = null, engineError = null;
        try { const m = getArtifacts().manifest(); engine = { model: m.model ?? null, weights: m.weights ?? null, signer: m.signer ?? null, artifactSha256: m.artifactSha256 ?? null }; }
        catch (e) { engineError = artifactRefusal(e); }
        let voiceModels = null, voiceError = null;
        try { const m = getVoice().manifest(); voiceModels = { models: m.models ?? null, signer: m.signer ?? null, artifactSha256: m.artifactSha256 ?? null }; }
        catch (e) { voiceError = artifactRefusal(e); }
        return json(res, 200, {
          ok: true, schema: FEEDS_SCHEMA,
          profile: profile ? { label: profile.label ?? profile.id ?? null, class: profile.class ?? null } : null,
          seatPlan, seats: getRouter().seatStatus(),
          engine, engineError, voice: voiceModels, voiceError,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/library') {
        let engine = null, engineError = null;
        try {
          const m = getArtifacts().manifest();
          engine = {
            signer: m.signer ?? null, model: m.model ?? null, weights: m.weights ?? null,
            bundle: Array.isArray(m.bundle) ? m.bundle : [], pinned: Array.isArray(m.pinned) ? m.pinned : [],
            artifactSha256: m.artifactSha256 ?? null,
          };
        } catch (e) { engineError = artifactRefusal(e); }
        let voiceLib = null, voiceError = null;
        try {
          const m = getVoice().manifest();
          voiceLib = {
            signer: m.signer ?? null, models: m.models ?? null,
            bundle: Array.isArray(m.bundle) ? m.bundle : [], pinned: Array.isArray(m.pinned) ? m.pinned : [],
            artifactSha256: m.artifactSha256 ?? null,
          };
        } catch (e) { voiceError = artifactRefusal(e); }
        return json(res, 200, {
          ok: true, schema: FEEDS_SCHEMA,
          // Scripture Armor as an active item: the bundle loader's own state in this
          // process, and the sealed artifacts' manifests — fingerprints and pins are the
          // device layer's published record of the armor that sealed them.
          armorBundle: armorBundleState(),
          engine, engineError, voice: voiceLib, voiceError,
          catalog: getFeeds().catalog(join(assetsDir, '..', 'catalog')),
        });
      }
      // ── The engine artifact (hosted / device-custody legs) ─────────────────
      if (req.method === 'GET' && url.pathname === '/engine/manifest') {
        try { return json(res, 200, getArtifacts().manifest()); }
        catch (e) { return artifactJson(res, 500, e); }
      }
      if (req.method === 'GET' && url.pathname === '/engine/artifact') {
        try { const c = getArtifacts(); return bytes(res, 200, Buffer.from(c.sealedText(), 'utf8'), 'text/plain; charset=utf-8', { 'x-artifact-sha256': c.manifest().artifactSha256, ...ISOLATION }); }
        catch (e) { return artifactJson(res, 500, e); }
      }
      const sessionFile = /^\/engine\/session\/([A-Za-z0-9._-]{1,80})$/.exec(url.pathname);
      if (req.method === 'GET' && sessionFile) {
        try {
          const buf = getArtifacts().sessionFile(sessionFile[1]);
          return buf ? bytes(res, 200, buf, MIME(sessionFile[1]), ISOLATION) : json(res, 404, { ok: false, error: 'NOT_IN_BUNDLE' });
        } catch (e) { return artifactJson(res, 500, e); }
      }
      const pinnedFile = /^\/engine\/file\/(.{1,200})$/.exec(url.pathname);
      if (req.method === 'GET' && pinnedFile) {
        const path = decodeURIComponent(pinnedFile[1]);
        if (path.includes('..')) return json(res, 400, { ok: false, error: 'BAD_PATH' });
        try {
          const buf = getArtifacts().pinnedFile(path);
          return buf ? bytes(res, 200, buf, MIME(path), ISOLATION) : json(res, 404, { ok: false, error: 'NOT_PINNED' });
        } catch (e) { return artifactJson(res, 500, e); }
      }
      // ── The voice artifact (the ear + the mouth, sealed like the engine) ────
      if (req.method === 'GET' && url.pathname === '/voice/manifest') {
        try { return json(res, 200, getVoice().manifest()); }
        catch (e) { return artifactJson(res, 500, e); }
      }
      if (req.method === 'GET' && url.pathname === '/voice/artifact') {
        try { const c = getVoice(); return bytes(res, 200, Buffer.from(c.sealedText(), 'utf8'), 'text/plain; charset=utf-8', { 'x-artifact-sha256': c.manifest().artifactSha256, ...ISOLATION }); }
        catch (e) { return artifactJson(res, 500, e); }
      }
      const voiceSession = /^\/voice\/session\/(.{1,400})$/.exec(url.pathname);
      if (req.method === 'GET' && voiceSession) {
        const path = decodeURIComponent(voiceSession[1]);
        if (path.includes('..')) return json(res, 400, { ok: false, error: 'BAD_PATH' });
        try {
          const buf = getVoice().sessionFile(path);
          return buf ? bytes(res, 200, buf, VMIME(path), ISOLATION) : json(res, 404, { ok: false, error: 'NOT_IN_BUNDLE' });
        } catch (e) { return artifactJson(res, 500, e); }
      }
      const voiceFile = /^\/voice\/file\/(.{1,400})$/.exec(url.pathname);
      if (req.method === 'GET' && voiceFile) {
        const path = decodeURIComponent(voiceFile[1]);
        if (path.includes('..')) return json(res, 400, { ok: false, error: 'BAD_PATH' });
        try {
          const buf = getVoice().pinnedFile(path);
          return buf ? bytes(res, 200, buf, MIME(path), ISOLATION) : json(res, 404, { ok: false, error: 'NOT_PINNED' });
        } catch (e) { return artifactJson(res, 500, e); }
      }
      if (req.method === 'POST' && url.pathname === '/voice/failure') {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { ok: false, error: 'BAD_JSON' });
        const v = getRouter().recordSurfaceFailure({
          surface: 'voice',
          stage: typeof body.stage === 'string' ? body.stage : null,
          error: typeof body.error === 'string' ? body.error : null,
        });
        return json(res, 202, v);
      }
      return json(res, 404, { ok: false, errors: ['not found'] });
    } catch (e) {
      return json(res, 500, { ok: false, errors: [String(e?.message ?? e)] });
    }
  });
}

/** Bind the server to loopback only. The one address this surface is ever served on. */
export function listenLightRuntime(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address()));
  });
}

/** The engine's state dir the ask path reads (the job inbox + meter log): KINGMAKER_STATE_DIR,
 *  else SOL_GHOST_HOME, else the app's data folder — lib/paths.mjs resolvePaths' own formula. */
export function defaultEngineStateDir(env = process.env, home = homedir()) {
  return String(env.KINGMAKER_STATE_DIR || env.SOL_GHOST_HOME || join(home, 'Library', 'Application Support', 'sol-ghost'));
}

/** The standalone run: serve this folder's window on LIGHT_RUNTIME_PORT (default 8931). */
export function runLightRuntimeMain(env = process.env) {
  const assetsDir = fileURLToPath(new URL('.', import.meta.url));
  const stateDir = env.KINGMAKER_LIGHT_DIR || assetsDir;
  const engineStateDir = defaultEngineStateDir(env);
  const server = createLightRuntimeServer({ assetsDir, stateDir, profileDir: engineStateDir, engineStateDir });
  const port = Number(env.LIGHT_RUNTIME_PORT || 8931);
  return listenLightRuntime(server, port).then((a) => {
    console.log(`kingmaker light runtime: http://127.0.0.1:${a.port}  (state dir: ${stateDir}, control: ${CONTROL_FILE})`);
    return server;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLightRuntimeMain();
}
