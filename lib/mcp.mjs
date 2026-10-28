// Kingmaker as an MCP control surface (stdio, newline-delimited JSON-RPC 2.0).
//
// Any MCP client — Claude, Codex, an IDE — can drive this Mac THROUGH Kingmaker: ask, plan, and propose
// app actions, which its engine governs and ghost-os carries out. The client is a local program to the engine
// (no launch nonce), so every side effect it asks for waits in the owner console for a human yes. There
// is deliberately no approve tool: an agent can never confirm its own proposal.
//
// The ArtCraft apps reach MCP clients the same way: artcraft_request is one sentence to the engine's governed
// ArtCraft engine (sandboxed, byte-verified, signed receipts), so a write is read back and waits for the owner.
// The apps' own `<app>-cli mcp` servers are never started or re-exported here: VectorCraft's attaches, with no
// flags, to an unauthenticated 127.0.0.1:7979 (often the owner's open app), and VectorCraft `screenshot` and
// DesignCraft `render_page` claim readOnlyHint yet write a file when given a path. What a request does is decided
// from its words (artcraft.mjs classifyCraftAsk) and by the engine, never from a tool's hint. Nothing here installs.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { artcraftDoctor, cancelProposal, controlStatus, health, pendingProposals, turn } from './client.mjs';
import { classifyCraftAsk, CRAFT_APP_IDS, CRAFT_APPS, craftApp, craftTurnText, LIGHTCRAFT_LIMITS } from './artcraft.mjs';
import { closestCapabilityLine, mapCounts, readDeviceMap } from './device-scan.mjs';
import { IPHONE_TOOLS, IPHONE_TOOL_NAMES, callIphoneTool } from './iphone-mcp.mjs';
import { auditText, mapText, planRun, routeTarget } from './rd-floor.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = Object.freeze([
  {
    name: 'kingmaker_turn',
    description: 'Say something to Kingmaker on this Mac (a question, or a command like "open Calculator and press 7"). '
      + 'Answers come back grounded or say they are not. App actions are PROPOSED only: they wait for the owner to approve them at the Kingmaker console. This tool cannot approve anything.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say, in plain words.' },
        conversationId: { type: 'string', description: 'Continue an earlier conversation (from a previous result).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'kingmaker_pending',
    description: 'List actions waiting for the owner\'s approval (redacted: a non-owner sees ids, origin, risk tier and status only).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'kingmaker_cancel',
    description: 'Cancel a pending proposal by id. Cancelling is always allowed; it is the safe direction.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'], additionalProperties: false },
  },
  {
    name: 'kingmaker_status',
    description: 'Is the Kingmaker runtime up, and is the control surface armed and enforcing?',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'device_capabilities',
    description: 'What on this Mac Kingmaker can drive and how (from its device scan): every app with its routes (its own CLI, an MCP server, '
      + 'Kingmaker\'s own engines, AppleScript, URL links, the Hands of Horus as the universal fallback), the gaps, the open-source tools proposed for them, '
      + 'and how many API keys are on the Mac by provider (never a key, never where it is). Read-only. Installing a tool or putting keys in the vault is the owner\'s word at Kingmaker; this surface cannot.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'Only this app (a word of its name).' } }, additionalProperties: false },
    annotations: { title: 'Device capabilities', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'artcraft_status',
    description: `Which of the seven ArtCraft apps (${CRAFT_APPS.map((a) => `${a.name}: ${a.serves}`).join('; ')}) Kingmaker can run on this Mac, `
      + 'pinned or refused, and the ArtCraft inbox their inputs are read from (with the files in it). Read-only. Installing is the owner\'s (kingmaker craft install <app>); this surface cannot install.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'ArtCraft apps: status', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'artcraft_request',
    description: 'Ask Kingmaker to run an ArtCraft app, in words (e.g. app "photocraft", request "make a carousel image from beach.jpg", says "Summer sale"). '
      + 'It goes through Kingmaker\'s governed ArtCraft engine: a sandbox with no network, outputs verified by their bytes, a signed receipt. Anything that makes a file is READ BACK and PROPOSED: '
      + 'it waits for the owner\'s word at Kingmaker, and this tool cannot approve it. Reading a PDF (PrintCraft) or probing a clip (FilmCraft) is answered now. '
      + `Inputs: name a file already in the ArtCraft inbox (artcraft_status lists it). FilmCraft and EffectCraft renders wait for the heavy slot. LightCraft: ${LIGHTCRAFT_LIMITS} `
      + 'The apps\' own CLIs and MCP servers are never run from here.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: [...CRAFT_APP_IDS], description: 'Which app.' },
        request: { type: 'string', description: 'What to make or read, in plain words (the app\'s usual job when empty).' },
        says: { type: 'string', description: 'Words the image, thumbnail or title card should say.' },
        conversationId: { type: 'string', description: 'Continue an earlier conversation (from a previous result).' },
      },
      required: ['app'],
      additionalProperties: false,
    },
    annotations: { title: 'ArtCraft: ask Kingmaker (writes are proposed)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'rd_floor',
    description: 'Kingmaker\'s R&D floor (the REA analysis engine): the five modules, the licence audit, which module a file routes to, or the exact plan for a run. '
      + 'Read-only. It does not start rea, download it, or approve anything. The owner runs a plan at the console: kingmaker rd run <module> <command> <absolute-path>.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['map', 'audit', 'route', 'plan'], description: 'map, audit, route a path, or plan a command.' },
        module: { type: 'string', description: 'For plan: analysis-core, mobile-apps, binary-low-level, network-runtime, or rebuild-verify.' },
        command: { type: 'string', description: 'For plan: a command from that module.' },
        target: { type: 'string', description: 'Absolute path. For route, the file. For plan, the artifact (repeat in targets for a second path).' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Absolute paths when a plan needs more than one.' },
        provider: { type: 'string', enum: ['ghidra', 'kuna'], description: 'Native engine. Ghidra when omitted. Hopper, IDA and JEB are refused.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { title: 'R&D floor (read-only plan)', readOnlyHint: true, openWorldHint: false },
  },
  // The owner's iPhone, through iPhone Mirroring on this Mac (iphone-bridge.mjs). Outbound waits for their Touch ID.
  ...IPHONE_TOOLS,
]);

