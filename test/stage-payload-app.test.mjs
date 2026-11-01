import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPayload } from '../scripts/build-payload.mjs';
import { stagePayloadApp } from '../scripts/stage-payload-app.mjs';

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fixtureWrapper = (dir) => { const wrapper = join(dir, 'wrapper'); writeFileSync(wrapper, '#!/bin/sh\nexit 0\n'); chmodSync(wrapper, 0o755); return wrapper; };
const repack = (tar, dir) => execFileSync('tar', ['-cf', tar, '-C', dir, 'sol-ghost'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

test('verified raw payload stages into the installer app layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-test-'));
  try {
    const built = buildPayload({ out: join(dir, 'payload') });
    const wrapper = fixtureWrapper(dir);
    const out = join(dir, 'Kingmaker.app');
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    const result = stagePayloadApp({ payload: built.tar, wrapper, out, expectedSha256: built.sha256, expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') });
    assert.equal(result.version, '4.4.2-recovered.0');
    assert.ok(result.files > 300);
    assert.match(readFileSync(join(out, 'Contents', 'Info.plist'), 'utf8'), /4\.4\.2-recovered\.0/);
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
    assert.throws(() => stagePayloadApp({ payload: tar, wrapper: fixtureWrapper(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: hash(tar), expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') }), /not listed/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('payload executables without execute mode are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-mode-'));
  try {
    const built = buildPayload({ out: join(dir, 'built') }), tree = join(dir, 'tree'), tar = join(dir, 'mode.tar');
    mkdirSync(tree); execFileSync('tar', ['-xf', built.tar, '-C', tree]);
    chmodSync(join(tree, 'sol-ghost', 'bin', 'kingmaker'), 0o644); repack(tar, tree);
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: tar, wrapper: fixtureWrapper(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: hash(tar), expectedVersion: built.version, fixtureAdhoc: true, resources: join(dir, 'none') }), /not executable/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('link archive entries are rejected before extraction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-link-'));
  try {
    const tree = join(dir, 'tree'), runtime = join(tree, 'sol-ghost'), tar = join(dir, 'link.tar');
    mkdirSync(runtime, { recursive: true }); symlinkSync('/tmp', join(runtime, 'escape')); repack(tar, tree);
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: tar, wrapper: fixtureWrapper(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: hash(tar), expectedVersion: 'fixture', fixtureAdhoc: true, resources: join(dir, 'none') }), /unsafe payload entry type/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('external payload digest is required and enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-pin-'));
  try {
    const built = buildPayload({ out: join(dir, 'built') }); process.env.KINGMAKER_FIXTURE_BUILD = '1';
    assert.throws(() => stagePayloadApp({ payload: built.tar, wrapper: fixtureWrapper(dir), out: join(dir, 'Kingmaker.app'), expectedSha256: '0'.repeat(64), expectedVersion: built.version, fixtureAdhoc: true }), /sha256 mismatch/);
  } finally { delete process.env.KINGMAKER_FIXTURE_BUILD; rmSync(dir, { recursive: true, force: true }); }
});

test('production staging fails closed without release identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-gate-'));
  try {
    const payload = join(dir, 'payload.tar'), wrapper = join(dir, 'wrapper');
    writeFileSync(payload, 'not read before the signing gate'); writeFileSync(wrapper, 'wrapper');
    assert.throws(() => stagePayloadApp({ payload, wrapper, out: join(dir, 'Kingmaker.app') }), /production staging requires/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixture ad-hoc mode cannot be enabled accidentally', () => {
  delete process.env.KINGMAKER_FIXTURE_BUILD;
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-gate-'));
  try {
    const payload = join(dir, 'payload.tar'), wrapper = join(dir, 'wrapper');
    writeFileSync(payload, 'not read before the fixture gate'); writeFileSync(wrapper, 'wrapper');
    assert.throws(() => stagePayloadApp({ payload, wrapper, out: join(dir, 'Kingmaker.app'), fixtureAdhoc: true }), /fixture-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
