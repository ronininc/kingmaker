import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPayload } from '../scripts/build-payload.mjs';
import { stagePayloadApp, trustedPayloadFromSignedManifest } from '../scripts/stage-payload-app.mjs';
import { generateReleaseKeypair, signManifestBytes } from '../lib/release-signing.mjs';
import { COMPONENT_MARKERS, ENGINE_RUNTIME_COMPONENTS, validateEngineRuntimeClosure } from '../scripts/runtime-closure.mjs';

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fixtureWrapper = (dir) => { const wrapper = join(dir, 'wrapper'); writeFileSync(wrapper, '#!/bin/sh\nexit 0\n'); chmodSync(wrapper, 0o755); return wrapper; };
const fixtureEngine = (dir) => { const engine = join(dir, 'fixture-engine'); writeFileSync(engine, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`); chmodSync(engine, 0o755); return engine; };
const fixtureEngineResources = (dir) => {
  const root = join(dir, 'fixture-engine-resources');
  for (const component of ENGINE_RUNTIME_COMPONENTS) {
    mkdirSync(join(root, component), { recursive: true });
    const markers = COMPONENT_MARKERS[component] ?? ['fixture-runtime-file'];
    for (const marker of markers) {
      mkdirSync(join(root, component, marker, '..'), { recursive: true });
      writeFileSync(join(root, component, marker), component === 'voice-runtime' && marker.endsWith('whisper-cli') ? '#!/bin/sh\nexit 0\n' : `fixture ${component}/${marker}\n`);
      if (marker.endsWith('whisper-cli')) chmodSync(join(root, component, marker), 0o755);
    }
  }
  return root;
};
const repack = (tar, dir) => execFileSync('tar', ['-cf', tar, '-C', dir, 'sol-ghost'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

test('verified raw payload stages into the installer app layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-test-'));
  try {
    const built = buildPayload({ out: join(dir, 'payload') });
    const wrapper = fixtureWrapper(dir);
    const out = join(dir, 'Kingmaker.app');
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    const result = stagePayloadApp({ payload: built.tar, wrapper, engine: fixtureEngine(dir), engineResources: fixtureEngineResources(dir), out, expectedSha256: built.sha256, expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') });
    assert.equal(result.version, '4.4.2');
    assert.ok(result.files > 300);
    assert.match(readFileSync(join(out, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleShortVersionString<\/key><string>4\.4\.2<\/string>/);
    execFileSync('codesign', ['--verify', '--deep', '--strict', out]);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('unlisted payload files are rejected before signing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-extra-'));
  try {
    const built = buildPayload({ out: join(dir, 'built') }), tree = join(dir, 'tree'), tar = join(dir, 'extra.tar');
    mkdirSync(tree); execFileSync('tar', ['-xf', built.tar, '-C', tree]);
    writeFileSync(join(tree, 'sol-ghost', 'harmless-UNLISTED.txt'), 'not trusted'); repack(tar, tree);
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: tar, wrapper: fixtureWrapper(dir), engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: hash(tar), expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') }), /not listed/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('payload executables without execute mode are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-mode-'));
  try {
    const built = buildPayload({ out: join(dir, 'built') }), tree = join(dir, 'tree'), tar = join(dir, 'mode.tar');
    mkdirSync(tree); execFileSync('tar', ['-xf', built.tar, '-C', tree]);
    chmodSync(join(tree, 'sol-ghost', 'bin', 'kingmaker'), 0o644); repack(tar, tree);
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: tar, wrapper: fixtureWrapper(dir), engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: hash(tar), expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') }), /not executable/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('link archive entries are rejected before extraction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-link-'));
  try {
    const tree = join(dir, 'tree'), runtime = join(tree, 'sol-ghost'), tar = join(dir, 'link.tar');
    mkdirSync(runtime, { recursive: true }); symlinkSync('/tmp', join(runtime, 'escape')); repack(tar, tree);
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: tar, wrapper: fixtureWrapper(dir), engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: hash(tar), expectedVersion: 'fixture', fixtureAdhoc: true, resources: join(dir, 'none') }), /unsafe payload entry type/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('external payload digest is required and enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-pin-'));
  try {
    const built = buildPayload({ out: join(dir, 'built') }); process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: built.tar, wrapper: fixtureWrapper(dir), engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: '0'.repeat(64), expectedVersion: built.version, fixtureAdhoc: true }), /sha256 mismatch/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('production payload pin is derived from a signature-verified release manifest', () => {
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const manifestBytes = Buffer.from(JSON.stringify({ schema: 'kingmaker.release/1', version: '4.4.2', units: { macos: { sha256: 'a'.repeat(64), payloadVersion: '4.4.2' } } }));
  const signature = signManifestBytes(manifestBytes, privateKeyPem);
  process.env.KINGMAKER_FIXTURE_BUILD = '1';
  assert.deepEqual(trustedPayloadFromSignedManifest({ manifestBytes, signature, fixturePublicKeyPem: publicKeyPem }), { sha256: 'a'.repeat(64), version: '4.4.2', verified: true });
  assert.throws(() => trustedPayloadFromSignedManifest({ manifestBytes: Buffer.from(`${manifestBytes} `), signature, fixturePublicKeyPem: publicKeyPem }), /signature is invalid/);
  delete process.env.KINGMAKER_FIXTURE_BUILD;
});

test('alternate manifest public keys are rejected outside the double fixture gate', () => {
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const manifestBytes = Buffer.from(JSON.stringify({ schema: 'kingmaker.release/1', version: 'fixture', units: { macos: { sha256: 'b'.repeat(64) } } }));
  const signature = signManifestBytes(manifestBytes, privateKeyPem);
  delete process.env.KINGMAKER_FIXTURE_BUILD;
  assert.throws(() => trustedPayloadFromSignedManifest({ manifestBytes, signature, fixturePublicKeyPem: publicKeyPem }), /fixture-only/);
});

test('real compiled native wrapper and bundled engine complete a fixture handshake', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-real-wrapper-'));
  try {
    const wrapper = join(dir, 'Kingmaker'), cache = join(dir, 'module-cache'); mkdirSync(cache);
    execFileSync('swiftc', ['-module-cache-path', cache, '-O', '-o', wrapper, new URL('../app/Kingmaker.swift', import.meta.url).pathname, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'QuartzCore', '-framework', 'ServiceManagement']);
    const built = buildPayload({ out: join(dir, 'built') }), out = join(dir, 'Kingmaker.app');
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    const result = stagePayloadApp({ payload: built.tar, wrapper, engine: fixtureEngine(dir), engineResources: fixtureEngineResources(dir), out, expectedSha256: built.sha256, expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') });
    assert.equal(result.version, built.version);
    assert.equal(execFileSync(join(out, 'Contents', 'MacOS', 'KingmakerEngine'), [join(out, 'Contents', 'Resources', 'sol-ghost', 'lib', 'kingmaker.mjs'), 'version'], { encoding: 'utf8' }).trim(), built.version);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('production staging rejects unverified direct digest and version pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-trust-'));
  try {
    const payload = join(dir, 'payload.tar'), wrapper = join(dir, 'wrapper');
    writeFileSync(payload, 'bytes'); writeFileSync(wrapper, 'wrapper');
    assert.throws(() => stagePayloadApp({ payload, wrapper, engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app'), identity: 'fixture identity', trustedPayload: { verified: true, sha256: hash(payload), version: 'fixture' }, expectedSha256: hash(payload), expectedVersion: 'fixture' }), /signed release manifest bytes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production staging fails closed without release identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-gate-'));
  try {
    const payload = join(dir, 'payload.tar'), wrapper = join(dir, 'wrapper');
    writeFileSync(payload, 'not read before the signing gate'); writeFileSync(wrapper, 'wrapper');
    assert.throws(() => stagePayloadApp({ payload, wrapper, engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app') }), /production staging requires/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixture ad-hoc mode cannot be enabled accidentally', () => {
  delete process.env.KINGMAKER_FIXTURE_BUILD;
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-gate-'));
  try {
    const payload = join(dir, 'payload.tar'), wrapper = join(dir, 'wrapper');
    writeFileSync(payload, 'not read before the fixture gate'); writeFileSync(wrapper, 'wrapper');
    assert.throws(() => stagePayloadApp({ payload, wrapper, engine: process.execPath, engineResources: fixtureEngineResources(dir), out: join(dir, 'Kingmaker.app'), fixtureAdhoc: true }), /fixture-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Node host without the packaged backend resource tree is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-backend-'));
  try {
    const payload = join(dir, 'payload.tar'), wrapper = fixtureWrapper(dir), incomplete = join(dir, 'resources');
    writeFileSync(payload, 'bytes'); mkdirSync(incomplete);
    assert.throws(() => stagePayloadApp({ payload, wrapper, engine: process.execPath, engineResources: incomplete, out: join(dir, 'Kingmaker.app'), fixtureAdhoc: true }), /engine resource tree is incomplete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime closure rejects every omitted mandatory engine component and empty placeholders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-runtime-closure-'));
  try {
    for (const missing of ENGINE_RUNTIME_COMPONENTS) {
      const root = fixtureEngineResources(join(dir, missing));
      rmSync(join(root, missing), { recursive: true, force: true });
      assert.throws(() => validateEngineRuntimeClosure(root), new RegExp(`missing ${missing.replaceAll('.', '\\.')}$`));
    }
    const root = fixtureEngineResources(join(dir, 'empty'));
    rmSync(join(root, 'guardrails-runtime'), { recursive: true, force: true });
    mkdirSync(join(root, 'guardrails-runtime'));
    assert.throws(() => validateEngineRuntimeClosure(root), /component is empty: guardrails-runtime/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime closure requires actual voice, frontend and backend marker files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-runtime-markers-'));
  try {
    for (const [component, markers] of Object.entries(COMPONENT_MARKERS)) {
      for (const marker of markers) {
        const root = fixtureEngineResources(join(dir, `${component}-${marker.replaceAll('/', '-')}`));
        rmSync(join(root, component, marker));
        assert.throws(() => validateEngineRuntimeClosure(root), new RegExp(`missing ${component.replaceAll('.', '\\.')}/${marker.replaceAll('.', '\\.')}`));
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime closure permits only symlinks contained inside their component', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-runtime-links-'));
  try {
    const root = fixtureEngineResources(join(dir, 'root'));
    writeFileSync(join(root, 'voice-runtime', 'inside'), 'inside\n');
    symlinkSync('inside', join(root, 'voice-runtime', 'safe-link'));
    assert.doesNotThrow(() => validateEngineRuntimeClosure(root));
    symlinkSync('/etc/passwd', join(root, 'voice-runtime', 'escape-link'));
    assert.throws(() => validateEngineRuntimeClosure(root), /runtime symlink escapes component/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
