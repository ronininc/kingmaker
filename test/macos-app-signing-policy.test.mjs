import test from 'node:test';
import assert from 'node:assert/strict';
import { appSigningPolicy, preflightAppSigner } from '../lib/macos-app-signing-policy.mjs';

const apple = { lane: 'developer-id', expectedVersion: '4.5.3', expectedTeam: 'ABCDEFGHIJ' };
const legacy = { lane: 'legacy', expectedVersion: apple.expectedVersion, legacyLeaf: 'A'.repeat(40) };
const bundle = 'com.ronininc.solghost', app = '/fixture/Kingmaker.app';

function mock({ code = 0, exactCode = 0, assessmentStatus = 0, stapleStatus = 0, version = apple.expectedVersion,
  id = bundle, identifier = bundle, team = apple.expectedTeam, runtime = true, timestamp = true, adhoc = false,
  assessment = 'Notarized Developer ID' } = {}) {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, args]);
    if (bin.endsWith('plutil')) return { status: 0, stdout: args[1] === 'CFBundleIdentifier' ? id : version };
    if (bin.endsWith('codesign') && args[0] === '-d') return { status: 0, stderr:
      `Identifier=${identifier}\nTeamIdentifier=${team}\nCodeDirectory v=20500 size=123 flags=0x10000(${runtime ? 'runtime' : 'other'})\n`
      + (adhoc ? 'Signature=adhoc\n' : '') + (timestamp ? 'Timestamp=Nov 24, 2026 at 10:00:00 AM\n' : '') };
    if (bin.endsWith('codesign')) return { status: args.some(a => a.startsWith('-R=')) ? exactCode : code };
    if (bin.endsWith('spctl')) return { status: assessmentStatus, stderr: 'source=' + assessment + '\n' };
    if (bin.endsWith('xcrun')) return { status: stapleStatus };
    throw Error('Unexpected probe');
  };
  return { run, platform: 'darwin', calls };
}

test('there is no inferred lane, no wildcard team, and no OR requirement', () => {
  for (const o of [{}, { ...apple, lane: undefined }, { ...apple, expectedVersion: 'latest' },
    { ...apple, expectedTeam: '" or true' }, { ...apple, legacyLeaf: legacy.legacyLeaf },
    { ...legacy, expectedTeam: apple.expectedTeam }, { ...legacy, legacyLeaf: 'anything' }]) assert.throws(() => appSigningPolicy(o));
  assert.match(appSigningPolicy(apple).requirement, /anchor apple generic and certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] exists/);
  assert.match(appSigningPolicy(apple).requirement, /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists and certificate leaf\[subject\.OU\] = "ABCDEFGHIJ"/);
  assert.doesNotMatch(appSigningPolicy(apple).requirement, /\bor\b/);
});

test('Apple preflight asks the OS about exact selected identity, Gatekeeper and staple', () => {
  const m = mock();
  assert.deepEqual(preflightAppSigner(app, apple, m), { ok: true, lane: 'developer-id', problems: [] });
  assert(m.calls.some(([,args]) => args.includes('-R=' + appSigningPolicy(apple).requirement)));
  assert(m.calls.some(([bin,args]) => bin === '/usr/sbin/spctl' && args.includes('execute')));
  assert(m.calls.some(([bin,args]) => bin === '/usr/bin/xcrun' && args[0] === 'stapler' && args[1] === 'validate'));
});

test('fails closed for wrong signer/version/bundle/team or insufficient Apple proof', () => {
  for (const bad of [{ exactCode: 1 }, { version: '4.5.2' }, { id: 'com.other.app' }, { identifier: 'com.other.app' },
    { team: 'ZZZZZZZZZZ' }, { adhoc: true }, { timestamp: false }, { runtime: false }, { code: 1 },
    { stapleStatus: 1 }, { assessmentStatus: 1 }, { assessment: 'Developer ID' }]) {
    assert.equal(preflightAppSigner(app, apple, mock(bad)).ok, false, JSON.stringify(bad));
  }
});

test('the explicit legacy lane still pins its own leaf; it never claims notarized status or falls back', () => {
  const m = mock({ team: 'not set', timestamp: false, assessmentStatus: 1, stapleStatus: 1 });
  assert.deepEqual(preflightAppSigner(app, legacy, m), { ok: true, lane: 'legacy', problems: [] });
  assert(m.calls.some(([,args]) => args.includes('-R=' + appSigningPolicy(legacy).requirement)));
  assert(m.calls.every(([bin]) => !bin.endsWith('spctl') && !bin.endsWith('xcrun')));
  assert.equal(preflightAppSigner(app, legacy, mock({ exactCode: 1 })).ok, false);
  assert.equal(preflightAppSigner(app, apple, { platform: 'linux', run: () => { throw Error('must not spawn'); } }).ok, false);
});
