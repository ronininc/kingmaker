// lib/k-office.mjs — K Office (Kingmaker 4.4, Phase 8, Slice 1): the office door.
//
// K Office is Kingmaker's paid command-center floor: an army of local deputies ("the bit army") doing jobs
// with Kingmaker's powers, each under a token Kingmaker minted for it. This module is the door the office
// hangs on — the seat registry, the seat tokens, and the office ledger. Design: K-OFFICE-DESIGN.md at the
// 4.4 root. NOT lib/office.mjs (that is the documents stack: Word/Excel/PowerPoint/PDF).
//
// The rules baked in here, none of them optional:
//   • The token IS the delegation: seat + capability scope + expiry. Verification FAILS CLOSED — a forged,
//     expired, revoked, unknown, or mis-scoped token verifies as exactly nothing.
//   • Only Kingmaker mints. mintSeatToken refuses any other mintedBy; there is no self-service path and no
//     MCP tool that mints (the MCP surface can read the office, never staff it — see K_OFFICE_TOOL below).
//   • NO seat executes trades. Money seats produce proposals and records only; no capability named
//     *:execute exists in any seat's scope, and minting one throws. Execution, when the owner approves a
//     proposal, is the owner's engines under the owner's credentials — never this module.
//   • The office secret is per-install state (0600, in Kingmaker's home), generated on first mint. It is
//     never in this repo, never in a token list, never in a tool result.
//
// Store layout (one folder, default Files/Office in Kingmaker's home):
//   office-secret.key  — the HMAC key (created on first mint, mode 0600)
//   seat-tokens.json   — { minted: [{ jti, seat, caps, iat, exp, mintedBy }], revoked: [jti] }
//   office-ledger.jsonl — append-only: mint / revoke / verify-refused events (audit-chain fold-in is Slice 3)

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeFolder } from './kingmaker-home.mjs';

export const K_OFFICE_SCHEMA = 'kingmaker.k-office/1';
const TOKEN_VERSION = 1;
const MINUTE = 60_000;

/**
 * The seat registry: every post in the office, as data. `engine` names the real binding (a lib module, an
 * engine_route destination, a catalog program, or an external system); `status` says honestly how wired the
 * binding is; `money.executesTrades` is false on every seat and stays false — see the header.
 */
export const OFFICE_SEATS = Object.freeze([
  {
    id: 'authority', title: 'Seeker — Kingmaker itself', kind: 'authority',
    engine: { kind: 'self', ref: 'kingmaker' },
    scope: [], maxMinutes: 0,
    money: { handlesMoney: false, executesTrades: false },
    status: 'live',
    note: 'The supervisor seat. Mints and revokes every token; never token-held itself.',
  },
  {
    id: 'kronos-desk', title: 'Kronos desk — trading signals', kind: 'engine',
    engine: { kind: 'tree', ref: 'solomon/server/src/runtime/trading/ + lib/automaton.mjs + catalog/kronos.json' },
    scope: ['signals:read', 'proposals:write'], maxMinutes: 24 * 60,
    money: { handlesMoney: true, executesTrades: false },
    status: 'binding-new',
    note: 'Forecasts and proposed actions only, behind the automaton rails (ships OFF, gate ON). A proposal '
      + 'executes nothing: it queues for the owner\'s tap, and any execution is the owner\'s engines under '
      + 'the owner\'s credentials. Trading priority: Kronos/Alpaca before Copy Trader.',
  },
  {
    id: 'market-analysts', title: 'Market analysts — research desk', kind: 'engine',
    engine: { kind: 'lib', ref: 'lib/trading-agents.mjs' },
    scope: ['research:read', 'reports:write'], maxMinutes: 24 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'binding-new',
    note: 'TradingAgents rates tickers (Buy…Sell) with the reports behind the rating. The engine has no '
      + 'order path by construction; this seat inherits that.',
  },
  {
    id: 'merchant-desk', title: 'Merchant desk — Clover ops', kind: 'engine',
    engine: { kind: 'lib', ref: 'lib/merchant.mjs' },
    scope: ['merchant:read', 'proposals:write'], maxMinutes: 12 * 60,
    money: { handlesMoney: true, executesTrades: false },
    status: 'binding-new',
    note: 'Dry-runs and diffs only. Applying a change to a live register is the owner\'s word.',
  },
  {
    id: 'crm-desk', title: 'CRM desk — the Seeker floor', kind: 'external',
    engine: { kind: 'external', ref: 'ronininc-crm (separate repo; Kingmaker is named Seeker there)' },
    scope: ['crm:read', 'crm:draft'], maxMinutes: 12 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'designed',
    note: 'Records, drafts and the job board. Anything leaving the CRM waits for the owner\'s approval, '
      + 'as the CRM already enforces.',
  },
  {
    id: 'outreach-desk', title: 'Outreach desk — emailer + deal flow', kind: 'external',
    engine: { kind: 'external', ref: 'auto-emailer repo; car-flipper / wholesale methods' },
    scope: ['outreach:draft', 'leads:read'], maxMinutes: 12 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'designed',
    note: 'Drafts outreach and works lead lists. Sending is a batch the owner approves; this seat never sends.',
  },
  {
    id: 'research-desk', title: 'Research desk', kind: 'engine',
    engine: { kind: 'engine_route', ref: 'research' },
    scope: ['research:read', 'reports:write'], maxMinutes: 24 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'binding-new',
    note: 'Governed web research through the engine\'s own route.',
  },
  {
    id: 'build-desk', title: 'Build desk — CodeGen', kind: 'engine',
    engine: { kind: 'engine_route', ref: 'create' },
    scope: ['build:propose', 'reports:write'], maxMinutes: 24 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'binding-new',
    note: 'Proposes builds through the engine; a build runs on the owner\'s go-ahead, as everywhere else.',
  },
  {
    id: 'rea-floor', title: 'REA floor — reverse-engineering analysis', kind: 'engine',
    engine: { kind: 'lib', ref: 'lib/rea.mjs' },
    scope: ['rea:inspect', 'reports:write'], maxMinutes: 24 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'binding-new',
    note: 'Reads candidate code/binaries before anything joins the arsenal. Clean-room doctrine holds.',
  },
  {
    id: 'fabrication-desk', title: 'Fabrication desk', kind: 'engine',
    engine: { kind: 'engine_route', ref: 'fabrication' },
    scope: ['fabrication:plan'], maxMinutes: 12 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'binding-new',
    note: 'Planning only. There is no machine-run path on this seat, ever.',
  },
  {
    id: 'documents-clerk', title: 'Documents clerk', kind: 'engine',
    engine: { kind: 'lib', ref: 'lib/office.mjs' },
    scope: ['documents:write'], maxMinutes: 12 * 60,
    money: { handlesMoney: false, executesTrades: false },
    status: 'binding-new',
    note: 'Word/Excel/PowerPoint/PDF files written by Kingmaker itself into its own folder.',
  },
]);

