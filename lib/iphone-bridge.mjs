// THE iPHONE BRIDGE (operator 2026-10-13 build order "iPhone Control Bridge"): The owner's ONE iPhone, driven from their
// Mac, local only, $0. Agents reach it through Kingmaker's MCP registry (lib/mcp.mjs: see-phone-screen, tap-phone,
// type-on-phone, press-phone-button, swipe-phone, open-phone-app, call-from-phone, send-imessage-to-contact).
//
// How (all Apple-native, no jailbreak, no developer account, no cloud):
//   see    iPhone Mirroring (macOS 15+) shows the phone in a Mac window; /usr/sbin/screencapture -l grabs that window
//          and Apple Vision reads its text (app/iphone-helper). Every element comes back with tap coordinates.
//   act    CGEvent clicks, drags and keystrokes into that window (iPhone Mirroring turns them into touches and typing).
//          Taps are screen-aware: "tap Settings" finds Settings on the screen it just read, taps it, and reads the
//          screen again so the agent sees what changed (the see → decide → act loop; runLoop() closes it locally).
//   call   macOS "Calls from iPhone" (Continuity): a tel: link, carried by the phone's SIM.
//   text   Messages.app (AppleScript): iMessage, or SMS through the iPhone's Text Message Forwarding.
// Pattern reference: kevinbadi/Kevs-iOS-Agents (Apache-2.0) and jfarcand/mirroir-mcp (Apache-2.0) for the
// screen-aware loop over iPhone Mirroring; no code is copied from either.
//
// Governance:
//   • Calls and messages go through iphone-policy.mjs decideOutbound(): Contacts only, the CRM do-not-call list,
//     and the owner's Touch ID per action unless they trusted that contact themself. There is no approve tool.
//   • Raw input is screen-guarded: on a password / code / payment screen the bridge stops and hands back to the owner;
//     typing into (or sending from) what looks like a message box needs their Touch ID too.
//   • Wallet and Passwords are never opened.
//   • No network: the only fetch in the bridge is the owner's explicit `dnc sync` (iphone-dnc.mjs) and the optional
//     local decider at 127.0.0.1 (Ollama). See README-iphone-bridge.md for the proof.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyScreen, decideOutbound, matchContacts, secretInText } from './iphone-policy.mjs';
import { loadDnc } from './iphone-dnc.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER_SOURCE = join(REPO, 'app', 'iphone-helper', 'main.swift');
export const resolveHelper = (env = process.env) => String(env.KINGMAKER_IPHONE_HELPER || join(REPO, 'dist', 'kingmaker-iphone-helper'));
export const iphoneDir = (paths) => join(paths.state, 'iphone');

export const BLOCKED_APPS = /^(wallet|passwords?|apple pay|keychain)$/i;
// Apps where typed text can reach another person. Typing or pressing Return in them needs the owner's Touch ID, whether
// or not OCR can see the message box (a thread's input field often reads as nothing).
export const MESSAGING_APPS = /^(messages|imessage|phone|facetime|mail|gmail|outlook|whatsapp|instagram|messenger|facebook|telegram|signal|slack|discord|snapchat|x|twitter|threads|linkedin|tiktok|reddit|teams|google voice|skype|wechat|line|viber|kik|hinge|tinder|bumble)$/i;
export const SEND_WORDS = /^(send|post|reply|call|facetime|share|submit|pay|buy|confirm|place order)$/i;
export const BUTTONS = Object.freeze({ home: 'cmd+1', 'app-switcher': 'cmd+2', spotlight: 'cmd+3', return: 'return', delete: 'delete', escape: 'escape', tab: 'tab', up: 'up', down: 'down', left: 'left', right: 'right' });
const LEAVE_BUTTONS = new Set(['home', 'app-switcher', 'escape']);

export const MESSAGES_SCRIPT = `on run argv
  set theHandle to item 1 of argv
  set theText to item 2 of argv
  set svcType to item 3 of argv
  tell application "Messages"
    if svcType is "SMS" then
      set svc to 1st account whose service type = SMS
    else
      set svc to 1st account whose service type = iMessage
    end if
    try
      set p to participant theHandle of svc
    on error
      set p to buddy theHandle of svc
    end try
    send theText to p
  end tell
  return "handed to Messages"
end run`;

