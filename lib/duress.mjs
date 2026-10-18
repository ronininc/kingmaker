// lib/duress.mjs — the duress ("dead man's") switch (the owner, 2026-10-16: "no kingmaker data remains whatsoever
// including any file or artifact — full wipe of his presence", like GrapheneOS's duress wipe).
//
// What this is, honestly: GrapheneOS's duress PIN does a full DATA wipe (a factory reset that makes everything
// cryptographically unrecoverable); the phone still boots and can be set up again. It does NOT destroy the hardware.
// This is the same: on the duress credential, Kingmaker exports a last CSV to a cloud place the owner is logged into,
// then ERASES ITS WHOLE PRESENCE on this Mac — the crypto keys first (so every sealed thing is unreadable at once, the
// real irreversibility), then its data folders, logs, artifacts, knowledge library, preferences and its own app bundle.
// Nothing of Kingmaker is left and nothing is recoverable. It never touches the hardware or anyone else's data, and it
// is not "track removal" for its own sake — it is the owner erasing their own tool under coercion.
//
// Safety rails (this thing is irreversible, so they matter):
//   • Ships DISARMED. Nothing wipes until the owner arms it and sets a SEPARATE duress credential on purpose.
//   • SPOKEN TRIGGERING IS KEPT ON PURPOSE: under coercion the owner may only be able to say it. The cost is that a
//     phrase heard by accident, or a line that contains it, could fire it, so the password must be 10+ characters (a
//     phrase of several words, not a word), must match the WHOLE utterance exactly, and the owner should pick something
//     nobody would say by chance. The password text is never echoed, logged or sent to any brain (lib/bar-guard.mjs).
//   • The panic fires only when armed AND the exact duress credential is given (constant-time compare of a salted hash)
//     — never on a mistyped normal password. An optional Touch-ID gate can be required on top.
//   • The crypto keys go first: even if a later step is interrupted, the sealed data is already unrecoverable.
//   • Every real effect — the CSV export, the key destruction, the file shred, the app removal — is an INJECTED dependency,
//     so tests exercise the whole sequence without deleting a single byte.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createKeychainSafeStorage } from './keychain-seal.mjs';
import { appBundleOf } from './integrity.mjs';
import { ronin } from './addons.mjs';

export const BUNDLE_ID = 'com.ronininc.solghost';

/** The shortest duress password accepted (was 6). It can be typed in the bar, sent from the phone, or SPOKEN. */
export const MIN_DURESS_PASSWORD = 10;

/** The crypto keys that make the sealed data readable: destroying these is the irreversibility (cryptographic erase). */
export const KEYCHAIN_ITEMS = Object.freeze([
  { service: 'Sol Ghost Owner Voice', account: 'owner-print-key', what: 'owner voiceprint seal' },
  { service: 'Ronin Automaton Wallet', account: 'automaton-wallet-key', what: 'automaton wallet seal' },
]);

/**
 * Every place Kingmaker keeps anything on this Mac — wiped in this order (keys already gone by now). Pure; `home`/`app`
 * injectable. The data home holds runtime/data, state, logs, the vault, the knowledge library, artifacts and the hidden
 * Files folder, so erasing it removes the owner's content and Kingmaker's own state together.
 */
export function footprintPaths({ home = homedir(), app = '/Applications/Kingmaker.app' } = {}) {
  return {
    data: [
      join(home, '.solomon-secure'),                               // the credentials vault and its key (SOLOMON_SECURE_ROOT)
      join(home, 'Library', 'Application Support', 'sol-ghost'),   // runtime/data, state, logs, vault, knowledge, Files, artifacts
      join(home, 'Library', 'Preferences', `${BUNDLE_ID}.plist`),  // the bar's UserDefaults
      join(home, 'Library', 'Caches', BUNDLE_ID),
      join(home, 'Library', 'HTTPStorages', BUNDLE_ID),
      join(home, 'Library', 'WebKit', BUNDLE_ID),
      join(home, 'Documents', 'Kingmaker'),                        // legacy, pre-tidy
      join(home, 'Pictures', 'Kingmaker'),
    ],
    app,   // the app bundle itself goes last
  };
}

const PBKDF = (password, salt) => scryptSync(String(password), salt, 32);

export function defaultDuressState() {
  return { armed: false, mode: 'live', requireTouchId: false, cloud: null, armedAt: null, salt: null, hash: null };
}

