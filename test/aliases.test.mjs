// The rename keeps the old names working: `sol-ghost` is an alias of the `kingmaker` CLI, solghost:// of kingmaker://,
// and what macOS keys its permissions to (the bundle id) and the data folder (vault, knowledge index) never move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEGACY_WAKE_LINK, WAKE_LINK } from '../lib/cli.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { SIRI_SHORTCUT_NAME, wakeShortcutPlist } from '../lib/siri.mjs';
import { SEAL_SERVICE } from '../lib/keychain-seal.mjs';

const at = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

test('CLI: kingmaker is the command, sol-ghost an alias of the same script', () => {
  const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
  assert.equal(pkg.name, 'kingmaker');
  assert.deepEqual(pkg.bin, { kingmaker: 'bin/kingmaker', 'sol-ghost': 'bin/sol-ghost' });
  assert.ok(lstatSync(at('bin/sol-ghost')).isSymbolicLink() && readlinkSync(at('bin/sol-ghost')) === 'kingmaker');
  for (const name of ['kingmaker', 'sol-ghost']) {
    const r = spawnSync(at(`bin/${name}`), ['--version'], { encoding: 'utf8', env: { ...process.env, SOL_GHOST_RUNTIME: '' } });
    assert.equal(r.stdout.trim(), pkg.version, `${name} --version`);
  }
  const usage = spawnSync(at('bin/kingmaker'), ['help'], { encoding: 'utf8' }).stdout;
  assert.match(usage, /^kingmaker \(formerly sol-ghost, still an alias\)/m);
  assert.match(usage, /kingmaker siri\s+add the "Wake Kingmaker" Siri Shortcut/);
  assert.doesNotMatch(usage, /Sol Ghost|Wake Ghost/);
});

test('links: kingmaker://wake, with solghost://wake still answered; Siri says "Wake Kingmaker"', () => {
  assert.equal(WAKE_LINK, 'kingmaker://wake');
  assert.equal(LEGACY_WAKE_LINK, 'solghost://wake');
  assert.equal(SIRI_SHORTCUT_NAME, 'Wake Kingmaker');
  assert.match(wakeShortcutPlist(), /<string>kingmaker:\/\/wake<\/string>/);
  const plist = readFileSync(at('app/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleURLSchemes<\/key><array><string>kingmaker<\/string><string>solghost<\/string><\/array>/);
  assert.match(plist, /<key>CFBundleName<\/key><string>Kingmaker<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>Kingmaker<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/);
  const bundle = JSON.parse(readFileSync(at('app/bundle.json'), 'utf8'));
  assert.equal(bundle.appName, 'Kingmaker.app');
  assert.equal(bundle.executable, 'Kingmaker');
});

test('kept on purpose: the bundle id, the data folder, the Keychain item', () => {
  assert.match(readFileSync(at('app/Info.plist'), 'utf8'), /<key>CFBundleIdentifier<\/key><string>com\.ronininc\.solghost<\/string>/, 'macOS mic / screen / accessibility grants carry over');
  assert.equal(JSON.parse(readFileSync(at('app/bundle.json'), 'utf8')).bundleId, 'com.ronininc.solghost');
  assert.equal(resolvePaths({}, '/Users/o').state, '/Users/o/Library/Application Support/sol-ghost', 'the vault and knowledge index stay where they are');
  assert.equal(SEAL_SERVICE, 'Sol Ghost Owner Voice', 'an enrolled voiceprint still opens');
});

test('the menu bar app: the Ronin Inc logo as a template image, three looks, no windows by default', () => {
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  assert.match(swift, /case "awake": return \.glow/);
  assert.match(swift, /case "hearing": return \.ring/);
  assert.match(swift, /case "speaking": return \.pulse/);
  assert.match(swift, /default: return \.plain \/\/ asleep/);
  assert.match(swift, /image\.isTemplate = true/);
  assert.match(swift, /case \.plain, \.dim:\n\s+overlay\.isHidden = true \/\/ nothing drawn over the template, nothing animating/, 'asleep: no animation at all');
  assert.match(swift, /environment\["KINGMAKER_EDGE_GLOW"\] == "1" \? GhostGlow\(\) : nil/, 'the screen-edge windows only on request');
  assert.match(swift, /title: "Quit Kingmaker"/);
  for (const f of ['MenuBarLogo.png', 'MenuBarLogo@2x.png', 'MenuBarOutline.png', 'MenuBarOutline@2x.png', 'AppIcon.icns']) assert.ok(lstatSync(at(`app/Resources/${f}`)).size > 0, f);
});