/** The ArtCraft inbox's entries (names, kind, size), newest first, at most 100. [] when it is not there yet. */
export function listInbox(dir) {
  if (!dir) return [];
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.')).map((name) => {
      const st = statSync(join(dir, name));
      return { name, kind: st.isDirectory() ? 'folder' : 'file', bytes: st.isDirectory() ? null : st.size, mtimeMs: st.mtimeMs };
    }).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 100).map(({ mtimeMs, ...rest }) => rest);
  } catch { return []; }
}

/** A route engine's read-back lives in the asking conversation, and this client's go-ahead never counts there. */
export const READ_BACK_NOTE = 'Read back, not made. Nothing this client says can make it go: the owner makes it by asking Kingmaker for the same thing (by voice or at the console) and saying go ahead.';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

/** One tool call → MCP result. `deps` is injectable for tests. No call here ever sends the nonce. */
export async function callTool(name, args, deps = {}) {
  const { port, fetchImpl } = deps;
  const opts = fetchImpl ? { fetchImpl } : {};
  if (IPHONE_TOOL_NAMES.has(name)) return callIphoneTool(name, args, { bridge: deps.iphone });
  switch (name) {
    case 'kingmaker_turn': {
      const said = String(args?.text ?? '').trim();
      if (!said) return { ...text('text is required'), isError: true };
      const r = await turn(port, { text: said, conversationId: args?.conversationId, ...opts });
      let closestCapability;
      try { closestCapability = closestCapabilityLine((deps.readMap ?? readDeviceMap)(deps.mapFile), said, r.spoken) ?? undefined; } catch { closestCapability = undefined; }
      return text({
        spoken: r.spoken,
        closestCapability,
        conversationId: r.conversationId,
        awaitingOwnerApproval: r.confirmationRequired,
        proposalId: r.proposalId,
        executed: r.executed,
        note: r.readBack && !r.proposalId ? READ_BACK_NOTE
          : r.confirmationRequired ? 'Proposed. The owner approves or cancels it at the Kingmaker console; this client cannot.' : undefined,
      });
    }
    case 'device_capabilities': {
      const map = (deps.readMap ?? readDeviceMap)(deps.mapFile);
      if (!map) return text({ scanned: false, note: 'No device scan yet: it runs on Kingmaker\'s first start (or the owner runs kingmaker scan).' });
      const want = String(args?.app ?? '').trim().toLowerCase();
      const apps = (map.apps ?? []).filter((a) => !want || String(a.name).toLowerCase().includes(want) || (a.tokens ?? []).includes(want.replace(/[^a-z0-9]/g, '')));
      return text({
        scanned: map.scannedAt ?? map.startedAt, complete: map.complete === true, counts: mapCounts(map),
        hands: map.hands?.name ?? null,
        apps: apps.slice(0, 200).map((a) => ({ name: a.name, bundleId: a.bundleId || null, best: a.best, gap: a.gap, routes: (a.routes ?? []).map((r) => `${r.kind}:${r.via}`) })),
        proposals: (map.proposals ?? []).filter((p) => p.state === 'proposed' && (!want || String(p.app).toLowerCase().includes(want))).map((p) => ({ name: p.name, app: p.app, kind: p.kind, package: p.package, license: p.license, flags: p.flags, stars: p.stars, repo: p.repo, ownerAsk: `install ${p.name}` })),
        apiKeys: { found: map.keys?.found ?? 0, byProvider: map.keys?.byProvider ?? {}, freeApisWithoutKey: map.keys?.freeTier?.labels ?? [] },
        note: 'Installing and vault imports are the owner\'s word at Kingmaker; this client cannot ask for them.',
      });
    }
    case 'kingmaker_pending': {
      const r = await pendingProposals(port, opts);
      return text(r.json?.data ?? r.json ?? { status: r.status });
    }
    case 'kingmaker_cancel': {
      const r = await cancelProposal(port, String(args?.proposalId ?? ''), opts);
      return text(r.json?.data ?? { status: r.status });
    }
    case 'artcraft_status': {
      const r = await artcraftDoctor(port, opts);
      const rows = Array.isArray(r.json?.data) ? r.json.data : null;
      return text({
        apps: rows ? rows.map((a) => ({ app: a.app, name: a.name, state: a.state, ready: a.ok === true, pinned: a.pinned === true, serves: a.serves, verdict: a.verdict, ...(a.ok ? {} : { fix: `the owner runs: kingmaker craft install ${a.app}` }) })) : { status: r.status },
        inbox: deps.inbox ?? null,
        inboxEntries: (deps.listInbox ?? listInbox)(deps.inbox),
        lightcraft: LIGHTCRAFT_LIMITS,
      });
    }
    case 'artcraft_request': {
      const app = craftApp(args?.app);
      if (!app) return { ...text(`app must be one of: ${CRAFT_APP_IDS.join(', ')}`), isError: true };
      const asked = craftTurnText(app, String(args?.request ?? ''), { says: typeof args?.says === 'string' ? args.says : null });
      if (asked.error) return { ...text(asked.error), isError: true };
      const kind = classifyCraftAsk(app, asked.text);
      const r = await turn(port, { text: asked.text, conversationId: args?.conversationId, timeoutMs: 10 * 60_000, ...opts });
      const output = r.raw?.data?.output;
      return text({
        asked: asked.text,
        kind,
        spoken: r.spoken,
        conversationId: r.conversationId,
        awaitingOwnerApproval: r.confirmationRequired,
        proposalId: r.proposalId,
        executed: r.executed,
        outputs: output && /^artcraft_job/.test(String(output.kind ?? '')) ? { status: output.status, files: (output.outputs ?? []).map(({ role, mime, bytes, sha256, url }) => ({ role, mime, bytes, sha256, url })), receiptUrl: output.receiptUrl ?? null } : undefined,
        ownerAsk: r.confirmationRequired ? asked.text : undefined,
        note: r.readBack && !r.proposalId ? READ_BACK_NOTE
          : r.confirmationRequired ? 'Proposed. Only the owner\'s word at Kingmaker makes it; this client cannot approve it.' : undefined,
      });
    }
    case 'rd_floor': {
      const action = String(args?.action ?? 'map');
      if (action === 'map') return text(mapText());
      if (action === 'audit') return text(auditText());
      if (action === 'route') return text(routeTarget(args?.target));
      if (action === 'plan') {
        const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
        return text(planRun({ module: args?.module, command: args?.command, targets, provider: args?.provider }));
      }
      return { ...text('action must be map, audit, route or plan'), isError: true };
    }
    case 'kingmaker_status': {
      const [h, c] = await Promise.all([health(port, opts).catch((e) => ({ error: String(e.message) })), controlStatus(port, opts).catch((e) => ({ error: String(e.message) }))]);
      return text({ health: h.json?.data ?? h, control: c.json?.data ?? c });
    }
    default:
      return { ...text(`unknown tool: ${name}`), isError: true };
  }
}

