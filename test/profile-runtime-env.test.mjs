import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_ROLES, profileRuntimeEnv } from '../lib/profile.mjs';
import { GRANITE_8GB } from '../lib/mac-profiles.mjs';

test('8 GB runtime uses one resident profile model for routing and reasoning', () => {
  const env = profileRuntimeEnv([GRANITE_8GB, 'huihui_ai/qwen3-abliterated:1.7b'], 8, {});
  for (const role of BRAIN_ROLES) assert.equal(env[role], GRANITE_8GB, role);
  assert.equal(env.SOLOMON_OLLAMA_CLASSIFIER_MODEL, GRANITE_8GB);
  assert.equal(env.SOLOMON_PINNED_FAST_MODEL, GRANITE_8GB);
  assert.equal(env.OLLAMA_MAX_LOADED_MODELS, '1');
});

test('larger profiles retain their separate brain selection', () => {
  const env = profileRuntimeEnv([GRANITE_8GB], 16, {});
  for (const role of BRAIN_ROLES) assert.equal(env[role], undefined, role);
});
