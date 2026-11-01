#!/usr/bin/env node
// Adapt the verified, raw Kingmaker payload tar used by v4.4.1 into the app layout
// consumed by the installer. Production builds require an explicit signing identity;
// ad-hoc signing is available only to fixture tests and can never produce a release.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayload, payloadProblem } from '../lib/payload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function safeArchiveEntries(payload) {
  const entries = execFileSync('tar', ['-tf', payload], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!entries.length) throw new Error('payload archive is empty');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..') || !(entry === 'sol-ghost/' || entry.startsWith('sol-ghost/'))) {
      throw new Error(`unsafe payload entry: ${entry}`);
    }
  }
  return entries;
}

export function stagePayloadApp({ payload, wrapper, out, identity = null, fixtureAdhoc = false, resources = join(ROOT, 'app', 'Resources'), infoPlist = join(ROOT, 'app', 'Info.plist') }) {
  payload = resolve(payload); wrapper = resolve(wrapper); out = resolve(out);
  if (!existsSync(payload)) throw new Error(`no payload at ${payload}`);
  if (!existsSync(wrapper)) throw new Error(`no native wrapper at ${wrapper}`);
  if (basename(out) !== 'Kingmaker.app') throw new Error('output must be named Kingmaker.app');
  if (fixtureAdhoc && process.env.KINGMAKER_FIXTURE_BUILD !== '1') throw new Error('ad-hoc signing is fixture-only (set KINGMAKER_FIXTURE_BUILD=1 in an isolated test)');
  if (!fixtureAdhoc && !identity) throw new Error('production staging requires an explicit Kingmaker Release signing identity');
  safeArchiveEntries(payload);

  const scratch = mkdtempSync(join(tmpdir(), 'km-stage-payload-'));
  try {
    execFileSync('tar', ['-xf', payload, '-C', scratch]);
    const runtime = join(scratch, 'sol-ghost');
    const proof = checkPayload(runtime, { deep: true, installed: true });
    if (!proof.ok || !proof.listed) throw new Error(payloadProblem(proof) || 'payload manifest is invalid');

    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(out, 'Contents', 'Resources'), { recursive: true });
    cpSync(wrapper, join(out, 'Contents', 'MacOS', 'Kingmaker'));
    execFileSync('chmod', ['755', join(out, 'Contents', 'MacOS', 'Kingmaker')]);
    if (existsSync(resources)) cpSync(resources, join(out, 'Contents', 'Resources'), { recursive: true });
    cpSync(runtime, join(out, 'Contents', 'Resources', 'sol-ghost'), { recursive: true, preserveTimestamps: true });
    const plist = readFileSync(infoPlist, 'utf8').replaceAll('@VERSION@', proof.version).replaceAll('@SOLOMON_BUILD@', 'recovered payload adapter');
    writeFileSync(join(out, 'Contents', 'Info.plist'), plist);
    writeFileSync(join(out, 'Contents', 'PkgInfo'), 'APPL????');

    const stagedProof = checkPayload(join(out, 'Contents', 'Resources', 'sol-ghost'), { deep: true, installed: true });
    if (!stagedProof.ok) throw new Error(`staged payload changed: ${payloadProblem(stagedProof)}`);
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
  const result = stagePayloadApp({ payload: value('--payload'), wrapper: value('--wrapper'), out: value('--out'), identity: value('--identity'), fixtureAdhoc });
  console.log(`staged ${result.out}: Kingmaker ${result.version}, ${result.files} verified payload files${result.fixture ? ' (FIXTURE, ad-hoc signed)' : ''}`);
}
