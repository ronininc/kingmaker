#!/usr/bin/env node
/**
 * Cloud Provider Regression Test — Aegis Skill
 *
 * Reads ~/.aegis-ai/llm-config.json and tests every enabled provider:
 *   1. Connectivity — can we reach the API?
 *   2. Chat completion — does the model respond?
 *   3. JSON output — can it follow structured output instructions?
 *   4. Streaming — does SSE streaming work?
 *
 * Follows the Aegis Skill Protocol:
 *   - JSONL events on stdout (parsed by skill-runtime-manager)
 *   - Human-readable logs on stderr (visible in Aegis console tab)
 *
 * Usage:
 *   node scripts/run-regression.cjs                    # test all enabled
 *   node scripts/run-regression.cjs --provider glm     # test one provider
 *   node scripts/run-regression.cjs --provider glm,xai # test specific providers
 *   node scripts/run-regression.cjs --verbose          # show full responses
 *   node scripts/run-regression.cjs --skip-json        # skip JSON test
 *   node scripts/run-regression.cjs --skip-stream      # skip streaming test
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Skill Protocol ─────────────────────────────────────────────────────────

const SKILL_ID = process.env.AEGIS_SKILL_ID || '';
const IS_SKILL = !!SKILL_ID;
let skillParams = {};
try { skillParams = JSON.parse(process.env.AEGIS_SKILL_PARAMS || '{}'); } catch {}

/** Emit structured JSONL event on stdout (Aegis skill protocol) */
function emit(event) {
    process.stdout.write(JSON.stringify(event) + '\n');
}

/** Log human-readable text to stderr (Aegis console tab / terminal) */
function log(msg) {
    process.stderr.write(msg + '\n');
}

// ─── CLI Args + Skill Params ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? (args[idx + 1] || true) : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

if (hasFlag('help') || hasFlag('h')) {
    log(`
Cloud Provider Regression Test — Aegis-AI

Usage: node scripts/run-regression.cjs [options]

Options:
  --provider ID       Test specific provider(s), comma-separated
  --verbose           Show full API responses
  --skip-json         Skip JSON output test
  --skip-stream       Skip streaming test
  --timeout MS        Request timeout (default: 30000)
  -h, --help          Show this help

Reads API keys from: ~/.aegis-ai/llm-config.json
    `.trim());
    process.exit(0);
}

// Merge CLI args with skill params (CLI takes precedence)
const VERBOSE = hasFlag('verbose');
const SKIP_JSON = hasFlag('skip-json') || skillParams.skipJson;
const SKIP_STREAM = hasFlag('skip-stream') || skillParams.skipStream;
const TIMEOUT_MS = parseInt(getArg('timeout') || skillParams.timeout || '30000', 10);
const FILTER = getArg('provider') || (skillParams.providers !== 'all' ? skillParams.providers : null);
const FILTER_IDS = FILTER ? String(FILTER).split(',').map(s => s.trim()) : null;

// ─── Load Config ─────────────────────────────────────────────────────────────

const LLM_CONFIG_PATH = path.join(os.homedir(), '.aegis-ai', 'llm-config.json');

let llmConfig;
try {
    llmConfig = JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf-8'));
} catch (err) {
    log(`❌ Cannot read ${LLM_CONFIG_PATH}: ${err.message}`);
    if (IS_SKILL) emit({ event: 'error', message: `Cannot read llm-config.json: ${err.message}` });
    process.exit(1);
}

// Load cloud provider registry — try Aegis-AI project first, then inline fallback
let CLOUD_PROVIDERS = {};
const registryPaths = [
    // Running from Aegis-AI project
    path.join(__dirname, '..', '..', '..', '..', 'Aegis-AI', 'electron', 'config', 'cloud-providers.cjs'),
    // Running from within Aegis-AI/scripts
    path.join(__dirname, '..', 'electron', 'config', 'cloud-providers.cjs'),
    // Running from installed skill location
    path.resolve(os.homedir(), '.aegis-ai', '..', 'workspace', 'Aegis-AI', 'electron', 'config', 'cloud-providers.cjs'),
];
for (const rp of registryPaths) {
    try {
        CLOUD_PROVIDERS = require(rp).CLOUD_PROVIDERS;
        break;
    } catch { /* try next */ }
}

// ─── URL Normalization (same as benchmark fix) ───────────────────────────────

const ensureVersionPath = (u) => {
    const cleaned = u.replace(/\/+$/, '');
    return /\/v\d+$/.test(cleaned) ? cleaned : `${cleaned}/v1`;
};

// ─── Provider API Adapters ───────────────────────────────────────────────────

