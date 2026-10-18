#!/usr/bin/env node
/**
 * HomeSafe-Bench — Indoor Safety Hazard Detection Benchmark
 *
 * Evaluates VLM models on indoor home safety hazard detection across 5 categories:
 * - Fire/Smoke, Electrical, Trip/Fall, Child Safety, Falling Objects
 *
 * Inspired by HomeSafeBench (arXiv 2509.23690), adapted for static indoor cameras.
 *
 * ## Skill Protocol (when spawned by Aegis)
 *
 * Aegis → Skill (env vars):
 *   AEGIS_VLM_URL       — VLM server URL (e.g. http://localhost:5405)
 *   AEGIS_SKILL_PARAMS  — JSON params from skill config
 *   AEGIS_SKILL_ID      — Skill ID
 *
 * Skill → Aegis (stdout, JSON lines):
 *   {"event": "ready", "vlm": "SmolVLM-500M"}
 *   {"event": "suite_start", "suite": "🔥 Fire / Smoke"}
 *   {"event": "test_result", "suite": "...", "test": "...", "status": "pass", "timeMs": 4500}
 *   {"event": "suite_end", "suite": "...", "passed": 7, "failed": 1}
 *   {"event": "complete", "passed": 36, "total": 40, "timeMs": 180000}
 *
 * Standalone usage:
 *   node run-benchmark.cjs [options]
 *   --vlm URL        VLM server (required)
 *   --mode MODE      full or quick (default: full)
 *   --out DIR        Results directory
 *   --no-open        Don't auto-open report
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ─── Config: Aegis env vars → CLI args → defaults ────────────────────────────

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return defaultVal;
    return args[idx + 1] || defaultVal;
}

// ─── Help ─────────────────────────────────────────────────────────────────────
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
HomeSafe-Bench — Indoor Safety Hazard Detection Benchmark • DeepCamera / SharpAI

Inspired by HomeSafeBench (arXiv 2509.23690)

Usage: node scripts/run-benchmark.cjs [options]

Options:
  --vlm URL         VLM server base URL          (required)
  --mode MODE       full or quick                 (default: full)
  --out DIR         Results output directory       (default: ~/.aegis-ai/homesafe-benchmarks)
  --no-open         Don't auto-open report in browser
  -h, --help        Show this help message

Environment Variables (set by Aegis):
  AEGIS_VLM_URL       VLM server base URL
  AEGIS_SKILL_ID      Skill identifier (enables skill mode)
  AEGIS_SKILL_PARAMS  JSON params from skill config

Categories: Fire/Smoke, Electrical, Trip/Fall, Child Safety, Falling Objects
    `.trim());
    process.exit(0);
}

// Parse skill parameters if running as Aegis skill
let skillParams = {};
try { skillParams = JSON.parse(process.env.AEGIS_SKILL_PARAMS || '{}'); } catch { }

const VLM_URL = process.env.AEGIS_VLM_URL || getArg('vlm', '');
const VLM_MODEL = process.env.AEGIS_VLM_MODEL || '';
const RESULTS_DIR = getArg('out', path.join(os.homedir(), '.aegis-ai', 'homesafe-benchmarks'));
const IS_SKILL_MODE = !!process.env.AEGIS_SKILL_ID;
const NO_OPEN = args.includes('--no-open') || skillParams.noOpen || false;
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const FRAMES_DIR = path.join(FIXTURES_DIR, 'frames');
const IDLE_TIMEOUT_MS = 120000; // 2 minutes — safety scenarios may need more analysis

// Mode (full = 40 tests, quick = 10 tests — 2 per category)
const TEST_MODE = skillParams.mode || getArg('mode', 'full');

// ─── OpenAI SDK Client ──────────────────────────────────────────────────────
const OpenAI = require('openai');

const strip = (u) => u.replace(/\/v1\/?$/, '');
const vlmClient = VLM_URL ? new OpenAI({
    apiKey: 'not-needed',
    baseURL: `${strip(VLM_URL)}/v1`,
}) : null;

// ─── Skill Protocol: JSON lines on stdout, human text on stderr ──────────────

function emit(event) {
    process.stdout.write(JSON.stringify(event) + '\n');
}

function log(msg) {
    process.stderr.write(msg + '\n');
}

// ─── Test Framework ───────────────────────────────────────────────────────────

const suites = [];
let currentSuite = null;

function suite(name, fn) {
    suites.push({ name, fn, tests: [] });
}

const results = {
    timestamp: new Date().toISOString(),
    vlm: VLM_URL || null,
    system: {},
    model: {},
    suites: [],
    totals: { passed: 0, failed: 0, skipped: 0, total: 0, timeMs: 0 },
    tokenTotals: { prompt: 0, completion: 0, total: 0 },
};

async function vlmCall(messages, opts = {}) {
    if (!vlmClient) {
        throw new Error('VLM client not configured — pass --vlm URL');
    }

    const model = opts.model || VLM_MODEL || undefined;

    const params = {
        messages,
        stream: true,
        ...(model && { model }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        max_completion_tokens: opts.maxTokens || 512,
    };

    const controller = new AbortController();
    const idleMs = opts.timeout || IDLE_TIMEOUT_MS;
    let idleTimer = setTimeout(() => controller.abort(), idleMs);
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), idleMs); };

    try {
        const stream = await vlmClient.chat.completions.create(params, {
            signal: controller.signal,
        });

        let content = '';
        let reasoningContent = '';
        let streamModel = '';
        let usage = {};
        let tokenCount = 0;

        for await (const chunk of stream) {
            resetIdle();
            if (chunk.model) streamModel = chunk.model;
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) content += delta.content;
            if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
            if (delta?.content || delta?.reasoning_content) {
                tokenCount++;
                if (tokenCount % 100 === 0) {
                    log(`    … ${tokenCount} tokens received`);
                }
            }
            if (chunk.usage) usage = chunk.usage;
        }

        if (!content && reasoningContent) {
            content = reasoningContent;
        }

        results.tokenTotals.prompt += usage.prompt_tokens || 0;
        results.tokenTotals.completion += usage.completion_tokens || 0;
        results.tokenTotals.total += usage.total_tokens || 0;

        if (!results.model.vlm && streamModel) results.model.vlm = streamModel;

        return { content, usage, model: streamModel };
    } finally {
        clearTimeout(idleTimer);
    }
}

function stripThink(text) {
    return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

async function runSuites() {
    for (const s of suites) {
        currentSuite = { name: s.name, tests: [], passed: 0, failed: 0, skipped: 0, timeMs: 0 };
        log(`\n${'─'.repeat(60)}`);
        log(`  ${s.name}`);
        log(`${'─'.repeat(60)}`);
        emit({ event: 'suite_start', suite: s.name });

        await s.fn();

        results.suites.push(currentSuite);
        results.totals.passed += currentSuite.passed;
        results.totals.failed += currentSuite.failed;
        results.totals.skipped += currentSuite.skipped;
        results.totals.total += currentSuite.tests.length;

        emit({ event: 'suite_end', suite: s.name, passed: currentSuite.passed, failed: currentSuite.failed, skipped: currentSuite.skipped, timeMs: currentSuite.timeMs });
    }
}

async function test(name, fn) {
    const testResult = { name, status: 'pass', timeMs: 0, detail: '', tokens: {} };
    const start = Date.now();
    try {
        const detail = await fn();
        testResult.timeMs = Date.now() - start;
        testResult.detail = detail || '';
        currentSuite.passed++;
        log(`  ✅ ${name} (${testResult.timeMs}ms)${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
        testResult.timeMs = Date.now() - start;
        testResult.status = 'fail';
        testResult.detail = err.message;
        currentSuite.failed++;
        log(`  ❌ ${name} (${testResult.timeMs}ms) — ${err.message}`);
    }
    currentSuite.timeMs += testResult.timeMs;
    currentSuite.tests.push(testResult);
    emit({ event: 'test_result', suite: currentSuite.name, test: name, status: testResult.status, timeMs: testResult.timeMs, detail: testResult.detail.slice(0, 120) });
}

function skip(name, reason) {
    currentSuite.skipped++;
    currentSuite.tests.push({ name, status: 'skip', timeMs: 0, detail: reason });
    log(`  ⏭️  ${name} — ${reason}`);
    emit({ event: 'test_result', suite: currentSuite.name, test: name, status: 'skip', timeMs: 0, detail: reason });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISK SPACE CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function checkDiskSpace(targetDir, requiredGB) {
    try {
        fs.mkdirSync(targetDir, { recursive: true });
        const dfOutput = execSync(`df -k "${targetDir}"`, { encoding: 'utf8' });
        const lines = dfOutput.trim().split('\n');
        if (lines.length >= 2) {
            const parts = lines[1].split(/\s+/);
            const availableKB = parseInt(parts[3], 10);
            if (!isNaN(availableKB)) {
                const availableGB = availableKB / (1024 * 1024);
                if (availableGB < requiredGB) {
                    log(`  ❌ Insufficient disk space`);
                    log(`     Required: ${requiredGB.toFixed(1)} GB`);
                    log(`     Available: ${availableGB.toFixed(1)} GB`);
                    log(`     Location: ${targetDir}`);
                    emit({ event: 'error', message: `Insufficient disk space: need ${requiredGB}GB, have ${availableGB.toFixed(1)}GB` });
                    process.exit(1);
                }
                log(`  💾 Disk: ${availableGB.toFixed(1)} GB available (need ${requiredGB} GB) ✓`);
                return availableGB;
            }
        }
    } catch (err) {
        log(`  ⚠️  Could not check disk space: ${err.message} — proceeding anyway`);
    }
    return -1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATASET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if upstream HomeSafeBench dataset is available for download.
 * When the academic dataset becomes publicly available, this function
 * will download it to ~/.aegis-ai/datasets/homesafe-bench/.
 *
 * Until then, the skill uses AI-generated fixture images from fixtures/frames/.
 */
