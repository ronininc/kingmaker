// lib/automaton.mjs — the gated supervisor for Conway-Research/automaton, run as a Kronos-vertical connector (the owner,
// 2026-10-15: "its an open source program dawg youre just giving kingmaker a cnnector for it so i dont have to do so
// manually", and: "Include the gate-off toggle too: ships off, needs a second confirmation and a spend cap, then
// automaton acts autonomously. I approve building that option.").
//
// automaton is someone else's autonomous agent: it can spend and it can change itself. So Kingmaker never lets it run
// loose. It runs it behind rails that live HERE, in Kingmaker's own state folder and process — never inside automaton,
// where automaton could edit them:
//
//   • Off by default. Both the agent and the gate-off toggle ship off.
//   • A spend cap (total + optional daily) is required before it can start — no cap, no start — and is enforced outside
//     automaton. Every spend is accounted against the cap even in dry-run, so a rehearsal is faithful.
//   • The gate (default): every money action AND every self-modification goes to Kingmaker's approval gate first
//     (consent to the owner's phone, lib/owner-call.mjs / lib/phone-ring.mjs). Replication is never allowed.
//   • The gate-off toggle: off by default; turning it off needs a required cap AND a second confirmation. Then money
//     actions inside the cap run autonomously — but self-modification still asks, and replication is still refused.
//   • Real funds only in 'live' mode, which the owner sets at the console; 'dry-run' (default) and 'testnet' never move
//     real money, whatever an action asks for.
//   • The kill switch ("stop approving", said or typed — lib/approvals.mjs isStopApproving) stops automaton and every
//     child, freezes all spending, and puts the gate back on. Clearing it is the owner's own typed act.
//   • Wallet keys are sealed in this Mac's login Keychain (lib/keychain-seal.mjs), never on disk beside the state.
//   • Every decision is in the audit log (shown in Kingmaker and the Ronin dashboard); problems go to the phone.
//
// The weights of this module are code, so Ronin's signature seals them and only the owner commits changes (the
// governance rule, 2026-10-15). The pins below are the integrity anchor: a git commit hash is a checksum of the whole
// tree, so cloning automaton at its pinned commit verifies every byte. Conway's skills carry no licence, so they are
// never bundled or republished in Ronin's Resources — they are fetched from Conway on each Mac when the owner enables
// them, at the pinned commit.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isStopApproving } from './kill-switch.mjs';
import { createKeychainSafeStorage } from './keychain-seal.mjs';

/** The pinned sources. A commit hash anchors the whole tree; verified on GitHub 2026-10-15. */
export const AUTOMATON_SOURCES = Object.freeze({
  program: Object.freeze({
    repo: 'Conway-Research/automaton', url: 'https://github.com/Conway-Research/automaton',
    commit: 'd8f816881fd24b6f5e3d616e59edec387a447667', license: 'MIT',
    bundled: true, note: 'MIT: the LICENSE is kept with any copy. Cloned at this commit, which checksums the tree.',
  }),
  skills: Object.freeze({
    repo: 'Conway-Research/skills', url: 'https://github.com/Conway-Research/skills',
    commit: '54df68e6f0e0ca7ad5df586ec109f6b7b4b9ffee', license: null,
    bundled: false, fetchOnEnable: true, note: 'No licence on the repo: never bundled, never in Ronin Resources. Fetched from Conway on this Mac when enabled, at this commit.',
  }),
});

/** Wallet keys live in this Mac's login Keychain, in their own item (never the owner-voice item). */
export const WALLET_SERVICE = 'Ronin Automaton Wallet';
export const WALLET_ACCOUNT = 'automaton-wallet-key';

/** The modes. Only 'live' may move real funds; the others simulate, whatever an action asks. */
export const MODES = Object.freeze(['dry-run', 'testnet', 'live']);

/**
 * Pure: the exact, pinned steps to put automaton on a Mac — never run here, handed to the owner's explicit enable. The
 * program is cloned and checked out at its pinned commit (which checksums the tree), then REA reads it like any repo
 * connector (lib/connectors.mjs, kind 'repo') before it may run. Conway's skills carry no licence, so they are fetched
 * only when the owner enables them, at their pinned commit, into the Mac's own folder — never bundled, never in Ronin's
 * public Resources. → { program, skills } step lists.
 */
