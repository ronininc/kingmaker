#!/usr/bin/env node
// Adapt the verified, raw Kingmaker payload tar used by v4.4.1 into the app layout
// consumed by the installer. Production builds require an explicit signing identity;
// ad-hoc signing is available only to fixture tests and can never produce a release.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayload, payloadProblem } from '../lib/payload.mjs';
import { verifyManifestBytes } from '../lib/release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from '../lib/release-pubkey.mjs';
import { validateEngineRuntimeClosure } from './runtime-closure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function safeArchiveEntries(payload) {
  const entries = execFileSync('tar', ['-tf', payload], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const verbose = execFileSync('tar', ['-tvf', payload], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!entries.length) throw new Error('payload archive is empty');
  if (verbose.length !== entries.length) throw new Error('could not account for every payload archive entry');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..') || !(entry === 'sol-ghost/' || entry.startsWith('sol-ghost/'))) {
      throw new Error(`unsafe payload entry: ${entry}`);
    }
  }
  for (let i = 0; i < verbose.length; i += 1) {
    const type = verbose[i][0];
    if (type !== '-' && type !== 'd') throw new Error(`unsafe payload entry type ${type} for ${entries[i]}`);
  }
  return entries;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function trustedPayloadFromSignedManifest({ manifestBytes, signature, fixturePublicKeyPem = null }) {
  const fixtureKeyAllowed = fixturePublicKeyPem && process.env.KINGMAKER_FIXTURE_BUILD === '1';
  if (fixturePublicKeyPem && !fixtureKeyAllowed) throw new Error('alternate release public keys are fixture-only');
  const publicKeyPem = fixtureKeyAllowed ? fixturePublicKeyPem : RELEASE_PUBLIC_KEY_PEM;
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  if (!publicKeyPem || !verifyManifestBytes(bytes, String(signature ?? '').trim(), publicKeyPem)) throw new Error('release manifest signature is invalid');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw new Error('signed release manifest is not JSON'); }
  if (manifest.schema !== 'kingmaker.release/1') throw new Error('signed release manifest schema is not kingmaker.release/1');
  const unit = manifest.units?.macos;
  if (!unit || !/^[a-f0-9]{64}$/.test(String(unit.sha256 ?? ''))) throw new Error('signed release manifest has no macOS payload sha256');
  const version = unit.payloadVersion ?? manifest.version;
  if (!version) throw new Error('signed release manifest has no payload version');
  return Object.freeze({ sha256: unit.sha256, version: String(version), verified: true });
}
function allFiles(root) {
  const found = [];
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name), rel = prefix ? `${prefix}/${name}` : name, st = lstatSync(abs);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error(`unsafe extracted payload type: ${rel}`);
      if (st.isDirectory()) walk(abs, rel); else found.push(rel);
    }
  };
  walk(root); return found.sort();
}