/**
 * OpenAI-compatible chat completion (works for OpenAI, DeepSeek, MiniMax,
 * Kimi, Qwen, xAI, GLM, etc.)
 */
async function openaiChat(baseUrl, apiKey, model, messages, stream = false, opts = {}) {
    const url = `${baseUrl}/chat/completions`;

    const makeBody = (useModern) => ({
        model,
        messages,
        stream,
        ...(useModern ? { max_completion_tokens: 256 } : { max_tokens: 256 }),
        ...(opts.skipTemperature ? {} : { temperature: 0.3 }),
    });

    const doFetch = async (body) => {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return resp;
    };

    // Try with max_completion_tokens first
    let resp = await doFetch(makeBody(true));

    // If 400 error mentioning max_tokens/max_completion_tokens, retry with legacy param
    if (resp.status === 400) {
        const errText = await resp.text().catch(() => '');
        if (errText.includes('max_tokens') || errText.includes('max_completion_tokens') || errText.includes('Unsupported parameter')) {
            if (VERBOSE) log(`    ↻ Retrying with max_tokens (max_completion_tokens rejected)`);
            resp = await doFetch(makeBody(false));
        } else {
            throw new Error(`HTTP 400: ${errText.slice(0, 200)}`);
        }
    }

    // Retry on 429 rate limit with exponential backoff
    if (resp.status === 429) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const delayMs = Math.pow(2, attempt) * 1000;
            log(`    ⏳ Rate limited (429) — retry ${attempt}/3 in ${delayMs / 1000}s...`);
            await new Promise(r => setTimeout(r, delayMs));
            resp = await doFetch(makeBody(false));
            if (resp.status !== 429) break;
        }
    }

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    if (stream) {
        return readSSEStream(resp);
    }
    return resp.json();
}

/**
 * Anthropic Messages API
 */
async function anthropicChat(baseUrl, apiKey, model, messages) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');
    const systemText = systemMsgs.map(m => m.content).join('\n');

    const url = `${baseUrl}/v1/messages`;
    const body = {
        model,
        max_tokens: 256,
        ...(systemText && { system: systemText }),
        messages: convMsgs.map(m => ({ role: m.role, content: m.content })),
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    return {
        choices: [{
            message: { role: 'assistant', content: data.content?.[0]?.text || '' },
        }],
        model: data.model,
        usage: { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0 },
    };
}

/**
 * Gemini API (generateContent)
 */
async function geminiChat(baseUrl, apiKey, model, messages) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');
    const systemText = systemMsgs.map(m => m.content).join('\n');

    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;
    const body = {
        contents: convMsgs.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        })),
        ...(systemText && { systemInstruction: { parts: [{ text: systemText }] } }),
        generationConfig: { maxOutputTokens: 256, temperature: 0.3 },
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    return {
        choices: [{
            message: { role: 'assistant', content: data.candidates?.[0]?.content?.parts?.[0]?.text || '' },
        }],
        model,
        usage: data.usageMetadata || {},
    };
}

/** Read SSE stream and return concatenated content */
async function readSSEStream(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '', model = '', tokenCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                    const chunk = JSON.parse(data);
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) { content += delta.content; tokenCount++; }
                    if (chunk.model) model = chunk.model;
                } catch { /* skip */ }
            }
        }
    }
    return { content, model, tokenCount };
}

// ─── Test Cases ──────────────────────────────────────────────────────────────

const SIMPLE_PROMPT = [
    { role: 'user', content: 'Reply with exactly one word: "hello"' },
];

const JSON_PROMPT = [
    { role: 'system', content: 'You are a helpful assistant that responds only in valid JSON.' },
    {
        role: 'user',
        content: 'Classify this: "A person is at the front door at 2am". Respond with ONLY valid JSON: {"category": "...", "severity": "low|medium|high", "action": "..."}',
    },
];

// ─── Test Runner ─────────────────────────────────────────────────────────────

const results = [];
const TEMP_RESTRICTED = ['kimi-k2.5', 'kimi-k2', 'nemotron'];

