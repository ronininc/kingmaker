/**
 * Kingmaker — condense truth pass (Edge0 × MiniCPM5 augmentation).
 *
 * Wraps lib/model-condense.mjs by composition and corrects three things
 * the base planner cannot express today, all measured against the
 * artifacts that actually ship (see augmentation-spec.md §2):
 *
 *   1. The format Edge0 ships — MLX affine int4, group_size 64 — is in
 *      the byte table. MXFP4 (microscaling, block-32 E8M0 scales) is a
 *      different format; on Apple Silicon/MLX, affine-g64 is the native
 *      fast path, and plan bytes computed without it mis-describe the
 *      shipped model.
 *   2. A sensitive-tensor registry: MoE router/gate tensors stay at
 *      fp8 while the bulk drops to 4-bit. Misrouting is the dominant
 *      MoE-quant failure mode; Edge0's own artifact pins all 80 of its
 *      gate tensors at 8-bit. The byte cost is ~10 MB — reported, not
 *      hidden.
 *   3. KV budgeting over the layers that actually carry a cache:
 *      hybrid-attention models (Edge0: 3 linear : 1 full) hold KV on
 *      a fraction of their layers. Assuming every layer carries KV
 *      overstates Edge0's cache by 4×.
 *
 * Pure functions. No I/O, no network. The base planner is untouched —
 * this module feeds it a corrected descriptor and annotates its plan.
 */

import {
  condenseModel,
  QUANT_BYTES,
  DEFAULT_CONTEXT_TOKENS,
} from '../../kingmaker-survey/lib/model-condense.mjs';

export { QUANT_BYTES, DEFAULT_CONTEXT_TOKENS };

/* ------------------------------------------------------------------ */
/* 1. Format table — MLX affine formats                                */
/* ------------------------------------------------------------------ */

/**
 * MLX affine quantization stores, per group, one fp16 scale and one
 * fp16 bias: 4 bytes of overhead per group on top of the packed
 * payload. Effective bytes/param = bits/8 + 4/groupSize.
 */
export const AFFINE_GROUP_OVERHEAD_BYTES = 4;

export function affineBytesPerParam(bits, groupSize) {
  return bits / 8 + AFFINE_GROUP_OVERHEAD_BYTES / groupSize;
}

/** The format MiniCPM5-1B-MLX and Edge0 both ship: affine 4-bit, group 64. */
export const AFFINE_INT4_G64 = {
  format: 'affine-int4-g64',
  mode: 'affine',
  bits: 4,
  groupSize: 64,
  payloadBytesPerParam: 4 / 8,
  overheadBytesPerParam: AFFINE_GROUP_OVERHEAD_BYTES / 64,
  bytesPerParam: affineBytesPerParam(4, 64), // 0.5625
};

/** Base planner table plus the affine formats. Base entries are kept verbatim. */
export const EXTENDED_QUANT_BYTES = {
  ...QUANT_BYTES,
  'affine-int4-g64': AFFINE_INT4_G64.bytesPerParam,
  'affine-int8-g64': affineBytesPerParam(8, 64), // 1.0625
};

/** Bytes per parameter for any format the extended table knows. Throws on unknown. */
export function bytesPerParam(format) {
  const b = EXTENDED_QUANT_BYTES[format];
  if (b === undefined) throw new Error(`unknown quantization format: ${format}`);
  return b;
}

/* ------------------------------------------------------------------ */
/* 2. Sensitive-tensor registry                                        */
/* ------------------------------------------------------------------ */

/**
 * Tensors whose precision is pinned regardless of the bulk format.
 * `pin` names a format in EXTENDED_QUANT_BYTES. Matching is by suffix
 * on the tensor's dotted name, so it works across the naming schemes
 * publishers use (language_model.model.layers.N…, model.layers.N…).
 */
export const SENSITIVE_TENSOR_REGISTRY = [
  {
    id: 'moe-router-gate',
    suffix: 'mlp.gate',
    pin: 'fp8',
    reason:
      'MoE router: decides expert selection for every token. Quantization error here misroutes the whole layer — the dominant MoE-quant failure mode. Edge0 ships this tensor at 8-bit.',
  },
  {
    id: 'moe-shared-expert-gate',
    suffix: 'mlp.shared_expert_gate',
    pin: 'fp8',
    reason:
      'Shared-expert gate: scales the always-on expert path. Same misrouting sensitivity as the router gate; Edge0 ships it at 8-bit.',
  },
  {
    id: 'token-embedding',
    suffix: 'embed_tokens',
    pin: 'fp8',
    reason:
      'Token embeddings: every position reads them; error here propagates into every layer. Kept at fp8 by extension of the gate rule.',
  },
  {
    id: 'final-norm',
    suffix: 'model.norm',
    pin: 'fp8',
    reason:
      'Final norm before the head: a single small tensor on the output path of every token; no reason to quantize it.',
  },
];