/** JSON-RPC message → response (or null for notifications). */
export async function handleMessage(msg, deps) {
  const { id, method, params } = msg ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null; // notifications (initialized, cancelled) need no answer
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kingmaker', version: deps.version ?? '0.1.0' },
        instructions: 'Kingmaker on this Mac, governed. You may ask and propose; only the owner approves, at the Kingmaker console. The R&D floor (rd_floor) plans an analysis; only the owner runs it with kingmaker rd. The ArtCraft apps (artcraft_status, artcraft_request) run only through Kingmaker: a write is proposed and waits for the owner. the owner\'s iPhone: see-phone-screen, then tap-phone / type-on-phone / press-phone-button / swipe-phone / open-phone-app; call-from-phone and send-imessage-to-contact reach only people in their Contacts and wait for their Touch ID.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try { return reply(await callTool(params?.name, params?.arguments ?? {}, deps)); } catch (error) {
        return reply({ ...text(`Kingmaker's engine is not reachable on port ${deps.port}: ${error?.message || error}. Start it with: kingmaker start`), isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function serveStdio(deps, { input = process.stdin, output = process.stdout } = {}) {
  let buffer = '';
  // Calls still answering when the client closes stdin are answered before this resolves (a piped client).
  const inFlight = new Set();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    const work = handleChunk(chunk);
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  });
  async function handleChunk(chunk) {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`); continue; }
      const res = await handleMessage(msg, deps);
      if (res) output.write(`${JSON.stringify(res)}\n`);
    }
  }
  return new Promise((resolve) => input.once('end', () => { void Promise.allSettled([...inFlight]).then(() => resolve()); }));
}