function checkUpstreamDataset() {
    const datasetDir = path.join(os.homedir(), '.aegis-ai', 'datasets', 'homesafe-bench');
    const markerFile = path.join(datasetDir, '.downloaded');

    if (fs.existsSync(markerFile)) {
        log(`  📂 Upstream dataset cached at: ${datasetDir}`);
        return datasetDir;
    }

    // Upstream not available yet — use bundled AI-generated fixtures
    log(`  ℹ️  Upstream HomeSafeBench dataset not yet public (arXiv 2509.23690)`);
    log(`     Using bundled AI-generated fixture images`);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VLM EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

async function vlmAnalyze(framePath, prompt) {
    const imageData = fs.readFileSync(framePath);
    const base64 = imageData.toString('base64');
    const mimeType = framePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const r = await vlmCall([{
        role: 'user',
        content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: 'text', text: prompt },
        ],
    }], { maxTokens: 512 });

    return stripThink(r.content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function loadScenarios() {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'scenarios.json'), 'utf8'));

    // Group scenarios by category
    const byCategory = {};
    for (const cat of data.categories) {
        byCategory[cat.id] = {
            name: cat.name,
            emoji: cat.emoji,
            scenarios: [],
        };
    }

    for (const scenario of data.scenarios) {
        if (byCategory[scenario.category]) {
            byCategory[scenario.category].scenarios.push(scenario);
        }
    }

    // Apply quick mode — keep 2 per category
    if (TEST_MODE === 'quick') {
        for (const cat of Object.values(byCategory)) {
            cat.scenarios = cat.scenarios.slice(0, 2);
        }
    }

    return byCategory;
}

