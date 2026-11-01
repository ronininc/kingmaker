import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPayload } from '../scripts/build-payload.mjs';
import { stagePayloadApp } from '../scripts/stage-payload-app.mjs';

test('verified raw payload stages into the installer app layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-stage-test-'));
  try {
    const built = buildPayload({ out: join(dir, 'payload') });
    const wrapper = join(dir, 'wrapper');
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n'); chmodSync(wrapper, 0o755);
    const out = join(dir, 'Kingmaker.app');
    process.env.KINGMAKER_FIXTURE_BUILD = '1';
    const result = stagePayloadApp({ payload: built.tar, wrapper, out, fixtureAdhoc: true, resources: join(dir, 'none') });
    assert.equal(result.version, '4.4.2-recovered.0');
    assert.ok(result.files > 300);
    assert.match(readFileSync(join(out, 'Contents', 'Info.plist'), 'utf8'), /4\.4\.2-recovered\.0/);
    execFileSync('codesign', ['--verify', '--deep', '--strict', out]);
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
