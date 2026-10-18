// OWNER + KEYS PROOF — Kingmaker's real key flow against its engine's real routes, nothing faked between them.
//
//   engine     its real HTTP surface on loopback: the local-process guard + principal verifier, the owner-console
//              middleware (SOLOMON_HEADLESS=1, sovereign loopback mode on, as headless-server runs it), the
//              /api/vault and /api/key-handoff routers, the credentials vault, on a scratch runtime.
//   Sol Ghost  lib/client.mjs ownerCall + lib/keys.mjs runKeyFlow exactly as the console runs them. Only the browser
//              opener and the hidden prompt are stand-ins (no human pastes in a proof); both are recorded.
//
// Proves: the console's nonce is the owner on owner-only routes and a `say`-style call is refused there; the key
// lands in the vault row the GitHub connector reads; "Saved your GitHub key to the vault" is said only after
// the engine confirms; the canary key is in no Kingmaker output, argv, log, engine response or runtime file.
//
// Run:   KINGMAKER_ENGINE_SRC=<an engine source checkout with the headless owner console> npm run proof:owner-keys
// Needs: that checkout's server/node_modules. Absent → exit 2 (SKIP, never a PASS). Exit 0 only when all hold.

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerCall, turn } from '../lib/client.mjs';
import { runKeyFlow } from '../lib/keys.mjs';
import { forkLayout } from '../lib/fork.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = (process.env.KINGMAKER_ENGINE_SRC ? resolve(process.env.KINGMAKER_ENGINE_SRC) : forkLayout().root);
function skip(reason) { console.log(`SKIP owner-keys proof: ${reason}`); process.exit(2); }
if (!existsSync(join(ENGINE_SRC, 'server', 'src', 'runtime', 'headless-owner-console.ts'))) skip(`no engine source checkout with the headless owner console at ${ENGINE_SRC}`);
if (!existsSync(join(ENGINE_SRC, 'server', 'node_modules', 'express'))) skip(`${ENGINE_SRC}/server/node_modules is not installed`);

let failed = 0;
function check(name, ok, detail = '') { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); }

process.env.NODE_ENV = 'test';
const NONCE = randomBytes(32).toString('hex');
process.env.SOLOMON_HEADLESS = '1';
process.env.SOLOMON_DESKTOP_CONTROL_NONCE = NONCE;
const setup = await import(`${ENGINE_SRC}/tests/meta-governance/setup.ts`);
const runtimeRoot = setup.initMetaGovernanceTestRuntime('sol-ghost-owner-keys-proof-');
await setup.bootstrapMetaGovernanceStorage();
const { default: express } = await import(`${ENGINE_SRC}/server/node_modules/express/index.js`);
const auth = await import(`${ENGINE_SRC}/server/src/runtime/account-auth.ts`);
const { markSovereignLocalRuntime } = await import(`${ENGINE_SRC}/server/src/runtime/sovereign-local-session.ts`);
const { capabilityVaultRouter } = await import(`${ENGINE_SRC}/server/src/routes/capability-vault.ts`);
const { apiKeyHandoffRouter } = await import(`${ENGINE_SRC}/server/src/routes/api-key-handoff.ts`);
const { createLocalProcessMutationGuard } = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/authority/local-guard.ts`);
const { createPrincipalVerifier } = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/authority/principal-verifier.ts`);
const probes = await import(`${ENGINE_SRC}/server/src/connectors/live-capability-probes.ts`);
const vault = await import(`${ENGINE_SRC}/server/src/storage/credentials-vault.ts`);
markSovereignLocalRuntime(process.env); // the real runtime: loopback would be ROOT with no credentials at all

const app = express();
app.use(createLocalProcessMutationGuard({ verifier: () => createPrincipalVerifier({ warn: () => {} }), audit: { record: () => true } }));
app.use('/api/vault', auth.ownerAuthSessionMiddleware, auth.requireRoles(['ROOT']), express.json(), capabilityVaultRouter);
app.use('/api/key-handoff', auth.ownerOptionalAuthSessionMiddleware, express.json({ limit: '16kb' }), apiKeyHandoffRouter);
const responses = [];
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const recordingFetch = async (url, init) => { const res = await fetch(url, init); responses.push(await res.clone().text()); return res; };

