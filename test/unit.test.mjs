import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSseFrame } from '../lib/client.mjs';
import { callTool, handleMessage, TOOLS } from '../lib/mcp.mjs';
import { findGhostBinary, resolvePaths, singletonPid } from '../lib/paths.mjs';
import { DESKTOP_NONCE_HEADER, ghostBackendEnv, mintLaunchSecrets, redactedEnv } from '../lib/profile.mjs';
import { startBlockers } from '../lib/runtime.mjs';
import { classifyLine, newestPending } from '../lib/session.mjs';
import { glowState } from '../lib/cli.mjs';
import { createSegmenter, isNonSpeech, splitWake, wakePhrasesFromKeywords, wavBytes } from '../lib/voice.mjs';
import { FORK_DIR } from '../lib/fork.mjs';

import { existsSync } from 'node:fs';
// App-mode paths whatever this checkout carries: hide the engine source so the installed-app expectations hold
// (fork mode has its own test below).
const appModeExists = (p) => !new RegExp(`[\\\\/]${FORK_DIR}[\\\\/]server[\\\\/]`).test(p) && existsSync(p);
const paths = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { exists: appModeExists });
const secrets = { nonce: 'a'.repeat(64), voiceKey: 'b'.repeat(64) };

test('keeps its OWN data folder; never the window app\'s unless the operator opts in', () => {
  assert.equal(paths.runtimeHome, '/tmp/sg-state/runtime');
  assert.equal(paths.sharesDesktopData, false);
  assert.equal(paths.singletonLock, '/tmp/sg-state/SingletonLock', 'no window app ever holds Sol Ghost\'s own folder');
  assert.equal(paths.managedRuntimes, '/Users/owner/Library/Application Support/solomon-desktop/runtimes', 'machine-level tool installs are shared, not data');
  const shared = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state', KINGMAKER_DESKTOP_USERDATA: '/Users/owner/Library/Application Support/solomon-desktop' }, '/Users/owner');
  assert.equal(shared.runtimeHome, '/Users/owner/Library/Application Support/solomon-desktop/runtime');
  assert.equal(shared.singletonLock, '/Users/owner/Library/Application Support/solomon-desktop/SingletonLock');
  assert.equal(shared.sharesDesktopData, true);
});

test('two CRM pairings on one Mac have separate runtime homes, locks, logs, and ports', () => {
  const ronin = resolvePaths({ SOL_GHOST_HOME: '/Users/owner/Library/Application Support/kingmaker-ronin', SOL_GHOST_RUNTIME_HOME: '/Users/owner/Library/Application Support/kingmaker-ronin/runtime', SOL_GHOST_PORT: '3001' }, '/Users/owner', { exists: () => false });
  const acme = resolvePaths({ SOL_GHOST_HOME: '/Users/owner/Library/Application Support/kingmaker-acme', SOL_GHOST_RUNTIME_HOME: '/Users/owner/Library/Application Support/kingmaker-acme/runtime', SOL_GHOST_PORT: '3002' }, '/Users/owner', { exists: () => false });
  assert.notEqual(ronin.state, acme.state);
  assert.notEqual(ronin.runtimeHome, acme.runtimeHome);
  assert.notEqual(ronin.stateFile, acme.stateFile);
  assert.notEqual(ronin.logs, acme.logs);
});

test('from a git checkout it borrows the installed Solomon.app', () => {
  assert.equal(paths.runtimeSource, 'borrowed-app');
  assert.equal(paths.headlessEntry, '/Applications/Kingmaker.app/Contents/Resources/app.asar/desktop/headless-server.mjs');
});

test('fork mode: runs the engine from its source when it is there, the installed app otherwise or when forced', () => {
  const withFork = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg' }, '/Users/o', { exists: (p) => p.endsWith(`${FORK_DIR}/server/src/index.ts`) });
  assert.equal(withFork.runtimeSource, 'fork');
  assert.equal(withFork.desktopModules, withFork.fork.desktop, 'plain-Node desktop modules come from the source tree');
  assert.equal(withFork.forkInstalled, false, 'no server deps yet');
  const noFork = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg' }, '/Users/o', { exists: () => false });
  assert.equal(noFork.runtimeSource, 'borrowed-app');
  assert.match(noFork.desktopModules, /Kingmaker\.app\/Contents\/Resources\/app\.asar\/desktop$/);
  const forced = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg', SOL_GHOST_RUNTIME: 'app' }, '/Users/o', { exists: () => true });
  assert.equal(forced.runtimeSource, 'borrowed-app');
});

