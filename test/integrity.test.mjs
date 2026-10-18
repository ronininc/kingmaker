// Is this the official Kingmaker? (lib/integrity.mjs): the bundle's seal and Ronin's signer, checked at launch. A changed
// or re-signed copy is "modified" and kept out of the collective; a source checkout is "dev".
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appBundleOf, BUNDLE_ID, checkIntegrity, createIntegrity, MODIFIED_NOTE, RONIN_SIGNERS, requirement } from '../lib/integrity.mjs';

const hasRoninCert = spawnSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' }).stdout?.includes(RONIN_SIGNERS[0]);

function fixtureApp(root) {
  const app = join(root, 'Kingmaker.app'), c = join(app, 'Contents');
  mkdirSync(join(c, 'MacOS'), { recursive: true }); mkdirSync(join(c, 'Resources', 'sol-ghost', 'lib'), { recursive: true });
  writeFileSync(join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleExecutable</key><string>Kingmaker</string></dict></plist>`);
  writeFileSync(join(c, 'MacOS', 'Kingmaker'), '#!/bin/sh\nexit 0\n'); chmodSync(join(c, 'MacOS', 'Kingmaker'), 0o755);
  writeFileSync(join(c, 'Resources', 'sol-ghost', 'lib', 'cli.mjs'), 'export const official = true;\n');
  return app;
}

test('where it runs from: an app bundle, or a source checkout', () => {
  assert.equal(appBundleOf('/Applications/Kingmaker.app/Contents/Resources/sol-ghost/lib/integrity.mjs'), '/Applications/Kingmaker.app');
  assert.equal(appBundleOf('/Users/me/Projects/sol-ghost/lib/integrity.mjs'), null);
  assert.equal(requirement(), `identifier "${BUNDLE_ID}" and (${RONIN_SIGNERS.map((h) => `certificate leaf = H"${h.toLowerCase()}"`).join(' or ')})`);
});

test('official, then an edited file, then someone else\'s signature: both are "modified"', { skip: !hasRoninCert && 'needs Ronin\'s signing certificate (the owner\'s Mac)', timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'km-integrity-')), app = fixtureApp(root);
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', RONIN_SIGNERS[0], '--identifier', BUNDLE_ID, app], { stdio: 'pipe' });
    assert.equal((await checkIntegrity({ app })).state, 'official');
    appendFileSync(join(app, 'Contents/Resources/sol-ghost/lib/cli.mjs'), 'export const tampered = true;\n');
    const edited = await checkIntegrity({ app });
    assert.equal(edited.state, 'modified'); assert.equal(edited.reason, 'files changed since Ronin signed it');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', BUNDLE_ID, app], { stdio: 'pipe' });
    const resigned = await checkIntegrity({ app });
    assert.equal(resigned.state, 'modified'); assert.equal(resigned.reason, 'signed by someone other than Ronin');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the engine\'s view: optimistic until checked, then a modified copy is cut off and told once', async () => {
  const state = mkdtempSync(join(tmpdir(), 'km-integrity-state-')), told = [];
  try {
    const i = createIntegrity({ state, check: async () => ({ state: 'modified', reason: 'files changed since Ronin signed it' }), onModified: (r) => told.push(r) });
    assert.equal(i.official(), true, 'before the check finishes');
    await i.start(); await i.start();
    assert.equal(i.official(), false); assert.equal(i.modified(), true); assert.equal(told.length, 1);
    assert.equal(JSON.parse(readFileSync(join(state, 'integrity.json'), 'utf8')).state, 'modified');
    assert.match(MODIFIED_NOTE('x'), /cut off from the collective/);
    const ok = createIntegrity({ state, check: async () => ({ state: 'dev', reason: 'running from source' }) });
    await ok.start(); assert.equal(ok.official(), true);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('daily sharing is skipped from a changed copy', () => {
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const shareDaily = \(\) => \(!integrity\.official\(\) \? log\('sharing_daily', \{ skipped: 'not the official build' \}\)/);
});

test('a release signed with the pinned Kingmaker Release certificate is official', async () => {
  const { signersFor, RONIN_SIGNERS, requirement } = await import('../lib/integrity.mjs');
  const { readPin } = await import('../lib/release-identity.mjs');
  const pin = readPin();
  if (pin) assert.ok(RONIN_SIGNERS.includes(pin.sha1), 'the shipped pin is a Ronin signer');
  assert.deepEqual(signersFor({ sha1: 'A'.repeat(40) }), ['A'.repeat(40), '4B14A5E4B8B51526A3668C5A97AE82BE8BA0F6D7']);
  assert.deepEqual(signersFor(null), ['4B14A5E4B8B51526A3668C5A97AE82BE8BA0F6D7']);
  assert.match(requirement(signersFor({ sha1: 'A'.repeat(40) })), /certificate leaf = H"a{40}" or certificate leaf = H"4b14/);
});
