// conduction.mjs — DESIGN §4.1: wake(text) -> Jev gate -> job inbox -> conducted job -> evidence card.
// The inbox door is the tree's REAL propose-only refusal (lib/job-inbox.mjs jobRefusal, PR #106 lineage):
// approval-shaped text is refused by the engine's own rule, never by a copy of it.
// The Jev gate applies the shipped thresholds (>=0.90 auto-proceed, <0.60 escalate, between -> reasoning
// brain). On this rig the classifier is a deterministic fixture — the gate arithmetic and the audit are
// real; the model behind the number is an owner-rig (local floor model) concern, graded as such.
import { jobRefusal } from '../../kingmaker-lightui-build/lib/job-inbox.mjs';
import { renderFacts } from './ronin-state.mjs';

export function jevGate(p) {
  if (p >= 0.90) return 'auto-proceed';
  if (p < 0.60) return 'escalate';
  return 'reasoning-brain';
}
const RED_LANE = /\b(bench|scan|exploit|pentest|nmap|zap|nettacker|attack)\b/i;

export class Conductor {
  constructor({ stateDir, chain, sm, classify }) { this.dir = stateDir; this.chain = chain; this.sm = sm; this.classify = classify; this.jobs = 0; }
  /** A spoken/typed order. Returns the evidence card (§4.1 step 4) — also appended to the audit chain. */
  hear(text, { via = 'voice-fixture' } = {}) {
    const refusal = jobRefusal(text);
    if (refusal) { const e = this.chain.append('job-refused', { text, why: refusal, via }); return { ok: false, card: { headline: `REFUSED — ${refusal}`, text, auditSeq: e.seq } }; }
    const rec = this.sm.record(); const state = rec.posture.state;
    if (RED_LANE.test(text) && state !== 'RED') {
      const e = this.chain.append('job-refused', { text, why: 'red-lane order outside RED', state, via });
      return { ok: false, card: { headline: `REFUSED — the red lane is not armed (state: ${state})`, text, offer: 'declare RED — scope required', auditSeq: e.seq } };
    }
    const p = this.classify(text); const gate = jevGate(p);
    const id = `job-${++this.jobs}`;
    if (gate === 'escalate') { const e = this.chain.append('job-escalated', { id, text, p, via }); return { ok: false, card: { headline: `ESCALATED TO OWNER — Jev confidence ${p.toFixed(2)} < 0.60`, id, text, auditSeq: e.seq } }; }
    const steps = ['received via ' + via, `Jev gate: ${gate} (p=${p.toFixed(2)})`, 'conducted headless (fixture executor on this rig)', 'method write-back recorded'];
    const e = this.chain.append('job-conducted', { id, text, p, gate, steps, state });
    return { ok: true, card: { headline: `DONE — ${id}`, id, text, steps, proof: `audit chain seq ${e.seq} · hash ${e.hash.slice(0, 12)}…`, auditSeq: e.seq, hash: e.hash } };
  }
}