// Contacts through Contacts.app (Automation) when the host app cannot be given Contacts access directly (a CLI
// helper under a host with no Contacts usage string is denied without a prompt). Four bulk Apple events, local.
export const CONTACTS_JXA = `function run() {
  const p = Application('Contacts').people;
  const ids = p.id(), names = p.name(), phones = p.phones.value(), emails = p.emails.value();
  return JSON.stringify(ids.map((id, i) => ({ id: id, name: names[i] || '', phones: phones[i] || [], emails: emails[i] || [] })));
}`;

// Best effort: macOS asks "Call <number>?" after a tel: link; the owner already said yes with Touch ID, so press Call.
export const CALL_BUTTON_SCRIPT = `tell application "System Events"
  repeat 24 times
    repeat with procName in {"NotificationCenter", "FaceTime"}
      try
        tell process procName
          repeat with w in windows
            set bs to (every button of (entire contents of w) whose name is "Call")
            if bs is not {} then
              click item 1 of bs
              return "pressed"
            end if
          end repeat
        end tell
      end try
    end repeat
    delay 0.25
  end repeat
  return "not-found"
end tell`;

export function runProcess(cmd, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const short = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const signature = (screen) => (screen?.elements ?? []).map((e) => e.text).join('|');

/** The OCR element to tap for `text`: exact (case-insensitive) first, then contains; top-to-bottom. Pure. */
export function findTarget(elements, text, index = 0) {
  const want = String(text ?? '').trim().toLowerCase();
  if (!want) return null;
  const order = (a, b) => a.y - b.y || a.x - b.x;
  const exact = elements.filter((e) => e.text.trim().toLowerCase() === want).sort(order);
  const loose = exact.length ? exact : elements.filter((e) => e.text.toLowerCase().includes(want)).sort(order);
  return loose[Math.max(0, Number(index) || 0)] ?? null;
}

/** Helper OCR items (fractions) → elements in window points, center-tappable. Pure. */
export function toElements(items, win, minConf = 0.3) {
  return (items ?? []).filter((i) => i && typeof i.text === 'string' && i.text.trim() && (i.conf ?? 1) >= minConf).map((i) => ({
    text: i.text.trim(),
    x: Math.round(win.w * (i.x + i.w / 2)), y: Math.round(win.h * (i.y + i.h / 2)),
    box: [Math.round(win.w * i.x), Math.round(win.h * i.y), Math.round(win.w * i.w), Math.round(win.h * i.h)],
    conf: Math.round((i.conf ?? 1) * 100) / 100,
  }));
}

export function createBridge({ stateDir, helper = resolveHelper(), run = runProcess, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), confirm, dncFile, settleMs = 700 } = {}) {
  if (!stateDir) throw new Error('createBridge needs a stateDir');
  const screensDir = join(stateDir, 'screens');
  const logFile = join(stateDir, 'actions.jsonl');
  const contextFile = join(stateDir, 'context.json');
  // What the bridge last put on screen: 'home', an app name, or unknown. Unknown (fresh connect, app switcher, a tap
  // that may have opened something) counts as a messaging app for typing: fail closed.
  const readContext = () => { try { return JSON.parse(readFileSync(contextFile, 'utf8')).app ?? null; } catch { return null; } };
  const writeContext = (app) => { try { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); writeFileSync(contextFile, JSON.stringify({ app, at: new Date(now()).toISOString() }), { mode: 0o600 }); } catch { /* unknown is the safe default */ } };
  const typingRisk = (screen) => {
    const app = readContext();
    if (screen.screen === 'compose') return 'what looks like a message box';
    if (!app) return 'an app I did not open myself';
    if (app !== 'home' && MESSAGING_APPS.test(app)) return `${app}, a messaging app`;
    return null;
  };
  const snapshotFile = dncFile ?? join(stateDir, 'dnc-snapshot.json');

  async function h(args, input) {
    if (!existsSync(helper)) throw new Error(`The iPhone helper is not built yet: kingmaker iphone build (${helper})`);
    const r = await run(helper, args, input === undefined ? {} : { input });
    let j;
    try { j = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}'); } catch { j = { ok: false, error: r.stderr.trim() || 'helper gave no answer' }; }
    return j;
  }
  async function must(args, input) {
    const j = await h(args, input);
    if (!j.ok) throw new Error(j.error || `helper ${args[0]} failed`);
    return j;
  }
  function audit(entry) {
    try { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); appendFileSync(logFile, `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`, { mode: 0o600 }); } catch { /* the log never blocks the phone */ }
  }
  /** The owner's presence, per action: Touch ID or their login password, in the macOS dialog. */
  const ownerConfirms = confirm ?? (async (reason) => {
    const j = await h(['auth', reason.slice(0, 220), '120']);
    return j.ok === true && j.approved === true;
  });

  async function status() {
    const s = await h(['status']);
    const dnc = loadDnc(snapshotFile, { now: now() });
    return { helper: existsSync(helper) ? helper : null, ...s, dnc: dnc.ok ? { ok: true, fetchedAt: dnc.fetchedAt, numbers: dnc.count } : { ok: false, reason: dnc.reason } };
  }

  async function see() {
    const t0 = now();
    const { window: win } = await must(['window']);
    mkdirSync(screensDir, { recursive: true, mode: 0o700 });
    const image = join(screensDir, 'latest.png');
    const cap = await run('/usr/sbin/screencapture', ['-x', '-o', '-l', String(win.id), image]);
    if (cap.code !== 0) throw new Error(`Could not capture the iPhone Mirroring window (Screen Recording granted?): ${short(cap.stderr, 160)}`);
    const { items } = await must(['ocr', image]);
    const elements = toElements(items, win);
    return { window: { w: Math.round(win.w), h: Math.round(win.h) }, screen: classifyScreen(elements.map((e) => e.text)), elements, image, ms: now() - t0 };
  }

  const handBack = (what) => ({ ok: false, handBack: true, refusal: `Stopped: this screen asks for a password, code or payment details. It's yours to ${what}.` });

  async function guarded(op, screen, readBack) {
    if (screen.screen === 'compose' || readBack.forceConfirm) {
      const yes = await ownerConfirms(readBack.reason);
      audit({ op, confirmRequired: true, confirmed: yes, reason: short(readBack.reason, 120) });
      return yes;
    }
    return true;
  }

  async function settleAndSee(before) {
    await sleep(settleMs);
    const after = await see();
    return { changed: signature(before) !== signature(after), screen: after };
  }

  async function tap({ text, index, x, y } = {}) {
    const before = await see();
    if (before.screen === 'secret') return handBack('handle');
    let target;
    if (text !== undefined && String(text).trim()) {
      target = findTarget(before.elements, text, index);
      if (!target) return { ok: false, refusal: `"${short(text, 40)}" is not on the screen.`, visible: before.elements.map((e) => e.text).slice(0, 60) };
    } else if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      target = { text: null, x: Number(x), y: Number(y) };
    } else return { ok: false, refusal: 'Say what to tap (its text) or where (x, y in window points).' };
    if (target.x < 0 || target.y < 0 || target.x > before.window.w || target.y > before.window.h) return { ok: false, refusal: 'That point is outside the phone screen.' };
    const nearby = target.text ?? before.elements.find((e) => e.box && target.x >= e.box[0] && target.x <= e.box[0] + e.box[2] && target.y >= e.box[1] && target.y <= e.box[1] + e.box[3])?.text;
    const sendLike = nearby && SEND_WORDS.test(nearby.trim());
    if (sendLike || before.screen === 'compose') {
      const ok = await guarded('tap', before, { forceConfirm: sendLike, reason: `tap "${short(nearby ?? `${target.x},${target.y}`, 40)}" on your iPhone (it may send something)` });
      if (!ok) return { ok: false, refusal: 'You did not confirm, so nothing was tapped.' };
    }
    const { window: win } = await must(['window']);
    await must(['activate']);
    await must(['click', String(win.x + target.x), String(win.y + target.y)]);
    // A tap on the Home Screen opens the app named by the icon's label; any other unlabeled tap may leave the app.
    const ctx = readContext();
    if (ctx === 'home') writeContext(target.text && !SEND_WORDS.test(target.text) ? target.text : null);
    else if (!target.text) writeContext(ctx && MESSAGING_APPS.test(ctx) ? ctx : null);
    audit({ op: 'tap', text: target.text ? short(target.text, 40) : null, x: target.x, y: target.y });
    return { ok: true, tapped: { text: target.text, x: target.x, y: target.y }, ...(await settleAndSee(before)) };
  }

  async function type({ text, submit = false } = {}) {
    const t = String(text ?? '');
    if (!t) return { ok: false, refusal: 'Nothing to type.' };
    const secret = secretInText(t);
    if (secret) return { ok: false, handBack: true, refusal: `I will not type that: ${secret}. You type passwords, codes and payment details yourself.` };
    const before = await see();
    if (before.screen === 'secret') return handBack('type here');
    const risk = typingRisk(before);
    if (risk) {
      const ok = await guarded('type', before, { forceConfirm: true, reason: `type "${short(t, 90)}" into ${risk} on your iPhone${submit ? ' and send it' : ''}` });
      if (!ok) return { ok: false, refusal: 'You did not confirm, so nothing was typed.' };
    }
    await must(['activate']);
    await must(['type'], t);
    if (submit) await must(['key', 'return']);
    audit({ op: 'type', chars: t.length, textSha256: sha256(t), submit: Boolean(submit), screen: before.screen });
    return { ok: true, typed: t.length, ...(await settleAndSee(before)) };
  }

  async function press({ button } = {}) {
    const b = String(button ?? '').toLowerCase();
    const combo = BUTTONS[b];
    if (!combo) return { ok: false, refusal: `Button must be one of: ${Object.keys(BUTTONS).join(', ')}.` };
    const before = await see();
    if (before.screen === 'secret' && !LEAVE_BUTTONS.has(b)) return handBack('handle');
    const risk = b === 'return' ? typingRisk(before) : null;
    if (risk) {
      const ok = await guarded('press', before, { forceConfirm: true, reason: `press Return in ${risk} on your iPhone (it may send a message)` });
      if (!ok) return { ok: false, refusal: 'You did not confirm, so nothing was pressed.' };
    }
    await must(['activate']);
    await must(['key', combo]);
    if (b === 'home') writeContext('home');
    else if (b === 'app-switcher') writeContext(null);
    audit({ op: 'press', button: b });
    return { ok: true, pressed: b, ...(await settleAndSee(before)) };
  }

  async function swipe({ direction = 'up', from, to, ms = 300 } = {}) {
    const before = await see();
    const { w, h: hh } = before.window;
    const lines = { up: [[w / 2, hh * 0.72], [w / 2, hh * 0.28]], down: [[w / 2, hh * 0.28], [w / 2, hh * 0.72]], left: [[w * 0.8, hh / 2], [w * 0.2, hh / 2]], right: [[w * 0.2, hh / 2], [w * 0.8, hh / 2]] };
    const [a, z] = Array.isArray(from) && Array.isArray(to) ? [from, to] : lines[String(direction)] ?? lines.up;
    const { window: win } = await must(['window']);
    await must(['activate']);
    await must(['drag', String(win.x + a[0]), String(win.y + a[1]), String(win.x + z[0]), String(win.y + z[1]), String(Math.min(2000, Math.max(80, Number(ms) || 300)))]);
    audit({ op: 'swipe', direction: Array.isArray(from) ? 'custom' : direction });
    return { ok: true, swiped: Array.isArray(from) ? 'custom' : direction, ...(await settleAndSee(before)) };
  }

  async function openApp({ name } = {}) {
    const app = String(name ?? '').trim();
    if (!app) return { ok: false, refusal: 'Which app?' };
    if (BLOCKED_APPS.test(app)) return { ok: false, refusal: `${app} holds payment or password details; you open it yourself.` };
    const before = await see();
    await must(['activate']);
    await must(['key', BUTTONS.home]); await sleep(500);
    await must(['key', BUTTONS.spotlight]); await sleep(700);
    await must(['type'], app); await sleep(1100);
    await must(['key', 'return']);
    writeContext(app);
    audit({ op: 'open-app', app: short(app, 40) });
    await sleep(800);
    return { ok: true, opened: app, ...(await settleAndSee(before)) };
  }

  /** Contacts lookup: the helper (Contacts framework) first, else Contacts.app over Automation. */
  async function lookupContacts(query) {
    const direct = await h(['contacts', String(query ?? '')]);
    // Same matching rules on both paths: an exact full name beats looser name matches, a number must be on the card.
    if (direct.ok) { const refined = matchContacts(direct.contacts, query); return { ...direct, contacts: refined.length ? refined : direct.contacts }; }
    const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { input: CONTACTS_JXA, timeoutMs: 60_000 });
    if (r.code !== 0) return { ok: false, error: `${direct.error ?? 'no Contacts access'}; Contacts.app: ${short(r.stderr, 120) || 'no answer'}` };
    try { return { ok: true, via: 'contacts-app', contacts: matchContacts(JSON.parse(r.stdout), query).slice(0, 5) }; } catch { return { ok: false, error: 'Contacts.app gave no readable answer' }; }
  }

  /** The outbound gate around a call or message; the act runs only if it is allowed and confirmed. */
  async function outbound(request, act) {
    const look = await lookupContacts(request.to);
    if (!look.ok) {
      const refusal = `Refused: I cannot read your Contacts (${look.access ?? look.error ?? 'no answer'}), so I contact no one.`;
      audit({ op: request.action, ok: false, code: 'contacts-unavailable' });
      return { ok: false, sent: false, refusal };
    }
    const policy = await readPolicy();
    const decision = decideOutbound(request, { contacts: look.contacts, dnc: loadDnc(snapshotFile, { now: now() }), policy });
    if (!decision.allowed) {
      audit({ op: request.action, ok: false, code: decision.code, to: short(request.to, 40) });
      return { ok: false, sent: false, refusal: decision.refusal, code: decision.code };
    }
    let confirmed = false;
    if (decision.needsConfirm) {
      confirmed = await ownerConfirms(decision.readBack.charAt(0).toLowerCase() + decision.readBack.slice(1));
      if (!confirmed) {
        audit({ op: request.action, ok: false, code: 'not-confirmed', contact: decision.contact.name, to: decision.handle.value });
        return { ok: false, sent: false, refusal: 'You did not confirm, so nothing was sent.', readBack: decision.readBack };
      }
    }
    const result = await act(decision);
    audit({ op: request.action, ok: result.ok, contact: decision.contact.name, to: decision.handle.value, confirmed, trusted: !decision.needsConfirm, ...(decision.text ? { chars: decision.text.length, textSha256: sha256(decision.text) } : {}), detail: result.detail });
    return { ...result, readBack: decision.readBack, confirmedBy: decision.needsConfirm ? 'owner' : 'owner-trusted-contact' };
  }

  async function sendMessage({ to, text, channel = 'imessage' } = {}) {
    const action = String(channel).toLowerCase() === 'sms' ? 'sms' : 'imessage';
    return outbound({ action, to, text }, async (d) => {
      const r = await run('/usr/bin/osascript', ['-', d.handle.value, d.text, action === 'sms' ? 'SMS' : 'iMessage'], { input: MESSAGES_SCRIPT });
      return r.code === 0 ? { ok: true, sent: true, detail: 'handed to Messages' } : { ok: false, sent: false, detail: short(r.stderr, 200), refusal: `Messages did not take it: ${short(r.stderr, 200)}` };
    });
  }

  async function placeCall({ to } = {}) {
    return outbound({ action: 'call', to }, async (d) => {
      const r = await run('/usr/bin/open', [`tel:${d.handle.value}`]);
      if (r.code !== 0) return { ok: false, sent: false, detail: short(r.stderr, 200), refusal: `macOS would not open the call: ${short(r.stderr, 200)}` };
      const press = await run('/usr/bin/osascript', ['-'], { input: CALL_BUTTON_SCRIPT, timeoutMs: 15_000 });
      const pressed = press.stdout.trim() === 'pressed';
      return { ok: true, sent: pressed, calling: pressed, detail: pressed ? 'call started' : 'call prompt shown', note: pressed ? undefined : 'macOS is showing the Call prompt; press Call (or check FaceTime > Settings > Calls from iPhone).' };
    });
  }

  async function readPolicy() {
    const p = await h(['policy-get']);
    try { const j = p.ok ? JSON.parse(p.policy || '{}') : {}; return j && typeof j === 'object' ? j : {}; } catch { return {}; }
  }

  /** The owner's own act (CLI only, never an MCP tool): let agents reach ONE contact on these channels without asking
   *  each time, or take that back. Written to the login Keychain by the helper only after their Touch ID. */
  async function setTrust({ to, channels = ['imessage', 'sms'], trusted = true } = {}) {
    const look = await lookupContacts(to);
    if (!look.ok) return { ok: false, refusal: `I cannot read your Contacts (${look.access ?? look.error}).` };
    if (look.contacts.length !== 1) return { ok: false, refusal: look.contacts.length ? `"${to}" matches ${look.contacts.length} contacts; be more specific.` : `"${to}" is not in your Contacts.` };
    const card = look.contacts[0];
    const chans = [...new Set(channels.map((c) => String(c).toLowerCase()))].filter((c) => ['imessage', 'sms', 'call'].includes(c));
    if (!chans.length) return { ok: false, refusal: 'Channels must be imessage, sms and/or call.' };
    const policy = await readPolicy();
    const rest = (Array.isArray(policy.trusted) ? policy.trusted : []).filter((t) => t?.contactId !== card.id);
    const next = { version: 1, trusted: trusted ? [...rest, { contactId: card.id, name: card.name, channels: chans, addedAt: new Date(now()).toISOString() }] : rest };
    const reason = trusted ? `let your agents ${chans.join('/')} ${card.name} without asking you each time` : `make your agents ask you again before contacting ${card.name}`;
    const r = await h(['policy-set', reason], JSON.stringify(next));
    if (!r.ok) return { ok: false, refusal: r.error };
    if (!r.approved) return { ok: false, refusal: 'Not confirmed; the policy is unchanged.' };
    audit({ op: trusted ? 'trust' : 'untrust', contact: card.name, channels: chans });
    return { ok: true, contact: card.name, channels: trusted ? chans : [], trusted };
  }

  return { status, see, tap, type, press, swipe, openApp, sendMessage, placeCall, readPolicy, setTrust, lookupContacts, audit, helper, stateDir };
}

