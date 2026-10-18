import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorFlowSteps, createFlow, keyFlowSteps } from '../lib/flow.mjs';

test('a key flow: page shown, paste active; only what the engine saw done is done', () => {
  const sent = [];
  const f = createFlow({ id: 'h1', ask: 'Connect my CRM.', title: 'Connect Acme CRM', steps: keyFlowSteps({ label: 'Acme CRM', keyPageUrl: 'https://www.crm.example/settings/api' }), emit: (x) => sent.push(x) });
  assert.deepEqual(sent[0].steps.map((s) => s.state), ['done', 'active', 'waiting', 'waiting']);
  assert.match(sent[0].steps[0].caption, /crm\.example/);
  f.step('secret', 'done', { caption: 'Key pasted (hidden). Saving it…' });
  f.step('check', 'active');
  assert.deepEqual(sent.at(-1).steps.map((s) => s.state), ['done', 'done', 'active', 'waiting']);
  assert.equal(sent.at(-1).done, false);
  f.step('check', 'done'); f.step('ready', 'done', { caption: 'Acme CRM connected.' });
  assert.equal(sent.at(-1).done, true);
  const n = sent.length; f.step('check', 'failed'); assert.equal(sent.length, n, 'a finished flow does not change');
});

test('no key page: that step is skipped, not claimed', () => {
  assert.equal(keyFlowSteps({ label: 'X' })[0].state, 'skipped');
});

test('a failure marks the working step failed and the rest skipped', () => {
  const sent = [];
  const f = createFlow({ id: 'c1', ask: 'Add a connector', steps: connectorFlowSteps({ kind: 'mcp', name: 'notion' }), emit: (x) => sent.push(x) });
  assert.deepEqual(sent[0].steps.map((s) => s.state), ['active', 'waiting', 'waiting']);
  f.fail('REA rejected it: it fetches and runs code.');
  assert.deepEqual(sent.at(-1).steps.map((s) => s.state), ['failed', 'skipped', 'skipped']);
  assert.match(sent.at(-1).steps[0].caption, /REA rejected/);
  assert.equal(sent.at(-1).done, true);
  assert.equal(connectorFlowSteps({ kind: 'cli', name: 'ffmpeg' })[1].state, 'skipped', 'only an MCP server registers');
});