test('inside a built Sol Ghost.app it runs its OWN runtime; KINGMAKER_RUNTIME_APP is only the dev fallback', () => {
  const modulePath = '/Users/owner/Applications/Sol Ghost.app/Contents/Resources/sol-ghost/lib/paths.mjs';
  const own = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state', KINGMAKER_RUNTIME_APP: '/nowhere/Solomon.app' }, '/Users/owner', { modulePath, exists: () => true });
  assert.equal(own.runtimeSource, 'bundle');
  assert.equal(own.app, '/Users/owner/Applications/Sol Ghost.app');
  assert.equal(own.binary, '/Users/owner/Applications/Sol Ghost.app/Contents/MacOS/Solomon');
  assert.equal(own.headlessEntry, '/Users/owner/Applications/Sol Ghost.app/Contents/Resources/app.asar/desktop/headless-server.mjs');
  assert.ok(!JSON.stringify(own).includes('/nowhere/'), 'a missing Solomon.app path is never consulted');
  // A thin dev build (scripts/build-app.sh) carries no runtime: it borrows the installed app.
  const thin = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { modulePath, exists: (p) => !p.endsWith('solomon-runtime') });
  assert.equal(thin.runtimeSource, 'borrowed-app');
  assert.equal(thin.binary, '/Applications/Kingmaker.app/Contents/MacOS/Solomon');
});

test('the server gets the plain wake PHRASE file, never the tokenized spotter keywords', () => {
  assert.equal(paths.voice.wakePhraseFile, '/tmp/sg-state/wake-word.txt');
  const desktopPhrase = '/Users/owner/Library/Application Support/solomon-desktop/wake-word.txt';
  const borrowed = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { exists: (p) => p === desktopPhrase });
  assert.equal(borrowed.voice.wakePhraseFile, desktopPhrase);
  const env = ghostBackendEnv({ env: {}, paths, port: 3001, secrets: { nonce: 'a', voiceKey: 'b' }, ghostBin: null });
  assert.match(env.SOLOMON_REPORTS_DIR, /sol-ghost\/Files\/Reports$/, 'reports land in Kingmaker\'s hidden folder, out of sight');
  assert.equal(env.SOLOMON_DEVICE_SEND_ENABLED, 'true', 'sending by voice is live, behind the read-back and the owner\'s yes');
  assert.equal(env.SOLOMON_WAKE_WORD_PATH, '/tmp/sg-state/wake-word.txt');
  assert.equal(env.SOLOMON_HEADLESS_LAUNCHER, 'kingmaker');
  assert.equal(env.SOLOMON_WAKE_PHRASE, 'Hey Kingmaker', 'with no wake-word file anywhere, its name is the default word');
});

test('launch secrets are 64 hex and differ per launch', () => {
  const a = mintLaunchSecrets(); const b = mintLaunchSecrets();
  assert.match(a.nonce, /^[0-9a-f]{64}$/); assert.match(a.voiceKey, /^[0-9a-f]{64}$/);
  assert.notEqual(a.nonce, b.nonce);
});

test('backend env: enforcement secrets are fixed and cannot be overridden from the environment', () => {
  const env = ghostBackendEnv({ env: { PATH: '/usr/bin', SOLOMON_DESKTOP_CONTROL_NONCE: 'attacker', SOLOMON_VOICE_ATTESTATION_KEY: 'attacker' }, paths, port: 3001, secrets, ghostBin: '/opt/homebrew/bin/ghost' });
  assert.equal(env.SOLOMON_DESKTOP_CONTROL_NONCE, secrets.nonce);
  assert.equal(env.SOLOMON_VOICE_ATTESTATION_KEY, secrets.voiceKey);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.SOLOMON_HEADLESS_HOME, paths.runtimeHome);
  assert.deepEqual(JSON.parse(env.SOLOMON_GHOST_MCP_CMD), ['/opt/homebrew/bin/ghost', 'mcp']);
  assert.equal(env.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, 'true');
  assert.ok(env.PATH.startsWith('/opt/homebrew/bin:'));
});

test('backend env: no ghost binary → no mac control; Ronin Atlas on with no boot prewarm; operator overrides win', () => {
  const env = ghostBackendEnv({ env: { SOLOMON_LOCAL_CODING_MODEL: 'mine' }, paths, port: 3001, secrets, ghostBin: null });
  assert.equal(env.SOLOMON_GHOST_MCP_CMD, undefined);
  assert.equal(env.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, undefined);
  assert.equal(env.SOLOMON_GODS_EYE_APP_ROOT, undefined, 'Ronin Atlas stays available for the browser');
  assert.equal(env.SOLOMON_GODS_EYE_PREWARM, '0');
  assert.equal(env.SOLOMON_MONEY_POLICY, 'spoken-second-confirm', 'the operator\'s Ghost money rule');
  assert.equal(ghostBackendEnv({ env: { SOLOMON_MONEY_POLICY: 'prohibited' }, paths, port: 3001, secrets, ghostBin: null }).SOLOMON_MONEY_POLICY, 'prohibited', 'the environment can turn payments off');
  assert.equal(env.SOLOMON_LOCAL_CODING_MODEL, 'mine');
  const off = ghostBackendEnv({ env: { SOL_GHOST_GODS_EYE: '0' }, paths, port: 3001, secrets, ghostBin: null });
  assert.equal(off.SOLOMON_GODS_EYE_APP_ROOT, '/tmp/sg-state/gods-eye-off');
});

test('redacted env never prints a secret', () => {
  const env = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null });
  const shown = JSON.stringify(redactedEnv(env));
  assert.ok(!shown.includes(secrets.nonce)); assert.ok(!shown.includes(secrets.voiceKey));
});

