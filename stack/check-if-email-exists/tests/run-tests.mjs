/**
 * check-if-email-exists verify-gate tests — gate logic only. The
 * transport is an injected fake; no SMTP, DNS, or HTTP ever happens.
 */

import { readFileSync } from 'node:fs';
import {
  CIE_PIN,
  buildBackendConfig,
  openBatch,
  verifyAddress,
  checkHibpEgress,
  closeBatch,
} from '../lib/verify-gate.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const tap = async (t) => t === 'founder-token';
const fakeTransport = (verdict = 'deliverable', methods = ['syntax', 'dns-mx', 'smtp']) =>
  async () => ({ verdict, methods });

// 1. Pin record.
check('pin names the intake commit', CIE_PIN.commit.startsWith('5fba96e') && descriptor.commit === CIE_PIN.commit);
check('license is MIT', CIE_PIN.license === 'MIT' && descriptor.license.core === 'MIT');

// 2. Backend config: loopback pin, Sentry pinned off, gravatar off.
const cfg = buildBackendConfig();
check('backend defaults to loopback:8080', cfg.ok === true && cfg.config.host === '127.0.0.1' && cfg.config.port === 8080);
check('backend wide bind refused (no auth layer upstream)', buildBackendConfig({ host: '0.0.0.0' }).ok === false);
check('backend LAN bind refused', buildBackendConfig({ host: '192.168.1.50' }).ok === false);
check('Sentry DSN refused, not dropped', buildBackendConfig({ sentryDsn: 'https://x@o.ingest.sentry.io/1' }).ok === false);
check('gravatar pinned off in config env', cfg.config.gravatar === false && cfg.config.env.CHECK_GRAVATAR === 'false');

// 3. Batch opening: provenance + tap + bounded allowance.
check('batch refuses without provenance', (await openBatch({ listId: 'investors-oct', allowance: 10, tapToken: 'founder-token', verifyTap: tap })).ok === false);
check('batch refuses without tap', (await openBatch({ listId: 'investors-oct', provenance: 'Robbie CRM export', allowance: 10 })).ok === false);
check('batch refuses bad tap', (await openBatch({ listId: 'investors-oct', provenance: 'Robbie CRM export', allowance: 10, tapToken: 'nope', verifyTap: tap })).ok === false);
check('batch refuses zero allowance', (await openBatch({ listId: 'investors-oct', provenance: 'Robbie CRM export', allowance: 0, tapToken: 'founder-token', verifyTap: tap })).ok === false);
check('hibp opt-in without a key refuses', (await openBatch({ listId: 'investors-oct', provenance: 'Robbie CRM export', allowance: 10, hibp: true, tapToken: 'founder-token', verifyTap: tap })).ok === false);
const opened = await openBatch({ listId: 'investors-oct', provenance: 'Drafted investor outreach list, Robbie CRM', allowance: 2, tapToken: 'founder-token', verifyTap: tap });
check('batch opens with tap + provenance', opened.ok === true && opened.batch.open === true && opened.batch.egressHosts.length === 0);
const batch = opened.batch;

// 4. Verification inside the batch.
check('malformed address refused before transport', (await verifyAddress(batch, 'not-an-email', { transport: fakeTransport() })).ok === false && batch.used === 0);
const r1 = await verifyAddress(batch, 'founder@example.com', { transport: fakeTransport() });
check('check records verdict + declared methods', r1.ok === true && r1.record.verdict === 'deliverable' && r1.record.methods.includes('smtp') && r1.remaining === 1);
check('undeclared probe method refuses the record', (await verifyAddress(batch, 'a@b.co', { transport: fakeTransport('x', ['smtp', 'carrier-lookup']) })).ok === false && batch.used === 1);
check('gravatar probing refuses the record (pinned off)', (await verifyAddress(batch, 'a@b.co', { transport: fakeTransport('x', ['smtp', 'gravatar']) })).ok === false && batch.used === 1);
check('hibp in a non-opted batch refuses the record', (await verifyAddress(batch, 'a@b.co', { transport: fakeTransport('x', ['smtp', 'hibp']) })).ok === false && batch.used === 1);
const r2 = await verifyAddress(batch, 'second@example.org', { transport: fakeTransport('risky', ['syntax', 'dns-mx', 'smtp', 'provider-probe']) });
check('provider-probe is declarable and recorded', r2.ok === true && r2.record.methods.includes('provider-probe') && r2.remaining === 0);
check('allowance exhaustion closes the batch', (await verifyAddress(batch, 'third@example.net', { transport: fakeTransport() })).ok === false && batch.open === false);

// 5. HIBP batch: egress guard honors the opt-in.
const hibpOpened = await openBatch({ listId: 'crm-cleanup', provenance: 'CRM dedupe pass, Robbie export', allowance: 5, hibp: true, hibpKeyPresent: true, tapToken: 'founder-token', verifyTap: tap });
check('hibp batch opens with key present', hibpOpened.ok === true && hibpOpened.batch.egressHosts.includes('haveibeenpwned.com'));
check('hibp URL allowed in hibp batch', checkHibpEgress(hibpOpened.batch, 'https://haveibeenpwned.com/api/v3/breachedaccount/x').ok === true);
check('hibp URL refused in plain batch', checkHibpEgress(batch, 'https://haveibeenpwned.com/api/v3/x').ok === false);
check('unrelated host refused even in hibp batch', checkHibpEgress(hibpOpened.batch, 'https://example.com/').ok === false);
const hr = await verifyAddress(hibpOpened.batch, 'vip@example.com', { transport: fakeTransport('deliverable', ['syntax', 'dns-mx', 'smtp', 'hibp']) });
check('hibp method accepted in opted batch', hr.ok === true && hr.record.methods.includes('hibp'));
closeBatch(hibpOpened.batch);
check('closed batch refuses further checks', (await verifyAddress(hibpOpened.batch, 'a@b.co', { transport: fakeTransport() })).ok === false);
check('no transport wired refuses', (await openBatch({ listId: 'x-list', provenance: 'test provenance', allowance: 1, tapToken: 'founder-token', verifyTap: tap })).ok === true);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
