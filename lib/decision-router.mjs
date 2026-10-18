/**
 * lib/decision-router.mjs
 *
 * COMPILED from ronininc/kingmaker-os runtime/decision-router.ts
 * Source of truth: kingmaker-os. Do not edit here — edit the TypeScript
 * source and re-compile.
 *
 * The decision-model reflex layer for Kingmaker.
 * Typed routing decisions via Ollama /v1/systemone — one forward pass,
 * ~100ms, no text generation. The big models only wake up for actual thinking.
 */

const PERMISSIVE_LICENSES = ['apache-2.0', 'mit', 'other-permissive'];

export const DEFAULT_CALIBRATION = {
  autoProceedThreshold: 0.9,
  escalateThreshold: 0.6,
  betweenAction: 'route-to-reasoning',
  maxQuestionsPerCall: 64,
  timeoutMs: 2000,
};

/**
 * Built-in registry. Verified 2026-10-18.
 * nimble-v3 (HF, CC BY-NC 4.0) is EXCLUDED — non-commercial.
 * The Ollama-distributed `nimble` build is Apache 2.0 and IS registered.
 */
export const DECISION_MODEL_REGISTRY = [
  {
    name: 'tev1',
    size: '0.8B',
    downloadSize: '812MB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    fitsMacClass: ['8gb', '16gb', '24gb', '32gb', '48gb+', 'spark'],
    publishedLatencyMs: 100,
  },
  {
    name: 'laya',
    size: '0.421B',
    downloadSize: '~450MB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    fitsMacClass: ['8gb', '16gb', '24gb', '32gb', '48gb+', 'spark'],
    publishedLatencyMs: 33,
  },
  {
    name: 'tev1:4b',
    size: '4B',
    downloadSize: '4.5GB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    fitsMacClass: ['16gb', '24gb', '32gb', '48gb+', 'spark'],
  },
  {
    name: 'nimble',
    size: '9B',
    downloadSize: '9.5GB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    fitsMacClass: ['24gb', '32gb', '48gb+', 'spark'],
    publishedLatencyMs: 91,
  },
  {
    name: 'clef-flash',
    size: 'unknown',
    downloadSize: 'unknown',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    fitsMacClass: ['16gb', '24gb', '32gb', '48gb+', 'spark'],
  },
  {
    name: 'clef',
    size: 'unknown',
    downloadSize: 'unknown',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    fitsMacClass: ['24gb', '32gb', '48gb+', 'spark'],
  },
];

export class DecisionRouter {
  constructor(config) {
    const registration = DECISION_MODEL_REGISTRY.find((r) => r.name === config.model);
    if (!registration) {
      throw new Error(
        `decision-router: model "${config.model}" is not in the licensed registry. ` +
          `Refusing to serve an unvetted decision model.`
      );
    }
    this.config = config;
    this.calibration = { ...DEFAULT_CALIBRATION, ...(config.calibration ?? {}) };
    this.validateCalibration(this.calibration);
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  validateCalibration(c) {
    if (c.escalateThreshold >= c.autoProceedThreshold) {
      throw new Error('decision-router: escalateThreshold must be below autoProceedThreshold');
    }
    if (c.maxQuestionsPerCall > 64) {
      throw new Error('decision-router: endpoint caps at 64 questions per call');
    }
  }

  static registerModel(reg) {
    if (!PERMISSIVE_LICENSES.includes(reg.license)) {
      throw new Error(
        `decision-router: refusing model "${reg.name}" — license "${reg.license}" ` +
          `is not permissive. Non-commercial builds (e.g. CC BY-NC 4.0) are excluded.`
      );
    }
    if (DECISION_MODEL_REGISTRY.some((r) => r.name === reg.name)) {
      throw new Error(`decision-router: model "${reg.name}" already registered`);
    }
    DECISION_MODEL_REGISTRY.push(reg);
  }

  static pickModelForMac(macClass) {
    const fits = DECISION_MODEL_REGISTRY.filter((r) => r.fitsMacClass.includes(macClass));
    if (fits.length === 0) {
      throw new Error(`decision-router: no registered model fits ${macClass}`);
    }
    return fits[0];
  }

  topProbability(answer) {
    const probs = Object.values(answer.probabilities);
    return probs.length > 0 ? Math.max(...probs) : 0;
  }

  toOutcome(questionName, answer) {
    const p = this.topProbability(answer);
    if (p >= this.calibration.autoProceedThreshold) {
      return { kind: 'auto-proceed', answer, questionName };
    }
    if (p < this.calibration.escalateThreshold) {
      return {
        kind: 'escalate',
        answer,
        questionName,
        reason: `top probability ${p.toFixed(3)} below escalate threshold ${this.calibration.escalateThreshold}`,
      };
    }
    return { kind: 'route-to-reasoning', answer, questionName };
  }

  async decide(request) {
    const questionNames = Object.keys(request.questions);
    if (questionNames.length === 0) return [];
    if (questionNames.length > this.calibration.maxQuestionsPerCall) {
      throw new Error(
        `decision-router: ${questionNames.length} questions exceeds maxQuestionsPerCall=${this.calibration.maxQuestionsPerCall}`
      );
    }

    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.calibration.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.config.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.config.model,
            state: request.state,
            questions: request.questions,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`endpoint returned HTTP ${res.status}`);
        }
        response = await res.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.config.reasoningFallback) {
        return this.config.reasoningFallback(request);
      }
      return questionNames.map((questionName) => ({
        kind: 'transport-failed',
        questionName,
        reason: `reflex layer unreachable: ${reason}`,
      }));
    }

    return questionNames.map((questionName) => {
      const answer = response.answers[questionName];
      if (!answer) {
        return {
          kind: 'transport-failed',
          questionName,
          reason: 'endpoint returned no answer for this question',
        };
      }
      return this.toOutcome(questionName, answer);
    });
  }
}