const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY = `ghp_CANARY${Array.from(randomBytes(30), (b) => alnum[b % alnum.length]).join('')}`;

// 1. Who is the owner.
const asOwner = await ownerCall(port, '/api/vault', { nonce: NONCE, fetchImpl: recordingFetch });
const asSay = await fetch(`http://127.0.0.1:${port}/api/vault`);
check('the console\'s nonce is the owner on an owner-only route', asOwner.ok && Array.isArray(asOwner.json?.entries), `HTTP ${asOwner.status}`);
check('a `say`-style call (no nonce) is refused there even in sovereign loopback mode', asSay.status === 403 && (await asSay.json()).error === 'owner_console_required', `HTTP ${asSay.status}`);
const sayTurn = await turn(port, { text: 'x', fetchImpl: async (url, init) => { check('`say` sends no nonce', !Object.keys(init.headers).some((h) => h.toLowerCase() === 'x-solomon-desktop-nonce')); return new Response('{}'); } });
void sayTurn;

// 2. The key, from the "terminal".
const out = [];
const spoken = [];
const logs = [];
const argv = [];
let pasted = null;
const result = await runKeyFlow({
  port, nonce: NONCE, provider: 'github', fetchImpl: recordingFetch,
  launch: async (args) => { argv.push(args); return true; },
  out: (line) => out.push(line), speak: (line) => spoken.push(line), log: (e, d) => logs.push(JSON.stringify({ e, ...d })),
  readSecret: async () => { pasted = Buffer.from(KEY); return pasted; },
  ask: async () => 'n',
});
check('the flow reports success with the last 4 only', result.ok === true && result.last4 === KEY.slice(-4), JSON.stringify(result));
check('the GitHub key page from the engine\'s catalog opened in Chrome', argv[0]?.[0] === '-a' && argv[0]?.[1] === 'Google Chrome' && argv[0]?.[2] === 'https://github.com/settings/personal-access-tokens/new', JSON.stringify(argv[0]));
check('the key is in the vault row the GitHub connector reads', probes.isGithubConfigured('primary'));
check('"Saved your GitHub key to the vault." was printed and spoken after the engine confirmed', out.some((l) => l.includes('Saved your GitHub key to the vault.')) && spoken.includes('Saved your GitHub key to the vault.'));
check('the pasted bytes were zero-filled', pasted && pasted.every((b) => b === 0));

// 3. Nowhere else.
server.closeAllConnections?.();
server.close();
vault.__closeVaultForTests();
await new Promise((r) => setTimeout(r, 300));
const needles = [KEY, KEY.slice(8, 24), Buffer.from(KEY).toString('base64').replace(/=+$/, ''), Buffer.from(KEY).toString('hex'), encodeURIComponent(KEY)];
const files = [];
const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
walk(runtimeRoot);
const fileHits = files.filter((f) => { const t = readFileSync(f).toString('latin1'); return needles.some((n) => t.includes(n)); });
const textHits = [...out, ...spoken, ...logs, ...argv.flat(), ...responses].filter((t) => needles.some((n) => String(t).includes(n)));
check('the key is in no Kingmaker output, log, argv or engine response', textHits.length === 0, `${out.length + spoken.length + logs.length} lines, ${responses.length} responses`);
check('the key is in no runtime file (the vault holds ciphertext only)', fileHits.length === 0 && files.some((f) => f.endsWith(join('vault', 'credentials.db'))), `${files.length} files${fileHits.length ? ` HIT: ${fileHits.join(', ')}` : ''}`);

console.log(failed ? `\nOWNER-KEYS PROOF: ${failed} FAILED` : '\nOWNER-KEYS PROOF: all checks passed');
process.exit(failed ? 1 : 0);
