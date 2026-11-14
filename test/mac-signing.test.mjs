import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  KINGMAKER_BUNDLE_ID,
  PINNED_KINGMAKER_LOCAL_SHA1,
  resolveKingmakerSigning,
} from '../scripts/kingmaker-mac-signing.mjs';
import { checkDesignatedRequirement } from '../solomon/scripts/solomon-mac-signing.mjs';

const IDENTITIES = `Policy: Code Signing
  Matching identities
  1) 3F7E2899428AF2EB6EBD1237977A90FFD423637B "Solomon Local" (CSSMERR_TP_NOT_TRUSTED)
  2) 4B14A5E4B8B51526A3668C5A97AE82BE8BA0F6D7 "Solomon Local" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found`;

test('Kingmaker pins this Mac\'s stable local certificate, even when another same-named one is listed first', () => {
  const plan = resolveKingmakerSigning({ env: {}, identitiesText: IDENTITIES, pin: null });
  assert.equal(plan.mode, 'identity');
  assert.equal(plan.identity, PINNED_KINGMAKER_LOCAL_SHA1);
});

test('certificate requirement persists; ad-hoc cdhash does not', () => {
  assert.equal(checkDesignatedRequirement(`designated => identifier "${KINGMAKER_BUNDLE_ID}" and certificate leaf = H"${PINNED_KINGMAKER_LOCAL_SHA1}"`, KINGMAKER_BUNDLE_ID).ok, true);
  assert.equal(checkDesignatedRequirement('designated => cdhash H"43aaddfa7a2d0bbf3d251899ea958f2034ab5a7a"', KINGMAKER_BUNDLE_ID).ok, false);
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

test('a self-signed release identity (certificate root) is certificate-based; cdhash-only is not', async () => {
  const { checkDesignatedRequirement } = await import('../solomon/scripts/solomon-mac-signing.mjs');
  const root = 'designated => identifier "com.ronininc.solghost" and certificate root = H"aa6a53e3555ccd97e04a2f7667155963297da354"';
  assert.equal(checkDesignatedRequirement(root, 'com.ronininc.solghost').ok, true);
  assert.equal(checkDesignatedRequirement('# designated => cdhash H"0123456789abcdef0123456789abcdef01234567"', 'com.ronininc.solghost').ok, false);
});

test('the release check tests the pinned certificate with codesign -R, not the requirement text', () => {
  const script = readFileSync(new URL('../scripts/kingmaker-mac-signing.mjs', import.meta.url), 'utf8');
  assert.match(script, /pinMatches = !pin \|\| run\('codesign', \['--verify', '--strict', `-R=\$\{appRequirement\(pin\.sha1\)\}`, appPath\]\)\.code === 0/);
});
