// Tests for Phase 2: dark web search method.
// These tests NEVER touch the Tor network. fetchViaTor is not invoked —
// all tests use the pure functions (CSAM check, text extraction, gates).
// Live Tor tests require founder supervision and are NOT in CI.

import { createEmptyAuditChain } from '../runtime/audit-chain';
import {
  checkCsamIndicators,
  darkwebSearch,
  extractTextOnly,
  killDarkWebSession,
} from '../runtime/darkweb-search';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function testTextExtraction(): Promise<void> {
  console.log('text extraction:');
  const html = '<html><head><script>evil()</script><style>.x{}</style></head><body><p>Hello <b>world</b></p><img src="x.jpg"></body></html>';
  const text = extractTextOnly(html);
  assert(!text.includes('<script'), 'scripts stripped');
  assert(!text.includes('<style'), 'styles stripped');
  assert(!text.includes('<img'), 'images stripped');
  assert(text.includes('Hello'), 'text preserved');
  assert(text.includes('world'), 'text preserved');
}

async function testGates(): Promise<void> {
  console.log('governance gates:');
  const chain = createEmptyAuditChain();
  const scope = { topics: ['test'], maxQueries: 5, maxResultsPerQuery: 10, maxMinutes: 30 };

  // No hardening = refuse to load
  const noHardening = await darkwebSearch(
    {
      queries: ['test'],
      scope,
      tapReference: 'tap-001',
      hardeningVerified: false,
      requesterAuthority: 'FOUNDER',
    },
    chain,
  );
  assert(!noHardening.ok, 'refuses without hardening verified');
  assert(noHardening.reasonPlain.includes('fail-closed'), 'names fail-closed design');

  // No tap = refused
  const noTap = await darkwebSearch(
    {
      queries: ['test'],
      scope,
      tapReference: '',
      hardeningVerified: true,
      requesterAuthority: 'OPERATOR',
    },
    chain,
  );
  assert(!noTap.ok, 'refuses without founder tap');
  // Audit chain should have the denial recorded
  assert(noTap.auditChain.records.length === 1, 'denial written to audit chain');
  assert(noTap.auditChain.records[0].eventType === 'TAP_DENIED', 'denial event type correct');

  // Scope violation: too many queries
  const overScope = await darkwebSearch(
    {
      queries: ['a', 'b', 'c', 'd', 'e', 'f'],
      scope,
      tapReference: 'tap-002',
      hardeningVerified: true,
      requesterAuthority: 'FOUNDER',
    },
    chain,
  );
  assert(!overScope.ok, 'refuses queries beyond scope');
}

async function testKillSwitch(): Promise<void> {
  console.log('kill switch:');
  const chain = createEmptyAuditChain();
  const { auditChain } = killDarkWebSession({ sessionId: 'dw-test' }, chain, 'founder command');
  assert(auditChain.records.length === 1, 'kill recorded in audit chain');
  assert(auditChain.records[0].eventType === 'KILL_SWITCH', 'kill switch event type correct');
}

async function testCsamCheckExists(): Promise<void> {
  console.log('csam guard:');
  // The blocklist is intentionally minimal in source — production loads
  // from an external file. Verify the check function exists and returns
  // null for clean content (does not false-positive on normal text).
  const clean = checkCsamIndicators('This is a normal search result about cybersecurity threats.');
  assert(clean === null, 'clean content not flagged');
}

async function main(): Promise<void> {
  await testTextExtraction();
  await testGates();
  await testKillSwitch();
  await testCsamCheckExists();
  console.log('\nAll Phase 2 dark web search tests passed (offline — no Tor traffic).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
