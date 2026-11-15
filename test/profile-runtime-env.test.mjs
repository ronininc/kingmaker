import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_ROLES, profileRuntimeEnv } from '../lib/profile.mjs';
import { GRANITE_8GB, FLOOR_ROLES } from '../lib/mac-profiles.mjs';

test('runtime pins the installed starter router without imposing a class-wide reasoning model', () => {
  for (const totalGb of [8, 16]) {
    const env = profileRuntimeEnv([GRANITE_8GB, FLOOR_ROLES.router], totalGb, { KINGMAKER_REFLEX_PIN: 'off' }, 2);
    for (const role of BRAIN_ROLES) assert.equal(env[role], undefined, role);
    assert.equal(env.SOLOMON_OLLAMA_CLASSIFIER_MODEL, FLOOR_ROLES.router);
    assert.equal(env.SOLOMON_PINNED_FAST_MODEL, FLOOR_ROLES.router);
    assert.equal(env.SOLOMON_OLLAMA_NUM_CTX, undefined, 'context is admitted per request');
    assert.equal(env.OLLAMA_MAX_LOADED_MODELS, '1');
  }
});

test('an uninstalled router is never pinned', () => {
  const env = profileRuntimeEnv([], 8, { KINGMAKER_REFLEX_PIN: 'off' }, 2);
  assert.equal(env.SOLOMON_OLLAMA_CLASSIFIER_MODEL, undefined);
  assert.equal(env.SOLOMON_PINNED_FAST_MODEL, undefined);
  assert.equal(env.OLLAMA_MAX_LOADED_MODELS, '1');
});

test('larger profiles retain their separate brain selection', () => {
  const env = profileRuntimeEnv([GRANITE_8GB], 16, {});
  for (const role of BRAIN_ROLES) assert.equal(env[role], undefined, role);
});
