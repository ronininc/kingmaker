import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('macOS client is a real WKWebView pane with closed navigation and local service lifecycle', () => {
  const source = fs.readFileSync(path.join(ROOT, 'mac', 'ScriptureArmorApp.swift'), 'utf8');
  assert.match(source, /WKWebView/);
  assert.match(source, /websiteDataStore = \.nonPersistent\(\)/);
  assert.match(source, /url\.host == "127\.0\.0\.1"/);
  assert.match(source, /url\.host == "www\.ronininc\.org" && url\.path == "\/armor\/checkout"/);
  assert.doesNotMatch(source, /evaluateJavaScript|developerExtrasEnabled"\s*,\s*forKey:\s*true/);
  assert.match(source, /dashboard\.terminate\(\)/);
  for (const command of ['cut:', 'copy:', 'paste:', 'selectAll:']) assert.match(source, new RegExp(`Selector\\(\\(\\"${command}\\"\\)\\)`));
  assert.match(source, /NSApp\.mainMenu = main/);
});

test('macOS native pane compiles against AppKit and WebKit', { skip: process.platform !== 'darwin' }, () => {
  const out = path.join(process.env.TMPDIR || '/tmp', `scripture-armor-pane-${process.pid}`);
  try {
    execFileSync('swiftc', ['-j','1',
      ...['ScriptureArmorApp.swift','LocalKeyAuthorization.swift','ProtectedIdentityVault.swift','ProtectedGenerationStore.swift','NativeKeyRotation.swift'].map(file=>path.join(ROOT,'mac',file)),
      '-framework','AppKit','-framework','WebKit','-framework','LocalAuthentication','-framework','Security','-o',out,
    ], { stdio: 'pipe', timeout: 120000 });
    assert.ok(fs.statSync(out).size > 0);
    assert.equal(fs.readFileSync(out).includes(Buffer.from('Disposable UI fixture configuration is missing or invalid.')),false,'test-only startup is absent from production compilation');
  } finally { fs.rmSync(out, { force: true }); }
});

test('macOS release builder packages the approved crest as the application icon', () => {
  const source = fs.readFileSync(path.join(ROOT, 'mac', 'build-native-app.sh'), 'utf8');
  assert.match(source, /ui\/scripture-armor-app-icon-dark\.png/);
  assert.match(source, /iconutil -c icns/);
  assert.match(source, /<key>CFBundleIconFile<\/key><string>ScriptureArmor<\/string>/);
});