/** Registry entry for a tensor name, or null if the tensor takes the bulk format. */
export function classifyTensor(tensorName) {
  if (typeof tensorName !== 'string') return null;
  // Names arrive as module paths (config quantization keys) or full
  // tensor names with a trailing .weight/.bias — normalize to the module.
  const name = tensorName.replace(/\.(weight|bias)$/, '');
  for (const entry of SENSITIVE_TENSOR_REGISTRY) {
    if (name === entry.suffix || name.endsWith(`.${entry.suffix}`)) {
      return entry;
    }
  }
  return null;
}

/** The pinned format for a tensor name, or null if it takes the bulk format. */
export function pinnedFormatFor(tensorName) {
  const entry = classifyTensor(tensorName);
  return entry ? entry.pin : null;
}

/**
 * Gate-tensor parameter census for an MoE geometry.
 * Router gate: hiddenSize × numExperts. Shared-expert gate:
 * hiddenSize × 1 per shared expert. (Biases ignored — sub-0.1%.)
 */
export function sensitiveTensorParams({ hiddenSize, numExperts, sharedExperts = 1, layers }) {
  const gatePerLayer = hiddenSize * numExperts;
  const sharedGatePerLayer = hiddenSize * sharedExperts;
  const perLayer = gatePerLayer + sharedGatePerLayer;
  return { gatePerLayer, sharedGatePerLayer, perLayer, layers, total: perLayer * layers };
}

/**
 * Byte cost of pinning the sensitive tensors instead of quantizing
 * them with the bulk. Reports pinned bytes, bulk bytes, and the delta
 * (what the protection costs). On Edge0: ~21M params, ~10 MB delta.
 */
export function sensitiveTensorCost({
  hiddenSize,
  numExperts,
  sharedExperts = 1,
  layers,
  baseFormat = 'affine-int4-g64',
  pinFormat = 'fp8',
}) {
  const census = sensitiveTensorParams({ hiddenSize, numExperts, sharedExperts, layers });
  const pinnedBytes = census.total * bytesPerParam(pinFormat);
  const baseBytes = census.total * bytesPerParam(baseFormat);
  return {
    ...census,
    totalParams: census.total,
    baseFormat,
    pinFormat,
    pinnedBytes,
    baseBytes,
    deltaBytes: pinnedBytes - baseBytes,
  };
}

/* ------------------------------------------------------------------ */
/* 3. KV layer fraction (hybrid attention)                             */
/* ------------------------------------------------------------------ */

/**
 * Fraction of layers carrying a KV cache, from a config's layer_types
 * list: the share of 'full_attention' entries. Returns 1 when the
 * model has no hybrid split (or no list to read).
 */
export function kvLayerFractionFromLayerTypes(layerTypes) {
  if (!Array.isArray(layerTypes) || layerTypes.length === 0) return 1;
  const full = layerTypes.filter((t) => t === 'full_attention').length;
  return full / layerTypes.length;
}

/**
 * Resolve the KV layer fraction from a descriptor, in precedence
 * order: explicit kvLayerFraction → layerTypes → kvLayers/totalLayers
 * → 1 (no correction). `corrected` says whether any real fraction < 1
 * was applied.
 */
export function resolveKvLayerFraction(model) {
  if (Number.isFinite(model.kvLayerFraction)) {
    return { fraction: model.kvLayerFraction, source: 'descriptor', corrected: model.kvLayerFraction < 1 };
  }
  if (Array.isArray(model.layerTypes)) {
    const fraction = kvLayerFractionFromLayerTypes(model.layerTypes);
    return { fraction, source: 'layerTypes', corrected: fraction < 1 };
  }
  if (Number.isFinite(model.kvLayers) && Number.isFinite(model.totalLayers) && model.totalLayers > 0) {
    const fraction = model.kvLayers / model.totalLayers;
    return { fraction, source: 'kvLayers/totalLayers', corrected: fraction < 1 };
  }
  return { fraction: 1, source: 'none', corrected: false };
}

/** Naive (all-layers) vs corrected KV bytes for a context window. */
export function kvCorrection({ kvBytesPerToken, contextTokens, kvLayerFraction }) {
  const naiveBytes = kvBytesPerToken * contextTokens;
  const correctedBytes = kvBytesPerToken * kvLayerFraction * contextTokens;
  return {
    naiveBytes,
    correctedBytes,
    overstatementFactor: correctedBytes > 0 ? naiveBytes / correctedBytes : 1,
  };
}

