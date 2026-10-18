// A click on the menu bar logo wakes Kingmaker to listen (operator 2026-10-09). Source-level checks: the Swift app
// can't be built on the Linux test box, so this pins the wiring; the live click is tested on a Mac.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const swift = readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
const body = (name) => {
  const i = swift.indexOf(name);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0; let start = swift.indexOf('{', i);
  for (let j = start; j < swift.length; j++) { if (swift[j] === '{') depth++; else if (swift[j] === '}' && --depth === 0) return swift.slice(start, j + 1); }
  return '';
};

test('the menu is not attached to the status item, so a left click reaches the app', () => {
  assert.doesNotMatch(body('init(menu: NSMenu'), /item\.menu = menu/);
  assert.match(swift, /final class MenuBarMark: NSObject/, 'an NSObject, so it can be the button target');
  assert.match(swift, /button\.sendAction\(on: \[\.leftMouseUp, \.rightMouseUp\]\)/);
  assert.match(swift, /button\.action = #selector\(clicked\(_:\)\)/);
});

test('left click (or ⌥Space) opens the Kingmaker bar; right-, control- or option-click opens the menu (status line, Quit)', () => {
  const clicked = body('@objc private func clicked(');
  assert.match(clicked, /\.rightMouseUp/);
  assert.match(clicked, /modifierFlags\.contains\(\.control\)/);
  assert.match(clicked, /modifierFlags\.contains\(\.option\)/);
  assert.match(clicked, /item\.menu = menu[\s\S]*performClick[\s\S]*item\.menu = nil/, 'the menu pops for that click only');
  assert.match(clicked, /onClick\(\)/);
  assert.match(swift, /MenuBarMark\(menu: menu\) \{ \[weak self\] in self\?\.bar\.toggle\(\) \}/);
  assert.match(swift, /kingmakerHotKeyAction = \{ \[weak self\] in self\?\.bar\.toggle\(\) \}/);
  assert.match(swift, /b\.onWake = \{ \[weak self\] in self\?\.requestWake\(source: "bar mic"\) \}/, 'talking is the bar\'s mic button: the same wake path');
});

test('the click and the kingmaker:// link share one wake path, and it only ever sends "wake"', () => {
  const wake = body('private func requestWake(');
  const writes = [...wake.matchAll(/write\("([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(writes, ['wake\\n'], 'never y / yes / approve / confirm');
  assert.doesNotMatch(wake, /\by\\n|yes|approve|confirm|decide/i);
  assert.match(body('func application(_ application: NSApplication, open urls: [URL])'), /requestWake\(source: "link"\)/);
  assert.match(wake, /pendingWake = true/, 'a click before voice is up wakes it once voice is ready');
});

test('the dropdown accepts a typed command and frames it so text cannot become app control input', () => {
  assert.match(swift, /final class CommandEntryView: NSView, NSTextFieldDelegate/);
  assert.match(swift, /placeholderString = UI\.t\("Type a command…"\)/);   // in the owner's language (enum UI)
  assert.match(body('private func buildMenuBar()'), /CommandEntryView[\s\S]*commandItem\.view = entry/);
  const submit = body('private func submitTextCommand(');
  assert.match(submit, /Data\(command\.utf8\)\.base64EncodedString\(\)/);
  assert.ok(submit.includes(String.raw`"typed-command \(payload)\n"`));
  assert.doesNotMatch(submit, /write\(command/);
});
