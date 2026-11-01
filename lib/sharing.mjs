// lib/sharing.mjs — community sharing: what Kingmaker learned, shared so every Kingmaker gets smarter (option B, owner
// 2026-10-15: "go with option B and build the permissions box"; design: docs/community-learning.md).
//
// On by default, with a real choice:
//   • Nothing leaves this Mac until the permissions box has been shown (shareAsk → the bar). Share is the box's default.
//   • "Keep it on this Mac" (or "sharing off") stops it at once; Kingmaker keeps working and learning locally, it just gets
//     no community improvements (the collective's reciprocity). "sharing on" turns it back on.
//   • "learning off" stops sharing too: nothing new is learned, so nothing new is shared.
//   • What is sent is the engine's closed fleet packet only (enums, bounded numbers, a random install id, a day, a version,
//     a coarse device class, public-vocabulary words; no free text by construction). Every packet is logged exactly as
//     sent (contributed.jsonl), and "what have you shared" reads that log back.
// Pure Node; the packet builder and the transport are handed in (the engine builds the packet; the Worker receives it).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BOX_WORDING_VERSION = 1;

/** The permissions box: what the bar shows (its look comes from the bar's own settings: km.look, km.replyColor, km.textSize). */
export const SHARE_BOX = Object.freeze({
  version: BOX_WORDING_VERSION,
  title: 'Help every Kingmaker get smarter',
  body: 'Kingmaker learns how to do things better on this Mac. With your OK, it shares what it learned, never what you said or stored, so every Kingmaker improves, including yours.',
  shared: 'counts of common task words, how well models and skills worked, and your Mac\'s type (for example "M5, 24 GB")',
  never: 'your words, files, screen, contacts, keys, names or business records',
  see: 'See exactly what\'s sent',
  no: 'Keep it on this Mac',
  yes: 'Share and get improvements',
  defaultChoice: 'yes',
});

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const atomic = (file, body) => { writeFileSync(file + '.tmp', body, { mode: 0o600 }); renameSync(file + '.tmp', file); };

/** Pure: the owner's sharing words, or null. */
export function sharingWords(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  let m;
  if ((m = /^(?:sharing|share) (on|off)$/i.exec(t))) return { op: m[1].toLowerCase() };
  if (/^(?:what (?:have|did) you (?:shared?|sen[dt])(?: with the community)?|\/shared)$/i.test(t)) return { op: 'log' };
  if (/^forget what (?:i|you|we) shared$/i.test(t)) return { op: 'forget' };
  return null;
}

