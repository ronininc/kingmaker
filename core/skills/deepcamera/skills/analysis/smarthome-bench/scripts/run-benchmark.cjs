#!/usr/bin/env node
/**
 * SmartHome-Bench — Video Anomaly Detection Benchmark
 * 
 * Evaluates VLM models on video anomaly detection across 7 smart home categories:
 * - Wildlife, Senior Care, Baby Monitoring, Pet Monitoring,
 *   Home Security, Package Delivery, General Activity
 * 
 * Based on SmartHome-Bench (https://github.com/Xinyi-0724/SmartHome-Bench-LLM)
 * 
 * ## Skill Protocol (when spawned by Aegis)
 * 
 * Aegis → Skill (env vars):
 *   AEGIS_VLM_URL       — VLM server URL (e.g. http://localhost:5405)
 *   AEGIS_SKILL_PARAMS  — JSON params from skill config
 *   AEGIS_SKILL_ID      — Skill ID
 * 
 * Skill → Aegis (stdout, JSON lines):
 *   {"event": "ready", "model": "SmolVLM2-2.2B"}
 *   {"event": "suite_start", "suite": "Wildlife"}
 *   {"event": "test_result", "suite": "...", "test": "...", "status": "pass", "timeMs": 1234}
 *   {"event": "suite_end", "suite": "...", "passed": 12, "failed": 3}
 *   {"event": "complete", "passed": 78, "total": 105, "timeMs": 480000}
 * 
 * Standalone usage:
 *   node run-benchmark.cjs [options]
 *   --vlm URL        VLM server (required)
 *   --max-videos N   Max videos to evaluate (default: 50)
 *   --mode MODE      subset or full (default: subset)
 *   --categories L   Comma-separated category filter
 *   --skip-download  Use cached videos only
 *   --out DIR        Results directory
 *   --no-open        Don't auto-open report
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

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
SmartHome-Bench — Video Anomaly Detection Benchmark • DeepCamera / SharpAI

Usage: node scripts/run-benchmark.cjs [options]

Options:
  --vlm URL         VLM server base URL          (required)
  --max-videos N    Max videos to evaluate        (default: 50)
  --mode MODE       subset or full                (default: subset)
  --categories L    Comma-separated filter         (default: all)
  --skip-download   Use cached videos only
  --out DIR         Results output directory       (default: ~/.aegis-ai/smarthome-bench)
  --no-open         Don't auto-open report in browser
  --report          Force report generation
  -h, --help        Show this help message

Environment Variables (set by Aegis):
  AEGIS_VLM_URL       VLM server base URL
  AEGIS_SKILL_ID      Skill identifier (enables skill mode)
  AEGIS_SKILL_PARAMS  JSON params from skill config

Categories: Wildlife, Senior Care, Baby Monitoring, Pet Monitoring,
            Home Security, Package Delivery, General Activity
    `.trim());
    process.exit(0);
}

// Parse skill parameters if running as Aegis skill
let skillParams = {};
try { skillParams = JSON.parse(process.env.AEGIS_SKILL_PARAMS || '{}'); } catch { }

const VLM_URL = process.env.AEGIS_VLM_URL || getArg('vlm', '');
const VLM_MODEL = process.env.AEGIS_VLM_MODEL || '';
const RESULTS_DIR = getArg('out', path.join(os.homedir(), '.aegis-ai', 'smarthome-bench'));
const VIDEO_CACHE_DIR = path.join(os.homedir(), '.aegis-ai', 'smarthome-bench', 'videos');
const FRAMES_DIR = path.join(os.homedir(), '.aegis-ai', 'smarthome-bench', 'frames');
const IS_SKILL_MODE = !!process.env.AEGIS_SKILL_ID;
const NO_OPEN = args.includes('--no-open') || skillParams.noOpen || false;
const SKIP_DOWNLOAD = args.includes('--skip-download');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const IDLE_TIMEOUT_MS = 60000; // VLM inference can be slow for multi-image

// Mode & limits
const TEST_MODE = skillParams.mode || getArg('mode', 'subset');
const MAX_VIDEOS = parseInt(skillParams.maxVideos || getArg('max-videos', '50'), 10) || 50;
const CATEGORIES_FILTER = (skillParams.categories || getArg('categories', 'all') || 'all').toLowerCase();
const FRAMES_PER_VIDEO = 6;

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
    metrics: {},
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
        let model = '';
        let usage = {};
        let tokenCount = 0;

        for await (const chunk of stream) {
            resetIdle();
            if (chunk.model) model = chunk.model;
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

        if (!results.model.vlm && model) results.model.vlm = model;

        return { content, usage, model };
    } finally {
        clearTimeout(idleTimer);
    }
}

function stripThink(text) {
    return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

function parseJSON(text) {
    const cleaned = stripThink(text);
    let jsonStr = cleaned;
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlock) jsonStr = codeBlock[1];
    else {
        const idx = cleaned.search(/[{[]/);
        if (idx > 0) jsonStr = cleaned.slice(idx);
    }
    return JSON.parse(jsonStr.trim());
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
        // Use df to check available space on the partition
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
    return -1; // unknown
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO ACQUISITION
// ═══════════════════════════════════════════════════════════════════════════════

function checkSystemDeps() {
    const deps = {};
    try {
        const ytVer = execSync('yt-dlp --version', { encoding: 'utf8' }).trim();
        deps.ytdlp = ytVer;
    } catch {
        deps.ytdlp = null;
    }
    try {
        const ffVer = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
        deps.ffmpeg = ffVer;
    } catch {
        deps.ffmpeg = null;
    }
    return deps;
}

function downloadVideo(annotation) {
    const videoFile = path.join(VIDEO_CACHE_DIR, `${annotation.id}.mp4`);

    // Already cached
    if (fs.existsSync(videoFile)) {
        return videoFile;
    }

    log(`    📥 Downloading ${annotation.id}...`);
    try {
        const result = spawnSync('yt-dlp', [
            '-f', 'best[height<=720][ext=mp4]/best[height<=720]/best',
            '--no-playlist',
            '--socket-timeout', '30',
            '--retries', '3',
            '-o', videoFile,
            annotation.youtube_url,
        ], {
            encoding: 'utf8',
            timeout: 120000, // 2 minute timeout per video
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (result.status !== 0) {
            throw new Error(result.stderr?.slice(-200) || 'yt-dlp failed');
        }

        if (!fs.existsSync(videoFile)) {
            // yt-dlp may append extension — find the file
            const files = fs.readdirSync(VIDEO_CACHE_DIR).filter(f => f.startsWith(annotation.id));
            if (files.length > 0) {
                const actual = path.join(VIDEO_CACHE_DIR, files[0]);
                if (actual !== videoFile) fs.renameSync(actual, videoFile);
            } else {
                throw new Error('Download completed but file not found');
            }
        }

        return videoFile;
    } catch (err) {
        log(`    ⚠️  Download failed for ${annotation.id}: ${err.message}`);
        return null;
    }
}

function extractFrames(videoFile, videoId) {
    const frameDir = path.join(FRAMES_DIR, videoId);

    // Check cache
    if (fs.existsSync(frameDir)) {
        const existing = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg'));
        if (existing.length >= FRAMES_PER_VIDEO) {
            return existing.sort().map(f => path.join(frameDir, f));
        }
    }

    fs.mkdirSync(frameDir, { recursive: true });

    try {
        // Get video duration
        const probeResult = spawnSync('ffmpeg', [
            '-i', videoFile,
            '-f', 'null', '-',
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });

        // Parse duration from ffmpeg stderr
        const durationMatch = (probeResult.stderr || '').match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
        let durationSec = 30; // default if parse fails
        if (durationMatch) {
            durationSec = parseInt(durationMatch[1]) * 3600 +
                parseInt(durationMatch[2]) * 60 +
                parseInt(durationMatch[3]) +
                parseInt(durationMatch[4]) / 100;
        }

        // Extract evenly-spaced frames
        const interval = Math.max(0.5, durationSec / (FRAMES_PER_VIDEO + 1));
        const framePaths = [];

        for (let i = 1; i <= FRAMES_PER_VIDEO; i++) {
            const timestamp = (interval * i).toFixed(2);
            const framePath = path.join(frameDir, `frame_${String(i).padStart(2, '0')}.jpg`);

            const extractResult = spawnSync('ffmpeg', [
                '-ss', timestamp,
                '-i', videoFile,
                '-frames:v', '1',
                '-q:v', '2',
                '-y',
                framePath,
            ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });

            if (extractResult.status === 0 && fs.existsSync(framePath)) {
                framePaths.push(framePath);
            }
        }

        if (framePaths.length === 0) {
            throw new Error('No frames extracted');
        }

        return framePaths;
    } catch (err) {
        log(`    ⚠️  Frame extraction failed for ${videoId}: ${err.message}`);
        return [];
    }
}

function framesToBase64(framePaths) {
    return framePaths.map(fp => {
        const data = fs.readFileSync(fp);
        return data.toString('base64');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VLM EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

const ANOMALY_DETECTION_PROMPT = `You are a smart home security camera AI analyst. You are evaluating video footage from a home camera.

You will be shown multiple frames sampled from a video clip captured by a smart home security camera.

## Task
Analyze the frames and determine whether the footage shows a NORMAL event or an ABNORMAL (anomalous) event.

## Anomaly Categories
- **Wildlife**: Unusual wild animal presence (bears, coyotes, snakes — NOT birds at feeder)
- **Senior Care**: Falls, wandering, inactivity, forgotten appliances
- **Baby Monitoring**: Unsupervised children near hazards, equipment failures
- **Pet Monitoring**: Escaped pets, property damage by pets, pet distress
- **Home Security**: Break-ins, theft attempts, trespassing, suspicious behavior
- **Package Delivery**: Package theft, misdelivery, rough handling
- **General Activity**: Unusual time activity, equipment malfunction, property damage

## Response Format
Respond with ONLY valid JSON (no markdown, no explanation):
{"result": 0, "reasoning": "brief 1-sentence explanation"}

Where:
- result: 0 = NORMAL (no anomaly), 1 = ABNORMAL (anomaly detected)
- reasoning: Brief explanation of your determination`;

async function evaluateClip(annotation, framePaths) {
    const base64Frames = framesToBase64(framePaths);

    // Build multi-image message content
    const imageContent = base64Frames.map((b64, i) => ({
        type: 'image_url',
        image_url: {
            url: `data:image/jpeg;base64,${b64}`,
            detail: 'low',
        },
    }));

    const messages = [
        { role: 'system', content: ANOMALY_DETECTION_PROMPT },
        {
            role: 'user',
            content: [
                { type: 'text', text: `Analyze these ${base64Frames.length} frames from a smart home camera video. Is there an anomaly?` },
                ...imageContent,
            ],
        },
    ];

    const response = await vlmCall(messages, {
        temperature: 0.1,
        maxTokens: 256,
    });

    return response;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function loadAnnotations() {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'annotations.json'), 'utf8'));

    // Apply category filter
    let filtered = raw;
    if (CATEGORIES_FILTER !== 'all') {
        const allowed = CATEGORIES_FILTER.split(',').map(c => c.trim().toLowerCase());
        filtered = raw.filter(a => allowed.some(c =>
            a.category.toLowerCase().includes(c) || c.includes(a.category.toLowerCase())
        ));
    }

    // Group by category
    const byCategory = {};
    for (const a of filtered) {
        const cat = a.category;
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(a);
    }

    // Apply max videos limit (distribute evenly across categories)
    if (TEST_MODE === 'subset' || MAX_VIDEOS < filtered.length) {
        const categories = Object.keys(byCategory);
        const perCategory = Math.max(2, Math.floor(MAX_VIDEOS / categories.length));
        for (const cat of categories) {
            if (byCategory[cat].length > perCategory) {
                // Keep balanced normal/abnormal
                const normal = byCategory[cat].filter(a => a.anomaly_tag === 0);
                const abnormal = byCategory[cat].filter(a => a.anomaly_tag === 1);
                const halfPer = Math.ceil(perCategory / 2);
                byCategory[cat] = [
                    ...normal.slice(0, halfPer),
                    ...abnormal.slice(0, halfPer),
                ].slice(0, perCategory);
            }
        }
    }

    return byCategory;
}

const CATEGORY_EMOJIS = {
    'Wildlife': '🦊',
    'Senior Care': '👴',
    'Baby Monitoring': '👶',
    'Pet Monitoring': '🐾',
    'Home Security': '🔒',
    'Package Delivery': '📦',
    'General Activity': '🏠',
};

function buildSuites(annotationsByCategory) {
    for (const [category, annotations] of Object.entries(annotationsByCategory)) {
        const emoji = CATEGORY_EMOJIS[category] || '📋';
        suite(`${emoji} ${category}`, async () => {
            for (const annotation of annotations) {
                const expectedTag = annotation.anomaly_tag;
                const expectedLabel = expectedTag === 0 ? 'Normal' : 'Abnormal';

                await test(`${annotation.id} → ${expectedLabel}`, async () => {
                    // Step 1: Download video
                    const videoFile = SKIP_DOWNLOAD
                        ? path.join(VIDEO_CACHE_DIR, `${annotation.id}.mp4`)
                        : downloadVideo(annotation);

                    if (!videoFile || !fs.existsSync(videoFile)) {
                        skip(annotation.id, 'Video not available');
                        throw new Error('Video download failed or not cached');
                    }

                    // Step 2: Extract frames
                    const framePaths = extractFrames(videoFile, annotation.id);
                    if (framePaths.length === 0) {
                        throw new Error('No frames extracted from video');
                    }

                    // Step 3: VLM evaluation
                    const response = await evaluateClip(annotation, framePaths);
                    const parsed = parseJSON(response.content);

                    // Step 4: Compare prediction vs ground truth
                    const predicted = parsed.result;
                    assert(predicted === 0 || predicted === 1, `Invalid result: ${predicted}`);
                    assert(predicted === expectedTag,
                        `Expected ${expectedLabel} (${expectedTag}), got ${predicted === 0 ? 'Normal' : 'Abnormal'} (${predicted}). VLM: "${(parsed.reasoning || '').slice(0, 80)}"`);

                    return `${predicted === 0 ? 'Normal' : 'Abnormal'} ✓ — "${(parsed.reasoning || '').slice(0, 60)}"`;
                });
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

function computeMetrics() {
    const perCategory = {};
    let totalTP = 0, totalFP = 0, totalTN = 0, totalFN = 0;

    for (const s of results.suites) {
        // Extract category name (remove emoji prefix)
        const catName = s.name.replace(/^[^\w]+\s*/, '').trim();
        let tp = 0, fp = 0, tn = 0, fn = 0;

        for (const t of s.tests) {
            // Parse expected from test name
            const isExpectedAbnormal = t.name.includes('Abnormal');
            const isExpectedNormal = t.name.includes('Normal');
            const passed = t.status === 'pass';

            if (isExpectedAbnormal && passed) tp++;          // Correctly detected anomaly
            else if (isExpectedNormal && passed) tn++;        // Correctly classified normal
            else if (isExpectedAbnormal && !passed) fn++;     // Missed anomaly
            else if (isExpectedNormal && !passed) fp++;       // False alarm
        }

        const accuracy = (tp + tn) / Math.max(1, tp + fp + tn + fn);
        const precision = tp / Math.max(1, tp + fp);
        const recall = tp / Math.max(1, tp + fn);
        const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

        perCategory[catName] = { tp, fp, tn, fn, accuracy, precision, recall, f1, total: tp + fp + tn + fn };
        totalTP += tp; totalFP += fp; totalTN += tn; totalFN += fn;
    }

    const overall = {
        tp: totalTP, fp: totalFP, tn: totalTN, fn: totalFN,
        accuracy: (totalTP + totalTN) / Math.max(1, totalTP + totalFP + totalTN + totalFN),
        precision: totalTP / Math.max(1, totalTP + totalFP),
        recall: totalTP / Math.max(1, totalTP + totalFN),
    };
    overall.f1 = overall.precision + overall.recall > 0
        ? 2 * (overall.precision * overall.recall) / (overall.precision + overall.recall) : 0;

    results.metrics = { perCategory, overall };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    log('');
    log('  ╔══════════════════════════════════════════════════════════════╗');
    log('  ║     SmartHome-Bench — Video Anomaly Detection Benchmark    ║');
    log('  ║     Based on SmartHome-Bench-LLM (1,203 videos, 7 cats)   ║');
    log('  ╚══════════════════════════════════════════════════════════════╝');
    log('');

    // Check VLM
    if (!VLM_URL) {
        log('  ❌ VLM server URL required. Pass --vlm http://localhost:5405');
        log('     This is a VLM-only benchmark (multi-frame video analysis).');
        process.exit(1);
    }

    // Check system deps
    const deps = checkSystemDeps();
    if (!SKIP_DOWNLOAD) {
        if (!deps.ytdlp) {
            log('  ❌ yt-dlp not found. Install: pip install yt-dlp');
            process.exit(1);
        }
    }
    if (!deps.ffmpeg) {
        log('  ❌ ffmpeg not found. Install: brew install ffmpeg');
        process.exit(1);
    }

    // System info
    results.system = {
        platform: `${os.platform()} ${os.arch()}`,
        cpus: os.cpus()[0]?.model || 'unknown',
        totalRAM_GB: (os.totalmem() / 1073741824).toFixed(1),
        node: process.version,
        deps,
    };

    log(`  VLM:      ${VLM_URL}`);
    log(`  Mode:     ${TEST_MODE} (max ${MAX_VIDEOS} videos)`);
    log(`  Filter:   ${CATEGORIES_FILTER}`);
    log(`  Cache:    ${VIDEO_CACHE_DIR}`);
    log(`  System:   ${results.system.cpus} (${results.system.totalRAM_GB} GB RAM)`);

    // Emit ready
    emit({
        event: 'ready',
        model: VLM_MODEL || 'unknown',
        system: results.system.cpus,
        totalVideos: MAX_VIDEOS,
    });

    // Disk space check — full needs ~15GB, subset ~2GB
    const requiredGB = TEST_MODE === 'full' ? 15 : 2;
    checkDiskSpace(VIDEO_CACHE_DIR, requiredGB);

    // Ensure cache dirs
    fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
    fs.mkdirSync(FRAMES_DIR, { recursive: true });

    // Load and build suites
    const annotationsByCategory = loadAnnotations();
    const totalClips = Object.values(annotationsByCategory).reduce((n, arr) => n + arr.length, 0);
    log(`\n  📊 Loaded ${totalClips} clips across ${Object.keys(annotationsByCategory).length} categories\n`);

    buildSuites(annotationsByCategory);

    // Run
    const suiteStart = Date.now();
    await runSuites();
    results.totals.timeMs = Date.now() - suiteStart;

    // Compute metrics
    computeMetrics();

    // Summary
    const { passed, failed, skipped, total, timeMs } = results.totals;
    const tokPerSec = timeMs > 0 ? ((results.tokenTotals.total / (timeMs / 1000)).toFixed(1)) : '?';
    const overallAcc = (results.metrics.overall?.accuracy * 100 || 0).toFixed(1);
    const overallF1 = (results.metrics.overall?.f1 * 100 || 0).toFixed(1);

    log(`\n${'═'.repeat(66)}`);
    log(`  RESULTS:  ${passed}/${total} passed, ${failed} failed, ${skipped} skipped (${(timeMs / 1000).toFixed(1)}s)`);
    log(`  ACCURACY: ${overallAcc}%  |  F1: ${overallF1}%`);
    log(`  TOKENS:   ${results.tokenTotals.total} total (${tokPerSec} tok/s)`);
    log(`  MODEL:    ${results.model.vlm || 'unknown'}`);
    log(`${'═'.repeat(66)}`);

    // Per-category breakdown
    if (results.metrics.perCategory) {
        log('\n  Per-Category Breakdown:');
        log(`  ${'Category'.padEnd(22)} ${'Acc'.padStart(6)} ${'Prec'.padStart(6)} ${'Rec'.padStart(6)} ${'F1'.padStart(6)} ${'TP'.padStart(4)} ${'FP'.padStart(4)} ${'TN'.padStart(4)} ${'FN'.padStart(4)}`);
        log(`  ${'─'.repeat(72)}`);
        for (const [cat, m] of Object.entries(results.metrics.perCategory)) {
            log(`  ${cat.padEnd(22)} ${(m.accuracy * 100).toFixed(1).padStart(5)}% ${(m.precision * 100).toFixed(1).padStart(5)}% ${(m.recall * 100).toFixed(1).padStart(5)}% ${(m.f1 * 100).toFixed(1).padStart(5)}% ${String(m.tp).padStart(4)} ${String(m.fp).padStart(4)} ${String(m.tn).padStart(4)} ${String(m.fn).padStart(4)}`);
        }
    }

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
        accuracy: results.metrics.overall?.accuracy || 0,
        f1: results.metrics.overall?.f1 || 0,
        timeMs,
        tokens: results.tokenTotals.total,
    });
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    // Generate report
    let reportPath = null;
    log('\n  Generating HTML report...');
    try {
        const reportScript = path.join(__dirname, 'generate-report.cjs');
        reportPath = require(reportScript).generateReport(RESULTS_DIR);
        log(`  ✅ Report: ${reportPath}`);

        if (!NO_OPEN && !IS_SKILL_MODE && reportPath) {
            try {
                const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
                execSync(`${openCmd} "${reportPath}"`, { stdio: 'ignore' });
                log(`  📂 Opened in browser`);
            } catch {
                log(`  ℹ️  Open manually: ${reportPath}`);
            }
        }
    } catch (err) {
        log(`  ⚠️  Report generation failed: ${err.message}`);
    }

    // Emit completion
    emit({
        event: 'complete',
        model: results.model.vlm,
        passed, failed, skipped, total,
        timeMs,
        accuracy: results.metrics.overall?.accuracy || 0,
        f1: results.metrics.overall?.f1 || 0,
        tokens: results.tokenTotals.total,
        tokPerSec: parseFloat(tokPerSec) || 0,
        resultFile,
        reportPath,
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
