// lib/phone-ring.mjs — Kingmaker rings the owner's phone: the way the CRM calls the owner (the owner, 2026-10-15: "this
// is also how the crm should be calling the user"), on the same call screen as calling Kingmaker (the pulsing crest).
//
// One ring at a time. The Mac side (lib/owner-call.mjs, through createPhoneRunners) rings, waits for an answer, says each
// line, listens once, and ends; the phone side (lib/phone-companion.mjs routes) answers, declines, reports each line
// played, sends the one reply it heard, or hangs up. The ring reaches an open app through its event stream and a closed
// one through Web Push (lib/web-push.mjs). What a reply MEANS is decided where it always was (owner-call.mjs: a message
// reply is information only; a batch is approved only by the exact words, before the deadline).

/**
 * deps: broadcast(event, data) to the open apps; push(payload) → number of phones notified; reachable() → can any
 * paired phone get a ring; now(); setTimer/clearTimer.
 */
export function createRinger({ broadcast = () => {}, push = async () => 0, reachable = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
  let active = null;
  const settle = (map, key, value) => { const w = map.get(key); if (w) { map.delete(key); clearTimer(w.timer); w.resolve(value); } };
  const finish = (why) => {
    if (!active) return;
    const a = active; active = null; a.state = 'ended';
    for (const k of [...a.says.keys()]) settle(a.says, k, { hangup: why === 'hangup' });
    if (a.listen) { clearTimer(a.listen.timer); a.listen.resolve({ text: '', hangup: why === 'hangup' }); a.listen = null; }
    broadcast('ring-end', { id: a.id, why });
    log('ring_end', { id: a.id.slice(0, 8), why });
  };
  return {
    reachable,
    /** Start ringing: → the ring's info, as the phone sees it. Throws when one is already on. */
    async ring({ id, callerName = 'Kingmaker', kind = 'message' }) {
      if (active) throw new Error('a ring is already on');
      active = { id: String(id), callerName: String(callerName).slice(0, 40), kind, state: 'ringing', seq: 0, says: new Map(), listen: null, at: now() };
      const info = { id: active.id, caller: active.callerName, kind };
      broadcast('ring', info);
      const pushed = await push({ type: 'ring', ...info }).catch(() => 0);
      log('ring', { id: active.id.slice(0, 8), pushed });
      return info;
    },
    /** null before a ring, true once answered, false while ringing or after it ended. */
    connected: () => (active ? active.state === 'connected' : false),
    active: () => (active ? { id: active.id, caller: active.callerName, kind: active.kind, state: active.state } : null),
    /** Say one line on the phone; resolves when the phone has played it (or after a generous time, or on hang-up). */
    say(text) {
      if (!active || active.state !== 'connected') return Promise.resolve({ hangup: true });
      const seq = ++active.seq, line = String(text || '').slice(0, 1500);
      return new Promise((resolve) => {
        const timer = setTimer(() => settle(active?.says ?? new Map(), seq, { timeout: true }), 8000 + line.length * 90);
        active.says.set(seq, { resolve, timer });
        broadcast('ring-say', { id: active.id, seq, text: line });
      });
    },
    /** Listen for the one reply. → { text } | { text: '', hangup: true } | { text: '' } (nothing within maxMs). */
    listen({ maxMs = 20_000 } = {}) {
      if (!active || active.state !== 'connected') return Promise.resolve({ text: '', hangup: true });
      return new Promise((resolve) => {
        const timer = setTimer(() => { if (active?.listen) { active.listen = null; resolve({ text: '' }); } }, maxMs + 6000);   // + the trip and the transcription
        active.listen = { resolve, timer };
        broadcast('ring-listen', { id: active.id, maxMs });
      });
    },
    /** The Mac ends the call. */
    end: () => finish('ended'),

    // ── the phone's side (a paired phone, through the companion's routes)
    answer(id) { if (!active || active.id !== id || active.state !== 'ringing') return false; active.state = 'connected'; log('ring_answered', { id: id.slice(0, 8) }); return true; },
    decline(id) { if (!active || active.id !== id) return false; finish('hangup'); return true; },
    hangup(id) { if (!active || active.id !== id) return false; finish('hangup'); return true; },
    played(id, seq) { if (!active || active.id !== id) return false; settle(active.says, Number(seq), { played: true }); return true; },
    heard(id, text) {
      if (!active || active.id !== id || !active.listen) return false;
      const l = active.listen; active.listen = null; clearTimer(l.timer); l.resolve({ text: String(text || '') }); return true;
    },
  };
}

/**
 * lib/owner-call.mjs's call steps (placeOwnerCall's `mac`), carried by the phone instead of FaceTime: the same order
 * (ring, wait for the answer, speak, listen once, end) and the same meaning of every reply.
 */
export function createPhoneRunners(ringer, call) {
  let watching = false;
  return {
    channel: 'phone',
    watch: () => ({
      start: () => (ringer.reachable() ? (watching = true, { ok: true }) : { ok: false, reason: 'no_phone_reachable' }),
      connected: () => (watching ? ringer.connected() : null),
      stop: () => { watching = false; },
    }),
    dial: async () => { await ringer.ring({ id: String(call?.id ?? ''), callerName: call?.caller_name || call?.caller || 'Kingmaker', kind: call?.kind }); return { code: 0 }; },
    confirmPrompt: async () => ({ code: 0, out: 'phone' }),
    speak: (text) => ringer.say(text),
    tone: async () => ({ code: 0 }),
    hear: async ({ maxMs }) => ringer.listen({ maxMs }),
    endCall: async () => { ringer.end(); },
  };
}
