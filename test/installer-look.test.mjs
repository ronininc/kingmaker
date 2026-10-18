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
});

test('its words follow the language setting, and the Ronin Launcher is listed', () => {
  for (const w of ['Wake word', 'Choose your pack', 'Give me a name']) assert.ok(swift.includes(`L.t("${w}")`), w);
  assert.match(swift, /Caps\(text: L\.t\(\{ if case \.failed/, 'the main button\'s label goes through L.t');
  for (const w of ['Download & Install', 'Download & Update', 'Try again']) assert.ok(swift.includes(`"${w}": ["es":`), `${w} is translated`);
  assert.match(swift, /Kingmaker\.app · Ronin Launcher/);
});
