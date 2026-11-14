/**
 * weightsynth-core.mjs — deterministic weight synthesis: recipes and merge math.
 *
 * The contract (SPEC.md, founder's order 2026-10-21): synthesis is a pure
 * function. Same parents (by sha256), same recipe, same seed → the same
 * artifact, byte-for-byte. All merge math runs in FP32 with a fixed
 * operation order (tensor names sorted, elements in index order) on a
 * single thread. No GPU kernels, no ambient randomness: every random
 * draw comes from a PRNG seeded by the recipe.
 *
 * A "model" here is an in-memory tensor set:
 *   { tensors: { [name]: { shape: number[], data: Float32Array } } }
 * Hosts adapt their file formats (GGUF / safetensors) to this shape at
 * the boundary; the core never touches a filesystem format, so the math
 * stays auditable in one place.
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Canonical hashing                                                    */
/* ------------------------------------------------------------------ */

/** Stable JSON: object keys sorted recursively, arrays in order. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

export function sha256Hex(input) {
  const h = createHash('sha256');
  if (typeof input === 'string') h.update(input, 'utf8');
  else h.update(input);
  return h.digest('hex');
}

/** Content address of any recipe/record: sha256 of its canonical form. */
export function contentId(record) {
  return sha256Hex(canonicalStringify(record));
}

/**
 * Artifact hash: the canonical tensor manifest (names sorted, shapes,
 * dtype) followed by each tensor's raw FP32 bytes in the same order.
 * Two bit-identical tensor sets hash identically; any single flipped
 * element changes the hash.
 */
export function hashTensorSet(tensors) {
  const names = Object.keys(tensors).sort();
  const manifest = names.map((n) => ({ name: n, shape: tensors[n].shape, dtype: 'f32' }));
  const h = createHash('sha256');
  h.update(canonicalStringify(manifest), 'utf8');
  for (const n of names) {
    const d = tensors[n].data;
    h.update(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
  }
  return h.digest('hex');
}

/* ------------------------------------------------------------------ */
/* Seeded PRNG — the ONLY randomness in the engine                      */
/* ------------------------------------------------------------------ */

/** Derive a uint32 seed from an arbitrary seed string (+ salt). */
export function seedFromString(seed, salt = '') {
  const hex = sha256Hex(String(seed) + '|' + salt);
  return parseInt(hex.slice(0, 8), 16) >>> 0;
}

/** mulberry32: small, exact, identical on every JS engine. */
export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG stream whose draws depend on (recipe seed, stream name) only —
 *  never on call order across tensors. */
export function streamPrng(recipeSeed, streamName) {
  return mulberry32(seedFromString(recipeSeed, streamName));
}

/* ------------------------------------------------------------------ */
/* Tensor-set validation                                                */
/* ------------------------------------------------------------------ */

export function tensorNames(tensors) {
  return Object.keys(tensors).sort();
}

function numel(shape) {
  return shape.reduce((a, b) => a * b, 1);
}

/** All parents must share one architecture fingerprint: same tensor
 *  names, same shapes. Returns the fingerprint (canonical manifest). */
export function architectureFingerprint(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('REFUSE: no parent models');
  }
  const ref = models[0].tensors;
  const refNames = tensorNames(ref);
  const manifest = refNames.map((n) => ({ name: n, shape: ref[n].shape }));
  for (let i = 0; i < models.length; i++) {
    const t = models[i].tensors;
    const names = tensorNames(t);
    if (names.length !== refNames.length || names.some((n, j) => n !== refNames[j])) {
      throw new Error(`REFUSE: parent ${i} tensor names differ (architecture mismatch)`);
    }
    for (const n of refNames) {
      const shape = t[n].shape;
      const rShape = ref[n].shape;
      if (shape.length !== rShape.length || shape.some((s, j) => s !== rShape[j])) {
        throw new Error(`REFUSE: parent ${i} tensor ${n} shape differs (architecture mismatch)`);
      }
      if (t[n].data.length !== numel(shape)) {
        throw new Error(`REFUSE: parent ${i} tensor ${n} data length does not match its shape`);
      }
    }
  }
  return { manifest, id: sha256Hex(canonicalStringify(manifest)) };
}

