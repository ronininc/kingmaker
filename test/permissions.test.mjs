// Every "Turn on" in Access raises the real macOS prompt for exactly that permission, or (settings-only / already
// denied) opens its exact System Settings page and says what to switch on (the owner, 2026-10-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const swift = readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
// openPermission only, up to the next member (`permWatch`): openDuressArm, which sits before watchPermissions, has its
// own NSApp.activate and must not fall inside this slice's "never steals focus" check.
const body = swift.slice(swift.indexOf('@objc fileprivate func openPermission'), swift.indexOf('private var permWatch'));

test('each permission raises its own prompt', () => {
  assert.match(body, /AVCaptureDevice\.requestAccess\(for: \.audio\)/);
  assert.match(body, /CNContactStore\(\)\.requestAccess\(for: \.contacts\)/);
  assert.match(body, /AXIsProcessTrustedWithOptions\(opts\)/);
  assert.match(body, /kAXTrustedCheckOptionPrompt/);
  assert.match(body, /CGRequestScreenCaptureAccess\(\)/);
  assert.match(body, /automationAllowed\(id, ask: true\)/);
});

test('settings-only or denied: the exact pane, and a line saying what to switch on', () => {
  assert.match(body, /x-apple\.systempreferences:com\.apple\.preference\.security\?\\\(pane\)/);
  assert.match(body, /turn on Kingmaker/);
  for (const what of ['Full Disk Access', 'App Management', 'Screen & System Audio Recording']) assert.ok(body.includes(what), what);
});

test('Automation starts a closed app hidden, never in front, and the list refreshes itself', () => {
  assert.match(body, /cfg\.activates = false; cfg\.hides = true/);
  assert.doesNotMatch(body, /activate\(ignoringOtherApps/);
  assert.match(swift, /private func watchPermissions\(\)[\s\S]{0,400}onCommand\("screen connectors"\)/);
});
