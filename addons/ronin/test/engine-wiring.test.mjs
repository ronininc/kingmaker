// (Ronin add-on part of test/engine-wiring.test.mjs) Fork-mode wiring: the env Kingmaker hands Solomon (lib/profile.mjs ghostBackendEnv) must be what the imported
// engine (solomon/) actually reads. Guards against a re-import that renames or drops a variable Kingmaker relies on:
//   SOLOMON_CRM_DEFAULT=none        → home-crm.ts: no CRM until the owner connects one (never the operator's Ronin CRM)
//   SOLOMON_MAC_HANDS=peekaboo      → peekaboo-hands-client.ts / mac-hands.ts: Hands of Horus drive the Mac
//   SOLOMON_PEEKABOO_MCP_CMD        → peekaboo-hands-client.ts: the Peekaboo MCP launch command (JSON argv)
//   SOLOMON_RUNTIME_EDITION=DEV_NONCOMMERCIAL (lib/fork.mjs) → edition-profile.ts: the noncommercial dev edition, on 'merchant'
import './_bind.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { forkBackendLaunch, KINGMAKER_RUNTIME_EDITION, REPO_ROOT } from '../../../lib/fork.mjs';
import { resolvePaths } from '../../../lib/paths.mjs';
import { ghostBackendEnv } from '../../../lib/profile.mjs';
import * as ronin from '../index.mjs';

const runtime = join(REPO_ROOT, 'solomon', 'server', 'src', 'runtime');
const src = (name) => readFileSync(join(runtime, name), 'utf8');
const imported = existsSync(join(REPO_ROOT, 'solomon', 'server', 'src', 'index.ts'));
const paths = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { exists: () => false });
const secrets = { nonce: 'a'.repeat(64), voiceKey: 'b'.repeat(64) };
const PKB = '/opt/homebrew/bin/peekaboo';