function emptyLike(tensors) {
  const out = {};
  for (const n of tensorNames(tensors)) {
    out[n] = { shape: [...tensors[n].shape], data: new Float32Array(tensors[n].data.length) };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Merge algorithms — FP32, fixed order, single thread                  */
/* ------------------------------------------------------------------ */

/** Weighted linear merge ("model soup"). Coefficients must sum to 1. */
export function mergeLinear(models, coefficients) {
  architectureFingerprint(models);
  if (coefficients.length !== models.length) {
    throw new Error('REFUSE: coefficient count does not match parent count');
  }
  const sum = coefficients.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`REFUSE: linear coefficients must sum to 1 (got ${sum})`);
  }
  const out = emptyLike(models[0].tensors);
  for (const n of tensorNames(out)) {
    const o = out[n].data;
    for (let p = 0; p < models.length; p++) {
      const d = models[p].tensors[n].data;
      const c = coefficients[p];
      for (let i = 0; i < o.length; i++) o[i] += c * d[i];
    }
  }
  return out;
}

/** Spherical interpolation between exactly two parents, per tensor. */
export function mergeSlerp(models, t) {
  if (models.length !== 2) throw new Error('REFUSE: slerp takes exactly two parents');
  if (!(t >= 0 && t <= 1)) throw new Error('REFUSE: slerp t must be in [0,1]');
  architectureFingerprint(models);
  const out = emptyLike(models[0].tensors);
  for (const n of tensorNames(out)) {
    const a = models[0].tensors[n].data;
    const b = models[1].tensors[n].data;
    const o = out[n].data;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    if (na === 0 || nb === 0) { // a zero tensor: fall back to linear
      for (let i = 0; i < a.length; i++) o[i] = (1 - t) * a[i] + t * b[i];
      continue;
    }
    let cos = dot / (na * nb);
    if (cos > 1) cos = 1; if (cos < -1) cos = -1;
    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    if (Math.abs(sinTheta) < 1e-6) { // (anti)parallel: linear is the defined path
      for (let i = 0; i < a.length; i++) o[i] = (1 - t) * a[i] + t * b[i];
      continue;
    }
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    for (let i = 0; i < a.length; i++) o[i] = wa * a[i] + wb * b[i];
  }
  return out;
}

function deltas(models, base) {
  return models.map((m) => {
    const out = {};
    for (const n of tensorNames(m.tensors)) {
      const d = m.tensors[n].data, b = base.tensors[n].data;
      const delta = new Float32Array(d.length);
      for (let i = 0; i < d.length; i++) delta[i] = d[i] - b[i];
      out[n] = delta;
    }
    return out;
  });
}

/**
 * TIES merge: trim each delta to its top-density magnitudes, elect one
 * sign per element by summed delta, average the agreeing deltas, add
 * back to base. Ties in magnitude ranking break by element index
 * (fixed order — deterministic).
 */
export function mergeTies(models, base, { density = 0.5, scale = 1 } = {}) {
  architectureFingerprint([...models, base]);
  if (!(density > 0 && density <= 1)) throw new Error('REFUSE: ties density must be in (0,1]');
  const ds = deltas(models, base);
  const out = emptyLike(base.tensors);
  for (const n of tensorNames(out)) {
    const b = base.tensors[n].data;
    const o = out[n].data;
    const len = b.length;
    const keep = Math.max(1, Math.floor(len * density));
    const trimmed = ds.map((d) => {
      const delta = d[n];
      const idx = Array.from({ length: len }, (_, i) => i);
      idx.sort((x, y) => (Math.abs(delta[y]) - Math.abs(delta[x])) || (x - y));
      const kept = new Float32Array(len);
      for (let k = 0; k < keep; k++) kept[idx[k]] = delta[idx[k]];
      return kept;
    });
    for (let i = 0; i < len; i++) {
      let signSum = 0;
      for (const td of trimmed) signSum += td[i];
      const sign = signSum >= 0 ? 1 : -1;
      let acc = 0, cnt = 0;
      for (const td of trimmed) {
        if (td[i] !== 0 && Math.sign(td[i]) === sign) { acc += td[i]; cnt++; }
      }
      o[i] = b[i] + (cnt > 0 ? scale * (acc / cnt) : 0);
    }
  }
  return out;
}

/**
 * DARE merge: randomly drop delta elements with probability p (seeded
 * PRNG, one stream per tensor name), rescale survivors by 1/(1-p),
 * average across parents, add back to base.
 */
