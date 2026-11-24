// Kingmaker Installer has Kingmaker's look and customizability (owner, 2026-10-15): the same settings as the bar, a
// window that moves, resizes and remembers its place, any language, and the Ronin Launcher listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const swift = readFileSync(new URL('../installer/KingmakerInstaller.swift', import.meta.url), 'utf8');

test('the same settings as Kingmaker, read and written in its own defaults and language file', () => {
  assert.match(swift, /UserDefaults\(suiteName: "com\.ronininc\.solghost"\)/);
  for (const k of ['km.look', 'km.replyColor', 'km.textSize', 'km.position']) assert.ok(swift.includes(`"${k}"`), k);
  assert.match(swift, /appendingPathComponent\("language"\)/);
});

test('the window moves, resizes, goes full screen and remembers where it was', () => {
  assert.match(swift, /isMovableByWindowBackground = true/);
  assert.match(swift, /styleMask\.insert\(\.resizable\)/);
  assert.match(swift, /fullScreenPrimary/);
  assert.match(swift, /setFrameAutosaveName\("KingmakerInstaller"\)/);
  assert.match(swift, /windowResizability\(\.contentMinSize\)/);
  assert.doesNotMatch(swift, /\.frame\(width: installer\.packs\.isEmpty \? 560 : 660, height:/, 'no fixed size');
  assert.match(swift, /\.frame\(minWidth: 520, idealWidth: 560, minHeight: 560, idealHeight: 720\)/, 'one packless size');
  assert.doesNotMatch(swift, /PackPicker|installer\.packs|selectedPack/, 'no pack picker remains');
});

test('its words follow the language setting, including the optional Launcher', () => {
  for (const w of ['Wake word', 'Give me a name', 'Install Kingmaker on its own.', 'Also install Ronin Launcher (optional)']) assert.ok(swift.includes(`L.t("${w}")`), w);
  assert.ok(!swift.includes('Choose your pack'), 'the pack choice is gone from the window and its words');
  assert.match(swift, /Caps\(text: L\.t\(\{ if case \.failed/, 'the main button\'s label goes through L.t');
  for (const w of ['Download & Install', 'Download & Update', 'Try again']) assert.ok(swift.includes(`"${w}": ["es":`), `${w} is translated`);
  assert.doesNotMatch(swift, /Kingmaker\.app · Ronin Launcher/);
});

test('the stock installer opts out of Launcher unless the customer checks its separate optional box', () => {
  assert.match(swift, /@Published var installLauncher = false/);
  assert.match(swift, /Toggle\(isOn: \$installer\.installLauncher\)/);
  assert.match(swift, /let launcherChoice = installLauncher \? \[\] : \["--without-launcher"\]/);
  assert.match(swift, /p\.arguments = \[engine\.path, "--wake-word", word\] \+ terms \+ launcherChoice \+ Installer\.devArgs/);
});