export function stagePayloadApp({ payload, wrapper, engine, engineResources, out, releaseManifestBytes = null, releaseSignature = null, expectedSha256, expectedVersion, identity = null, fixtureAdhoc = false, resources = join(ROOT, 'app', 'Resources'), infoPlist = join(ROOT, 'app', 'Info.plist') }) {
  payload = resolve(payload); wrapper = resolve(wrapper); engine = resolve(engine); engineResources = resolve(engineResources); out = resolve(out);
  if (!existsSync(payload)) throw new Error(`no payload at ${payload}`);
  if (!existsSync(wrapper)) throw new Error(`no native wrapper at ${wrapper}`);
  if (!existsSync(engine)) throw new Error(`no engine runtime at ${engine}`);
  validateEngineRuntimeClosure(engineResources);
  if (basename(out) !== 'Kingmaker.app') throw new Error('output must be named Kingmaker.app');
  if (fixtureAdhoc && process.env.KINGMAKER_FIXTURE_BUILD !== '1') throw new Error('ad-hoc signing is fixture-only (set KINGMAKER_FIXTURE_BUILD=1 in an isolated test)');
  if (!fixtureAdhoc && !identity) throw new Error('production staging requires an explicit Kingmaker Release signing identity');
  if (!fixtureAdhoc) {
    if (!releaseManifestBytes || !releaseSignature) throw new Error('production staging requires signed release manifest bytes');
    const trusted = trustedPayloadFromSignedManifest({ manifestBytes: releaseManifestBytes, signature: releaseSignature });
    expectedSha256 = trusted.sha256; expectedVersion = trusted.version;
  }
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 ?? ''))) throw new Error('an externally trusted payload sha256 is required');
  if (!expectedVersion) throw new Error('an externally trusted payload version is required');
  const archiveSha = sha256(readFileSync(payload));
  if (archiveSha !== expectedSha256) throw new Error(`payload sha256 mismatch: got ${archiveSha}`);
  safeArchiveEntries(payload);

  const scratch = mkdtempSync(join(tmpdir(), 'km-stage-payload-'));
  try {
    execFileSync('tar', ['-xf', payload, '-C', scratch]);
    const runtime = join(scratch, 'sol-ghost');
    const proof = checkPayload(runtime, { deep: true, installed: true });
    if (!proof.ok || !proof.listed) throw new Error(payloadProblem(proof) || 'payload manifest is invalid');
    if (proof.version !== expectedVersion) throw new Error(`payload version ${proof.version} does not match trusted version ${expectedVersion}`);
    const manifest = JSON.parse(readFileSync(join(runtime, 'payload.json'), 'utf8'));
    const expectedFiles = [...manifest.files.map((f) => f.path), 'payload.json'].sort();
    const actualFiles = allFiles(runtime);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error('payload contains files not listed by its manifest, or omits listed files');
    for (const file of actualFiles) {
      if (file === 'payload.json') continue;
      const abs = join(runtime, file), bytes = readFileSync(abs);
      if ((file === 'bin/kingmaker' || bytes.subarray(0, 2).toString() === '#!') && !(statSync(abs).mode & 0o111)) {
        throw new Error(`payload executable is not executable: ${file}`);
      }
    }

    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(out, 'Contents', 'Resources'), { recursive: true });
    cpSync(wrapper, join(out, 'Contents', 'MacOS', 'Kingmaker'));
    execFileSync('chmod', ['755', join(out, 'Contents', 'MacOS', 'Kingmaker')]);
    cpSync(engine, join(out, 'Contents', 'MacOS', 'KingmakerEngine'));
    execFileSync('chmod', ['755', join(out, 'Contents', 'MacOS', 'KingmakerEngine')]);
    if (existsSync(resources)) cpSync(resources, join(out, 'Contents', 'Resources'), { recursive: true });
    cpSync(engineResources, join(out, 'Contents', 'Resources'), { recursive: true });
    cpSync(runtime, join(out, 'Contents', 'Resources', 'sol-ghost'), { recursive: true, preserveTimestamps: true });
    const plist = readFileSync(infoPlist, 'utf8').replaceAll('@VERSION@', proof.version).replaceAll('@SOLOMON_BUILD@', 'recovered payload adapter');
    writeFileSync(join(out, 'Contents', 'Info.plist'), plist);
    writeFileSync(join(out, 'Contents', 'PkgInfo'), 'APPL????');

    const stagedProof = checkPayload(join(out, 'Contents', 'Resources', 'sol-ghost'), { deep: true, installed: true });
    if (!stagedProof.ok) throw new Error(`staged payload changed: ${payloadProblem(stagedProof)}`);
    const handshake = execFileSync(join(out, 'Contents', 'MacOS', 'KingmakerEngine'), [join(out, 'Contents', 'Resources', 'sol-ghost', 'lib', 'kingmaker.mjs'), 'version'], { encoding: 'utf8', env: { ...process.env, KINGMAKER_ADDONS: 'off' } }).trim();
    if (handshake !== expectedVersion) throw new Error(`bundled engine handshake reported ${handshake || 'nothing'}, expected ${expectedVersion}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', fixtureAdhoc ? '-' : identity, out], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', out], { stdio: 'pipe' });
    return { out, version: proof.version, files: proof.checked, fixture: fixtureAdhoc };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
  const fixtureAdhoc = process.argv.includes('--fixture-adhoc');
  let releaseManifestBytes = null, releaseSignature = null;
  if (!fixtureAdhoc) {
    const manifest = value('--release-manifest'), sig = value('--release-signature');
    if (!manifest || !sig) throw new Error('production staging requires --release-manifest and --release-signature');
    releaseManifestBytes = readFileSync(manifest); releaseSignature = readFileSync(sig, 'utf8');
  }
  const result = stagePayloadApp({ payload: value('--payload'), wrapper: value('--wrapper'), engine: value('--engine'), engineResources: value('--engine-resources'), out: value('--out'), releaseManifestBytes, releaseSignature, expectedSha256: fixtureAdhoc ? value('--payload-sha256') : null, expectedVersion: fixtureAdhoc ? value('--payload-version') : null, identity: value('--identity'), fixtureAdhoc });
  console.log(`staged ${result.out}: Kingmaker ${result.version}, ${result.files} verified payload files${result.fixture ? ' (FIXTURE, ad-hoc signed)' : ''}`);
}
