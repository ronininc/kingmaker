import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FUNCTIONS, defaults, normalize, readCalibration, writeCalibration } from '../lib/calibration.mjs';
import { ROUTER_MODEL } from '../lib/fast-route.mjs';

test('every function has its defaults, and the defaults are today\'s behaviour', () => {
  const d = defaults();
  assert.deepEqual(Object.keys(d), FUNCTIONS.map((f) => f.id));
  assert.equal(d.router.model, ROUTER_MODEL);
  assert.equal('model' in d.writer, false, 'the writer\'s model is the picker\'s, never set twice');
  assert.equal(d.followUp.minutes, 10);
  assert.equal(d.crmJobs.on, true);
  assert.equal(d.sources.max, 8);
});

test('anything saved is made valid: unknown keys dropped, numbers clamped and stepped, bad models refused', () => {
  const v = normalize({ writer: { temperature: 9, context: 5000, model: 'hf.co/a/b:Q4_K_M', evil: 1 }, suggest2: {}, router2: { model: 'hf.co/a/b:Q4_K_M' }, followUp: { minutes: -3 }, suggest: { on: 'off' }, idleGaps: { everyMinutes: 33 }, router: { model: 'x; rm -rf /' }, nope: {} });
  assert.equal(v.writer.temperature, 1.5);
  assert.equal(v.writer.context, 4096);
  assert.equal('model' in v.writer, false, 'a writer model in the file is ignored: the picker sets it');
  assert.equal('evil' in v.writer, false);
  assert.equal(v.followUp.minutes, 0);
  assert.equal(v.suggest.on, false);
  assert.equal(v.idleGaps.everyMinutes, 30);
  assert.equal(v.router.model, ROUTER_MODEL, 'not a model tag: the default stays');
  assert.equal('nope' in v, false);
});

test('saved to the data folder (0600) and read back; a broken file reads as the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'));
  assert.deepEqual(readCalibration(dir), defaults(), 'no file: defaults');
  writeCalibration(dir, { writer: { temperature: 0.3 } });
  assert.equal(readCalibration(dir).writer.temperature, 0.3);
  assert.equal(statSync(join(dir, 'calibration.json')).mode & 0o777, 0o600);
  writeFileSync(join(dir, 'calibration.json'), '{ not json');
  assert.deepEqual(readCalibration(dir), defaults());
});