/**
 * The switch. deps (all injectable; the real-effect ones default to safe no-ops so nothing can wipe by accident):
 *   state           the state folder (duress.json lives here)
 *   exportCsv({csv, cloud})  → { ok, where } : send the last CSV to a logged-in cloud place; default: not configured
 *   destroyKeys(items)       → erase the Keychain crypto keys; default no-op (real impl: keychain-seal destroyKey)
 *   shred(paths)             → securely delete the file paths; default no-op (real impl: rm + rely on FileVault key erase)
 *   removeApp(path)          → delete the app bundle; default no-op
 *   touchId()                → gate the trigger behind Touch ID when required; default denies
 *   makeCsv()                → the CSV to export before wiping; default: a tiny manifest, the owner wires the real data
 */
export function createDuress({ state, exportCsv = async () => ({ ok: false, reason: 'no-cloud' }), destroyKeys = async () => ({}),
  shred = async () => ({}), removeApp = async () => ({}), touchId = async () => false, makeCsv = () => '', home = homedir(),
  app = '/Applications/Kingmaker.app', now = Date.now, random = randomBytes, log = () => {} } = {}) {
  if (!state) throw new Error('createDuress needs a state folder');
  const file = join(state, 'duress.json');
  const auditFile = join(state, 'duress-audit.jsonl');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  let st = { ...defaultDuressState(), ...read() };
  const save = () => { mkdirSync(state, { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(st, null, 1), { mode: 0o600 }); renameSync(tmp, file); };
  // Once a live wipe has shredded the data, nothing more is written to disk: an audit line would recreate the state
  // folder and leave panic metadata behind. Later steps still go to `log` (memory / the caller's console).
  let shredded = false;
  const audit = (event, extra = {}) => {
    log('duress', { event, ...extra });
    if (shredded) return;
    const line = { at: new Date(now()).toISOString(), event, ...extra };
    try { mkdirSync(state, { recursive: true }); } catch { /* */ }
    try { writeFileSync(auditFile, `${JSON.stringify(line)}\n`, { flag: 'a', mode: 0o600 }); } catch { /* the act still holds */ }
  };

  /** Is this the duress credential? Constant-time; false when disarmed or unset. */
  const matches = (password) => {
    if (!st.armed || !st.salt || !st.hash) return false;
    try {
      const got = PBKDF(password, Buffer.from(st.salt, 'base64'));
      const want = Buffer.from(st.hash, 'base64');
      return got.length === want.length && timingSafeEqual(got, want);
    } catch { return false; }
  };

  return {
    status: () => ({ armed: st.armed, mode: st.mode, requireTouchId: st.requireTouchId, cloud: st.cloud, armedAt: st.armedAt }),

    /**
     * Arm it: set a SEPARATE duress credential on purpose (never the normal password), the cloud place for the last CSV,
     * and whether a Touch-ID check is required too. `confirm` must be the literal "WIPE" so this can't be a slip.
     */
    arm({ password, cloud = null, requireTouchId = false, mode = 'live', confirm } = {}) {
      if (confirm !== 'WIPE') return { ok: false, reason: 'confirm must be the word WIPE' };
      if (typeof password !== 'string' || password.length < MIN_DURESS_PASSWORD) return { ok: false, reason: `set a distinct duress password (${MIN_DURESS_PASSWORD}+ characters), not your normal one` };
      const salt = random(16);
      st = { ...defaultDuressState(), armed: true, mode: mode === 'drill' ? 'drill' : 'live', requireTouchId: requireTouchId === true,
        cloud: cloud ? String(cloud).slice(0, 200) : null, armedAt: new Date(now()).toISOString(), salt: salt.toString('base64'), hash: PBKDF(password, salt).toString('base64') };
      save(); audit('arm', { mode: st.mode, requireTouchId: st.requireTouchId, cloud: st.cloud });
      return { ok: true, status: { armed: true, mode: st.mode } };
    },
    disarm() { st = defaultDuressState(); save(); audit('disarm'); return { ok: true }; },

    /** Just test the credential (e.g. a live login) without firing — for wiring that checks before deciding to panic. */
    isDuress: (password) => matches(password),

    /**
     * The panic. Fires ONLY when armed and the exact duress credential is given (and Touch ID, if required). In 'drill'
     * mode it runs the whole sequence against the injected deps but the real wipers are the caller's drill stubs, so a
     * rehearsal proves the wiring without destroying anything. Returns the step results. Irreversible in 'live' mode.
     */
    async panic({ password, viaFingerprint = false } = {}) {
      if (!st.armed) return { fired: false, reason: 'disarmed' };
      if (!matches(password)) return { fired: false, reason: 'not-the-duress-credential' };
      if (st.requireTouchId && !(viaFingerprint || await Promise.resolve(touchId()).catch(() => false))) return { fired: false, reason: 'touch-id-required' };
      audit('panic_start', { mode: st.mode });
      const steps = {};
      // 1) Last CSV out to a logged-in cloud place — best effort; the wipe happens whether or not it lands.
      try { steps.export = await exportCsv({ csv: makeCsv(), cloud: st.cloud }); } catch (e) { steps.export = { ok: false, reason: String(e?.message ?? e) }; }
      audit('export', steps.export);
      // 2) Destroy the crypto keys FIRST — from here the sealed data is already unrecoverable even if the rest is cut off.
      try { steps.keys = await destroyKeys([...KEYCHAIN_ITEMS, ...(ronin?.DURESS_KEYCHAIN_ITEMS ?? [])]); }  // an add-on's own keys too
       catch (e) { steps.keys = { ok: false, reason: String(e?.message ?? e) }; }
      audit('keys_destroyed', { ok: steps.keys?.ok !== false });
      // 3) Shred every file/folder of Kingmaker's presence.
      const fp = footprintPaths({ home, app });
      if (st.mode === 'live') shredded = true; // a drill keeps its audit trail; a live wipe leaves no file behind
      try { steps.shred = await shred(fp.data); } catch (e) { steps.shred = { ok: false, reason: String(e?.message ?? e) }; }
      audit('shred', { paths: fp.data.length });
      // 4) Remove the app bundle itself — Kingmaker is gone.
      try { steps.app = await removeApp(fp.app); } catch (e) { steps.app = { ok: false, reason: String(e?.message ?? e) }; }
      audit('app_removed', { path: fp.app });
      audit('panic_done', { mode: st.mode });
      return { fired: true, mode: st.mode, steps };
    },
  };
}

// ── The LIVE effects (the real wipe). Kept apart from the pure engine above so tests never import them; built only by
//    the bar/phone wiring. Belt-and-suspenders on the most destructive code in the app:
//    • It refuses to run from a source checkout (appBundleOf null) — only a real installed Kingmaker.app wipes.
//    • Every path is sanity-checked (safeToShred): it must carry Kingmaker's own marker and never be a bare root,
//      $HOME, /Applications, or ~/Library — so a wrong footprint entry can't delete the world.

/** Pure: may this path be shredded? Only Kingmaker's own marked paths, never a dangerous root. */
export function safeToShred(path, { home = homedir() } = {}) {
  const p = String(path || '').replace(/\/+$/, '');
  const banned = new Set(['', '/', home, '/Applications', '/Users', '/System', '/Library', join(home, 'Library'), join(home, 'Documents'), join(home, 'Pictures'), join(home, 'Desktop')]);
  if (!p.startsWith('/') || banned.has(p) || p.length < 8) return false;
  return /(\/sol-ghost(\/|$)|\/Kingmaker(\.app)?(\/|$)|com\.ronininc\.solghost)/.test(p) || p === join(home, '.solomon-secure');
}

/**
 * The real deps for createDuress, used only by the live bar/phone wiring. `cloudSend({csv,cloud})` carries the last CSV
 * to a logged-in cloud place (wired by the caller); without it the export is a no-op and the wipe still proceeds.
 */
export function liveDuressDeps({ home = homedir(), app = appBundleOf() || '/Applications/Kingmaker.app', cloudSend = null, log = () => {} } = {}) {
  const installed = Boolean(appBundleOf());
  const guard = (step) => { if (!installed) throw new Error(`duress ${step} refuses to run from a source checkout`); };
  return {
    makeCsv: () => `kingmaker-duress-wipe\nat,${new Date().toISOString()}\nhost,${hostname()}\n`,
    exportCsv: cloudSend ? async ({ csv, cloud }) => Promise.resolve(cloudSend({ csv, cloud })).catch((e) => ({ ok: false, reason: String(e?.message ?? e) })) : async () => ({ ok: false, reason: 'no cloud configured' }),
    destroyKeys: async (items) => {
      guard('key-wipe'); let removed = 0;
      for (const it of items) { try { if (createKeychainSafeStorage({ service: it.service, account: it.account }).destroyKey().removed) removed += 1; } catch { /* keep going */ } }
      log('duress_keys', { removed }); return { ok: true, removed };
    },
    shred: async (paths) => {
      guard('shred'); let count = 0;
      for (const p of paths) { if (!safeToShred(p, { home })) { log('duress_skip', { path: p }); continue; } try { rmSync(p, { recursive: true, force: true }); count += 1; } catch { /* keep going */ } }
      log('duress_shred', { count }); return { ok: true, count };
    },
    removeApp: async (a) => {
      guard('app-remove'); if (!/Kingmaker\.app\/?$/.test(String(a))) return { ok: false, reason: 'not the app bundle' };
      try { rmSync(a, { recursive: true, force: true }); return { ok: true }; } catch (e) { return { ok: false, reason: String(e?.message ?? e) }; }
    },
    touchId: async () => false, // Touch ID is done in the bar (Swift LocalAuthentication); it passes viaFingerprint in
  };
}