export function installPlan({ dir = '~/Library/Application Support/sol-ghost/kronos' } = {}) {
  const base = String(dir).replace(/\/+$/, '');
  const clone = (src, into) => [
    `git clone --no-checkout ${src.url} ${into}`,
    `git -C ${into} fetch --depth 1 origin ${src.commit}`,
    `git -C ${into} checkout --detach ${src.commit}`,
    `git -C ${into} rev-parse HEAD   # must equal ${src.commit}`,
  ];
  const programDir = `${base}/automaton`, skillsDir = `${base}/skills`;
  return {
    program: { dir: programDir, pinned: AUTOMATON_SOURCES.program.commit, license: AUTOMATON_SOURCES.program.license,
      steps: clone(AUTOMATON_SOURCES.program, programDir),
      then: `Connect it as a repo connector (addConnector kind 'repo', path ${programDir}); REA reads it first. Run it only under createAutomaton's rails.` },
    skills: { dir: skillsDir, pinned: AUTOMATON_SOURCES.skills.commit, license: AUTOMATON_SOURCES.skills.license, fetchOnEnable: true,
      steps: clone(AUTOMATON_SOURCES.skills, skillsDir),
      note: 'No licence: fetched from Conway on this Mac only when enabled, at the pinned commit; never bundled or republished.' },
  };
}
/** The kinds an action can be. 'replicate' is never allowed; 'self-mod' always asks. */
export const ACTION_KINDS = Object.freeze(['spend', 'trade', 'transfer', 'withdraw', 'self-mod', 'replicate', 'other']);
const SPENDING = new Set(['spend', 'trade', 'transfer', 'withdraw']);

const CENTS = (c) => (Number.isFinite(c) ? `$${(c / 100).toFixed(2)}` : '$?');
const intCents = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Pure: a fresh, safe default — off, gate on, dry-run, no cap. */
export function defaultAutomatonState() {
  return { enabled: false, gateMode: 'on', mode: 'dry-run', caps: { totalCents: 0, dailyCents: 0 }, replication: false, killed: false, killReason: null, armedAt: null };
}

/** Pure: what has been spent, in total and on the current UTC day, from the ledger's entries. */
export function spentFrom(entries, nowMs = Date.now()) {
  const today = utcDay(nowMs);
  let totalCents = 0, todayCents = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const c = intCents(e?.cents); totalCents += c;
    if (utcDay(Date.parse(String(e?.at ?? '')) || nowMs) === today) todayCents += c;
  }
  return { totalCents, todayCents };
}

/**
 * Pure: may `cents` be spent now, given the caps and what is already spent? → null when it may, or a refusal reason.
 * The cap is required: with no total cap, nothing may spend.
 */
export function capCheck({ cents, caps, spent }) {
  const want = intCents(cents);
  if (!caps || intCents(caps.totalCents) <= 0) return 'no-cap';
  if (want <= 0) return null;
  if (spent.totalCents + want > intCents(caps.totalCents)) return 'total-cap';
  if (intCents(caps.dailyCents) > 0 && spent.todayCents + want > intCents(caps.dailyCents)) return 'daily-cap';
  return null;
}

const REFUSALS = {
  killed: 'the kill switch is on (clear it at the console to run again)',
  disabled: 'automaton is off',
  'replication-off': 'replication is never allowed',
  'no-cap': 'no spend cap is set (set a cap first — no cap, no start)',
  'total-cap': 'it would pass the total spend cap',
  'daily-cap': 'it would pass the daily spend cap',
  'not-live-mode': 'real funds are refused outside live mode',
  declined: 'the owner did not approve it',
  'bad-action': 'the action was not understood',
};

