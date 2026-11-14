import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeAppProfilePath, applyActiveAppProfile, readActiveAppProfile, setActiveRoninAppProfile } from '../app-profile.mjs';

test('installed app profile is private, bounded to Application Support, and round-trips', () => {
  const home = mkdtempSync(join(tmpdir(), 'kingmaker-profile-'));
  const state = join(home, 'Library', 'Application Support', 'kingmaker-ronin');
  const runtimeHome = join(state, 'runtime');
  const value = setActiveRoninAppProfile({ state, runtimeHome }, { home, port: 3001 });
  assert.deepEqual(value, { schema: 1, profile: 'ronininc', state, runtimeHome, port: 3001 });
  assert.equal(statSync(activeAppProfilePath(home)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(activeAppProfilePath(home), 'utf8')).runtime_home, runtimeHome);
  assert.deepEqual(readActiveAppProfile(home), value);
});

test('installed app profile refuses paths outside the owner Application Support directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'kingmaker-profile-'));
  assert.throws(() => setActiveRoninAppProfile({ state: '/tmp/ronin', runtimeHome: '/tmp/ronin/runtime' }, { home, port: 3001 }), /Application Support/);
});

test('the macOS app loads the selected profile into its child environment', () => {
  const swift = readFileSync(new URL('../../../app/Kingmaker.swift', import.meta.url), 'utf8');
  assert.match(swift, /Kingmaker\/active-profile\.json/);
  assert.match(swift, /env\["SOL_GHOST_HOME"\] = profile\.state/);
  assert.match(swift, /env\["SOL_GHOST_RUNTIME_HOME"\] = profile\.runtime_home/);
  assert.match(swift, /env\["SOL_GHOST_PORT"\] = String\(profile\.port\)/);
});

test('a terminal command runs the same profile the menu bar app launches, unless one is named', () => {
  const home = mkdtempSync(join(tmpdir(), 'km-home-'));
  const env = {};
  assert.equal(applyActiveAppProfile(env, home), null, 'no pointer: the default profile stands');
  assert.deepEqual(env, {});
  const state = join(home, 'Library', 'Application Support', 'kingmaker-ronin');
  setActiveRoninAppProfile({ state, runtimeHome: join(state, 'runtime') }, { home, port: 3001 });
  const applied = applyActiveAppProfile(env, home);
  assert.equal(applied.profile, 'ronininc');
  assert.deepEqual(env, { SOL_GHOST_HOME: state, SOL_GHOST_RUNTIME_HOME: join(state, 'runtime'), SOL_GHOST_PORT: '3001' });
  const named = { SOL_GHOST_HOME: '/elsewhere' };
  assert.equal(applyActiveAppProfile(named, home), null);
  assert.deepEqual(named, { SOL_GHOST_HOME: '/elsewhere' });
});
