import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['entitlement-client.mjs', 'activation-flow.mjs', 'paid-activation.mjs', 'ui/scripture-armor-crest-ronin.png', 'mac/ScriptureArmorApp.swift', 'mac/build-native-app.sh'];

test('standalone bundle refuses fake-only prerequisites before writing output', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-standalone-contract-'));
  const ghidra = path.join(temp, 'ghidra');
  const jdk = path.join(temp, 'jdk');
  const ghidraExe = path.join(ghidra, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
  const javaExe = path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  fs.mkdirSync(path.dirname(ghidraExe), { recursive: true });
  fs.mkdirSync(path.dirname(javaExe), { recursive: true });
  fs.writeFileSync(ghidraExe, 'fixture', { mode: 0o700 });
  fs.writeFileSync(javaExe, 'fixture', { mode: 0o700 });
  const out = path.join(temp, 'bundle');
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'build-standalone.mjs'), '--out', out, '--ghidra-home', ghidra, '--jdk-home', jdk], { stdio: 'pipe' }), /Command failed/);
  assert.equal(fs.existsSync(out), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('real standalone bundle closes dashboard imports, isolates product policy and records runnable prerequisites', { skip: !(process.env.SCRIPTURE_GHIDRA_HOME && process.env.JAVA_HOME) && 'Requires verified real Ghidra/JDK' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-real-standalone-'));
  const out = path.join(temp, 'bundle');
  try {
  execFileSync(process.execPath, [path.join(ROOT, 'build-standalone.mjs'), '--out', out, '--ghidra-home', process.env.SCRIPTURE_GHIDRA_HOME, '--jdk-home', process.env.JAVA_HOME], { stdio: 'pipe', timeout: 180000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'BUNDLE.json'), 'utf8'));
  const records = new Map(manifest.files.map((record) => [record.path, record]));
  for (const rel of REQUIRED) {
    assert.ok(records.get(rel)?.size > 0, `${rel} is missing from the hashed standalone closure`);
    assert.match(records.get(rel).sha256, /^[a-f0-9]{64}$/);
  }
  const dashboard = fs.readFileSync(path.join(out, 'dashboard.mjs'), 'utf8');
  const imports = [...dashboard.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map((match) => match[1]);
  for (const rel of imports) assert.ok(records.has(rel), `dashboard import ${rel} is absent from BUNDLE.json`);
  assert.equal(manifest.product, 'standalone');
  assert.equal(manifest.prerequisites.requiresExternalNode, true);
  assert.ok(manifest.prerequisites.checks.includes('native-decompiler-start'));
  const home = path.join(temp, 'synthetic-home'); fs.mkdirSync(home);
  const query = JSON.parse(execFileSync(process.execPath, [path.join(out, 'product-paths.mjs'), '--home', home], { encoding: 'utf8' }));
  assert.equal(query.identityDir, path.join(home, '.scripture-armor'));
  assert.equal(query.serviceLabel, 'org.ronininc.scripture-vaultd');
  const other = path.join(home, '.kingmaker', 'scripture-armor'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'identity.json'), 'synthetic opposing-store sentinel, not key material');
  for (const script of ['armor.mjs', 'vaultd.mjs', 'launch.mjs']) {
    const args = script === 'armor.mjs' ? ['identity'] : script === 'vaultd.mjs' ? ['status'] : [];
    assert.throws(() => execFileSync(process.execPath, [path.join(out, script), ...args, '--identity-dir', other], { env: { ...process.env, HOME: home }, stdio: 'pipe', timeout: 10000 }), /Command failed/);
  }
  assert.equal(fs.readFileSync(path.join(other, 'identity.json'), 'utf8'), 'synthetic opposing-store sentinel, not key material');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