function normalizeAction(action) {
  const kind = ACTION_KINDS.includes(action?.kind) ? action.kind : 'other';
  return { kind, cents: intCents(action?.cents), summary: String(action?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    ref: String(action?.ref ?? '').slice(0, 120), realFunds: action?.realFunds === true };
}

/**
 * The supervisor. deps (all injectable for tests):
 *   state            the state folder (automaton.json / automaton-ledger.json / automaton-audit.jsonl live under it)
 *   approve(action)       the per-action approval gate → truthy to allow (consent to the owner's phone); default refuses
 *   gateOffConsent({…})   the OUT-OF-BAND owner consent to turn the gate off (e.g. an owner-call "say yes"); default refuses
 *   killChildren()        stop automaton and everything it started; default no-op
 *   alert(line)           a problem to the owner's phone (PROBLEMS ONLY); default no-op
 *   keychain              a safe-storage instance for the wallet key; default Kingmaker's Keychain sealer
 *   now()                 the clock
 *
 * Returns TWO facades so the agent can never reach the owner's controls (the 2026-10-15 audit, H7): `owner` holds every
 * authority (cap, mode, enable, gate, clear-kill, wallet) and is wired ONLY to the owner's console; `agent` holds just
 * requestAction, with no way to pass its own approver. The kill switch and read-only views are shared (stopping is
 * fail-safe, so exposing it widely is safe).
 */
export function createAutomaton({ state, approve = async () => false, gateOffConsent = async () => false, killChildren = async () => {}, alert = () => {},
  keychain = null, now = Date.now, log = () => {} } = {}) {
  if (!state) throw new Error('createAutomaton needs a state folder');
  const file = join(state, 'automaton.json');
  const ledgerFile = join(state, 'automaton-ledger.json');
  const auditFile = join(state, 'automaton-audit.jsonl');

  const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
  const writeJson = (f, obj) => { mkdirSync(state, { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 }); renameSync(tmp, f); };

  let st = { ...defaultAutomatonState(), ...readJson(file, {}) };
  st.caps = { totalCents: intCents(st.caps?.totalCents), dailyCents: intCents(st.caps?.dailyCents) };
  st.replication = false; // never persisted true, whatever is on disk
  const save = () => writeJson(file, st);

  const ledger = () => readJson(ledgerFile, { entries: [] });
  const spent = () => spentFrom(ledger().entries, now());
  const audit = (event, extra = {}) => {
    const line = { at: new Date(now()).toISOString(), event, ...extra };
    try { mkdirSync(state, { recursive: true }); appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 }); } catch { /* the decision still holds */ }
    log('automaton', { event, ...extra });
    return line;
  };
  const refuse = (a, reason) => { audit('refuse', { kind: a.kind, cents: a.cents, reason, ref: a.ref }); return { ok: false, reason, why: REFUSALS[reason] ?? reason }; };
  const record = (a, how) => {
    if (a.cents > 0 && SPENDING.has(a.kind)) { const l = ledger(); l.entries = [...(l.entries || []).slice(-9999), { at: new Date(now()).toISOString(), cents: a.cents, kind: a.kind, ref: a.ref, mode: st.mode, how }]; writeJson(ledgerFile, l); }
    audit(how, { kind: a.kind, cents: a.cents, ref: a.ref, mode: st.mode });
    return { ok: true, how };
  };

  const state_ = () => ({ ...st, caps: { ...st.caps } });

  /** The owner's view: safe to show in the console and the dashboard. */
  const status = () => {
    const s = spent();
    return {
      enabled: st.enabled, killed: st.killed, killReason: st.killReason, gateMode: st.gateMode, mode: st.mode,
      caps: { ...st.caps }, spent: s, armedAt: st.armedAt,
      line: st.killed ? `automaton: STOPPED (kill switch — ${st.killReason || 'owner'}); clear it at the console`
        : !st.enabled ? `automaton: off${st.caps.totalCents ? `; cap ${CENTS(st.caps.totalCents)}` : '; no cap set'}`
        : `automaton: on, gate ${st.gateMode}, ${st.mode}; spent ${CENTS(s.totalCents)} of ${CENTS(st.caps.totalCents)}${st.caps.dailyCents ? ` (today ${CENTS(s.todayCents)} of ${CENTS(st.caps.dailyCents)})` : ''}`,
    };
  };

  // ── owner-console controls (never reachable by automaton) ──
  const setCap = ({ totalCents, dailyCents } = {}) => {
    st.caps = { totalCents: intCents(totalCents), dailyCents: intCents(dailyCents) };
    audit('cap', { totalCents: st.caps.totalCents, dailyCents: st.caps.dailyCents }); save();
    return { ok: true, caps: { ...st.caps } };
  };
  const setMode = (mode) => {
    if (!MODES.includes(mode)) return { ok: false, reason: 'bad-mode', why: `mode is one of ${MODES.join(', ')}` };
    st.mode = mode; audit('mode', { mode }); save();
    return { ok: true, mode };
  };
  const enable = () => {
    if (st.killed) return { ok: false, reason: 'killed', why: REFUSALS.killed };
    if (intCents(st.caps.totalCents) <= 0) return { ok: false, reason: 'no-cap', why: REFUSALS['no-cap'] };
    st.enabled = true; st.armedAt = new Date(now()).toISOString(); audit('enable', { gateMode: st.gateMode, mode: st.mode, caps: st.caps }); save();
    return { ok: true };
  };
  const disable = () => { st.enabled = false; audit('disable'); save(); return { ok: true }; };

  /**
   * The gate-off toggle. 'on' is always allowed. 'off' ships off and needs BOTH a cap AND an OUT-OF-BAND owner consent
   * (gateOffConsent — e.g. an owner-call "say yes"), never a token this call hands back, so it cannot be self-serviced.
   */
  const setGateMode = async (mode, { totalCents, dailyCents } = {}) => {
    if (mode === 'on') { st.gateMode = 'on'; audit('gate', { gateMode: 'on' }); save(); return { ok: true, gateMode: 'on' }; }
    if (mode !== 'off') return { ok: false, reason: 'bad-mode', why: "gate is 'on' or 'off'" };
    if (totalCents != null) st.caps = { totalCents: intCents(totalCents), dailyCents: intCents(dailyCents ?? st.caps.dailyCents) };
    if (intCents(st.caps.totalCents) <= 0) return { ok: false, reason: 'no-cap', why: 'gate-off needs a spend cap (no cap, no autonomy)' };
    const consented = await Promise.resolve(gateOffConsent({ capCents: st.caps.totalCents })).catch(() => false);
    if (!consented) return { ok: false, needsConsent: true, caps: { ...st.caps },
      says: `Turning the gate OFF lets automaton spend up to ${CENTS(st.caps.totalCents)} on its own. It needs your out-of-band confirmation.` };
    st.gateMode = 'off'; st.armedAt = new Date(now()).toISOString();
    audit('gate', { gateMode: 'off', caps: st.caps }); alert(`automaton gate turned OFF: autonomous up to ${CENTS(st.caps.totalCents)}`); save();
    return { ok: true, gateMode: 'off', caps: { ...st.caps } };
  };
  const clearKill = () => { st.killed = false; st.killReason = null; st.enabled = false; audit('clear-kill'); save(); return { ok: true }; };
  const wallet = () => keychain || createKeychainSafeStorage({ service: WALLET_SERVICE, account: WALLET_ACCOUNT });

  // ── the kill switch (fail-safe: only ever STOPS, so it is shared, not owner-gated) ──
  const stop = async (reason = 'owner') => {
    st.killed = true; st.killReason = String(reason).slice(0, 120); st.gateMode = 'on'; save();
    await Promise.resolve(killChildren()).catch(() => {});
    audit('kill', { reason: st.killReason }); alert(`automaton stopped (${st.killReason}); spending frozen, gate back on`);
    return { ok: true };
  };
  const onText = (text) => { if (isStopApproving(text)) { stop('said: stop approving'); return true; } return false; };

  /**
   * The agent-facing surface — the ONLY thing automaton calls. It cannot pass its own approver: the per-action gate is
   * the construction-time `approve`. Spending is accounted against the cap in every mode; real funds are refused outside
   * live mode; self-modification always asks; replication is always refused. The cap is re-checked AFTER approval too, so
   * two requests that overlap the approval await can't both slip past one cap (H7/M8).
   */
  const requestAction = async (action) => {
    const a = normalizeAction(action);
    if (st.killed) return refuse(a, 'killed');
    if (!st.enabled) return refuse(a, 'disabled');
    if (a.kind === 'replicate') return refuse(a, 'replication-off');
    if (a.realFunds && st.mode !== 'live') return refuse(a, 'not-live-mode');
    if (SPENDING.has(a.kind)) { const reason = capCheck({ cents: a.cents, caps: st.caps, spent: spent() }); if (reason) return refuse(a, reason); }
    else if (intCents(st.caps.totalCents) <= 0) return refuse(a, 'no-cap'); // nothing runs without a cap in place
    audit('request', { kind: a.kind, cents: a.cents, ref: a.ref, gateMode: st.gateMode });
    const mustApprove = a.kind === 'self-mod' || st.gateMode === 'on';
    if (!mustApprove) return record(a, 'auto');
    const ok = await Promise.resolve(approve(a)).catch(() => false);
    if (!ok) return refuse(a, 'declined');
    // The ledger (and the kill switch) may have moved while we awaited approval — re-check before recording.
    if (st.killed) return refuse(a, 'killed');
    if (SPENDING.has(a.kind)) { const reason = capCheck({ cents: a.cents, caps: st.caps, spent: spent() }); if (reason) return refuse(a, reason); }
    return record(a, 'approve');
  };

  return {
    sources: AUTOMATON_SOURCES,
    state: state_,
    status,
    onText,
    stop,
    /** Every authority. Wire this to the owner's console ONLY. */
    owner: { setCap, setMode, enable, disable, setGateMode, clearKill, wallet },
    /** The automaton-facing surface. This is all the agent ever gets. */
    agent: { requestAction },
  };
}
