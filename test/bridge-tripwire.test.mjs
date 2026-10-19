/**
 * Bridge tripwire — tests. Injected fakes; no I/O, no network.
 * Run: node test/bridge-tripwire.test.mjs
 */
import assert from 'node:assert';
import { declareIncident, SEVERITY } from '../lib/bridge-tripwire.mjs';

function deps() {
  const audit = [];
  const incidents = [];
  return {
    audit,
    incidents,
    appendAudit: (e) => audit.push(e),
    onIncident: (i, d) => incidents.push({ incident: i, disposition: d }),
    now: () => '2026-10-18T22:15:00.000Z',
  };
}

// 1. Retired code → low severity, reconnect path.
{
  const d = deps();
  const { incident, disposition } = declareIncident({
    pairingId: 'p1', reason: 'retired call sign — outside the active window',
    history: [{ ok: false }], deps: d,
  });
  assert.equal(incident.severity, SEVERITY.RETIRED_CODE);
  assert.equal(disposition.action, 'reconnect');
  assert.equal(d.audit[0].type, 'bridge/tripwire');
}

// 2. Unknown code → high severity, investigate (don't reinstall yet).
{
  const d = deps();
  const { incident, disposition } = declareIncident({
    pairingId: 'p1', reason: 'unknown call sign — not from this pairing',
    history: [{ ok: false }], deps: d,
  });
  assert.equal(incident.severity, SEVERITY.UNKNOWN_CODE);
  assert.equal(disposition.action, 'investigate');
  assert.match(disposition.message, /do not reinstall/);
}

// 3. Repeated failures → critical (hostile code suspected).
{
  const d = deps();
  const { incident } = declareIncident({
    pairingId: 'p1', reason: 'unknown call sign — not from this pairing',
    history: [{ ok: false }, { ok: false }, { ok: false }, { ok: true }], deps: d,
  });
  assert.equal(incident.severity, SEVERITY.REPEATED_FAILURE);
  assert.equal(incident.failuresInWindow, 3);
}

// 4. Evidence is preserved on the incident and the audit chain.
{
  const d = deps();
  const { incident } = declareIncident({
    pairingId: 'p9', reason: 'unknown call sign',
    evidence: { presentedCode: '123456', expectedWindow: ['111111'] },
    history: [], deps: d,
  });
  assert.equal(incident.evidence.presentedCode, '123456');
  assert.equal(d.audit[0].evidence.presentedCode, '123456');
  assert.equal(d.incidents.length, 1);
}

console.log('bridge-tripwire: 4/4 passed');
