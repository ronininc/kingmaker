// state-machine.mjs — DESIGN §2.3: a state change is a governed act.
// Declared states (OPS/RED/FORGE/SETTLE): owner only, from an attested session.
// Condition states (CONTAINMENT/SEALED): entered by fact, exited by condition-clear + owner ack.
// Every transition writes an audit-chain state record; the posture record points at it.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATES, validatePostureRecord } from './ronin-state.mjs';

export class StateMachine {
  constructor(dir, chain) {
    this.dir = dir; this.chain = chain; this.file = join(dir, 'ronin-state.json');
    if (!existsSync(this.file)) {
      const e = chain.append('state-transition', { from: null, to: 'OPS', declaredBy: 'install', gate: 'initial' });
      this._write({ schema: 1, at: new Date().toISOString(), posture: { state: 'OPS', density: 'HOME', trust: 'SEALED-ENTRY', recordSeq: e.seq, since: new Date().toISOString() }, lanes: {}, approvals: [] });
    }
  }
  record() { return JSON.parse(readFileSync(this.file, 'utf8')); }
  _write(rec) { const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(rec, null, 2)); renameSync(t, this.file); }
  _commit(rec, entryBody) {
    const e = this.chain.append('state-transition', entryBody);
    rec.posture.recordSeq = e.seq; rec.posture.since = new Date().toISOString(); rec.at = new Date().toISOString();
    const v = validatePostureRecord(rec); if (!v.ok) throw new Error(`posture invalid: ${v.errors.join('; ')}`);
    this._write(rec); return e;
  }
  /** Owner declaration. session: { attested: bool, who: 'owner' }. Returns {ok, entry|refusal}. */
  declare(to, session, gate = {}) {
    const cur = this.record(); const from = cur.posture.state;
    if (!STATES[to]) return { ok: false, refusal: `unknown state ${to}` };
    if (STATES[to].kind !== 'declared') return { ok: false, refusal: `${to} is condition-entered; it cannot be declared` };
    if (!session?.attested || session?.who !== 'owner') return { ok: false, refusal: 'only the owner, from an attested session, may declare a state' };
    if (['CONTAINMENT', 'SEALED'].includes(from)) return { ok: false, refusal: `in ${from}: exit is by condition-clear + owner acknowledgment, not declaration` };
    if (to === 'RED') {
      if (!gate.scopeId) { const r = { ok: false, refusal: 'RED refused: no scope declaration on file (scope law). The field stays blue.', gate: 'scope' }; this.chain.append('state-refusal', { from, to, ...r }); return r; }
      if (!gate.armed) { const r = { ok: false, refusal: 'RED refused: red lane arming did not complete', gate: 'arming' }; this.chain.append('state-refusal', { from, to, ...r }); return r; }
    }
    if (to === 'SETTLE' && !gate.stagedActId) return { ok: false, refusal: 'SETTLE refused: no staged money act exists to settle' };
    if (to === 'FORGE' && !gate.productionJobId) return { ok: false, refusal: 'FORGE refused: no production job in flight or staged' };
    cur.posture.state = to; if (gate.scopeId) cur.posture.scopeId = gate.scopeId; else delete cur.posture.scopeId;
    const e = this._commit(cur, { from, to, declaredBy: 'owner', gate });
    return { ok: true, entry: e };
  }
  /** Condition entry: a fact, not a vote. event: { kind: 'containment'|'sealed', eventId }. */
  condition(kind, eventId) {
    const to = kind === 'containment' ? 'CONTAINMENT' : 'SEALED';
    const cur = this.record(); const from = cur.posture.state;
    cur.posture.state = to;
    const e = this._commit(cur, { from, to, declaredBy: 'condition', condition: kind, eventId });
    return { ok: true, entry: e };
  }
  /** Exit a condition state: the condition must have cleared AND the owner acknowledges. */
  acknowledge(session, conditionCleared) {
    const cur = this.record(); const from = cur.posture.state;
    if (!['CONTAINMENT', 'SEALED'].includes(from)) return { ok: false, refusal: `not in a condition state (in ${from})` };
    if (!conditionCleared) return { ok: false, refusal: `${from} persists: its condition has not cleared` };
    if (!session?.attested || session?.who !== 'owner') return { ok: false, refusal: 'exit requires the owner\u2019s acknowledgment from an attested session' };
    cur.posture.state = 'OPS'; delete cur.posture.scopeId;
    const e = this._commit(cur, { from, to: 'OPS', declaredBy: 'owner-ack', conditionCleared: true });
    return { ok: true, entry: e };
  }
  setTrust(trust, why) { const cur = this.record(); cur.posture.trust = trust; cur.at = new Date().toISOString(); this._write(cur); this.chain.append('trust-overlay', { trust, why }); }
  setLane(lane, summary, source) { const cur = this.record(); cur.lanes[lane] = { summary, at: new Date().toISOString(), source }; cur.at = new Date().toISOString(); this._write(cur); }
}
