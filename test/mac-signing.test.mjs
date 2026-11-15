import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { KINGMAKER_BUNDLE_ID, readPin, appRequirement } from '../lib/release-identity.mjs';
import { verifyKingmakerSignature } from '../scripts/kingmaker-mac-signing.mjs';

const pin = readPin();
test('identity CLI selects the pinned release certificate, not a same-named local identity', () => {
  assert.equal(pin.sha1, 'D4D40C383400C2D62785FB1D60FB0C3AD69CC3C2');
  assert.equal(execFileSync(process.execPath, ['scripts/kingmaker-mac-signing.mjs', '--identity'], { encoding: 'utf8' }).trim(), pin.sha1);
});

function fixture({ strict = 0, requirement = 0, selectedPin = pin, details = `Identifier=${KINGMAKER_BUNDLE_ID}\nflags=0x10000(runtime)\nAuthority=Kingmaker Release`, text = `certificate leaf = H"${pin.sha1}"` } = {}) {
  const calls = [];
  const result = verifyKingmakerSignature('/fixture.app', { pin: selectedPin, platform: 'darwin', exists: () => true,
    runImpl: (cmd, args) => {
      calls.push([cmd, args]);
      if (args.some(a => a.startsWith('-R='))) return { code: requirement, out: '' };
      if (args[0] === '--verify') return { code: strict, out: '' };
      return { code: 0, out: args[0] === '-dvvv' ? details : text };
    },
  });
  return { result, calls };
}
test('actual pinned requirement succeeds even when diagnostic requirement text has no leaf', () => {
  const {result,calls} = fixture({text:'diagnostic only'});
  assert.equal(result.ok,true); assert.equal(result.leaf,null);
  assert.ok(calls.some(([cmd,args])=>cmd==='codesign' && args.includes(`-R=${appRequirement(pin.sha1)}`)));
});
test('forged diagnostic text cannot substitute for actual pinned certificate verification', () => {
  assert.equal(fixture({requirement:1}).result.ok,false);
  assert.equal(fixture({selectedPin:{sha1:'A'.repeat(40)},requirement:1}).result.ok,false);
  const missing=fixture({selectedPin:null});
  assert.equal(missing.result.ok,false);
  assert.equal(missing.calls.some(([,args])=>args.some(a=>a.startsWith('-R='))),false);
  assert.equal(fixture({selectedPin:{sha1:'invalid'}}).result.ok,false);
});
test('pin success never overrides strict verification, bundle identity, runtime, or ad-hoc rejection', () => {
  for(const options of [{strict:1},{details:'Identifier=wrong\nflags=0x10000(runtime)'},
    {details:`Identifier=${KINGMAKER_BUNDLE_ID}`},
    {details:`Identifier=${KINGMAKER_BUNDLE_ID}\nflags=0x10000(runtime)\nSignature=adhoc`}]) {
    assert.equal(fixture(options).result.ok,false);
  }
});

test('thin app build fails closed onto the signing proof instead of ad-hoc signing', () => {
  const script = readFileSync(new URL('../scripts/build-app.sh', import.meta.url), 'utf8');
  assert.match(script, /kingmaker-mac-signing\.mjs" --identity/);
  assert.match(script, /kingmaker-mac-signing\.mjs" --verify/);
  assert.doesNotMatch(script, /codesign[^\n]*--sign - /);
});

test('thin app replacement waits for the running signed app to finish its backend shutdown', () => {
  const script = readFileSync(new URL('../scripts/build-app.sh', import.meta.url), 'utf8');
  const quit = script.indexOf('tell application id "com.ronininc.solghost" to quit');
  const wait = script.indexOf('seq 1 40');
  const refusal = script.indexOf('Kingmaker is still running');
  const replace = script.indexOf('rm -rf "$installed_app"');
  assert.ok(quit >= 0 && wait > quit && refusal > wait && replace > refusal, 'quit, wait, refuse, then replace');
  assert.match(script, /kingmaker_running \|\| break/);
  assert.match(script, /Never paper over it with kill -9/);
});

test('release packaging also refuses to ship an unstable permission identity', () => {
  const script = readFileSync(new URL('../scripts/release-parts.mjs', import.meta.url), 'utf8');
  assert.match(script, /verifyKingmakerSignature\(app\)/);
  assert.match(script, /macOS privacy identity is not stable/);
});

test('installer removes an alternate Kingmaker copy before committing the new one', () => {
  const script = readFileSync(new URL('../installer/engine.sh', import.meta.url), 'utf8');
  assert.match(script, /installed_apps\(\)/);
  assert.match(script, /Kingmaker\.app\.duplicate/);
});