// ---- the local see → decide → act loop -------------------------------------------------------------------------

const LOOP_ACTIONS = new Set(['tap', 'type', 'press', 'swipe', 'open_app', 'done', 'stop']);

/** Validates a decider's step. Outbound (calls, messages) is never a loop step: those go through their own gate. Pure. */
export function checkStep(step) {
  if (!step || typeof step !== 'object' || !LOOP_ACTIONS.has(step.action)) return { ok: false, reason: `unknown step ${JSON.stringify(step)?.slice(0, 80)}` };
  return { ok: true };
}

/** Pure: a step's identity (what it does, not when): two taps on the same text are the same step. */
const stepKey = (s) => JSON.stringify([s?.action, s?.text ?? null, s?.button ?? null, s?.direction ?? null, s?.name ?? null, s?.index ?? null]);
/**
 * Pure: is the loop stuck? (after OpenJarvis's agents/loop_guard.py, re-written.) → null, or { stuck, reason }:
 *   repeat     the same step three times running
 *   ping_pong  two steps in turn, A B A B (back and forth between two screens)
 *   no_change  three steps in a row that changed nothing on the screen
 * A small local model stuck like that never gets out by itself; stopping says why, instead of spending all 12 steps.
 */
export function loopStuck(history) {
  const keys = history.map((h) => stepKey(h.step)), n = keys.length;
  if (n >= 3 && keys[n - 1] === keys[n - 2] && keys[n - 2] === keys[n - 3]) return { stuck: 'repeat', reason: `it did the same step three times (${history[n - 1].step.action}) and nothing came of it` };
  if (n >= 4 && keys[n - 1] === keys[n - 3] && keys[n - 2] === keys[n - 4] && keys[n - 1] !== keys[n - 2]) return { stuck: 'ping_pong', reason: 'it went back and forth between the same two steps' };
  if (n >= 3 && history.slice(-3).every((h) => h.changed === false)) return { stuck: 'no_change', reason: 'three steps in a row changed nothing on the screen' };
  return null;
}

