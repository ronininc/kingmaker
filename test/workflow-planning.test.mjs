import test from 'node:test';
import assert from 'node:assert/strict';
import { governedWorkflowTurn, prepareWorkflowPlanning, workflowPlanningPrompt } from '../lib/workflow-planning.mjs';

const request = 'Create and render a metallic cyberpunk control panel from the declarative workflow.';
const choice = { hunted: true, model: 'local-coder', role: 'coder' };

test('selected workflow planner produces an explicitly untrusted governed envelope', async () => {
  let call;
  const result = await prepareWorkflowPlanning({
    request,
    choice,
    plan: async (input) => { call = input; return '1. Build scene. 2. Validate. 3. Stop for approval.'; },
  });
  assert.equal(result.planned, true);
  assert.equal(call.model, 'local-coder');
  assert.match(call.prompt, /planning proposal only/i);
  assert.match(result.governedText, /UNTRUSTED PLANNING PROPOSAL/);
  assert.match(result.governedText, /grants no execution authority/);
  assert.match(result.governedText, /human gates/);
  const payload = JSON.parse(result.governedText.split('\n\n').at(-1));
  assert.equal(payload.ownerRequest, request);
  assert.equal(payload.plannerModel, 'local-coder');
  assert.match(payload.untrustedProposal, /Build scene/);
});

test('ordinary actions and missing choices never invoke the planner', async () => {
  let calls = 0;
  const plan = async () => { calls += 1; return 'no'; };
  assert.deepEqual(await prepareWorkflowPlanning({ request: 'Send Robbie a message', choice, plan }), { planned: false, reason: 'not-applicable' });
  assert.deepEqual(await prepareWorkflowPlanning({ request, choice: null, plan }), { planned: false, reason: 'not-applicable' });
  assert.equal(calls, 0);
});

test('planner failure returns to the existing governed path without fabricated output', async () => {
  const result = await prepareWorkflowPlanning({ request, choice, plan: async () => { throw new Error('local timeout'); } });
  assert.deepEqual(result, { planned: false, reason: 'planner-failed', error: 'local timeout' });
});

test('proposal is bounded and cannot replace the owner request', () => {
  const text = governedWorkflowTurn({ request, model: 'local-coder', proposal: 'x'.repeat(20_000) });
  const payload = JSON.parse(text.split('\n\n').at(-1));
  assert.equal(payload.ownerRequest, request);
  assert.equal(payload.untrustedProposal.length, 12_000);
  assert.match(workflowPlanningPrompt(request), new RegExp(request.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