async function testProvider(providerId, config) {
    const registryEntry = CLOUD_PROVIDERS[providerId];
    const format = registryEntry?.api?.format || 'openai-compatible';
    const baseUrl = config.baseUrl || registryEntry?.api?.baseUrl || '';
    const apiKey = config.apiKey || '';
    const model = config.defaultModel || registryEntry?.defaults?.llm || '';
    const skipTemp = TEMP_RESTRICTED.some(m => model.includes(m));
    const label = registryEntry?.label || providerId;

    const providerResult = { id: providerId, label, model, baseUrl, format, tests: {}, time: 0 };

    log(`\n${'─'.repeat(60)}`);
    log(`  ${registryEntry?.icon || '🔌'} ${label}  (${model})`);
    log(`  ${baseUrl}`);
    log(`${'─'.repeat(60)}`);
    emit({ event: 'suite_start', suite: label });

    const startTime = Date.now();
    let suitePass = 0, suiteFail = 0;

    // ── Test 1: Simple Chat ──────────────────────────────────────────────
    try {
        const t0 = Date.now();
        let response;
        if (format === 'anthropic') {
            response = await anthropicChat(baseUrl, apiKey, model, SIMPLE_PROMPT);
        } else if (format === 'gemini') {
            response = await geminiChat(baseUrl, apiKey, model, SIMPLE_PROMPT);
        } else {
            response = await openaiChat(ensureVersionPath(baseUrl), apiKey, model, SIMPLE_PROMPT, false, { skipTemperature: skipTemp });
        }
        const content = response.choices?.[0]?.message?.content || '';
        const elapsed = Date.now() - t0;
        const hasHello = content.toLowerCase().includes('hello');
        if (VERBOSE) log(`    Response: "${content.slice(0, 200)}"`);
        log(`  ✅ Chat:     ${elapsed}ms — ${hasHello ? 'correct' : `unexpected: "${content.slice(0, 40)}"`} (${response.model || model})`);
        providerResult.tests.chat = { pass: true, ms: elapsed };
        emit({ event: 'test_result', suite: label, test: 'chat', status: 'pass', timeMs: elapsed });
        suitePass++;
    } catch (err) {
        const elapsed = Date.now() - startTime;
        log(`  ❌ Chat:     ${elapsed}ms — ${err.message.slice(0, 120)}`);
        providerResult.tests.chat = { pass: false, ms: elapsed, error: err.message };
        emit({ event: 'test_result', suite: label, test: 'chat', status: 'fail', timeMs: elapsed, detail: err.message.slice(0, 200) });
        suiteFail++;
    }

    // ── Test 2: JSON Output ──────────────────────────────────────────────
    if (!SKIP_JSON) {
        try {
            const t0 = Date.now();
            let response;
            if (format === 'anthropic') {
                response = await anthropicChat(baseUrl, apiKey, model, JSON_PROMPT);
            } else if (format === 'gemini') {
                response = await geminiChat(baseUrl, apiKey, model, JSON_PROMPT);
            } else {
                response = await openaiChat(ensureVersionPath(baseUrl), apiKey, model, JSON_PROMPT, false, { skipTemperature: skipTemp });
            }
            const content = response.choices?.[0]?.message?.content || '';
            const elapsed = Date.now() - t0;
            let jsonStr = content.trim();
            jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
            const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (codeBlock) jsonStr = codeBlock[1];
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonStr = jsonMatch[0];
            const parsed = JSON.parse(jsonStr);
            const valid = 'category' in parsed && 'severity' in parsed;
            if (VERBOSE) log(`    JSON: ${JSON.stringify(parsed)}`);
            log(`  ✅ JSON:     ${elapsed}ms — ${valid ? 'valid structure' : `partial: ${Object.keys(parsed).join(', ')}`}`);
            providerResult.tests.json = { pass: true, ms: elapsed };
            emit({ event: 'test_result', suite: label, test: 'json', status: 'pass', timeMs: elapsed });
            suitePass++;
        } catch (err) {
            const elapsed = Date.now() - startTime;
            log(`  ❌ JSON:     ${elapsed}ms — ${err.message.slice(0, 120)}`);
            providerResult.tests.json = { pass: false, ms: elapsed, error: err.message };
            emit({ event: 'test_result', suite: label, test: 'json', status: 'fail', timeMs: elapsed, detail: err.message.slice(0, 200) });
            suiteFail++;
        }
    }

    // ── Test 3: Streaming ────────────────────────────────────────────────
    if (!SKIP_STREAM && format !== 'anthropic' && format !== 'gemini') {
        try {
            const t0 = Date.now();
            const streamResult = await openaiChat(ensureVersionPath(baseUrl), apiKey, model, SIMPLE_PROMPT, true, { skipTemperature: skipTemp });
            const elapsed = Date.now() - t0;
            if (streamResult.tokenCount > 0) {
                log(`  ✅ Stream:   ${elapsed}ms — ${streamResult.tokenCount} chunks`);
                providerResult.tests.stream = { pass: true, ms: elapsed };
                emit({ event: 'test_result', suite: label, test: 'stream', status: 'pass', timeMs: elapsed });
                suitePass++;
            } else {
                log(`  ⚠️  Stream:   ${elapsed}ms — 0 chunks received`);
                providerResult.tests.stream = { pass: false, ms: elapsed, error: 'No chunks' };
                emit({ event: 'test_result', suite: label, test: 'stream', status: 'fail', timeMs: elapsed, detail: 'No chunks' });
                suiteFail++;
            }
        } catch (err) {
            const elapsed = Date.now() - startTime;
            log(`  ❌ Stream:   ${elapsed}ms — ${err.message.slice(0, 120)}`);
            providerResult.tests.stream = { pass: false, ms: elapsed, error: err.message };
            emit({ event: 'test_result', suite: label, test: 'stream', status: 'fail', timeMs: elapsed, detail: err.message.slice(0, 200) });
            suiteFail++;
        }
    }

    providerResult.time = Date.now() - startTime;
    results.push(providerResult);
    emit({ event: 'suite_end', suite: label, passed: suitePass, failed: suiteFail });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log('');
    log('╔══════════════════════════════════════════════════════════════╗');
    log('║   Cloud Provider Regression Test  •  Aegis-AI               ║');
    log('╚══════════════════════════════════════════════════════════════╝');
    log(`  Config:   ${LLM_CONFIG_PATH}`);
    log(`  Time:     ${new Date().toLocaleString()}`);
    log(`  Timeout:  ${TIMEOUT_MS}ms`);
    if (IS_SKILL) log(`  Mode:     Aegis Skill (${SKILL_ID})`);

    const providers = llmConfig.providers || {};

    // Build test list
    const testList = [];
    for (const [id, config] of Object.entries(providers)) {
        if (['builtin', 'ollama', 'openai-compatible', 'bedrock'].includes(id)) continue;
        if (!config.enabled) continue;
        if (!config.apiKey) continue;
        if (FILTER_IDS && !FILTER_IDS.includes(id)) continue;
        testList.push({ id, config });
    }

    if (testList.length === 0) {
        log('\n  ⚠️  No enabled providers with API keys found.');
        if (FILTER_IDS) log(`     Filter: ${FILTER_IDS.join(', ')}`);
        if (IS_SKILL) emit({ event: 'error', message: 'No enabled providers with API keys found' });
        process.exit(1);
    }

    log(`  Providers: ${testList.map(t => t.id).join(', ')} (${testList.length} total)`);
    emit({ event: 'ready', providers: testList.length });

    // Run tests
    for (const { id, config } of testList) {
        await testProvider(id, config);
    }

    // ── Summary ──────────────────────────────────────────────────────────
    let totalPass = 0, totalFail = 0;
    for (const r of results) {
        for (const t of Object.values(r.tests)) {
            if (t.pass) totalPass++; else totalFail++;
        }
    }

    log(`\n${'═'.repeat(76)}`);
    log('  RESULTS SUMMARY');
    log(`${'═'.repeat(76)}`);
    log(`  ${'Provider'.padEnd(14)} ${'Model'.padEnd(30)} ${'Chat'.padEnd(8)} ${'JSON'.padEnd(8)} ${'Stream'.padEnd(8)} ${'Time'.padEnd(8)}`);
    log(`  ${'─'.repeat(72)}`);
    for (const r of results) {
        const chat = r.tests.chat?.pass ? '✅' : '❌';
        const json = r.tests.json ? (r.tests.json.pass ? '✅' : '❌') : '⏭️';
        const stream = r.tests.stream ? (r.tests.stream.pass ? '✅' : '❌') : '⏭️';
        const modelShort = r.model.length > 28 ? r.model.slice(0, 26) + '..' : r.model;
        log(`  ${r.label.padEnd(14)} ${modelShort.padEnd(30)} ${chat.padEnd(6)}   ${json.padEnd(6)}   ${stream.padEnd(6)}   ${(r.time + 'ms').padEnd(8)}`);
    }
    log(`  ${'─'.repeat(72)}`);
    log(`  Total: ${totalPass} passed, ${totalFail} failed (${results.length} providers)`);
    log(`${'═'.repeat(76)}\n`);

    // Save results
    const resultsDir = path.join(os.homedir(), '.aegis-ai', 'regression-tests');
    fs.mkdirSync(resultsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultFile = path.join(resultsDir, `cloud-providers_${ts}.json`);
    fs.writeFileSync(resultFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        config: LLM_CONFIG_PATH,
        results,
        summary: { passed: totalPass, failed: totalFail, providers: results.length },
    }, null, 2));
    log(`  Results saved: ${resultFile}\n`);

    const totalMs = results.reduce((s, r) => s + r.time, 0);
    emit({ event: 'complete', passed: totalPass, failed: totalFail, total: totalPass + totalFail, timeMs: totalMs });

    process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
    log(`\nFatal: ${err.message}`);
    if (IS_SKILL) emit({ event: 'error', message: err.message });
    process.exit(1);
});