/** Drives the phone toward `goal`, one observed step at a time. `decide({goal, screen, history})` → a step. */
export async function runLoop({ bridge, goal, decide, maxSteps = 12, onStep = () => {} }) {
  const history = [];
  let screen = await bridge.see();
  for (let i = 0; i < maxSteps; i++) {
    if (screen.screen === 'secret') return { done: false, handBack: true, history, reason: 'a password, code or payment screen: you take it from here' };
    const step = await decide({ goal, screen, history });
    const v = checkStep(step);
    if (!v.ok) return { done: false, history, reason: v.reason };
    if (step.action === 'done' || step.action === 'stop') return { done: step.action === 'done', history, reason: step.reason ?? null };
    const r = step.action === 'tap' ? await bridge.tap(step)
      : step.action === 'type' ? await bridge.type(step)
        : step.action === 'press' ? await bridge.press(step)
          : step.action === 'swipe' ? await bridge.swipe(step)
            : await bridge.openApp({ name: step.name });
    history.push({ step, ok: r.ok, refusal: r.refusal, changed: r.changed });
    onStep(step, r);
    if (r.handBack) return { done: false, handBack: true, history, reason: r.refusal };
    const stuck = loopStuck(history);
    if (stuck) return { done: false, history, ...stuck };
    screen = r.screen ?? await bridge.see();
  }
  return { done: false, history, reason: `stopped after ${maxSteps} steps` };
}

