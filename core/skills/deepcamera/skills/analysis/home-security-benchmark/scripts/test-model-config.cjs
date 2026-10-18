#!/usr/bin/env node
/**
 * Unit tests for MODEL_FAMILIES / getModelFamily / getModelApiParams logic.
 *
 * Tests the model-family detection, per-request param injection,
 * and temperature clamping without needing a running LLM server.
 *
 * Usage:
 *   node scripts/test-model-config.cjs
 */

// ── Inline the config under test ─────────────────────────────────────────────
// (Kept in sync with run-benchmark.cjs MODEL_FAMILIES section)

const MODEL_FAMILIES = [
    {
        name: 'Mistral',
        match: (m) => m.includes('mistral') || m.includes('magistral') || m.includes('mixtral'),
        apiParams: { reasoning_effort: 'none' },
        serverFlags: '--chat-template-kwargs {"reasoning_effort":"none"} --parallel 1',
    },
    {
        name: 'Nemotron',
        match: (m) => m.includes('nemotron'),
        apiParams: {},
        minTemperature: 1.0,
    },
    {
        name: 'LFM',
        match: (m) => m.includes('lfm'),
        apiParams: {},
        minTemperature: 1.0,
    },
];

function getModelFamily(modelName) {
    if (!modelName) return {};
    const lower = modelName.toLowerCase();
    for (const family of MODEL_FAMILIES) {
        if (family.match(lower)) return family;
    }
    return {};
}

function getModelApiParams(modelName) {
    return getModelFamily(modelName).apiParams || {};
}

/** Simulate the temperature clamping logic from llmCall(). */
function resolveTemperature(modelName, requestedTemp, expectJSON) {
    const family = getModelFamily(modelName);
    let temperature = requestedTemp;
    if (temperature === undefined && expectJSON) temperature = 0.7;
    if (temperature !== undefined && family.minTemperature !== undefined) {
        temperature = Math.max(temperature, family.minTemperature);
    }
    return temperature;
}

