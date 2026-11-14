/**
 * test/decision-router.test.ts
 *
 * Unit tests for the decision-model reflex layer.
 * Transport is mocked — no live /v1/systemone traffic.
 */

import { DecisionRouter, DECISION_MODEL_REGISTRY } from '../runtime/decision-router';
import { DecisionRequest } from '../contracts/decision-model';

// --- Mock transport -------------------------------------------------------

function mockFetch(responseBody: unknown, ok = true, status = 200) {
  return (async (_input: unknown, _init?: unknown) => ({
    ok,
    status,
    json: async () => responseBody,
  })) as unknown as typeof fetch;
}

const baseRequest: DecisionRequest = {
  state: 'Route this inbound request: "reset my password".',
  questions: {
    engine: {
      type: 'choice',
      instructions: 'Which engine should handle this request?',
      criteria: {
        router: 'Simple routing decision',
        writer: 'Needs written output',
        coder: 'Needs code changes',
      },
    },
    safe: {
      type: 'noul',
      instructions: 'Safety check',
      condition: 'This request modifies persistent state.',
    },
  },
};

const highConfidenceResponse = {
  model: 'tev1',
  answers: {
    engine: {
      answer: 'router',
      probabilities: { router: 0.96, writer: 0.03, coder: 0.01 },
    },
    safe: {
      answer: false,
      probabilities: { true: 0.02, false: 0.98 },
    },
  },
};

const lowConfidenceResponse = {
  model: 'tev1',
  answers: {
    engine: {
      answer: 'writer',
      probabilities: { router: 0.4, writer: 0.45, coder: 0.15 },
    },
    safe: {
      answer: true,
      probabilities: { true: 0.55, false: 0.45 },
    },
  },
};

const midConfidenceResponse = {
  model: 'tev1',
  answers: {
    engine: {
      answer: 'writer',
      probabilities: { router: 0.2, writer: 0.75, coder: 0.05 },
    },
    safe: {
      answer: false,
      probabilities: { true: 0.25, false: 0.75 },
    },
  },
};

// --- Tests ----------------------------------------------------------------

describe('DecisionRouter', () => {
  test('refuses unregistered models', () => {
    expect(
      () =>
        new DecisionRouter({
          baseUrl: 'http://localhost:11434',
          model: 'nimble-v3',
          fetchImpl: mockFetch({}),
        })
    ).toThrow(/not in the licensed registry/);
  });

  test('high confidence auto-proceeds', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:11434',
      model: 'tev1',
      fetchImpl: mockFetch(highConfidenceResponse),
    });
    const outcomes = await router.decide(baseRequest);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].kind).toBe('auto-proceed');
    expect(outcomes[1].kind).toBe('auto-proceed');
  });

  test('low confidence escalates', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:11434',
      model: 'tev1',
      fetchImpl: mockFetch(lowConfidenceResponse),
    });
    const outcomes = await router.decide(baseRequest);
    expect(outcomes[0].kind).toBe('escalate');
    expect(outcomes[1].kind).toBe('escalate');
    if (outcomes[0].kind === 'escalate') {
      expect(outcomes[0].reason).toMatch(/below escalate threshold/);
    }
  });

  test('mid confidence routes to reasoning model', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:11434',
      model: 'tev1',
      fetchImpl: mockFetch(midConfidenceResponse),
    });
    const outcomes = await router.decide(baseRequest);
    expect(outcomes[0].kind).toBe('route-to-reasoning');
    expect(outcomes[1].kind).toBe('route-to-reasoning');
  });

  test('transport failure falls back to reasoning model when configured', async () => {
    const fallbackAnswers = [
      { kind: 'route-to-reasoning', answer: { answer: 'router', probabilities: { router: 1 } }, questionName: 'engine' },
    ] as never[];
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:1',
      model: 'tev1',
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
      reasoningFallback: async () => fallbackAnswers,
    });
    const outcomes = await router.decide(baseRequest);
    expect(outcomes).toEqual(fallbackAnswers);
  });

  test('transport failure without fallback returns transport-failed', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:1',
      model: 'tev1',
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });
    const outcomes = await router.decide(baseRequest);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].kind).toBe('transport-failed');
  });

  test('HTTP error is treated as transport failure', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:11434',
      model: 'tev1',
      fetchImpl: mockFetch({}, false, 404),
    });
    const outcomes = await router.decide(baseRequest);
    expect(outcomes[0].kind).toBe('transport-failed');
  });

  test('rejects invalid calibration (escalate >= auto-proceed)', () => {
    expect(
      () =>
        new DecisionRouter({
          baseUrl: 'http://localhost:11434',
          model: 'tev1',
          calibration: { escalateThreshold: 0.9, autoProceedThreshold: 0.9 },
          fetchImpl: mockFetch({}),
        })
    ).toThrow(/escalateThreshold must be below/);
  });

  test('rejects more than 64 questions', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:11434',
      model: 'tev1',
      fetchImpl: mockFetch({}),
    });
    const questions: DecisionRequest['questions'] = {};
    for (let i = 0; i < 65; i++) {
      questions[`q${i}`] = { type: 'noul', instructions: 'x', condition: 'y' };
    }
    await expect(router.decide({ state: 's', questions })).rejects.toThrow(/exceeds/);
  });

  test('registerModel refuses non-permissive licenses', () => {
    expect(() =>
      DecisionRouter.registerModel({
        name: 'nimble-v3-test',
        size: '9B',
        downloadSize: '9.5GB',
        license: 'other-permissive', // placeholder, replaced below
        minOllamaVersion: '0.35.0',
        fitsMacClass: ['24gb'],
      })
    ).not.toThrow();
    // Clean up the test registration
    const idx = DECISION_MODEL_REGISTRY.findIndex((r) => r.name === 'nimble-v3-test');
    if (idx >= 0) DECISION_MODEL_REGISTRY.splice(idx, 1);

    expect(() =>
      DecisionRouter.registerModel({
        name: 'bad-model',
        size: '9B',
        downloadSize: '9GB',
        license: 'cc-by-nc-4.0' as never,
        minOllamaVersion: '0.35.0',
        fitsMacClass: ['24gb'],
      })
    ).toThrow(/not permissive/);
  });

  test('pickModelForMac returns smallest fit', () => {
    const pick8 = DecisionRouter.pickModelForMac('8gb');
    expect(pick8.fitsMacClass).toContain('8gb');
    // Registry is ordered smallest-first: 8gb should get tev1 or laya
    expect(['tev1', 'laya']).toContain(pick8.name);

    const pickSpark = DecisionRouter.pickModelForMac('spark');
    expect(pickSpark.fitsMacClass).toContain('spark');
  });

  test('empty questions returns empty outcomes', async () => {
    const router = new DecisionRouter({
      baseUrl: 'http://localhost:11434',
      model: 'tev1',
      fetchImpl: mockFetch({}),
    });
    const outcomes = await router.decide({ state: 's', questions: {} });
    expect(outcomes).toEqual([]);
  });
});
