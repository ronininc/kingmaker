// Community export is opt-in under the current disclosure, default choice no.
// Only exact release-reviewed reusable method components may leave this boundary.
// Owner preferences, routing words, hardware/model telemetry, projects, raw tool
// source and arbitrary learned prose are not eligible. Unknown rights fail closed.
// This local choice is not a signed platform-benefit entitlement or CRM consent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReusableSkillPacket as validatePacket } from './reusable-skill-policy.mjs';

export const BOX_WORDING_VERSION = 2;
export const FLEET_DISCLOSURE_PURPOSE = 'fleet-participation-for-platform-benefits';
export const FLEET_DISCLOSURE_DIGEST = 'e36af28bdeb5fe7ad71fae31ba727d700a9d0e193ea6cc2073904a44999f9d32';
export const FLEET_DISCLOSURE_TEXT = 'I explicitly opt in to Fleet Learning to unlock the Scripture Armor and reusable skill-base capabilities. Only reusable, nonproprietary, generalized skills and tool-use methods may be shared with other participants. My proprietary material, user data, personal data, customer data, source documents, conversations, credentials, plaintext passwords, secrets, proprietary code, and proprietary assets must not be shared. Eligible reusable skills and components are intended for Apache-2.0 sharing only when their provenance and rights permit it; incompatible third-party material must not be relicensed. Projects created using them remain proprietary to their respective owners and are not shared. Tool-use knowledge does not include the tool itself or its private configuration. Sharing requires a separate privacy and provenance check; uncertain or unreviewed content must not be shared. I can withdraw this opt-in; withdrawal stops future fleet sharing and the fleet-based entitlement. Paid access is a separate option.';

/** The permissions box: what the bar shows (its look comes from the bar's own settings: km.look, km.replyColor, km.textSize). */
export const SHARE_BOX = Object.freeze({
  version: BOX_WORDING_VERSION,
  title: 'Help every Kingmaker get smarter',
  body: FLEET_DISCLOSURE_TEXT,
  shared: 'Only release-reviewed generic reusable methods under Apache 2.0; no project content or telemetry',
  never: 'your words, files, screen, contacts, keys, names or business records',
  see: 'See exactly what\'s sent',
  no: 'Keep it on this Mac',
  yes: 'Share and get improvements',
  defaultChoice: 'no',
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
  if(p?.schema==='kingmaker.fleet-skills/1')return `${p.methods.length} reviewed reusable methods (Apache-2.0); project content excluded`;
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
  buildPacket = async () => null, validate = validatePacket, send = null, forgetRemote = null, log = () => {} }) {
  const root = join(state, 'fleet');
  const recordPath = join(root, 'sharing.json'), logPath = join(root, 'contributed.jsonl');
  const record = () => readJson(recordPath, {});
  const write = (r) => { mkdirSync(root, { recursive: true, mode: 0o700 }); atomic(recordPath, JSON.stringify(r, null, 1)); };

  /** The setting: on unless the owner said no (or the install turned it off), and only while learning is on. */
  const enabled = () => env.KINGMAKER_SHARING !== 'off' && record().on === true && learningOn();
  /** May anything leave this Mac now? Only once the box has been shown and the setting is on. */
  const mayShare = () => enabled() && record().shown === true && record().on === true && record().wording === BOX_WORDING_VERSION && record().disclosureDigest === FLEET_DISCLOSURE_DIGEST;
  /** The box to show, or null (already answered, or sharing can't happen anyway). */
  const ask = () => ((record().shown && record().wording === BOX_WORDING_VERSION && record().disclosureDigest === FLEET_DISCLOSURE_DIGEST) || env.KINGMAKER_SHARING === 'off' || !learningOn() ? null : { ...SHARE_BOX });

  function answer(choice, how = 'box') {
    const on = /^(y|yes|on|share)$/i.test(String(choice).trim());
    write({ on, shown: true, at: now(), by: 'owner', how: `${how}: ${on ? 'share' : 'keep on this Mac'}`, wording: BOX_WORDING_VERSION, purpose:FLEET_DISCLOSURE_PURPOSE, disclosureDigest:FLEET_DISCLOSURE_DIGEST });
    log('sharing_choice', { on, how });
    return on ? 'Sharing is on for reviewed reusable methods only. Unknown content stays local. This local setting alone does not grant paid platform benefits. Say "what have you shared" to see it, or "sharing off" to stop.'
      : 'Kept on this Mac. Future sharing is stopped; paid access is separate. Say "sharing on" any time.';
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
    const built = await buildPacket();
    const packet = built ? structuredClone(built) : null;
    if (!packet) return { sent: false, why: 'nothing to share' };
    let v;
    try { v = validate(packet); } catch { v = {ok:false}; }
    // A caller validator can add restrictions, never replace the closed wire schema.
    if (!validatePacket(packet).ok) v = {ok:false};
    if (!mayShare()) return {sent:false,why:'off'};
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
