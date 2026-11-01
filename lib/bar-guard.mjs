// lib/bar-guard.mjs — the owner's own words come first, before any framing, before any brain.
//
// The bar (and the phone, and the dropdown) frame a typed turn before a model sees it: project doctrine, "Answer in this
// manner: <personality>", the folder line. A kill-switch phrase ("stop approving", "stop forwarding") or the duress
// switch (":duress arm|off|status", the armed duress password) must fire whatever that framing is, whichever model is
// picked, and in app mode as well as in the voice loop. So the check runs on the owner's RAW words, and, where only a
// framed string is at hand, on the string with the known frames stripped.
//
// The duress password is never echoed, logged or sent on: this module hands it only to the duress engine.

export const DOCTRINE_END = '(end of project doctrine)';

const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Pure: the framed turn a model is given. `ask` is the owner's sentence (already shaped). Personality changes the manner,
 * never what may run: nothing in this text is read by a gate.
 */
export function frameBarTurn({ doctrine = '', project = '', personality = '', folder = '', crm = '', ask = '' } = {}) {
  const doc = typeof doctrine === 'string' ? doctrine.replace(/\r/g, '').split(DOCTRINE_END).join('').trim().slice(0, 4000) : '';
  const proj = typeof project === 'string' ? project.trim().slice(0, 60) : '';
  const rules = doc ? `Project${proj ? ` "${proj}"` : ''} doctrine (follow it in this answer):\n${doc}\n${DOCTRINE_END}` : '';
  const pers = typeof personality === 'string' ? oneLine(personality, 300) : '';
  const manner = pers ? `Answer in this manner: ${pers}` : '';
  const where = folder ? `Working in the folder ${String(folder).slice(0, 300)}${crm ? ` (the ${String(crm).slice(0, 40)} CRM)` : ''}.` : '';
  return { rules, manner, where, framed: [rules, manner, where, ask].filter(Boolean).join('\n') };
}

/** Pure: a framed string with the bar's known frames removed (defence in depth; the raw words are checked first). */
export function stripFrames(text) {
  let s = String(text ?? '');
  const end = s.indexOf(DOCTRINE_END);
  if (/^\s*Project\b[^\n]*doctrine \(follow it in this answer\):/.test(s) && end !== -1) s = s.slice(end + DOCTRINE_END.length);
  return s.split('\n')
    .filter((line) => !/^\s*Answer in this manner:/.test(line) && !/^\s*Working in the folder .*\.\s*$/.test(line))
    .join('\n').trim();
}

/**
 * The guard. deps: duress (createDuress result), isStopApproving, isStopForwarding, stopApprovals(via), stopForwarding(via),
 * say(line), log(event, fields). `handle(text, {typed})` returns null when the line is for the brain, else
 * `{ handled: true, kind }` after acting; `kind` is one of duress-command | duress-panic | stop-approving | stop-forwarding.
 */
export function createBarGuard({ duress, isStopApproving, isStopForwarding, stopApprovals, stopForwarding, say = async () => {}, log = () => {} } = {}) {
  const duressLine = async (line) => {
    const t = String(line).trim();
    const sub = (t.split(/\s+/)[1] || 'status').toLowerCase();
    // ":duress arm <password> WIPE": the password is everything between "arm" and the final word, spaces and all.
    const armed = /^:duress\s+arm\s([\s\S]*)\s(\S+)$/i.exec(t);
    if (sub === 'arm') { const r = duress.arm({ password: armed?.[1], confirm: armed?.[2] }); log('duress_command', { op: 'arm', ok: r.ok }); await say(r.ok ? 'Duress switch armed. Give that password (bar, phone or voice) to wipe everything.' : `Not armed: ${r.reason}`); }
    else if (sub === 'off' || sub === 'disarm') { duress.disarm(); log('duress_command', { op: 'disarm' }); await say('Duress switch disarmed.'); }
    else await say(`Duress switch: ${duress.status().armed ? 'ARMED' : 'off'}.`);
    return { handled: true, kind: 'duress-command' };
  };
  return {
    async handle(text, { typed = true } = {}) {
      const raw = String(text ?? '');
      const via = typed ? 'text' : 'voice';
      // 1. THE DURESS SWITCH: a ":duress" line, then the exact password. Raw words first, then the stripped string.
      const candidates = [...new Set([raw, stripFrames(raw)].map((s) => s.trim()).filter(Boolean))];
      for (const c of candidates) if (/^:duress\b/i.test(c)) return duressLine(c);
      for (const c of candidates) if (duress.isDuress(c)) { await duress.panic({ password: c }); return { handled: true, kind: 'duress-panic' }; }
      // 2. THE KILL SWITCHES.
      for (const c of candidates) if (isStopApproving(c)) { await stopApprovals(via); return { handled: true, kind: 'stop-approving' }; }
      for (const c of candidates) if (isStopForwarding(c)) { await stopForwarding(via); return { handled: true, kind: 'stop-forwarding' }; }
      return null;
    },
  };
}