test('refuses to start beside the window app or on a busy port', async () => {
  const blockers = await startBlockers(paths, 3001, { exists: () => true, desktopPid: () => 63761, isPortFree: async () => false });
  assert.equal(blockers.length, 2);
  assert.match(blockers[0], /The desktop app is running \(pid 63761\)/);
  assert.equal((await startBlockers(paths, 3001, { exists: () => true, desktopPid: () => null, isPortFree: async () => true })).length, 0);
  assert.match((await startBlockers(paths, 3001, { exists: () => false, desktopPid: () => null, isPortFree: async () => true }))[0], /No engine to run/);
  const other = await startBlockers(paths, 3001, { exists: () => true, desktopPid: () => null, otherHeadless: () => ({ pid: 4242, launcher: 'sol-ghost' }), isPortFree: async () => true });
  assert.match(other[0], /Another headless engine \(sol-ghost, pid 4242\) is running on \/tmp\/sg-state\/runtime/);
  const forkNoDeps = { ...paths, runtimeSource: 'fork', forkInstalled: false, fork: { root: '/x/engine' } };
  assert.match((await startBlockers(forkNoDeps, 3001, { exists: () => true, desktopPid: () => null, isPortFree: async () => true }))[0], /npm ci --prefix \/x\/engine\/server/);
});

test('singleton lock target → pid', () => {
  assert.equal(singletonPid('owners-MacBook-Pro.local-63761'), 63761);
  assert.equal(singletonPid('garbage'), null);
});

test('ghost binary: explicit path must exist', () => {
  assert.equal(findGhostBinary({ SOL_GHOST_GHOST_BIN: '/nope' }, () => false), null);
  assert.equal(findGhostBinary({}, (p) => p === '/usr/local/bin/ghost'), '/usr/local/bin/ghost');
});

test('wake phrases come from the spotter file, not a hardcoded name', () => {
  assert.deepEqual(wakePhrasesFromKeywords('▁AT LAS @hey_atlas\n'), ['hey atlas', 'atlas']);
  assert.deepEqual(wakePhrasesFromKeywords('▁NO VA @nova'), ['nova']);
  assert.deepEqual(wakePhrasesFromKeywords('no label here'), []);
});

test('splitWake strips the wake phrase and keeps the command', () => {
  const p = ['hey atlas', 'atlas'];
  assert.deepEqual(splitWake('Hey Atlas, open Calculator and press 7.', p), { addressed: true, command: 'open Calculator and press 7.' });
  assert.deepEqual(splitWake('Atlas.', p), { addressed: true, command: '' });
  assert.equal(splitWake('open the door', p).addressed, false);
  assert.equal(splitWake('atlases of the world', p).addressed, false);
});

test('whisper placeholders are not speech', () => {
  for (const t of ['', '[BLANK_AUDIO]', '(music)', ' ... ']) assert.ok(isNonSpeech(t), t);
  assert.ok(!isNonSpeech('yes'));
});

test('segmenter: silence → speech → silence yields exactly one utterance', () => {
  const seg = createSegmenter();
  const frame = (amp, ms) => { const n = 16 * ms; const a = new Int16Array(n); for (let i = 0; i < n; i += 1) a[i] = Math.round(amp * Math.sin(i / 3)); return Buffer.from(a.buffer); };
  let got = [];
  got = got.concat(seg.push(frame(50, 900)));
  got = got.concat(seg.push(frame(6000, 1200)));
  got = got.concat(seg.push(frame(50, 1200)));
  assert.equal(got.length, 1);
  assert.ok(got[0].samples.length >= 16 * 1200 * 0.9);
  assert.ok(got[0].speechMs >= 1100 && got[0].speechMs <= 1200, `voiced ms only, never the silence: ${got[0].speechMs}`);
  assert.equal(seg.push(frame(50, 2000)).length, 0);
});

test('wav header is 44 bytes, 16 kHz mono 16-bit', () => {
  const w = wavBytes(new Int16Array(160));
  assert.equal(w.length, 44 + 320);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt16LE(22), 1);
});

test('console: yes/no/commands are told apart deterministically', () => {
  assert.equal(classifyLine('y'), 'yes'); assert.equal(classifyLine('Yes, go ahead'), 'yes');
  assert.equal(classifyLine('n'), 'no'); assert.equal(classifyLine('cancel'), 'no');
  assert.equal(classifyLine('open Blender'), 'text'); assert.equal(classifyLine('quit Blender'), 'text');
  assert.equal(classifyLine(':quit'), 'quit'); assert.equal(classifyLine('   '), 'empty');
});

test('a bare yes refers to the newest PENDING proposal only', () => {
  const p = newestPending([
    { proposalId: 'old', status: 'PENDING', createdAt: '2026-10-07T01:00:00Z' },
    { proposalId: 'done', status: 'CONFIRMED', createdAt: '2026-10-07T03:00:00Z' },
    { proposalId: 'new', status: 'PENDING', createdAt: '2026-10-07T02:00:00Z' },
  ]);
  assert.equal(p.proposalId, 'new');
  assert.equal(newestPending([]), null);
});

test('SSE frames parse; heartbeats are ignored', () => {
  assert.deepEqual(parseSseFrame('event: snapshot\ndata: {"armed":true}'), { type: 'snapshot', data: { armed: true } });
  assert.equal(parseSseFrame(': heartbeat 1'), null);
});