const SEAT_BY_ID = new Map(OFFICE_SEATS.map((s) => [s.id, s]));

/** A seat by id, or null. */
export const getSeat = (id) => SEAT_BY_ID.get(String(id ?? '')) ?? null;

/** The default office store folder: Files/Office inside Kingmaker's home. */
export const defaultOfficeDir = (opts = {}) => homeFolder('Office', opts);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/**
 * Open an office store over `dir` (created lazily, on first write). All state lives here and nowhere else;
 * pass a temp dir in tests. `now` is injectable for tests.
 */
export function openOfficeStore(dir = defaultOfficeDir(), { now = Date.now } = {}) {
  const secretFile = join(dir, 'office-secret.key');
  const tokensFile = join(dir, 'seat-tokens.json');
  const ledgerFile = join(dir, 'office-ledger.jsonl');

  const ensureDir = () => mkdirSync(dir, { recursive: true });
  const secret = () => {
    try { return readFileSync(secretFile, 'utf8').trim(); } catch { /* not minted yet */ }
    ensureDir();
    const s = randomBytes(32).toString('hex');
    writeFileSync(secretFile, s, { mode: 0o600 });
    return s;
  };
  const readTokens = () => {
    try { const t = JSON.parse(readFileSync(tokensFile, 'utf8')); return { minted: t.minted ?? [], revoked: t.revoked ?? [] }; }
    catch { return { minted: [], revoked: [] }; }
  };
  const writeTokens = (t) => { ensureDir(); writeFileSync(tokensFile, JSON.stringify(t, null, 2), { mode: 0o600 }); };
  const ledger = (event) => { try { ensureDir(); appendFileSync(ledgerFile, `${JSON.stringify({ at: now(), ...event })}\n`); } catch { /* the ledger is evidence, never a gate */ } };
  const sign = (payload) => createHmac('sha256', secret()).update(payload).digest();

  return Object.freeze({
    dir,
    now,
    _sign: sign, // internal: token signing only. The key itself is never returned by anything public.

    /**
     * Mint a seat token. Kingmaker only: `mintedBy` must be exactly 'kingmaker'. Capabilities must be a
     * subset of the seat's scope and may not include any *:execute capability (none exist; asking throws).
     * Duration is clamped to the seat's maxMinutes. Returns the token string — hand it to the deputy, once;
     * the store keeps only its claims.
     */
    mint({ seatId, capabilities, minutes, mintedBy } = {}) {
      if (mintedBy !== 'kingmaker') throw new Error('only Kingmaker mints seat tokens');
      const seat = getSeat(seatId);
      if (!seat) throw new Error(`unknown seat: ${seatId}`);
      if (seat.kind === 'authority') throw new Error('the authority seat is never token-held');
      const caps = [...new Set((capabilities ?? seat.scope).map(String))];
      if (!caps.length) throw new Error('a seat token needs at least one capability');
      for (const c of caps) {
        if (c.endsWith(':execute')) throw new Error(`capability refused: ${c} — no seat executes`);
        if (!seat.scope.includes(c)) throw new Error(`capability ${c} is outside the ${seat.id} seat's scope`);
      }
      const mins = Math.min(Math.max(1, Math.floor(minutes ?? seat.maxMinutes)), seat.maxMinutes);
      const iat = now();
      const claims = { v: TOKEN_VERSION, jti: randomBytes(9).toString('base64url'), seat: seat.id, caps, iat, exp: iat + mins * MINUTE };
      const payload = b64u(JSON.stringify(claims));
      const token = `${payload}.${b64u(sign(payload))}`;
      const t = readTokens();
      t.minted.push({ jti: claims.jti, seat: seat.id, caps, iat, exp: claims.exp, mintedBy });
      writeTokens(t);
      ledger({ type: 'mint', jti: claims.jti, seat: seat.id, caps, exp: claims.exp });
      return token;
    },

    /**
     * Verify a seat token, optionally for one capability. Fails closed: every problem — malformed, forged,
     * unknown, expired, revoked, mis-scoped — returns { ok: false, reason } and is ledgered. A token this
     * office never minted is unknown, however well-formed.
     */
    verify(token, { capability = null } = {}) {
      const refuse = (reason) => { ledger({ type: 'verify-refused', reason }); return { ok: false, reason }; };
      if (typeof token !== 'string' || !token.includes('.')) return refuse('malformed token');
      const [payload, sig] = token.split('.');
      let claims;
      try { claims = JSON.parse(unb64u(payload).toString('utf8')); } catch { return refuse('malformed claims'); }
      const expected = sign(payload);
      const got = unb64u(sig ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return refuse('bad signature');
      if (!claims || claims.v !== TOKEN_VERSION) return refuse('unknown token version');
      const seat = getSeat(claims.seat);
      if (!seat) return refuse('unknown seat');
      const t = readTokens();
      if (!t.minted.some((m) => m.jti === claims.jti)) return refuse('token not minted by this office');
      if (t.revoked.includes(claims.jti)) return refuse('token revoked');
      if (typeof claims.exp !== 'number' || now() > claims.exp) return refuse('token expired');
      if (capability && !(claims.caps ?? []).includes(capability)) return refuse(`capability ${capability} not in scope`);
      return { ok: true, claims, seat };
    },

    /** Revoke a token by jti. Returns true when a live minted token was revoked. */
    revoke(jti) {
      const t = readTokens();
      if (!t.minted.some((m) => m.jti === jti) || t.revoked.includes(jti)) return false;
      t.revoked.push(jti);
      writeTokens(t);
      ledger({ type: 'revoke', jti });
      return true;
    },

    /** Minted-token metadata (never token strings, never the secret), each with its live state. */
    listTokens() {
      const t = readTokens();
      const at = now();
      return t.minted.map((m) => ({
        ...m,
        state: t.revoked.includes(m.jti) ? 'revoked' : at > m.exp ? 'expired' : 'active',
      }));
    },
  });
}

/** The office manifest: the registry plus live token states, for the UI and phone surfaces. */
export function officeManifest(store = null) {
  const tokens = store ? store.listTokens() : [];
  return {
    schema: K_OFFICE_SCHEMA,
    seats: OFFICE_SEATS.map((s) => ({
      ...s,
      activeTokens: tokens.filter((t) => t.seat === s.id && t.state === 'active').length,
    })),
    tokens,
  };
}

/**
 * The office's tool definition — name, purpose, JSON schema — defined ONCE here and registered with the
 * MCP tool-calling layer in lib/mcp.mjs in the same pass (tool-wiring doctrine). Read-only by design:
 * this surface can look at the office; staffing it (mint/revoke) is Kingmaker's own act, never a client's.
 */
export const K_OFFICE_TOOL = Object.freeze({
  name: 'kingmaker_office',
  description: 'Look at Kingmaker\'s K Office: the seats (each a deputy post bound to a real engine, with its capability scope and money rule) '
    + 'and the seat tokens currently minted, by state. Read-only: this tool cannot mint, revoke, approve, or execute anything. '
    + 'No seat executes trades — money seats produce proposals for the owner\'s approval only.',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['seats', 'tokens'], description: 'Seats (the registry) or tokens (minted seat tokens by state). Default: seats.' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'K Office (read-only)', readOnlyHint: true, openWorldHint: false },
});

/** The payload behind kingmaker_office. `store` is injectable (tests, alternate homes). */
export function officeToolResult({ view = 'seats' } = {}, store = null) {
  const manifest = officeManifest(store);
  if (view === 'tokens') return { schema: manifest.schema, tokens: manifest.tokens, note: 'Token metadata only — token strings and the office secret never leave the office.' };
  return {
    schema: manifest.schema,
    seats: manifest.seats,
    note: 'Read-only. Kingmaker mints and revokes seat tokens; the owner approves proposals at the console or by phone. No seat executes trades.',
  };
}