function buildSuites(byCategory) {
    for (const [catId, cat] of Object.entries(byCategory)) {
        if (cat.scenarios.length === 0) continue;

        suite(`${cat.emoji} ${cat.name}`, async () => {
            for (const scenario of cat.scenarios) {
                await test(scenario.name, async () => {
                    const framePath = path.join(FRAMES_DIR, scenario.file);

                    if (!fs.existsSync(framePath)) {
                        skip(scenario.name, `Frame missing: ${scenario.file}`);
                        throw new Error(`Frame file not found: ${scenario.file}`);
                    }

                    const desc = await vlmAnalyze(framePath, scenario.prompt);
                    const lower = desc.toLowerCase();
                    const matched = scenario.expectedKeywords.some(kw => lower.includes(kw.toLowerCase()));

                    assert(matched,
                        `Expected one of [${scenario.expectedKeywords.slice(0, 4).join(', ')}...] in: "${desc.slice(0, 80)}"`);

                    const hits = scenario.expectedKeywords.filter(kw => lower.includes(kw.toLowerCase()));
                    return `${desc.length} chars, matched: ${hits.join(', ')} ✓`;
                });
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    log('');
    log('  ╔══════════════════════════════════════════════════════════════╗');
    log('  ║  HomeSafe-Bench — Indoor Safety Hazard Detection Benchmark  ║');
    log('  ║  Inspired by HomeSafeBench (arXiv 2509.23690)               ║');
    log('  ╚══════════════════════════════════════════════════════════════╝');
    log('');

    // Check VLM
    if (!VLM_URL) {
        log('  ❌ VLM server URL required. Pass --vlm http://localhost:5405');
        log('     This is a VLM-only benchmark (indoor safety image analysis).');
        emit({ event: 'error', message: 'VLM server URL required' });
        process.exit(1);
    }

    // Disk space check (minimal — bundled frames are <50MB, dataset download ~20GB when available)
    checkDiskSpace(RESULTS_DIR, 0.1);

    // Check for upstream dataset (will use bundled fixtures if not available)
    checkUpstreamDataset();

    // System info
    results.system = {
        platform: `${os.platform()} ${os.arch()}`,
        cpus: os.cpus()[0]?.model || 'unknown',
        totalRAM_GB: (os.totalmem() / 1073741824).toFixed(1),
        node: process.version,
    };

    log(`  VLM:      ${VLM_URL}`);
    log(`  Mode:     ${TEST_MODE} (${TEST_MODE === 'quick' ? '10' : '40'} tests)`);
    log(`  Frames:   ${FRAMES_DIR}`);
    log(`  Results:  ${RESULTS_DIR}`);
    log(`  System:   ${results.system.cpus} (${results.system.totalRAM_GB} GB RAM)`);

    // VLM healthcheck
    try {
        const ping = await vlmCall([
            { role: 'user', content: 'ping' },
        ], { maxTokens: 5, timeout: 10000 });
        results.model.vlm = ping.model || 'unknown';
        log(`  VLM Model: ${results.model.vlm}`);
    } catch (err) {
        log(`\n  ❌ Cannot reach VLM endpoint: ${err.message}`);
        log(`     URL: ${VLM_URL}`);
        log('     Check that the VLM server is running.\n');
        emit({ event: 'error', message: `Cannot reach VLM endpoint: ${err.message}` });
        process.exit(1);
    }

    // Emit ready event
    emit({
        event: 'ready',
        vlm: results.model.vlm,
        system: results.system.cpus,
        mode: TEST_MODE,
    });

    // Check that fixture frames exist
    if (!fs.existsSync(FRAMES_DIR)) {
        log(`\n  ❌ Frames directory not found: ${FRAMES_DIR}`);
        log('     Run the image generation step first.');
        emit({ event: 'error', message: 'Frames directory not found' });
        process.exit(1);
    }

    const frameCount = fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.png')).length;
    log(`  Frames:   ${frameCount} PNG files loaded`);

    // Load scenarios and build test suites
    const byCategory = loadScenarios();
    const totalTests = Object.values(byCategory).reduce((n, cat) => n + cat.scenarios.length, 0);
    log(`\n  📊 ${totalTests} tests across ${Object.keys(byCategory).length} categories\n`);

    buildSuites(byCategory);

    // Run all suites
    const suiteStart = Date.now();
    await runSuites();
    results.totals.timeMs = Date.now() - suiteStart;

    // Summary
    const { passed, failed, skipped, total, timeMs } = results.totals;
    const tokPerSec = timeMs > 0 ? ((results.tokenTotals.total / (timeMs / 1000)).toFixed(1)) : '?';

    log(`\n${'═'.repeat(66)}`);
    log(`  RESULTS:  ${passed}/${total} passed, ${failed} failed, ${skipped} skipped (${(timeMs / 1000).toFixed(1)}s)`);
    log(`  TOKENS:   ${results.tokenTotals.total} total (${tokPerSec} tok/s)`);
    log(`  MODEL:    ${results.model.vlm || 'unknown'}`);

    // Compare with academic benchmark
    log(`\n  📝 Academic reference (HomeSafeBench, best model):`);
    log(`     F1-score: 10.23% — current VLMs struggle significantly with safety hazards`);
    log(`     Your score: ${total > 0 ? ((passed / total * 100).toFixed(1) + '%') : 'N/A'} pass rate`);
    log(`${'═'.repeat(66)}`);

    if (failed > 0) {
        log('\n  Failures:');
        for (const s of results.suites) {
            for (const t of s.tests) {
                if (t.status === 'fail') log(`    ❌ ${s.name} > ${t.name}: ${t.detail}`);
            }
        }
    }

    // Save results
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const modelSlug = (results.model.vlm || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultFile = path.join(RESULTS_DIR, `${modelSlug}_${ts}.json`);
    fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
    log(`\n  Results saved: ${resultFile}`);

    // Update index
    const indexFile = path.join(RESULTS_DIR, 'index.json');
    let index = [];
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { }
    index.push({
        file: path.basename(resultFile),
        model: results.model.vlm || 'unknown',
        timestamp: results.timestamp,
        passed, failed, total,
        passRate: total > 0 ? passed / total : 0,
        timeMs,
        tokens: results.tokenTotals.total,
    });
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    // Emit completion
    emit({
        event: 'complete',
        model: results.model.vlm,
        passed, failed, skipped, total,
        timeMs,
        passRate: total > 0 ? passed / total : 0,
        tokens: results.tokenTotals.total,
        tokPerSec: parseFloat(tokPerSec) || 0,
        resultFile,
    });

    log('');
    process.exit(failed > 0 ? 1 : 0);
}

// Run when executed directly
const isDirectRun = require.main === module ||
    (process.argv[1] && require('path').resolve(process.argv[1]) === __filename);

if (isDirectRun) {
    main().catch(err => {
        log(`Fatal: ${err.message}`);
        emit({ event: 'error', message: err.message });
        process.exit(1);
    });
}

module.exports = { main };