// "give me a CRM status, where's everyone at" (Seeker): the imported engine reads team_status, read-only, from the
// Seeker MCP when a Seeker token is sealed. Each Kingmaker seat token has its own slot; the ronin-crm slot takes the
// master key (ronin_admin_) or a Solomon token, and ronin_king_ is refused everywhere.
test('the imported engine has the read-only CRM team status on /mcp/seeker and one slot per seat token', { skip: (!imported && 'solomon/ not imported') }, async () => {
  assert.match(src('ronin-crm-mcp.ts'), /async teamStatus\(\)[\s\S]{0,400}this\.call\('team_status'\)/, 'RoninCrm.teamStatus calls team_status with no arguments');
  assert.match(src('crm-commands.ts'), /kind: 'team-status'/);
  assert.match(src('route-dispatch.ts'), /command\.kind === 'team-status'[\s\S]{0,900}seatCaller\('seeker'\)[\s\S]{0,900}crmRecordAnswer\(formatTeamStatus/, 'read from the Seeker seat, answered as a read');
  const probes = readFileSync(join(REPO_ROOT, 'solomon', 'server', 'src', 'connectors', 'live-capability-probes.ts'), 'utf8');
  const shape = new RegExp(/const RONIN_CRM_TOKEN_SHAPE = \/(.+)\/i;/.exec(probes)?.[1] ?? '^$', 'i');
  const hex = 'c'.repeat(64);
  assert.ok(shape.test(`ronin_solomon_${hex}`) && shape.test(`ronin_admin_${hex}`) && !shape.test(`ronin_seeker_${hex}`) && !shape.test(`ronin_king_${hex}`), 'ronin-crm slot: the master key or a Solomon token');
  const seats = src('ronin-seats.ts');
  for (const [seat, svc, url] of [['approver', 'ronin-approver-mcp', '/mcp/solomon'], ['seeker', 'ronin-seeker-mcp', '/mcp/seeker'], ['local', 'ronin-local-capital', '/mcp/capital']]) {
    assert.match(seats, new RegExp(`id: '${seat}', prefix: 'ronin_${seat}_', vaultService: '${svc}'[\\s\\S]{0,300}${url.replace(/\//g, '\\/')}`), `${seat} seat: own prefix, own slot, own endpoint`);
  }
  const shell = await import(pathToFileURL(join(REPO_ROOT, 'solomon', 'desktop', 'key-handoff.mjs')).href);
  for (const slot of ['ronin-crm', 'ronin-approver', 'ronin-seeker', 'ronin-local']) {
    const own = slot === 'ronin-crm' ? ['solomon', 'admin'] : [slot.slice(6)];
    for (const p of ['solomon', 'admin', 'approver', 'seeker', 'local', 'king']) assert.equal(shell.clipboardLooksLikeKey(slot, `ronin_${p}_${hex}`), own.includes(p), `${slot} vs ronin_${p}_`);
  }
  // One key: a seat with no token of its own falls back to the master key in the ronin-crm slot (never a Solomon token).
  assert.match(seats, /export function seatSource\(/, 'seatSource: own | master | null');
  assert.match(seats, /MASTER_TOKEN_SHAPE = \/\^ronin_admin_\[0-9a-f\]\{64\}\$\/i/, 'only a well-formed master key stands in for a seat');
});

// The delegated approvals: Kingmaker turns the core's seats on, its console/voice kill switch matches the core's, and
// the core's loop is still the guarded one (server-delegated only, vetting id for trades, local ceiling, no outreach).
test('the imported engine has the guarded approval loop Kingmaker drives', { skip: (!imported && 'solomon/ not imported') }, async () => {
  const env = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null, addon: ronin });
  assert.equal(env.SOLOMON_KINGMAKER_SEATS, '1');
  const index = readFileSync(join(REPO_ROOT, 'solomon', 'server', 'src', 'index.ts'), 'utf8');
  assert.match(index, /app\.use\('\/api\/kingmaker-approver', ownerAuthSessionMiddleware, requireRoles\(\['ROOT'\]\)/);
  const loop = src('kingmaker-approver.ts');
  assert.match(loop, /env\.SOLOMON_KINGMAKER_SEATS !== '1'/, 'inert unless Kingmaker set it');
  assert.match(loop, /item\.delegateMayApprove !== true/);
  assert.match(loop, /item\.status !== 'reviewer_vetted'/);
  assert.match(loop, /item\.amountCents > ctx\.ceilingCents/);
  // ronininc-crm #177 on #173: relied_on required (no stand-in field), approve only through /mcp/solomon, names configurable.
  assert.match(loop, /vettingId: str\(x\.relied_on\), moneyCheckId: str\(x\.money_check_id\),\n/);
  // #173 money check: both ids required for a trade, both echoed on approve.
  assert.match(loop, /if \(!item\.vettingId \|\| !item\.moneyCheckId\)/);
  assert.match(loop, /money_check_id: d\.moneyCheckId/);
  assert.ok(!/str\(x\.vetting_id\)|reviewer_vetting_id/.test(loop), 'no other field stands in for relied_on');
  assert.match(loop, /if \(!approverEndpointAllowed\(seatServerUrl\('approver'\)\)\)/);
  assert.match(loop, /pathname\.replace\(\/\\\/\+\$\/, ''\) === '\/mcp\/solomon'/);
  assert.match(loop, /SOLOMON_APPROVER_TOOL_APPROVE/);
  // ronininc-crm #176: no auto-dock; docking only with the read-only answer loop.
  assert.equal(env.SOLOMON_SEEKER_DOCK, '1', 'a configured Seeker seat docks and heartbeats by default');
  assert.match(loop, /env\.SOLOMON_SEEKER_DOCK === '1'/);
  assert.match(loop, /if \(!seekerDockEnabled\(env\) \|\| !isSeatConfigured\('seeker'\)\) return false;/);
  assert.match(loop, /callTool\('mia_answer', \{ ask_id: ask\.id/);
  // #176 at 506a223: the mia_inbox poll is the heartbeat; no re-dock check-in; re-dock after 120 s without a good poll.
  assert.ok(!/SEEKER_CHECKIN_MS/.test(loop), 'no separate check-in timer');
  assert.match(loop, /export const SEEKER_POLL_MS = 5_000;/);
  assert.match(loop, /export const SEEKER_STALE_MS = 120_000;/);
  assert.match(loop, /heartbeat\.callTool\('mia_inbox', \{\}\)/);
  assert.match(loop, /OUTREACH\.test/);
  const route = readFileSync(join(REPO_ROOT, 'solomon', 'server', 'src', 'routes', 'kingmaker-approver.ts'), 'utf8');
  assert.match(route, /post\('\/enable'[\s\S]{0,200}isHeadlessOwnerConsoleRequest\(req\)/, 'enable is owner-console only');
  const core = new RegExp(/export const STOP_APPROVING = \/(.+)\/i;/.exec(loop)?.[1] ?? '^$', 'i');
  const { STOP_APPROVING } = await import('../../../lib/kill-switch.mjs');
  assert.equal(STOP_APPROVING.source, core.source, 'the console kill switch is the core\'s');
  assert.match(src('headless-owner-console.ts'), /'\/api\/kingmaker-approver'/, 'the console nonce reaches the approver routes');
});

// The inbound DM bridge: forwards every inbound DM to the CRM once, tagged, never replies; the console pause matches.
test('the imported engine has the DM bridge Kingmaker drives', { skip: (!imported && 'solomon/ not imported') }, async () => {
  const env = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null, addon: ronin });
  assert.equal(env.SOLOMON_DM_FORWARD_SCOPE, 'all');
  const bridge = src('crm-dm-bridge.ts');
  assert.match(bridge, /env\.SOLOMON_KINGMAKER_SEATS !== '1'/, 'inert unless Kingmaker set it');
  assert.match(bridge, /'inbound_message'/);
  assert.match(bridge, /crm\.captureContact\(/);
  assert.match(bridge, /crm\.addNote\(contactId, noteBody\(ev, tag(, urgency)?\)\)/);
  // decide() urgency (TSS#419) rides along on the note; scoring is advisory and never blocks a forward.
  assert.match(bridge, /scoreDmUrgency\(/);
  assert.match(bridge, /scoring is advisory; forwarding never waits on it/);
  assert.match(bridge, /scope === 'business' && tag === 'likely_personal'/);
  assert.match(bridge, /eventId TEXT PRIMARY KEY/, 'one forward row per ledger event');
  assert.ok(!/sendMessage|releaseAck|ACK_SENT|send_message|send_sms/.test(bridge.replace(/^\s*\/\/.*$/gm, '')), 'the bridge has no send path');
  const route = readFileSync(join(REPO_ROOT, 'solomon', 'server', 'src', 'routes', 'kingmaker-approver.ts'), 'utf8');
  assert.match(route, /post\('\/dms\/enable'[\s\S]{0,200}isHeadlessOwnerConsoleRequest\(req\)/, 'enable is owner-console only');
  const core = new RegExp(/export const STOP_FORWARDING = \/(.+)\/i;/.exec(bridge)?.[1] ?? '^$', 'i');
  const { STOP_FORWARDING } = ronin;
  assert.equal(STOP_FORWARDING.source, core.source, "the console pause is the core's");
  assert.match(src('governed-conversation-service.ts'), /isStopForwarding\(input\.transcript\)/, 'the core pauses on the spoken words too');
  assert.match(src('status-brief.ts'), /came\|come/, '"what came in" is the brief');
});

// The CRM task judge: answers the CRM's "is this task still current?" checks with the local decide() model, free, in the
// background. Kingmaker-only, advisory, and it can only call the two judge tools, so it never changes a task.
test('the imported engine has the task judge Kingmaker drives', { skip: (!imported && 'solomon/ not imported') }, () => {
  const judge = src('crm-task-judge.ts');
  assert.match(judge, /env\.SOLOMON_KINGMAKER_SEATS !== '1'/, 'inert unless Kingmaker set it');
  assert.match(judge, /callTool<TaskChecksReply>\('task_checks'/);
  assert.match(judge, /callTool\('task_check_answer'/);
  assert.match(judge, /lane: 'background'/, 'background lane: held while the owner is talking');
  assert.match(judge, /purpose: 'task-current'/, 'every decision is audited');
  assert.match(judge, /releaseDecider\(\)/, 'the model is unloaded after the burst');
  const tools = [...judge.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').matchAll(/callTool(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tools)].sort(), ['task_check_answer', 'task_checks'], 'only the two judge tools are ever called');
  assert.match(src('../index.ts'), /startupStep\('crm-task-judge'/, 'the server starts it');
});