/** Pure: a packet from the log, in plain words (artifact kinds and counts, never more than the packet holds). */
export function describePacket(p) {
  const arts = Array.isArray(p?.artifacts) ? p.artifacts : [];
  const kinds = {};
  for (const a of arts) kinds[a?.kind || 'unknown'] = (kinds[a?.kind || 'unknown'] || 0) + 1;
  const parts = Object.entries(kinds).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`);
  const prefs = arts.filter((a) => a?.kind === 'preference_stats').flatMap((a) => a.prefs || []).map((x) => `${x.pref.replace(/_/g, ' ')} ${x.polarity} ×${x.n}`);
  return `${p?.day || '?'}: ${parts.length ? parts.join(', ') : 'nothing'}${prefs.length ? ` [${prefs.join(', ')}]` : ''} (Kingmaker ${p?.runtimeVersion || '?'}, ${p?.deviceClass || 'device class not set'})`;
}

// ── The packet this Mac builds (the engine's own sanitizer and schema, vendored: vendor/fleet/fleet-packet.mjs) ──
/** This install's random id (fi_…), made once and kept on the Mac (0600). Never a host name, serial or account. */
export function installationId(state, make) {
  const file = join(state, 'fleet', 'install-id');
  try { const v = readFileSync(file, 'utf8').trim(); if (/^fi_[a-f0-9]{32}$/.test(v)) return v; } catch { /* first time */ }
  const id = make();
  mkdirSync(join(state, 'fleet'), { recursive: true, mode: 0o700 }); writeFileSync(file, id + '\n', { mode: 0o600 });
  return id;
}
/** The draft the sanitizer reads: only these fields are ever read; the device detail is reduced to a memory class. */
export function fleetDraft({ id, version, totalMemBytes, platform = process.platform, arch = process.arch, preferences = [], modelTrials = [], routing = [] }) {
  return { installationId: id, runtimeVersion: version, device: { platform, arch, totalMemBytes }, preferences, modelTrials, routing };
}

/**
 * openSharing({ state, env, now, learningOn, buildPacket, validate, send, forgetRemote, log })
 *   learningOn() → bool; buildPacket() → packet | null; validate(packet) → { ok, errors? };
 *   send(packet) → { ok, receipt? } (absent: no collective server yet); forgetRemote() → { ok } (absent: not built yet).
 */
export function openSharing({ state, env = process.env, now = () => new Date().toISOString(), learningOn = () => true,
  buildPacket = async () => null, validate = () => ({ ok: true }), send = null, forgetRemote = null, log = () => {} }) {
  const root = join(state, 'fleet');
  const recordPath = join(root, 'sharing.json'), logPath = join(root, 'contributed.jsonl');
  const record = () => readJson(recordPath, {});
  const write = (r) => { mkdirSync(root, { recursive: true, mode: 0o700 }); atomic(recordPath, JSON.stringify(r, null, 1)); };

  /** The setting: on unless the owner said no (or the install turned it off), and only while learning is on. */
  const enabled = () => env.KINGMAKER_SHARING !== 'off' && record().on !== false && learningOn();
  /** May anything leave this Mac now? Only once the box has been shown and the setting is on. */
  const mayShare = () => enabled() && record().shown === true;
  /** The box to show, or null (already answered, or sharing can't happen anyway). */
  const ask = () => (record().shown || env.KINGMAKER_SHARING === 'off' || !learningOn() ? null : { ...SHARE_BOX });

  function answer(choice, how = 'box') {
    const on = /^(y|yes|on|share)/i.test(String(choice));
    write({ on, shown: true, at: now(), by: 'owner', how: `${how}: ${on ? 'share' : 'keep on this Mac'}`, wording: BOX_WORDING_VERSION });
    log('sharing_choice', { on, how });
    return on ? 'Sharing is on. Kingmaker shares what it learned, never what you said or stored. Say "what have you shared" to see it, or "sharing off" to stop.'
      : 'Kept on this Mac. Kingmaker still learns here; it just won\'t share, and won\'t get community improvements. Say "sharing on" any time.';
  }

  /** The last packets sent, from the local log (exactly as sent), in plain words. */
  function shared(limit = 5) {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  function sharedLine() {
    const rows = shared();
    const state = mayShare() ? 'Sharing is on.' : enabled() ? 'Sharing is on, but nothing is sent until you have seen the permissions box.' : 'Sharing is off.';
    if (!rows.length) return `${state} Nothing has been shared from this Mac yet.`;
    const sent = rows.filter((r) => r.receipt).length;
    return `${state} The last ${rows.length} ${rows.length === 1 ? 'packet' : 'packets'} this Mac built, exactly as logged (${sent} received by the community):\n${rows.map((r) => `- ${describePacket(r.packet ?? r)}${r.receipt ? ' (received)' : r.note ? ' (not sent: no community server yet)' : ' (not received)'}`).join('\n')}`;
  }

  /** The owner's sharing words → the answer to say, or null. */
  async function handle(text, how = 'typed') {
    const w = sharingWords(text); if (!w) return null;
    if (w.op === 'on' || w.op === 'off') return answer(w.op, how);
    if (w.op === 'log') return sharedLine();
    if (w.op === 'forget') {
      if (!forgetRemote) return 'The community server isn\'t live yet, so nothing from this Mac has been received to erase. Your local log stays; say "sharing off" to stop sharing.';
      const r = await forgetRemote().catch((e) => ({ ok: false, error: String(e?.message || e) }));
      log('sharing_forget', { ok: Boolean(r?.ok) });
      return r?.ok ? 'Done: the community erased what this Mac shared. It gets no community improvements until it shares again.' : 'I couldn\'t reach the community server to erase it. I\'ll need you to try again later.';
    }
    return null;
  }

  /** Once a day: build, validate, log exactly as sent, send. Never sends unless mayShare(). → { sent, why? } */
  async function contribute() {
    if (!mayShare()) return { sent: false, why: !enabled() ? 'off' : 'box not shown' };
    const packet = await buildPacket();
    if (!packet) return { sent: false, why: 'nothing to share' };
    const v = validate(packet);
    if (!v?.ok) { log('sharing_invalid', { errors: (v?.errors || []).slice(0, 5) }); return { sent: false, why: 'invalid packet' }; }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!send) { appendFileSync(logPath, JSON.stringify({ at: now(), packet, receipt: null, note: 'not sent: no community server yet' }) + '\n', { mode: 0o600 }); return { sent: false, why: 'no server' }; }
    const r = await send(packet).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    appendFileSync(logPath, JSON.stringify({ at: now(), packet, receipt: r?.ok ? (r.receipt ?? true) : null }) + '\n', { mode: 0o600 });
    log('sharing_sent', { ok: Boolean(r?.ok) });
    return { sent: Boolean(r?.ok), why: r?.ok ? undefined : 'send failed' };
  }

  return { enabled, mayShare, ask, answer, handle, shared, sharedLine, contribute, recordPath, logPath };
}
