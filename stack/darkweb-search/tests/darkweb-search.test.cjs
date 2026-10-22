// Behavioral tests for runtime/darkweb-search.ts (the 2026-10-21 sandbox back-port).
// Build first: tsc --outDir $DW_OUT --module commonjs --moduleResolution node runtime/darkweb-search.ts
// Run: DW_OUT=/tmp/dw-out node tests/darkweb-search.test.cjs
// Behavioral tests for the back-ported runtime/darkweb-search.ts (compiled CJS in /tmp/dw-out).
const assert = require('node:assert/strict');
const { darkwebSearch, acknowledgeDarkwebFindings, killDarkWebSession, assertSandboxBinding } = require(`${process.env.DW_OUT || '/tmp/dw-out'}/runtime/darkweb-search.js`);
const { createEmptyAuditChain } = require(`${process.env.DW_OUT || '/tmp/dw-out'}/contracts/audit-chain.js`);

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const scope = { topics: ['test'], maxQueries: 5, maxResultsPerQuery: 3, maxMinutes: 5 };
const baseReq = { queries: ['normal query about radios'], scope, tapReference: 'tap-1', hardeningVerified: true, requesterAuthority: 'FOUNDER' };

function fakeBinding(over = {}) {
  const calls = { seal: 0, unseal: 0, snapshot: 0, diffScan: 0, transport: 0, tornDown: false };
  const binding = {
    id: 'fake-cell',
    async seal() { calls.seal += 1; return over.sealResult ?? { mic: true, camera: true }; },
    async unseal() { calls.unseal += 1; },
    async snapshot() { calls.snapshot += 1; if (over.snapshotFails) throw new Error('snapshot boom'); return { token: 1 }; },
    async diffScan() { calls.diffScan += 1; return over.scanDiff ?? { added: [], changed: [], removed: [] }; },
    transport(url) {
      calls.transport += 1;
      if (over.transportImpl) return over.transportImpl(url, calls);
      return Promise.resolve('<html><body><p>A perfectly ordinary result page about radios and antennas.</p></body></html>');
    },
  };
  return { binding, calls };
}

(async () => {
  // binding assertion shape
  assert.throws(() => assertSandboxBinding(null), /no bounded sandbox binding/); passed += 1; console.log('  ok - binding assertion refuses null');

  // 1. no binding → refused before anything
  {
    const { binding, calls } = fakeBinding();
    const res = await darkwebSearch({ ...baseReq, sandbox: undefined }, createEmptyAuditChain());
    ok('missing binding refuses the session', res.ok === false && res.sessionState === 'refused' && calls.seal === 0);
    void binding;
  }

  // 2. seal not attested → refused, no snapshot, no transport
  {
    const { binding, calls } = fakeBinding({ sealResult: { mic: true, camera: false } });
    const res = await darkwebSearch({ ...baseReq, sandbox: binding }, createEmptyAuditChain());
    ok('unattested seal refuses the dive', res.ok === false && calls.snapshot === 0 && calls.transport === 0);
  }

  // 3. happy path → results, clean scan, unsealed
  {
    const { binding, calls } = fakeBinding();
    const res = await darkwebSearch({ ...baseReq, sandbox: binding }, createEmptyAuditChain());
    ok('happy path completes closed-clean', res.ok === true && res.sessionState === 'closed-clean' && res.results.length >= 1);
    ok('seal → snapshot → transport → scan → unseal all ran', calls.seal === 1 && calls.snapshot === 1 && calls.transport === 1 && calls.diffScan === 1 && calls.unseal === 1);
    const types = res.auditChain.records.map((r) => r.eventType);
    ok('audit carries the seal + selfscan events', types.includes('DARKWEB_DEVICES_SEALED') && types.includes('DARKWEB_SELFSCAN_CLEAN'));
  }

  // 4. tripwire split across chunk boundary → mid-stream abort + teardown + still settles
  {
    const { binding, calls } = fakeBinding({
      transportImpl: (url, c) => (async function* () {
        try {
          yield '<p>ordinary text about pre';
          yield 'teen modeling agencies</p>';
          yield '<p>never reached</p>';
        } finally { c.tornDown = true; }
      })(),
    });
    const res = await darkwebSearch({ ...baseReq, sandbox: binding }, createEmptyAuditChain());
    ok('boundary-split tripwire aborts the session', res.ok === false && res.abortRecord && res.abortRecord.indicator === 'KEYWORD_BLOCKLIST');
    ok('the stream was torn down mid-transfer', calls.tornDown === true);
    ok('abort still owes + gets the self-scan (clean → unsealed)', calls.diffScan === 1 && calls.unseal === 1 && res.sessionState === 'closed-clean');
  }

  // 5. findings → quarantined, seal holds; acknowledgment is founder-only
  {
    const { binding, calls } = fakeBinding({ scanDiff: { added: ['/cell/new-file'], changed: [], removed: [] } });
    const res = await darkwebSearch({ ...baseReq, sandbox: binding }, createEmptyAuditChain());
    ok('findings quarantine the session', res.ok === false && res.sessionState === 'quarantined' && res.findings.added.length === 1);
    ok('devices stay sealed on findings', calls.unseal === 0);
    const denied = await acknowledgeDarkwebFindings({ sessionId: res.sessionId, tapReference: 'tap-2', requesterAuthority: 'OPERATOR' }, res.auditChain);
    ok('acknowledgment without the founder is refused', denied.ok === false && calls.unseal === 0);
    const ack = await acknowledgeDarkwebFindings({ sessionId: res.sessionId, tapReference: 'tap-2', requesterAuthority: 'FOUNDER' }, res.auditChain);
    ok('founder acknowledgment unseals + closes flagged', ack.ok === true && calls.unseal === 1);
    const again = await acknowledgeDarkwebFindings({ sessionId: res.sessionId, tapReference: 'tap-3', requesterAuthority: 'FOUNDER' }, ack.auditChain);
    ok('a settled session cannot be acknowledged twice', again.ok === false);
  }

  // 6. query-side trip → transport never runs
  {
    const { binding, calls } = fakeBinding();
    const res = await darkwebSearch({ ...baseReq, queries: ['preteen stuff'], sandbox: binding }, createEmptyAuditChain());
    ok('a tripping query aborts before any traffic', res.abortRecord !== null && calls.transport === 0);
  }

  // 7. non-text chunk → torn down, session settles
  {
    const { binding } = fakeBinding({
      transportImpl: () => (async function* () { yield Buffer.from('binary'); })(),
    });
    const res = await darkwebSearch({ ...baseReq, sandbox: binding }, createEmptyAuditChain());
    ok('non-text chunk is refused and the session still settles', res.sessionState === 'closed-clean' && res.results.length === 0);
  }

  // 8. byte bound → torn down
  {
    const { binding } = fakeBinding({ transportImpl: () => Promise.resolve('word '.repeat(1000)) });
    const res = await darkwebSearch({ ...baseReq, maxStreamBytes: 100, sandbox: binding }, createEmptyAuditChain());
    const q = res.auditChain.records.find((r) => r.eventType === 'DARKWEB_QUERY');
    ok('oversized stream is torn down at the byte bound', res.results.length === 0 && q.summaryPlain.includes('read bound'));
  }

  // 9. kill switch audits + marks (unknown session still records the act)
  {
    const out = killDarkWebSession({ sessionId: 'dw-ghost' }, createEmptyAuditChain(), 'test kill');
    ok('kill switch appends its audit record', out.auditChain.records.some((r) => r.eventType === 'KILL_SWITCH'));
  }

  console.log(`darkweb-ts-port: ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
