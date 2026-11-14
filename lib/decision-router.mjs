/**
 * lib/decision-router.mjs
 *
 * COMPILED from ronininc/kingmaker-os runtime/decision-router.ts
 * Source of truth: kingmaker-os. Do not edit here — edit the TypeScript
 * source and re-compile.
 *
 * METERED-DOCTRINE REWORK (2026-11-14, owner's build order): this file WAS
 * edited here, once, against the standing rule above — the per-class fit
 * table (fitsMacClass) and the fit-throw pick (pickModelForMac) are the
 * tier-gating the doctrine retires, and the design named this file. The
 * kingmaker-os TypeScript source needs the matching change: the registry
 * carries no fit table, and the decision pick is the smallest registered
 * model with a known size (pickDecisionModel) on every device.
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
    publishedLatencyMs: 100,
  },
  {
    name: 'laya',
    size: '0.421B',
    downloadSize: '~450MB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    publishedLatencyMs: 33,
  },
  {
    name: 'tev1:4b',
    size: '4B',
    downloadSize: '4.5GB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
  },
  {
    name: 'nimble',
    size: '9B',
    downloadSize: '9.5GB',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
    publishedLatencyMs: 91,
  },
  {
    name: 'clef-flash',
    size: 'unknown',
    downloadSize: 'unknown',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
  },
  {
    name: 'clef',
    size: 'unknown',
    downloadSize: 'unknown',
    license: 'apache-2.0',
    minOllamaVersion: '0.35.0',
  },
];

/** A registry entry's download size in GB ('812MB' → 0.812, '~450MB' → 0.45, '4.5GB' → 4.5); unknown → null. */
export function registryDownloadGb(entry) {
  const m = /^~?([\d.]+)\s*(MB|GB)$/i.exec(String(entry?.downloadSize ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toUpperCase() === 'MB' ? n / 1000 : n;
}

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

  /**
   * The decision pick: the SMALLEST registered model whose download size is
   * known (an unknown size is never planned on). The decision role's
   * requirement is a typed forward pass, and the smallest vetted model that
   * serves it is sufficient on every device — no fit table, no fit-throw.
   * Throws only when the registry holds no sized model at all (a registry
   * defect, not a device verdict).
   */
  static pickDecisionModel() {
    const sized = DECISION_MODEL_REGISTRY
      .map((r) => ({ r, gb: registryDownloadGb(r) }))
      .filter((x) => x.gb != null)
      .sort((a, b) => a.gb - b.gb);
    if (!sized.length) {
      throw new Error('decision-router: no registered model has a known download size');
    }
    return sized[0].r;
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
