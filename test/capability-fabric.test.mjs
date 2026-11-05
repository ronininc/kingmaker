import assert from 'node:assert/strict';
import test from 'node:test';

import { planTaskRuntime } from '../lib/capability-fabric.mjs';

const hash = (character) => character.repeat(64);
const components = [
  { id: 'video-director', kind: 'tool', sha256: hash('a'), capabilities: ['media-read', 'network'], shards: [{ url: 'https://paid.example/tool.part', sha256: hash('b'), size: 10 }] },
  { id: 'qwen-teacher', kind: 'model', role: 'tools', sha256: hash('c'), capabilities: [] },
  { id: 'deepseek-teacher', kind: 'model', role: 'reasoning', sha256: hash('d'), capabilities: [] },
];

test('verified tools and models compose through one governed broker and teacher harness', () => {
  const pins = new Map(components.map((component) => [component.id, component.sha256]));
  const runtime = planTaskRuntime({
    task: 'direct and render a sourced video', components, launcherPins: pins,
    allowedCapabilities: ['media-read'], forgePlan: { planHash: hash('e') },
  });
  assert.equal(runtime.components.length, 3);
  assert.deepEqual(runtime.components[0].grantedCapabilities, ['media-read']);
  assert.deepEqual(runtime.components[0].deniedCapabilities, ['network']);
  assert.equal(runtime.broker.directComponentInvocation, false);
  assert.equal(runtime.evolution.mode, 'composite-teacher-harness');
  assert.match(runtime.runtimeHash, /^[a-f0-9]{64}$/);
});

test('one changed component hash refuses the whole runtime', () => {
  const pins = new Map(components.map((component) => [component.id, component.sha256]));
  pins.set('video-director', hash('f'));
  assert.throws(() => planTaskRuntime({ task: 'x', components, launcherPins: pins }), /pin mismatch/);
});