test('MCP: there is no approve tool, and calls never carry the owner nonce', async () => {
  assert.ok(!TOOLS.some((t) => /confirm|approve|arm/i.test(t.name)), 'no approving tool');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers ?? {} });
    return new Response(JSON.stringify({ ok: true, data: { spokenResponse: 'I\'m ready to open Calculator.', confirmationRequired: true, conversationId: 'c1', controlSurface: { status: 'AWAITING_CONFIRMATION', proposalId: 'prp_1' } } }), { status: 200 });
  };
  const res = await callTool('kingmaker_turn', { text: 'open Calculator' }, { port: 3001, fetchImpl });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.awaitingOwnerApproval, true);
  assert.equal(body.proposalId, 'prp_1');
  assert.ok(seen.every((s) => !Object.keys(s.headers).map((k) => k.toLowerCase()).includes(DESKTOP_NONCE_HEADER)));
});

test('MCP handshake: initialize, tools/list, notifications get no reply', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { port: 3001 });
  assert.equal(init.result.serverInfo.name, 'kingmaker');
  assert.ok(init.result.capabilities.tools);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { port: 3001 });
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { port: 3001 }), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, { port: 3001 })).error.code, -32601);
});

import { chunkLevel, createBargeDetector, createWakeState } from '../lib/voice.mjs';
import { browserViewable, describeWall, evidenceTargets, openDesktopWall, reportsDir, sourcePages } from '../lib/evidence.mjs';

test('asleep: nothing heard goes anywhere until the wake phrase', () => {
  const w = createWakeState({ wakePhrases: ['ghost wake up', 'hey atlas'], idleMs: 1000 });
  assert.equal(w.handle('send the email to Sarah', 0).action, 'ignore');
  assert.equal(w.handle('Ghost, wake up.', 10).action, 'wake');
  assert.deepEqual(w.handle('open Calculator', 20), { action: 'command', text: 'open Calculator' });
  assert.equal(w.handle('go to sleep', 30).action, 'sleep');
  assert.equal(w.handle('open Calculator', 40).action, 'ignore');
});

test('wake + command in one breath; the desktop app\'s wake word also wakes it; idle puts it back to sleep', () => {
  const w = createWakeState({ wakePhrases: ['ghost wake up', 'hey atlas'], idleMs: 1000 });
  assert.deepEqual(w.handle('Hey Atlas, open Blender', 0), { action: 'command', text: 'open Blender', woke: true });
  assert.equal(w.handle('and Chrome', 900).action, 'command');
  assert.equal(w.handle('still there?', 3000).action, 'ignore', 'asleep again after idleMs of quiet');
});

test('barge-in: say\'s silent start and its own echo never trip it; talking over it does', () => {
  const b = createBargeDetector();
  const feed = (level, ms) => { let fired = false; for (let t = 0; t < ms; t += 64) fired = b.push(level, 64) || fired; return fired; };
  assert.equal(feed(150, 450), false, 'say is still silent: room level only');
  assert.equal(feed(1400, 1500), false, 'its own voice through the speakers');
  let at = -1; for (let t = 0; t < 1000 && at < 0; t += 64) if (b.push(6500, 64)) at = t + 64;
  assert.ok(at > 0 && at <= 384, `you talking over it stops it after ${at} ms`);
  b.reset();
  assert.equal(feed(150, 300) || feed(6500, 400), false, 'never inside the first 700 ms of a reply');
  assert.equal(chunkLevel(Buffer.from(new Int16Array([3, -4]).buffer)).ms > 0, true);
});

test('its own name wakes it: "Sol Ghost" and how the recogniser spells it, not only a leading "Ghost"', () => {
  const w = createWakeState({ idleMs: 1000 });
  assert.deepEqual(w.handle('Sol Ghost.', 0), { action: 'wake', text: '' });
  const v = createWakeState({ idleMs: 1000 });
  assert.deepEqual(v.handle('Sol Ghost, send Maria Lopez hello.', 0), { action: 'command', text: 'send Maria Lopez hello.', woke: true });
  for (const said of ['Solghost open Notes', 'Soul Ghost, open Notes', 'Hey Sol Ghost open Notes', 'Okay Sol Ghost, open Notes']) {
    const x = createWakeState({ idleMs: 1000 });
    assert.deepEqual(x.handle(said, 0), { action: 'command', text: 'open Notes', woke: true }, said);
  }
  const y = createWakeState({ idleMs: 1000 });
  assert.equal(y.handle('the ghost of Sol came by', 0).action, 'ignore', 'the name must lead the utterance');
});