/** A local decider on Ollama (127.0.0.1 only). Small local models are weak at UI driving; the calling agent is the
 *  usual decider (it loops see-phone-screen → tap-phone itself). */
export function ollamaDecider({ model = 'qwen3:1.7b', url = 'http://127.0.0.1:11434/api/chat', fetchImpl = fetch } = {}) {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('The loop decider must be local (127.0.0.1).');
  return async ({ goal, screen, history }) => {
    const sys = 'You drive an iPhone through its screen text. Reply with ONE JSON object: {"action":"tap","text":"<exact on-screen text>"} | {"action":"type","text":"..."} | {"action":"press","button":"home|app-switcher|spotlight|return|delete|escape"} | {"action":"swipe","direction":"up|down|left|right"} | {"action":"open_app","name":"..."} | {"action":"done","reason":"..."} | {"action":"stop","reason":"..."}. Never send messages or make calls. If you see a password, code or payment screen, stop.';
    const user = `Goal: ${goal}\nSteps so far: ${JSON.stringify(history.map((s) => s.step))}\nScreen text (top to bottom): ${screen.elements.map((e) => e.text).join(' | ').slice(0, 3000)}`;
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, format: 'json', think: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) });
    const j = await res.json();
    try { return JSON.parse(j?.message?.content ?? ''); } catch { return { action: 'stop', reason: 'the local model did not answer in JSON' }; }
  };
}

export async function buildHelper({ run = runProcess, out = resolveHelper() } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const c = await run('/usr/bin/xcrun', ['swiftc', '-O', '-o', out, HELPER_SOURCE], { timeoutMs: 600_000 });
  if (c.code !== 0) throw new Error(`swiftc failed: ${short(c.stderr, 400)}`);
  const s = await run('/usr/bin/codesign', ['-s', '-', '-f', '-i', 'org.ronininc.kingmaker.iphone-helper', out]);
  if (s.code !== 0) throw new Error(`codesign failed: ${short(s.stderr, 200)}`);
  return out;
}

