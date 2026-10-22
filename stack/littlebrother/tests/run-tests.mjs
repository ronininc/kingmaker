/**
 * tests/run-tests.mjs
 *
 * LittleBrother acceptance tests. FAKE TRANSPORT ONLY — no live network.
 * globalThis.fetch is patched to throw at the top of this file, so any
 * code path that reaches for the network fails loudly and the suite does
 * not pass.
 *
 * Usage: node tests/run-tests.mjs
 */

// Network guard FIRST: no network anywhere in this process.
globalThis.fetch = () => {
  throw new Error('TEST VIOLATION: network access is forbidden in tests');
};

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');

const { createLittleBrother } = await import(pathToFileURL(join(ROOT, 'lib/littlebrother.mjs')).href);
const { openAuditLog } = await import(pathToFileURL(join(ROOT, 'lib/audit-log.mjs')).href);

// ---------------------------------------------------------------- fake transport
function makeFakeTransport() {
  const calls = [];
  const canned = {
    username: ({ target }) => ({
      outlet: 'fake-platforms',
      profiles: [{ platform: 'github', url: `https://github.com/${target}`, exists: true, displayName: 'Fake Name' }],
    }),
    ip: () => ({ outlet: 'fake-registry', country: 'US', asn: 'AS12345', organization: 'FakeNet' }),
    domain: () => ({ outlet: 'fake-whois', registrar: 'Fake Registrar', created: '2020-01-01' }),
    web: () => ({ outlet: 'fake-web', title: 'Fake Site', text: 'This is what the target publishes about itself.' }),
  };
  const transport = async ({ kind, target, params }) => {
    calls.push({ kind, target, params });
    const payload = canned[kind];
    if (!payload) throw new Error(`fake-transport: no canned payload for kind '${kind}'`);
    return payload({ kind, target, params });
  };
  transport.calls = calls;
  return transport;
}

const tapVerifier = async (token) => token === 'tap-test-token';
const FULL_IDS = ['phoneLookup', 'personLookup', 'breachQuery'];
const PUBLIC_IDS = ['usernameLookup', 'ipLookup', 'domainLookup', 'webRecon', 'emailFormatCheck'];

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function freshAudit() {
  return join(mkdtempSync(join(tmpdir(), 'lb-audit-')), 'audit.jsonl');
}
function isIso(s) {
  return !Number.isNaN(new Date(s).getTime());
}

// ----------------------------------------------------------- (a) kingmaker mode
await check('kingmaker: public method returns an evidence record', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath: freshAudit(), tapVerifier });
  const r = await lb.usernameLookup('someuser');
  assert(r.ok === true, `expected ok, got ${JSON.stringify(r)}`);
  assert(r.source === 'littlebrother/usernameLookup', `source: ${r.source}`);
  assert(r.outlet === 'fake-platforms', `outlet: ${r.outlet}`);
  assert(isIso(r.date), `date not ISO: ${r.date}`);
  assert(r.data.profiles.length === 1 && r.data.profiles[0].exists === true, 'profile payload missing');
  assert(r.verified === true, 'expected verified:true');
});

await check('kingmaker: full method refuses without tap token', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath: freshAudit(), tapVerifier });
  const r = await lb.phoneLookup('555-0100');
  assert(r.ok === false && r.refused === true, `expected refusal, got ${JSON.stringify(r)}`);
  assert(/founder tap/i.test(r.reason), `reason: ${r.reason}`);
});

await check('kingmaker: full method refuses with wrong tap token', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath: freshAudit(), tapVerifier });
  const r = await lb.personLookup('Some Person', { tapToken: 'wrong-token' });
  assert(r.ok === false && r.refused === true, `expected refusal, got ${JSON.stringify(r)}`);
});

await check('kingmaker: full method runs with valid tap token (stub, no live source)', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath: freshAudit(), tapVerifier });
  const r = await lb.breachQuery('someone@example.com', { tapToken: 'tap-test-token' });
  assert(r.ok === true, `expected ok, got ${JSON.stringify(r)}`);
  assert(r.stub === true, 'expected stub:true — no live non-public source may be wired');
  assert(r.verified === false, 'expected verified:false on a stub result');
  assert(isIso(r.date), `date not ISO: ${r.date}`);
});

