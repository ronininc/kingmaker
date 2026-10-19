/**
 * Kingmaker — model condensation.
 *
 * Points the compute-condensation program at a model: takes a model
 * descriptor (including abliterated/uncensored builds) and produces the
 * concrete lighter-to-run plan — quantization assignments, expert
 * residency, KV budget, and the load strategy.
 *
 * The recipe mirrors where the industry converged: FP8 dense backbone,
 * MXFP4 experts, sparse activation, small KV cache. The abliterated
 * model keeps its capability; condensation only shrinks what it costs
 * to run. Deterministic and auditable: the same model + device always
 * yields the same plan.
 *
 * Pure functions. No I/O, no network. Composes with the compute
 * governor for the final load strategy.
 */

import { planLoad } from './compute-governor.mjs';

/** Bytes per parameter per quantization. */
export const QUANT_BYTES = {
  fp8: 1,
  mxfp4: 0.5,
};

/** Default context window for KV budgeting when the caller doesn't say. */
export const DEFAULT_CONTEXT_TOKENS = 32768;

/**
 * Condense a model for a device.
 *
 * @param {Object} model
 * @param {string} model.id
 * @param {number} model.denseParams - non-expert parameters (backbone)
 * @param {number} model.expertParams - parameters per expert
 * @param {number} model.totalExperts - experts per layer (0 for dense models)
 * @param {number} model.activeExperts - experts active per token (0 for dense)
 * @param {number} [model.kvBytesPerToken] - KV cache cost per token
 * @param {number} [model.contextTokens] - context window for KV budgeting
 * @param {Object} device - { totalMemoryBytes }
 * @returns {Object} condensation plan
 */
export function condenseModel(model, device) {
  const warnings = [];
  const denseParams = model.denseParams || 0;
  const expertParams = model.expertParams || 0;
  const totalExperts = model.totalExperts || 0;
  const activeExperts = model.activeExperts || 0;
  const kvBytesPerToken = model.kvBytesPerToken || 0;
  const contextTokens = model.contextTokens || DEFAULT_CONTEXT_TOKENS;

  const quantization = {
    dense: 'fp8',
    experts: totalExperts > 0 ? 'mxfp4' : 'fp8',
    kv: 'fp8',
  };

  const denseBytes = denseParams * QUANT_BYTES[quantization.dense];
  const allExpertsBytes = expertParams * totalExperts * QUANT_BYTES[quantization.experts];
  const activeExpertsBytes = expertParams * activeExperts * QUANT_BYTES[quantization.experts];
  const kvBytes = kvBytesPerToken * contextTokens;

  const totalWeightBytes = denseBytes + allExpertsBytes;
  const activeMemoryBytes = denseBytes + activeExpertsBytes + kvBytes;

  if (totalExperts > 0 && activeExperts === 0) {
    warnings.push('MoE model with no active-expert count — active set graded as full weights');
  }

  const load = planLoad(
    { id: model.id, estimatedSizeBytes: totalWeightBytes, activeMemoryBytes },
    device,
  );

  return {
    modelId: model.id,
    quantization,
    memory: {
      denseBytes,
      allExpertsBytes,
      activeExpertsBytes,
      kvBytes,
      totalWeightBytes,
      activeMemoryBytes,
    },
    residency: {
      resident: ['dense backbone', `${activeExperts} active experts/layer`, 'KV cache'],
      streamed: load.strategy === 'stream' ? ['inactive experts (SSD)'] : [],
    },
    strategy: load.strategy,
    tier: load.tier,
    warnings: [...warnings, ...load.warnings],
    reason: load.reason,
  };
}