test('woken by the link Siri opens (kingmaker://wake): awake now, the next words are the command', async () => {
  const w = createWakeState({ idleMs: 1000 });
  assert.equal(w.handle('open Notes', 0).action, 'ignore', 'asleep: ignored');
  w.wakeNow(10);
  assert.deepEqual(w.handle('open Notes', 20), { action: 'command', text: 'open Notes' }, 'no wake word needed');
  assert.equal(w.handle('open Notes', 2000).action, 'ignore', 'idle puts it back to sleep');
  const { WAKE_LINK } = await import('../lib/cli.mjs');
  assert.equal(WAKE_LINK, 'kingmaker://wake');
  const plist = (await import('node:fs')).readFileSync(new URL('../app/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /<key>CFBundleURLSchemes<\/key><array><string>kingmaker<\/string><string>solghost<\/string><\/array>/, 'the app registers kingmaker:// and keeps solghost:// as an alias');
  const swift = (await import('node:fs')).readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
  assert.match(swift, /func application\(_ application: NSApplication, open urls: \[URL\]\)/, 'the app handles the link');
  assert.match(swift, /\["kingmaker", "solghost"\]\.contains\(url\.scheme/, 'either scheme wakes it');
});

test('"Ghost, …" addresses it: the name strips off the command', () => {
  const w = createWakeState({ idleMs: 1000 });
  assert.deepEqual(w.handle('Ghost, open my Chrome.', 0), { action: 'command', text: 'open my Chrome.', woke: true });
  assert.equal(w.handle('Ghost wake up', 10).action, 'wake', 'the longer phrase still wins');
});

test('evidence: only the engine\'s own output opens', () => {
  const home = '/U/rt';
  const exists = (p) => p === '/U/rt/data/generated-media/poster.png';
  const raw = { data: {
    output: { url: '/generated-media/poster.png', other: 'http://127.0.0.1:3001/evidence-screenshots/s1.png' },
    sources: ['https://evil.example/generated-media/x.png', 'http://127.0.0.1:9999/generated-media/y.png'],
    notes: '/U/rt/data/sqlite/runtime.db', esc: '/generated-media/../keys/k',
  } };
  assert.deepEqual(evidenceTargets(raw, { port: 3001, runtimeHome: home, exists }), [
    { kind: 'file', target: '/U/rt/data/generated-media/poster.png' },
    { kind: 'url', target: 'http://127.0.0.1:3001/evidence-screenshots/s1.png' },
  ]);
});

test('the research shows its work: the answer\'s verified source pages open, lead first, never a report file', () => {
  const src = (url, state = 'ONLINE_PROVEN', isLead = false) => ({ label: url, url, state, isLead });
  const raw = { data: { answerEvidence: { sources: [
    src('https://blog.example.com/b'), src('https://developers.cloudflare.com/a', 'ONLINE_PROVEN', true), src('https://unverified.example/x', 'UNVERIFIED'),
    src('javascript:alert(1)'), src('https://user:pw@bank.example/'), src('https://blog.example.com/b'), src('https://c.example/c'), src('https://d.example/d'),
  ] }, evidenceReport: { path: '/U/me/Desktop/Kingmaker — Reports/x.html' }, answer: 'see https://evil.example/in-text' } };
  assert.deepEqual(sourcePages(raw).map((p) => p.target), ['https://developers.cloudflare.com/a', 'https://blog.example.com/b', 'https://c.example/c'], 'lead first, verified only, deduped, at most 3');
  const targets = evidenceTargets(raw, { port: 3001, runtimeHome: '/U/rt', exists: () => false });
  assert.equal(targets.some((t) => /Reports|evil\.example/.test(t.target)), false, 'no report file and no link from the answer text');
  assert.equal(targets.every((t) => t.kind === 'page'), true);
  assert.equal(reportsDir({}, '/U/me'), '/U/me/Library/Application Support/sol-ghost/Files/Reports');
  assert.equal(browserViewable({ kind: 'page', target: 'https://a.example/' }), true);
  assert.equal(browserViewable({ kind: 'file', target: '/d/poster.png' }), true);
  assert.equal(browserViewable({ kind: 'file', target: '/d/scene.blend' }), false);
  assert.equal(browserViewable({ kind: 'file', target: '/d/logo.svg' }), false);
});

test('the pages open as tabs in your visible Chrome, counted back; never claimed when they did not land', async () => {
  const pages = [{ kind: 'page', target: 'https://developers.cloudflare.com/a' }, { kind: 'page', target: 'https://blog.example.com/b' }];
  const launched = [];
  const scripts = [];
  const opened = await openDesktopWall([...pages, { kind: 'file', target: '/d/scene.blend' }], {
    launch: async (a) => { launched.push(a); return true; },
    exec: async (file, args) => { scripts.push([file, ...args.slice(2)]); return '2\n'; },
  });
  assert.deepEqual(launched, [['/d/scene.blend']], 'only the file a browser cannot show goes to its app');
  assert.deepEqual(scripts, [['/usr/bin/osascript', 'https://developers.cloudflare.com/a', 'https://blog.example.com/b']], 'Apple events to the visible Chrome, not open -a');
  assert.deepEqual(opened, { where: 'chrome', pages: 2, windows: 2, apps: 1 });
  assert.equal(describeWall(opened), 'The 2 sources are open in Chrome.');
  const one = await openDesktopWall(pages, { exec: async () => '1', launch: async () => true });
  assert.equal(describeWall(one), 'The source is open in Chrome.', 'only what was read back is claimed');
  const noControl = await openDesktopWall(pages.slice(0, 1), { exec: async () => { throw new Error('not allowed'); }, launch: async () => true });
  assert.equal(noControl.where, 'browser');
  assert.equal(describeWall(noControl), 'The source is open in your browser.');
  const nothing = await openDesktopWall(pages.slice(0, 1), { exec: async () => '0', launch: async () => false });
  assert.deepEqual(nothing, { where: null, pages: 0, windows: 0, apps: 0 });
  assert.equal(describeWall(nothing), '', 'nothing landed → nothing said');
});

import { rulesVerdict } from '../lib/cli.mjs';

test('fail closed unless the rules are enforced and this console is the owner', () => {
  assert.equal(rulesVerdict(null).ok, false);
  assert.equal(rulesVerdict({ enforced: false, principal: { kind: 'operator_typed' } }).ok, false);
  assert.equal(rulesVerdict({ enforced: true, principal: { kind: 'local_process' } }).ok, false);
  assert.equal(rulesVerdict({ enforced: true, principal: { kind: 'operator_typed' } }).ok, true);
});

import { ABLITERATED_CODERS, ABLITERATED_MODELS, abliteratedCoder, abliteratedModelEnv } from '../lib/profile.mjs';
import { modelsLine } from '../lib/cli.mjs';

test('models: abliterated by their real names, only when installed; the operator\'s pins win; =0 keeps stock', () => {
  const all = ['huihui_ai/qwen3-abliterated:1.7b', 'huihui_ai/qwen3-abliterated:0.6b', 'huihui_ai/qwen3.5-abliterated:2b', 'qwen3:1.7b'];
  assert.deepEqual(abliteratedModelEnv(all, {}, 8), { ...ABLITERATED_MODELS }, 'no coder installed: no coder pin');
  assert.deepEqual(abliteratedModelEnv(['huihui_ai/qwen3-abliterated:0.6b'], {}), { SOLOMON_OLLAMA_CLASSIFIER_MODEL: 'huihui_ai/qwen3-abliterated:0.6b', SOLOMON_PINNED_FAST_MODEL: 'huihui_ai/qwen3-abliterated:0.6b' }, 'a model that is not installed is never pinned');
  assert.deepEqual(abliteratedModelEnv(all, { SOL_GHOST_ABLITERATED: '0' }), {});
  const env = ghostBackendEnv({ env: { SOLOMON_OLLAMA_MODEL: 'mine:7b' }, paths, port: 3001, secrets, ghostBin: null, installedModels: all, totalMemGb: 8 });
  assert.equal(env.SOLOMON_OLLAMA_MODEL, 'mine:7b', 'the operator\'s own pin wins');
  assert.equal(env.SOLOMON_AGENT_PLANNER_MODEL, 'huihui_ai/qwen3-abliterated:1.7b');
  assert.equal(env.SOLOMON_OLLAMA_CLASSIFIER_MODEL, 'huihui_ai/qwen3-abliterated:0.6b');
  // Fully abliterated: every role that answers in words, not only chat (drafts, builds, vision, the reflex tier).
  assert.equal(env.SOLOMON_DRAFT_MODEL, 'huihui_ai/qwen3-abliterated:1.7b');
  assert.equal(env.SOLOMON_BUILD_MODEL, 'huihui_ai/qwen3.5-abliterated:2b');
  assert.equal(env.SOLOMON_VISION_MODEL, 'huihui_ai/qwen3.5-abliterated:2b');
  assert.equal(env.SOLOMON_PINNED_FAST_MODEL, 'huihui_ai/qwen3-abliterated:0.6b');
  assert.ok(Object.values(ABLITERATED_MODELS).every((m) => /abliterated/.test(m)), 'never a stock tag name: the engine\'s integrity pins see the real weights');
  assert.match(modelsLine(abliteratedModelEnv(all, {}), {}), /^Models: abliterated/);
  assert.match(modelsLine({}, {}), /not installed: huihui_ai\/qwen3-abliterated:1\.7b/);
  assert.match(modelsLine({}, { SOL_GHOST_ABLITERATED: '0' }), /stock/);
});

test('the engine shares Kingmaker\'s profile: one router, the profile\'s context, its models-at-once; the operator still wins', async () => {
  const { profileRuntimeEnv } = await import('../lib/profile.mjs');
  const r24 = profileRuntimeEnv(['huihui_ai/qwen3-abliterated:1.7b', 'huihui_ai/qwen3-abliterated:0.6b'], 24, {});
  assert.equal(r24.SOLOMON_PINNED_FAST_MODEL, 'huihui_ai/qwen3-abliterated:1.7b', 'the 24 GB router is the reflex tier too: no second router');
  assert.equal(r24.SOLOMON_OLLAMA_CLASSIFIER_MODEL, 'huihui_ai/qwen3-abliterated:1.7b');
  assert.equal(r24.SOLOMON_OLLAMA_NUM_CTX, '8192'); assert.equal(r24.OLLAMA_MAX_LOADED_MODELS, '2');
  assert.equal(profileRuntimeEnv(['huihui_ai/qwen3-abliterated:0.6b'], 8, {}).SOLOMON_PINNED_FAST_MODEL, undefined, 'the 8 GB router not installed: the 0.6b stays');
  assert.equal(profileRuntimeEnv([], 8, {}).OLLAMA_MAX_LOADED_MODELS, '1');
  assert.deepEqual(profileRuntimeEnv([], 24, { SOL_GHOST_PROFILE_ENV: '0' }), {});
  const env = ghostBackendEnv({ env: { SOLOMON_OLLAMA_NUM_CTX: '4096' }, paths, port: 3001, secrets, ghostBin: null, installedModels: ['huihui_ai/qwen3-abliterated:1.7b'], totalMemGb: 24 });
  assert.equal(env.SOLOMON_OLLAMA_NUM_CTX, '4096', 'the operator\'s own context wins');
  assert.equal(env.SOLOMON_PINNED_FAST_MODEL, 'huihui_ai/qwen3-abliterated:1.7b');
});

test('coder: the abliterated 1.5b, stepping up to the abliterated 7b only on a 16 GB+ machine that has it', () => {
  const { small, large } = ABLITERATED_CODERS;
  assert.equal(abliteratedCoder([small, large], 8), small, '8 GB never runs the 7b, even when installed');
  assert.equal(abliteratedCoder([small, large], 16), large, '16 GB with the 7b steps up');
  assert.equal(abliteratedCoder([small, large], 32), large);
  assert.equal(abliteratedCoder([small], 32), small, 'a big machine without the 7b keeps the 1.5b');
  assert.equal(abliteratedCoder([large], 8), null, 'the 7b alone on 8 GB: nothing pinned, the engine keeps its own coder');
  assert.equal(abliteratedCoder(['qwen2.5-coder:1.5b'], 32), null);
  const pins = abliteratedModelEnv([small, large], {}, 32);
  assert.equal(pins.SOLOMON_LOCAL_CODING_MODEL, large);
  assert.equal(pins.SOLOMON_SNIPPET_MODEL, large);
  assert.equal(abliteratedModelEnv([small], {}, 8).SOLOMON_LOCAL_CODING_MODEL, small);
  assert.deepEqual(abliteratedModelEnv([small, large], { SOL_GHOST_ABLITERATED: '0' }, 32), {});
  assert.match(modelsLine(abliteratedModelEnv([small], {}, 32), {}, 32), /can run the 7b: ollama pull huihui_ai\/qwen2\.5-coder-abliterate:7b/);
  assert.match(modelsLine(abliteratedModelEnv([small], {}, 8), {}, 8), /abliterated 1\.5b, sized to this Mac/);
  assert.match(modelsLine(abliteratedModelEnv([small, large], {}, 32), {}, 32), /abliterated 7b/);
});

import { forkChildEnv } from '../lib/runtime.mjs';

test('fork mode under an Electron binary stays Node: it can never open the desktop app', () => {
  assert.equal(forkChildEnv({ ELECTRON_RUN_AS_NODE: '1', A: 'b' }, { node: '24.18.0', electron: '41.0.0' }).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(forkChildEnv({ A: 'b' }, { node: '24.18.0', electron: '41.0.0' }).ELECTRON_RUN_AS_NODE, '1', 'set even when the caller dropped it');
  assert.equal('ELECTRON_RUN_AS_NODE' in forkChildEnv({ ELECTRON_RUN_AS_NODE: '1' }, { node: '26.4.0' }), false, 'plain node: dropped');
  assert.equal(forkChildEnv({ A: 'b' }, { node: '26.4.0' }).A, 'b');
});

test('glow: a running studio project shows as thinking while the voice is idle; speech and asks still win', () => {
  const at = (voiceState, waiting, working, state = voiceState) => glowState(state, { voiceState, waiting, working });
  assert.equal(at('asleep', false, true), 'thinking');
  assert.equal(at('awake', false, true), 'thinking');
  assert.equal(at('asleep', false, false), 'asleep', 'no project, no glow');
  assert.equal(at('hearing', false, true), 'hearing', 'listening to you beats background work');
  assert.equal(at('asleep', true, true), 'waiting', 'an install waiting for your word beats background work');
  assert.equal(at('asleep', false, true, 'speaking'), 'speaking');
});

import { installSiriShortcut, wakeShortcutPlist, SIRI_SHORTCUT_NAME } from '../lib/siri.mjs';

test('"Hey Siri, wake Kingmaker": the Shortcut opens kingmaker://wake, is signed by macOS, then shown to add', async () => {
  const plist = wakeShortcutPlist();
  assert.match(plist, /is\.workflow\.actions\.url<\/string>[\s\S]*<string>kingmaker:\/\/wake<\/string>/);
  assert.match(plist, /is\.workflow\.actions\.openurl/);
  const calls = [];
  const signed = await installSiriShortcut({ exec: async (f, a) => { calls.push([f, ...a]); return ''; }, dir: (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'siri-test-')) });
  assert.equal(SIRI_SHORTCUT_NAME, 'Wake Kingmaker');
  assert.deepEqual(calls.map((c) => c.slice(0, 4)), [['/usr/bin/shortcuts', 'sign', '--mode', 'anyone'], ['/usr/bin/open', signed]]);
});

import { isMuteCommand, isOffCommand, startVoiceLoop } from '../lib/voice.mjs';

test('mute and off in his own words: whole utterances only, so other commands still reach the engine', () => {
  for (const t of ['shut up', 'Be quiet.', 'stop listening', 'mute', "That's all, thanks.", 'go to sleep', 'Goodnight', "ok that's it", 'you can go', 'stand by', "I'm done"]) assert.equal(isMuteCommand(t), true, t);
  for (const t of ['shut down', 'Turn yourself off.', 'power down', 'go offline', 'quit', 'shut down please']) assert.equal(isOffCommand(t), true, t);
  for (const t of ['shut down the Mac', 'quit Spotify', 'mute the TV', 'turn off the lights', 'tell Maria to be quiet', 'stop listening to that podcast']) {
    assert.equal(isMuteCommand(t) || isOffCommand(t), false, t);
  }
  const w = createWakeState({ idleMs: 1000 });
  assert.equal(w.handle('shut up', 0).action, 'ignore', 'asleep and not called: nothing happens');
  assert.equal(w.handle('Ghost, shut down.', 0).action, 'off', 'called by name: the off switch');
  const v = createWakeState({ idleMs: 1000 });
  v.wakeNow(0);
  assert.equal(v.handle("that's all, thanks", 10).action, 'sleep');
  assert.equal(v.handle('open Notes', 20).action, 'ignore', 'asleep after the mute');
});

test('asleep the microphone is OFF: opened on wake, closed on mute and on idle, never transcribing asleep', async () => {
  const { EventEmitter } = await import('node:events');
  const opened = [];
  const fakeMic = () => { const m = new EventEmitter(); m.stdout = new EventEmitter(); m.stderr = new EventEmitter(); m.killed = false; m.kill = () => { m.killed = true; }; m.once = m.once.bind(m); opened.push(m); return m; };
  const said = [];
  const loop = startVoiceLoop({
    paths: { voice: { whisper: '/w', sttModel: '/m', wakeKeywords: [] } }, exists: () => true,
    onCommand: async () => ({}), say: async (l) => { said.push(l); }, isSpeaking: () => false,
    openMic: ({ probe }) => (probe ? true : fakeMic()), listenWhileAsleep: false,
  });
  assert.equal(loop.ok, true);
  assert.equal(loop.isListening(), false, 'starts asleep with the mic closed');
  assert.equal(opened.length, 0);
  await loop.wakeNow();
  assert.equal(loop.isListening(), true, 'woken: the mic opens');
  assert.deepEqual(said, ["I'm here."]);
  loop.sleepNow();
  assert.equal(loop.isListening(), false, 'asleep again: the mic is closed');
  assert.equal(opened[0].killed, true);
  loop.stop();
});

test('a mic that dies while awake is reopened; one closed on purpose is not', async () => {
  const { EventEmitter } = await import('node:events');
  const opened = [];
  const fakeMic = () => { const m = new EventEmitter(); m.stdout = new EventEmitter(); m.stderr = new EventEmitter(); m.kill = () => { m.killed = true; }; opened.push(m); return m; };
  const loop = startVoiceLoop({
    paths: { voice: { whisper: '/w', sttModel: '/m', wakeKeywords: [] } }, exists: () => true,
    onCommand: async () => ({}), say: async () => {}, isSpeaking: () => false,
    openMic: ({ probe }) => (probe ? true : fakeMic()), listenWhileAsleep: false,
  });
  await loop.wakeNow();
  assert.equal(opened.length, 1);
  opened[0].emit('exit', 0, null); // the device went away on its own
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(opened.length, 2, 'reopened while awake');
  assert.equal(loop.isListening(), true);
  loop.sleepNow();
  opened[1].emit('exit', null, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(opened.length, 2, 'asleep: a closed mic stays closed');
  loop.stop();
});

test('the bar lists sources as links: titles or domains, lead first, at most 8; nothing is opened', async () => {
  const { evidenceLinks, describeLinks } = await import('../lib/evidence.mjs');
  const sources = Array.from({ length: 10 }, (_, i) => ({ url: `https://www.site${i}.example/a`, state: 'ONLINE_PROVEN', title: i === 1 ? 'The  lead\n page' : '', isLead: i === 1 }));
  sources.push({ url: 'https://user:pw@bad.example/', state: 'ONLINE_PROVEN' }, { url: 'https://unproven.example/', state: 'DRAFT' });
  const links = evidenceLinks({ data: { answerEvidence: { sources } } }, { port: 3001, runtimeHome: null });
  assert.equal(links.length, 8);
  assert.deepEqual(links[0], { kind: 'page', title: 'The lead page', url: 'https://www.site1.example/a' });
  assert.equal(links[1].title, 'site0.example', 'no title: the domain');
  assert.ok(!links.some((l) => /bad\.example|unproven/.test(l.url)), 'only verified pages, never credentials');
  assert.equal(describeLinks(links), 'The sources are in the bar.');
  assert.equal(describeLinks(links, { where: 'below' }), 'The sources are below.');
  assert.equal(describeLinks([{ kind: 'file', title: 'r.html', url: 'file:///x' }]), 'The links are in the bar.');
  assert.equal(describeLinks([]), '');
});