await check('kingmaker: full methods refuse when no tap verifier configured', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath: freshAudit() });
  const r = await lb.phoneLookup('555-0100', { tapToken: 'tap-test-token' });
  assert(r.ok === false && r.refused === true, `expected fail-closed refusal, got ${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------- (b) solomon
await check('solomon: full methods absent from the object', async () => {
  const lb = await createLittleBrother({ mode: 'solomon', transport: makeFakeTransport(), auditPath: freshAudit() });
  for (const id of FULL_IDS) {
    assert(!(id in lb), `${id} exists on the solomon object — boundary broken`);
    assert(typeof lb[id] === 'undefined', `${id} readable as undefined? — boundary broken`);
  }
  for (const id of PUBLIC_IDS) {
    assert(typeof lb[id] === 'function', `${id} missing from solomon object`);
  }
  assert(lb.methods.length === 5, `solomon should expose exactly 5 methods, got ${lb.methods.length}`);
  const r = await lb.ipLookup('1.2.3.4');
  assert(r.ok === true && r.verified === true && r.data.country === 'US', `solomon ipLookup failed: ${JSON.stringify(r)}`);
});

await check('solomon: bundle physically excludes full-only code', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'lb-bundle-'));
  execFileSync(process.execPath, [join(ROOT, 'build-solomon.mjs'), outDir], { stdio: 'pipe' });
  const libFiles = readdirSync(join(outDir, 'lib')).sort();
  assert(libFiles.join(',') === 'audit-log.mjs,littlebrother.mjs,methods-public.mjs', `unexpected bundle lib files: ${libFiles}`);
  const forbidden = ['methods-full', 'phonelookup', 'personlookup', 'breachquery', 'createfullmethods', '__lb_full'];
  function* walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) yield* walk(p);
      else yield p;
    }
  }
  for (const file of walk(outDir)) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const needle of forbidden) {
      assert(!text.includes(needle), `bundle file ${file} contains '${needle}'`);
    }
  }
  // The bundle's own core: solomon works, kingmaker mode hard-fails.
  const bundleCore = await import(pathToFileURL(join(outDir, 'lib/littlebrother.mjs')).href);
  const lb = await bundleCore.createLittleBrother({ mode: 'solomon', transport: makeFakeTransport(), auditPath: join(outDir, 'audit.jsonl') });
  assert(!('breachQuery' in lb), 'bundle solomon object has breachQuery');
  const r = await lb.domainLookup('example.com');
  assert(r.ok === true && r.verified === true, `bundle solomon domainLookup failed`);
  let threw = false;
  try {
    await bundleCore.createLittleBrother({ mode: 'kingmaker' });
  } catch (err) {
    threw = /not present in this build/.test(err.message);
  }
  assert(threw, 'bundle core should refuse kingmaker mode with "not present in this build"');
});

// ------------------------------------------------------------- (c) audit log
await check('audit: calls and refusals are logged, chain verifies', async () => {
  const auditPath = freshAudit();
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath, tapVerifier });
  await lb.usernameLookup('someuser');
  await lb.phoneLookup('555-0100'); // refusal — no tap token
  const v = lb.verifyAudit();
  assert(v.ok === true, `chain failed verification: ${JSON.stringify(v)}`);
  const log = openAuditLog(auditPath);
  const actions = log.entries.map((e) => e.action);
  assert(actions.includes('lookup'), `no lookup action: ${actions}`);
  assert(actions.includes('lookup-refused'), `no lookup-refused action: ${actions}`);
  assert(log.entries[0].action === 'genesis', 'first entry must be genesis');
});

await check('audit: persisted chain detects tampering', async () => {
  const auditPath = freshAudit();
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath, tapVerifier });
  await lb.ipLookup('9.9.9.9');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(auditPath, JSON.stringify({ seq: 99, ts: 'x', actor: 'x', action: 'x', detail: 'x', meta: {}, prevHash: 'x', hash: 'x' }) + '\n');
  let threw = false;
  try {
    openAuditLog(auditPath);
  } catch (err) {
    threw = true;
  }
  assert(threw, 'tampered audit log was accepted — expected rejection');
});

// ----------------------------------------------------------- (d) no network
await check('no network: fake transport serves every network method', async () => {
  const transport = makeFakeTransport();
  const lb = await createLittleBrother({ mode: 'kingmaker', transport, auditPath: freshAudit(), tapVerifier });
  await lb.usernameLookup('u');
  await lb.ipLookup('1.1.1.1');
  await lb.domainLookup('example.com');
  await lb.webRecon('https://example.com');
  assert(transport.calls.length === 4, `expected 4 transport calls, got ${transport.calls.length}`);
});

await check('no network: email format check is local-only', async () => {
  const transport = makeFakeTransport();
  const lb = await createLittleBrother({ mode: 'kingmaker', transport, auditPath: freshAudit(), tapVerifier });
  const r = await lb.emailFormatCheck('someone@mailinator.com');
  assert(r.ok === true && r.data.disposable === true && r.verified === true, `unexpected: ${JSON.stringify(r)}`);
  assert(r.outlet === 'local-patterns', `expected local-patterns outlet, got ${r.outlet}`);
  assert(transport.calls.length === 0, 'email format check reached the transport — must be local-only');
  const bad = await lb.emailFormatCheck('not-an-email');
  assert(bad.verified === false, 'invalid email marked verified');
});

await check('csam discipline: abusive input aborts, no content returned', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', transport: makeFakeTransport(), auditPath: freshAudit(), tapVerifier });
  const r = await lb.usernameLookup('lolita video archive');
  assert(r.ok === false && r.aborted === true, `expected auto-abort, got ${JSON.stringify(r)}`);
});

await check('fail-closed: no transport means public methods refuse', async () => {
  const lb = await createLittleBrother({ mode: 'kingmaker', auditPath: freshAudit(), tapVerifier });
  const r = await lb.webRecon('https://example.com');
  assert(r.ok === false && r.refused === true, `expected fail-closed refusal, got ${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