export function mergeDare(models, base, { p = 0.5, scale = 1, seed } = {}) {
  architectureFingerprint([...models, base]);
  if (!(p >= 0 && p < 1)) throw new Error('REFUSE: dare p must be in [0,1)');
  if (seed === undefined) throw new Error('REFUSE: dare requires the recipe seed');
  const ds = deltas(models, base);
  const out = emptyLike(base.tensors);
  for (const n of tensorNames(out)) {
    const b = base.tensors[n].data;
    const o = out[n].data;
    const rand = streamPrng(seed, 'dare:' + n);
    const acc = new Float32Array(b.length);
    for (const d of ds) {
      const delta = d[n];
      for (let i = 0; i < b.length; i++) {
        acc[i] += rand() < p ? 0 : delta[i] / (1 - p);
      }
    }
    for (let i = 0; i < b.length; i++) o[i] = b[i] + scale * (acc[i] / ds.length);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Recipes                                                              */
/* ------------------------------------------------------------------ */

export const ALGORITHMS = Object.freeze(['linear', 'slerp', 'ties', 'dare']);
export const TOOLCHAIN = Object.freeze({ name: 'weightsynth-core', version: '1.0.0', numerics: 'fp32-canonical-order' });

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate a recipe and return its content id. A recipe names parents
 * BY HASH ONLY, carries its seed, its Judge suite identity, its balance
 * rule, and its environment record. Anything missing refuses — a recipe
 * that cannot reproduce is not a recipe.
 */
export function validateRecipe(recipe) {
  const fail = (m) => { throw new Error('REFUSE recipe: ' + m); };
  if (!recipe || typeof recipe !== 'object') fail('not an object');
  if (recipe.version !== 1) fail('version must be 1');
  if (!ALGORITHMS.includes(recipe.algorithm)) fail(`algorithm must be one of ${ALGORITHMS.join('/')}`);
  if (!Array.isArray(recipe.parents) || recipe.parents.length === 0) fail('parents required');
  for (const p of recipe.parents) if (!HEX64.test(p)) fail('every parent must be a sha256 hex (parents are named by hash only)');
  if (recipe.algorithm === 'slerp' && recipe.parents.length !== 2) fail('slerp takes exactly two parents');
  if ((recipe.algorithm === 'ties' || recipe.algorithm === 'dare')) {
    if (!HEX64.test(recipe.base || '')) fail(`${recipe.algorithm} requires a base parent hash`);
    if (!recipe.parents.includes(recipe.base)) fail('base must be one of the parents');
  }
  if (recipe.algorithm === 'linear') {
    if (!Array.isArray(recipe.coefficients) || recipe.coefficients.length !== recipe.parents.length) {
      fail('linear requires one coefficient per parent');
    }
  }
  if (recipe.algorithm === 'dare' && (recipe.seed === undefined || recipe.seed === '')) {
    fail('dare requires a seed');
  }
  if (recipe.seed !== undefined && typeof recipe.seed !== 'string') fail('seed must be a string');
  if (!recipe.suite || typeof recipe.suite.id !== 'string' || typeof recipe.suite.version !== 'string') {
    fail('suite {id, version} required — judging is part of the recipe');
  }
  const b = recipe.balance;
  if (!b || typeof b.qualityWeight !== 'number' || typeof b.productionWeight !== 'number'
      || typeof b.qualityFloor !== 'number') {
    fail('balance {qualityWeight, productionWeight, qualityFloor} required');
  }
  if (Math.abs(b.qualityWeight + b.productionWeight - 1) > 1e-6) {
    fail('balance weights must sum to 1');
  }
  if (!recipe.environment || typeof recipe.environment.twinSpecHash !== 'string'
      || !recipe.environment.toolchain) {
    fail('environment {twinSpecHash, toolchain} required');
  }
  return contentId(recipe);
}

/** Execute a validated recipe against hash-addressed parent models.
 *  parentsByHash: Map/object sha256 → model. Missing parent refuses. */
export function executeRecipe(recipe, parentsByHash) {
  validateRecipe(recipe);
  const get = (h) => {
    const m = parentsByHash instanceof Map ? parentsByHash.get(h) : parentsByHash[h];
    if (!m) throw new Error(`REFUSE: parent ${h.slice(0, 12)}… not in the registry (hash-addressed only)`);
    return m;
  };
  const models = recipe.parents.map(get);
  const params = recipe.params || {};
  let tensors;
  switch (recipe.algorithm) {
    case 'linear': tensors = mergeLinear(models, recipe.coefficients); break;
    case 'slerp': tensors = mergeSlerp(models, params.t ?? 0.5); break;
    case 'ties': tensors = mergeTies(models, get(recipe.base), { density: params.density ?? 0.5, scale: params.scale ?? 1 }); break;
    case 'dare': tensors = mergeDare(models, get(recipe.base), { p: params.p ?? 0.5, scale: params.scale ?? 1, seed: recipe.seed }); break;
    default: throw new Error('REFUSE: unreachable algorithm');
  }
  return { tensors, artifactHash: hashTensorSet(tensors) };
}