/* ------------------------------------------------------------------ */
/* The truth-pass plan                                                 */
/* ------------------------------------------------------------------ */

/**
 * Condense with the truth pass applied.
 *
 * Accepts the base planner's descriptor plus any of:
 * @param {number} [model.kvLayerFraction] - share of layers carrying KV
 * @param {string[]} [model.layerTypes] - config layer_types list
 * @param {number} [model.kvLayers] / [model.totalLayers]
 * @param {Object} [model.sensitiveTensors] - { hiddenSize, numExperts, sharedExperts?, layers }
 *        (or { perLayer, layers } / { totalParams } for a direct census)
 * @param {string} [model.shippedFormat] - format to price the weights in
 *        for the affine report (default 'affine-int4-g64')
 *
 * The returned plan is the base planner's plan — with KV already
 * corrected, so memory.kvBytes and memory.activeMemoryBytes are the
 * true figures — annotated with a `truthPass` section: the format
 * table, the KV correction (naive vs corrected), the sensitive-tensor
 * pinning cost, and the plan's weight bytes priced in shippedFormat
 * with the sensitive tensors carved out at their pin.
 */
export function condenseWithTruthPass(model, device) {
  const contextTokens = model.contextTokens || DEFAULT_CONTEXT_TOKENS;
  const kvBytesPerToken = model.kvBytesPerToken || 0;
  const { fraction, source: fractionSource, corrected } = resolveKvLayerFraction(model);

  // Composition: the base planner sees the corrected per-token KV cost,
  // so every figure it derives (kvBytes, activeMemoryBytes) is true.
  const plan = condenseModel(
    { ...model, kvBytesPerToken: kvBytesPerToken * fraction },
    device,
  );

  const kv = {
    layerFraction: fraction,
    fractionSource,
    corrected,
    bytesPerTokenAllLayers: kvBytesPerToken,
    bytesPerTokenEffective: kvBytesPerToken * fraction,
    ...kvCorrection({ kvBytesPerToken, contextTokens, kvLayerFraction: fraction }),
  };

  // Sensitive tensors: accept a geometry, a per-layer census, or a total.
  let sensitive = null;
  if (model.sensitiveTensors) {
    const st = model.sensitiveTensors;
    const baseFormat = model.shippedFormat || 'affine-int4-g64';
    const totalParams = Number.isFinite(st.totalParams)
      ? st.totalParams
      : Number.isFinite(st.perLayer) && Number.isFinite(st.layers)
        ? st.perLayer * st.layers
        : null;
    if (totalParams !== null) {
      const pinnedBytes = totalParams * bytesPerParam('fp8');
      const baseBytes = totalParams * bytesPerParam(baseFormat);
      sensitive = {
        totalParams,
        baseFormat,
        pinFormat: 'fp8',
        pinnedBytes,
        baseBytes,
        deltaBytes: pinnedBytes - baseBytes,
      };
    } else {
      sensitive = sensitiveTensorCost({ ...st, baseFormat });
    }
  }

  // Weight bytes priced in the shipped format, gates pinned at fp8.
  // Gate params live in the dense (non-expert) pool in the base
  // descriptor, so they are carved out of it before pricing the bulk.
  const shippedFormat = model.shippedFormat || 'affine-int4-g64';
  const shippedRate = bytesPerParam(shippedFormat);
  const gateParams = sensitive ? sensitive.totalParams : 0;
  const denseParams = model.denseParams || 0;
  const expertParams = model.expertParams || 0;
  const totalExperts = model.totalExperts || 0;
  const bulkDenseBytes = Math.max(0, denseParams - gateParams) * shippedRate;
  const pinnedBytes = sensitive ? sensitive.pinnedBytes : 0;
  const expertsBytes = expertParams * totalExperts * shippedRate;
  const affinePlan = {
    format: shippedFormat,
    bytesPerParam: shippedRate,
    bulkDenseBytes,
    pinnedSensitiveBytes: pinnedBytes,
    denseBytes: bulkDenseBytes + pinnedBytes,
    allExpertsBytes: expertsBytes,
    totalWeightBytes: bulkDenseBytes + pinnedBytes + expertsBytes,
  };

  return {
    ...plan,
    quantization: {
      ...plan.quantization,
      sensitive: SENSITIVE_TENSOR_REGISTRY.map(({ id, suffix, pin }) => ({ id, suffix, pin })),
    },
    truthPass: {
      formats: { ...EXTENDED_QUANT_BYTES },
      kv,
      sensitiveTensors: sensitive,
      shippedFormatPlan: affinePlan,
    },
  };
}