// ── Mirror the server-manager detection ──────────────────────────────────────
function getServerFlags(modelFilePath) {
    const lower = modelFilePath.toLowerCase();
    const isMistralFamily = lower.includes('mistral') ||
                            lower.includes('magistral') ||
                            lower.includes('mixtral');
    return isMistralFamily
        ? { flag: '--chat-template-kwargs', value: '{"reasoning_effort":"none"}' }
        : { flag: '--chat-template-kwargs', value: '{"enable_thinking":false}' };
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertDeepEqual(a, b, msg) {
    const as = JSON.stringify(a), bs = JSON.stringify(b);
    if (as !== bs) throw new Error(`${msg || 'Not equal'}: got ${as}, expected ${bs}`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== MODEL_FAMILIES / getModelApiParams ===\n');

// ── Mistral detection ─────────────────────────────────────────────────────────
test('Mistral-Small-4-119B GGUF → reasoning_effort:none', () => {
    assertDeepEqual(getModelApiParams('Mistral-Small-4-119B-2603-UD-IQ1_M.gguf'), { reasoning_effort: 'none' });
});

test('Mistral-Small-4 Q2_K_XL → reasoning_effort:none', () => {
    assertDeepEqual(getModelApiParams('Mistral-Small-4-119B-2603-UD-Q2_K_XL.gguf'), { reasoning_effort: 'none' });
});

test('Magistral model → reasoning_effort:none', () => {
    assertDeepEqual(getModelApiParams('magistral-medium-2506.gguf'), { reasoning_effort: 'none' });
});

test('Mixtral-8x7B → reasoning_effort:none', () => {
    assertDeepEqual(getModelApiParams('Mixtral-8x7B-Instruct-v0.1.Q4_K_M.gguf'), { reasoning_effort: 'none' });
});

test('Mistral cloud API model ID → reasoning_effort:none', () => {
    assertDeepEqual(getModelApiParams('mistral-small-latest'), { reasoning_effort: 'none' });
});

// ── Nemotron detection ────────────────────────────────────────────────────────
test('Nemotron-4B → no extra apiParams', () => {
    assertDeepEqual(getModelApiParams('NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf'), {});
});

test('Nemotron-30B → no extra apiParams', () => {
    assertDeepEqual(getModelApiParams('NVIDIA-Nemotron-3-Nano-30B-A3B-Q8_0.gguf'), {});
});

test('Nemotron-30B → minTemperature = 1.0', () => {
    const f = getModelFamily('NVIDIA-Nemotron-3-Nano-30B-A3B-Q8_0.gguf');
    assert(f.minTemperature === 1.0, `Expected 1.0, got ${f.minTemperature}`);
});

// ── LFM detection ─────────────────────────────────────────────────────────────
test('LFM2-24B → no extra apiParams', () => {
    assertDeepEqual(getModelApiParams('LFM2-24B-A2B-Q8_0.gguf'), {});
});

test('LFM2.5-1.2B → no extra apiParams', () => {
    assertDeepEqual(getModelApiParams('LFM2.5-1.2B-Instruct-BF16.gguf'), {});
});

test('LFM2-24B → minTemperature = 1.0', () => {
    const f = getModelFamily('LFM2-24B-A2B-Q8_0.gguf');
    assert(f.minTemperature === 1.0, `Expected 1.0, got ${f.minTemperature}`);
});

// ── Non-matching: should get no family config ─────────────────────────────────
test('Qwen3.5-9B → no extra params (handled by prompt)', () => {
    assertDeepEqual(getModelApiParams('Qwen3.5-9B-Q4_K_M.gguf'), {});
});

test('GPT-5.4 → no extra params', () => {
    assertDeepEqual(getModelApiParams('gpt-5.4-2026-03-05'), {});
});

test('Empty model name → no extra params', () => {
    assertDeepEqual(getModelApiParams(''), {});
});

test('Undefined model name → no extra params', () => {
    assertDeepEqual(getModelApiParams(undefined), {});
});

// ── Temperature clamping ──────────────────────────────────────────────────────
console.log('\n=== Temperature clamping ===\n');

test('Nemotron + temp 0.1 → clamped to 1.0', () => {
    const t = resolveTemperature('NVIDIA-Nemotron-3-Nano-30B-A3B-Q8_0.gguf', 0.1, false);
    assert(t === 1.0, `Expected 1.0, got ${t}`);
});

test('LFM2 + temp 0.1 → clamped to 1.0', () => {
    const t = resolveTemperature('LFM2-24B-A2B-Q8_0.gguf', 0.1, false);
    assert(t === 1.0, `Expected 1.0, got ${t}`);
});

test('LFM2 + temp 0.7 (expectJSON) → clamped to 1.0', () => {
    const t = resolveTemperature('LFM2-24B-A2B-Q8_0.gguf', 0.7, true);
    assert(t === 1.0, `Expected 1.0, got ${t}`);
});

test('LFM2 + temp undefined + expectJSON → clamped from 0.7 to 1.0', () => {
    const t = resolveTemperature('LFM2-24B-A2B-Q8_0.gguf', undefined, true);
    assert(t === 1.0, `Expected 1.0, got ${t}`);
});

test('LFM2 + temp 1.5 → kept at 1.5 (above min)', () => {
    const t = resolveTemperature('LFM2-24B-A2B-Q8_0.gguf', 1.5, false);
    assert(t === 1.5, `Expected 1.5, got ${t}`);
});

test('Qwen + temp 0.1 → kept at 0.1 (no clamp)', () => {
    const t = resolveTemperature('Qwen3.5-9B-Q4_K_M.gguf', 0.1, false);
    assert(t === 0.1, `Expected 0.1, got ${t}`);
});

test('Mistral + temp 0.1 → kept at 0.1 (no minTemperature)', () => {
    const t = resolveTemperature('Mistral-Small-4-119B-2603-UD-Q2_K_XL.gguf', 0.1, false);
    assert(t === 0.1, `Expected 0.1, got ${t}`);
});

test('Qwen + temp undefined + no expectJSON → stays undefined', () => {
    const t = resolveTemperature('Qwen3.5-9B-Q4_K_M.gguf', undefined, false);
    assert(t === undefined, `Expected undefined, got ${t}`);
});

test('Nemotron + temp undefined + no expectJSON → stays undefined', () => {
    const t = resolveTemperature('NVIDIA-Nemotron-3-Nano-30B-A3B-Q8_0.gguf', undefined, false);
    assert(t === undefined, `Expected undefined, got ${t}`);
});

// ── Server-manager flags ─────────────────────────────────────────────────────
console.log('\n=== Server-manager startup flags ===\n');

test('Mistral GGUF path → chat-template-kwargs with reasoning_effort:none', () => {
    const f = getServerFlags('/models/Mistral-Small-4-119B-2603-UD-IQ1_M.gguf');
    assert(f.flag === '--chat-template-kwargs', `Expected --chat-template-kwargs, got ${f.flag}`);
    assert(f.value.includes('reasoning_effort'), `Expected reasoning_effort in value`);
});

test('Qwen path → chat-template-kwargs with enable_thinking:false', () => {
    const f = getServerFlags('/models/Qwen3.5-9B-Q4_K_M.gguf');
    assert(f.flag === '--chat-template-kwargs');
    assert(f.value.includes('enable_thinking'));
});

test('Nemotron path → chat-template-kwargs (non-Mistral default)', () => {
    const f = getServerFlags('/models/NVIDIA-Nemotron-3-Nano-30B-A3B-Q8_0.gguf');
    assert(f.flag === '--chat-template-kwargs');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
