#!/usr/bin/env node
/**
 * HomeSec-Bench Operations Center — Report Generator
 * 
 * Generates a self-contained HTML dashboard with three views:
 *   ⚡ Performance — TTFT, decode tok/s, server metrics, trend charts
 *   ✅ Quality    — Suite pass/fail, test details, comparison tables
 *   🖼️ Vision     — VLM image grid with pass/fail overlays and model responses
 * 
 * Features:
 *   - Run picker sidebar with model-grouped history + multi-select
 *   - Side-by-side comparison tables across selected runs
 *   - Export to Markdown for community sharing
 *   - Embeds all data into a single offline-capable HTML file
 * 
 * Usage:
 *   node generate-report.cjs [results-dir]
 *   Default: ~/.aegis-ai/benchmarks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const RESULTS_DIR = process.argv[2] || path.join(os.homedir(), '.aegis-ai', 'benchmarks');

// ─── Fixture image directory (for Vision tab) ──────────────────────────────────
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'frames');

/**
 * Generate the report HTML.
 * @param {string} resultsDir - Directory containing benchmark results
 * @param {object} opts - Options
 * @param {boolean} opts.liveMode - If true, adds auto-refresh (5s) and a live progress banner
 * @param {object} opts.liveStatus - Live status info: { suitesCompleted, totalSuites, currentSuite, startedAt }
 */
function generateReport(resultsDir = RESULTS_DIR, opts = {}) {
    const dir = resultsDir || RESULTS_DIR;
    const { liveMode = false, liveStatus = null } = opts;

    // Load index — gracefully handle missing/empty for live mode
    const indexFile = path.join(dir, 'index.json');
    let index = [];
    try {
        if (fs.existsSync(indexFile)) {
            index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        }
    } catch { }

    if (index.length === 0 && !liveMode) {
        console.error(`No benchmark results found in ${dir}. Run the benchmark first.`);
        process.exit(1);
    }

    // Load all result files with full data
    const allResults = index.map(entry => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'));
            return { ...entry, data };
        } catch { return { ...entry, data: null }; }
    }).filter(r => r.data);

    // Load fixture images for Vision tab (base64)
    // Skip in live mode — saves ~43MB of base64 per regeneration, making per-test updates instant
    const fixtureImages = {};
    if (!liveMode && fs.existsSync(FIXTURES_DIR)) {
        try {
            const frames = fs.readdirSync(FIXTURES_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
            for (const f of frames) {
                const imgPath = path.join(FIXTURES_DIR, f);
                const ext = f.split('.').pop().toLowerCase();
                const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
                const b64 = fs.readFileSync(imgPath).toString('base64');
                fixtureImages[f] = `data:${mime};base64,${b64}`;
            }
        } catch (e) {
            console.warn('  ⚠️  Could not load fixture images:', e.message);
        }
    }

    const html = buildHTML(allResults, fixtureImages, { liveMode, liveStatus });
    const reportPath = path.join(dir, 'report.html');
    fs.writeFileSync(reportPath, html);
    // Suppress log noise during live updates
    if (!liveMode) console.log(`  Report saved: ${reportPath}`);

    return reportPath;
}

function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHTML(allResults, fixtureImages, { liveMode = false, liveStatus = null } = {}) {
    // Serialize data for embedded JS
    const embeddedData = JSON.stringify(allResults.map(r => ({
        file: r.file,
        model: r.model,
        vlm: r.vlm || r.data?.model?.vlm || null,
        timestamp: r.timestamp || r.data?.timestamp,
        passed: r.passed,
        failed: r.failed,
        total: r.total,
        llmPassed: r.llmPassed,
        llmTotal: r.llmTotal,
        vlmPassed: r.vlmPassed,
        vlmTotal: r.vlmTotal,
        timeMs: r.timeMs,
        tokens: r.tokens || r.data?.tokenTotals?.total,
        perfSummary: r.perfSummary || r.data?.perfSummary || null,
        system: r.data?.system || {},
        serverParams: r.data?.serverParams || {},
        tokenTotals: r.data?.tokenTotals || {},
        suites: (r.data?.suites || []).map(s => ({
            name: s.name,
            passed: s.passed,
            failed: s.failed,
            skipped: s.skipped,
            timeMs: s.timeMs,
            tests: s.tests.map(t => ({
                name: t.name,
                status: t.status,
                timeMs: t.timeMs,
                detail: (t.detail || '').slice(0, 200),
                tokens: t.tokens || {},
                perf: t.perf || {},
                fixture: t.fixture || null,
                vlmResponse: t.vlmResponse || null,
                vlmPrompt: t.vlmPrompt || null,
            })),
        })),
    })));

    const fixtureJSON = JSON.stringify(fixtureImages);

    // Live mode: JS-based reload (stateful, preserves active tab + scroll)
    const refreshMeta = '';
    const liveBannerHTML = liveMode ? buildLiveBanner(liveStatus) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshMeta}
<title>HomeSec-Bench ${liveMode ? '🔴 LIVE' : 'Operations Center'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
    --bg: #0b1120; --bg2: #111827; --card: #1a2332; --card-hover: #1e293b;
    --border: #2a3548; --border-light: #334155;
    --text: #e2e8f0; --text-dim: #94a3b8; --text-muted: #64748b;
    --accent: #3b82f6; --accent-glow: rgba(59,130,246,0.15);
    --green: #22c55e; --green-dim: rgba(34,197,94,0.12);
    --red: #ef4444; --red-dim: rgba(239,68,68,0.10);
    --yellow: #f59e0b; --yellow-dim: rgba(245,158,11,0.12);
    --purple: #a855f7; --cyan: #06b6d4;
    --sidebar-w: 260px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; overflow-x: hidden; }

/* ─── Layout ─── */
.app { display: flex; min-height: 100vh; }
.sidebar {
    width: var(--sidebar-w); min-width: var(--sidebar-w); background: var(--bg2);
    border-right: 1px solid var(--border); padding: 1.25rem 0;
    overflow-y: auto; position: fixed; top: 0; left: 0; bottom: 0; z-index: 10;
}
.main { margin-left: var(--sidebar-w); flex: 1; min-width: 0; }
.header { padding: 1.25rem 2rem 0; }
.content { padding: 1.5rem 2rem 3rem; }

/* ─── Sidebar ─── */
.sidebar-title {
    font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-muted); padding: 0 1rem 0.75rem; display: flex; align-items: center; gap: 0.5rem;
}
.sidebar-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.model-group { margin-bottom: 0.75rem; }
.model-group-label {
    font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
    padding: 0.35rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.35rem;
    user-select: none;
}
.model-group-label:hover { color: var(--text); }
.model-group-label .arrow { font-size: 0.6rem; transition: transform 0.2s; }
.model-group.collapsed .arrow { transform: rotate(-90deg); }
.model-group.collapsed .run-list { display: none; }
.run-item {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 1rem 0.3rem 1.5rem;
    cursor: pointer; font-size: 0.78rem; color: var(--text-dim); transition: background 0.15s;
    border-left: 2px solid transparent;
}
.run-item:hover { background: var(--accent-glow); color: var(--text); }
.run-item.selected { background: var(--accent-glow); border-left-color: var(--accent); color: var(--text); }
.run-item.primary { font-weight: 600; }
.run-item input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; }
.run-meta { font-size: 0.68rem; color: var(--text-muted); }
.run-score { margin-left: auto; font-size: 0.72rem; font-weight: 600; }
.run-score.good { color: var(--green); }
.run-score.mid { color: var(--yellow); }
.run-score.bad { color: var(--red); }
.sidebar-actions { padding: 0.75rem 1rem; border-top: 1px solid var(--border); }
.btn {
    display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.45rem 0.85rem;
    border-radius: 6px; font-size: 0.78rem; font-weight: 500; cursor: pointer;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
    transition: all 0.15s;
}
.btn:hover { background: var(--card-hover); border-color: var(--accent); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
.btn-primary:hover { background: #2563eb; }
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.72rem; }
.btn-block { width: 100%; justify-content: center; }

/* ─── Tabs ─── */
.tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border);
    padding: 0 2rem;
}
.tab {
    padding: 0.85rem 1.25rem; font-size: 0.85rem; font-weight: 500;
    color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent;
    transition: all 0.15s; user-select: none;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* ─── Hero Cards ─── */
.hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
.stat-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem 1.15rem; position: relative; overflow: hidden;
}
.stat-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, var(--accent), var(--cyan));
}
.stat-card .label { font-size: 0.7rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 0.3rem; }
.stat-card .value { font-size: 1.75rem; font-weight: 700; line-height: 1.1; }
.stat-card .sub { font-size: 0.78rem; color: var(--text-dim); margin-top: 0.2rem; }

/* ─── Tables ─── */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
th, td { padding: 0.55rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
th { color: var(--text-muted); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
tr:hover td { background: rgba(255,255,255,0.02); }
.fail-row { background: var(--red-dim); }
.badge { display: inline-block; padding: 0.12rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: white; }
.bar-bg { background: var(--border); border-radius: 3px; height: 6px; width: 80px; display: inline-block; vertical-align: middle; }
.bar-fill { height: 6px; border-radius: 3px; display: block; }

/* ─── Charts ─── */
.chart-container { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; margin-bottom: 1.5rem; }
.chart-title { font-size: 0.82rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-dim); }
svg text { font-family: 'Inter', sans-serif; }

/* ─── Vision Grid ─── */
.vision-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
.vision-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; transition: transform 0.15s, box-shadow 0.15s;
}
.vision-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
.vision-card img { width: 100%; height: 160px; object-fit: cover; display: block; }
.vision-card .card-body { padding: 0.75rem 1rem; }
.vision-card .card-title { font-size: 0.82rem; font-weight: 600; margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem; }
.vision-card .card-response { font-size: 0.72rem; color: var(--text-dim); line-height: 1.4; max-height: 3.6em; overflow: hidden; }
.vision-card .card-prompt { font-size: 0.68rem; color: var(--text-muted); font-style: italic; margin-bottom: 0.25rem; }
.no-img { width: 100%; height: 160px; background: var(--bg2); display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 0.8rem; }

/* ─── Comparison ─── */
.compare-table th.model-col { min-width: 140px; }
.compare-table td.better { color: var(--green); font-weight: 600; }
.compare-table td.worse { color: var(--red); }

/* ─── Section ─── */
.section-title { font-size: 0.95rem; font-weight: 600; margin: 1.5rem 0 0.75rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--border); color: var(--text); }

/* ─── Export Toast ─── */
.toast {
    position: fixed; bottom: 2rem; right: 2rem; background: var(--green); color: white;
    padding: 0.65rem 1.25rem; border-radius: 8px; font-size: 0.82rem; font-weight: 500;
    opacity: 0; transform: translateY(10px); transition: all 0.3s;
    z-index: 999; pointer-events: none;
}
.toast.show { opacity: 1; transform: translateY(0); }

/* ─── Header ─── */
.page-title { font-size: 1.4rem; font-weight: 700; display: flex; align-items: center; gap: 0.6rem; }
.page-subtitle { color: var(--text-dim); font-size: 0.85rem; margin-top: 0.2rem; }

/* ─── Empty state ─── */
.empty-state { text-align: center; padding: 3rem; color: var(--text-muted); }
.empty-state .icon { font-size: 2.5rem; margin-bottom: 0.75rem; }

/* ─── Footer ─── */
footer { padding: 1.5rem 2rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.72rem; text-align: center; margin-left: var(--sidebar-w); }

/* ─── Live Banner ─── */
.live-banner {
    background: linear-gradient(90deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05));
    border-bottom: 1px solid rgba(239,68,68,0.3);
    padding: 0.6rem 2rem; font-size: 0.82rem;
    display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
    margin-left: var(--sidebar-w);
}
.live-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--red);
    animation: livePulse 1.5s ease-in-out infinite;
}
@keyframes livePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.live-progress { width: 100%; height: 3px; background: var(--border); border-radius: 2px; margin-top: 0.3rem; }
.live-progress-bar { height: 3px; background: var(--accent); border-radius: 2px; transition: width 0.3s; }

/* ─── Responsive ─── */
@media (max-width: 800px) {
    .sidebar { width: 200px; min-width: 200px; --sidebar-w: 200px; }
    .main { margin-left: 200px; }
    .hero-grid { grid-template-columns: 1fr 1fr; }
    .content { padding: 1rem; }
}
</style>
</head>
<body>
${liveBannerHTML}
<div class="app">

<!-- ─── Sidebar ─── -->
<aside class="sidebar" id="sidebar">
    <div style="padding: 0 1rem 1rem; border-bottom: 1px solid var(--border); margin-bottom: 0.75rem;">
        <div style="font-size: 0.95rem; font-weight: 700;">🛡️ HomeSec-Bench</div>
        <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.15rem;">Operations Center</div>
    </div>
    <div class="sidebar-title">Run History</div>
    <div id="run-list"></div>
    <div class="sidebar-actions">
        <button class="btn btn-primary btn-block" id="btn-compare" disabled>Compare Selected</button>
        <button class="btn btn-block" id="btn-export" style="margin-top: 0.4rem;">📋 Export Markdown</button>
    </div>
</aside>

<!-- ─── Main ─── -->
<div class="main">
    <div class="tabs">
        <div class="tab active" data-tab="performance">⚡ Performance</div>
        <div class="tab" data-tab="quality">✅ Quality</div>
        <div class="tab" data-tab="vision">🖼️ Vision</div>
    </div>

    <div class="content">
        <!-- ⚡ Performance Tab -->
        <div class="tab-panel active" id="tab-performance"></div>

        <!-- ✅ Quality Tab -->
        <div class="tab-panel" id="tab-quality"></div>

        <!-- 🖼️ Vision Tab -->
        <div class="tab-panel" id="tab-vision"></div>
    </div>

    <footer>
        Home Security AI Benchmark Suite • DeepCamera / SharpAI • Generated ${new Date().toISOString().slice(0, 19)}
    </footer>
</div>
</div>

<div class="toast" id="toast"></div>

<script>
// ═══════════════════════════════════════════════════════════════════════════════
// EMBEDDED DATA
// ═══════════════════════════════════════════════════════════════════════════════
const ALL_RUNS = ${embeddedData};
const FIXTURE_IMAGES = ${fixtureJSON};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════
let selectedIndices = new Set([ALL_RUNS.length - 1]); // Latest run selected by default
let primaryIndex = ALL_RUNS.length - 1;
let compareMode = false;

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
function fmt(n, d = 1) { return n != null ? Number(n).toFixed(d) : '—'; }
function fmtInt(n) { return n != null ? Math.round(n) : '—'; }
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function pct(a, b) { return b > 0 ? ((a / b) * 100).toFixed(0) : '—'; }
function scoreClass(passed, total) {
    const r = total > 0 ? passed / total : 0;
    return r >= 0.9 ? 'good' : r >= 0.6 ? 'mid' : 'bad';
}
function scoreColor(passed, total) {
    const r = total > 0 ? passed / total : 0;
    return r >= 0.9 ? 'var(--green)' : r >= 0.6 ? 'var(--yellow)' : 'var(--red)';
}
function shortDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function modelShort(name) {
    if (!name) return '?';
    return name.replace(/\\.gguf$/i, '').replace(/Qwen3\\.5-/i, 'Q3.5-');
}
function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function getSelected() { return [...selectedIndices].map(i => ALL_RUNS[i]).filter(Boolean); }
function getPrimary() { return ALL_RUNS[primaryIndex]; }

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR — RUN LIST
// ═══════════════════════════════════════════════════════════════════════════════
function buildSidebar() {
    const groups = {};
    ALL_RUNS.forEach((r, idx) => {
        // Group by model family (first two segments: e.g. "Qwen3.5-9B")
        const parts = (r.model || '?').replace(/\\.gguf$/i, '').split('-');
        const family = parts.slice(0, 2).join('-');
        if (!groups[family]) groups[family] = [];
        groups[family].push({ ...r, _idx: idx });
    });

    let html = '';
    for (const [family, runs] of Object.entries(groups)) {
        html += '<div class="model-group">';
        html += '<div class="model-group-label" onclick="this.parentElement.classList.toggle(&#39;collapsed&#39;)"><span class="arrow">▾</span> ' + esc(family) + ' <span style="color:var(--text-muted);font-weight:400">(' + runs.length + ')</span></div>';
        html += '<div class="run-list">';
        for (const r of runs.reverse()) {
            const sel = selectedIndices.has(r._idx);
            const isPrimary = r._idx === primaryIndex;
            const sc = scoreClass(r.passed, r.total);
            html += '<div class="run-item' + (sel ? ' selected' : '') + (isPrimary ? ' primary' : '') + '" data-idx="' + r._idx + '">';
            html += '<input type="checkbox"' + (sel ? ' checked' : '') + ' data-idx="' + r._idx + '">';
            html += '<div><div style="font-size:0.78rem">' + esc(modelShort(r.model)) + '</div>';
            html += '<div class="run-meta">' + shortDate(r.timestamp) + '</div></div>';
            html += '<span class="run-score ' + sc + '">' + r.passed + '/' + r.total + '</span>';
            html += '</div>';
        }
        html += '</div></div>';
    }
    document.getElementById('run-list').innerHTML = html;

    // Bind events
    document.querySelectorAll('.run-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            const idx = parseInt(el.dataset.idx);
            primaryIndex = idx;
            if (!selectedIndices.has(idx)) selectedIndices.add(idx);
            refresh();
        });
    });
    document.querySelectorAll('.run-item input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(cb.dataset.idx);
            if (cb.checked) selectedIndices.add(idx);
            else selectedIndices.delete(idx);
            if (selectedIndices.size === 0) { selectedIndices.add(primaryIndex); }
            refresh();
        });
    });
}

function updateCompareBtn() {
    const btn = document.getElementById('btn-compare');
    const n = selectedIndices.size;
    btn.textContent = n > 1 ? 'Comparing ' + n + ' Runs' : 'Select 2+ to Compare';
    btn.disabled = n < 2;
    compareMode = n > 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: PERFORMANCE
// ═══════════════════════════════════════════════════════════════════════════════
function renderPerformance() {
    const run = getPrimary();
    const perf = run.perfSummary;
    const sel = getSelected();

    let html = '<div class="header"><div class="page-title">⚡ Performance</div>';
    html += '<div class="page-subtitle">' + esc(run.model || '?') + ' — ' + shortDate(run.timestamp) + '</div></div>';

    if (run.serverParams && typeof run.serverParams === 'object' && Object.keys(run.serverParams).length > 0) {
        let paramStr = '';
        for (const k in run.serverParams) {
            if (paramStr) paramStr += ' | ';
            paramStr += '<b>' + esc(k) + '</b>: ' + esc(String(run.serverParams[k]));
        }
        html += '<div style="font-size:0.75rem; color:var(--text-dim); margin-left: 2rem; margin-top: 0.5rem; padding-bottom: 0.5rem;">[Server Params]  ' + paramStr + '</div>';
    }

    // Hero cards
    html += '<div class="hero-grid">';
    const ttftAvg = perf?.ttft?.avgMs;
    const ttftP50 = perf?.ttft?.p50Ms;
    const ttftP95 = perf?.ttft?.p95Ms;
    const decAvg = perf?.decode?.avgTokensPerSec;
    const srvPrefill = perf?.server?.prefillTokensPerSec;
    const srvDecode = perf?.server?.decodeTokensPerSec;
    const totalTime = run.timeMs;
    const tokPerSec = totalTime > 0 && run.tokens ? (run.tokens / (totalTime / 1000)).toFixed(1) : null;

    html += statCard('TTFT (avg)', fmtInt(ttftAvg), 'ms', ttftP50 != null ? 'p50: ' + fmtInt(ttftP50) + 'ms · p95: ' + fmtInt(ttftP95) + 'ms' : 'No data — run with --metrics');
    html += statCard('Decode Speed', fmt(decAvg), 'tok/s', 'Client-measured generation');
    html += statCard('Server Prefill', fmt(srvPrefill), 'tok/s', 'From llama-server /metrics');
    html += statCard('Server Decode', fmt(srvDecode), 'tok/s', 'From llama-server /metrics');
    html += statCard('Total Time', fmt(totalTime / 1000), 's', run.total + ' tests');
    html += statCard('Throughput', fmt(tokPerSec), 'tok/s', fmtK(run.tokens || 0) + ' total tokens');

    // GPU & Memory cards (from resource samples)
    const res = perf?.resource;
    if (res) {
        html += statCard('GPU Utilization', res.gpu ? res.gpu.util + '' : '—', '%', res.gpu ? 'Renderer: ' + res.gpu.renderer + '% · Tiler: ' + res.gpu.tiler + '%' : 'MPS not available');
        html += statCard('GPU Memory', res.gpu?.memUsedGB != null ? fmt(res.gpu.memUsedGB) : '—', 'GB', res.gpu?.memAllocGB != null ? 'Alloc: ' + fmt(res.gpu.memAllocGB) + ' GB' : 'MPS not available');
        html += statCard('System Memory', fmt(res.sys?.usedGB), 'GB', 'of ' + fmt(res.sys?.totalGB) + ' GB total · Free: ' + fmt(res.sys?.freeGB) + ' GB');
    }
    html += '</div>';

    // Comparison table if multiple selected
    if (sel.length > 1) {
        html += '<div class="section-title">Performance Comparison</div>';
        html += '<div class="table-wrap"><table class="compare-table"><thead><tr><th>Metric</th>';
        for (const r of sel) html += '<th class="model-col">' + esc(modelShort(r.model)) + '<br><span style="font-weight:400;font-size:0.68rem">' + shortDate(r.timestamp) + '</span></th>';
        html += '</tr></thead><tbody>';
        const metrics = [
            ['TTFT avg (ms)', r => fmtInt(r.perfSummary?.ttft?.avgMs)],
            ['TTFT p50 (ms)', r => fmtInt(r.perfSummary?.ttft?.p50Ms)],
            ['TTFT p95 (ms)', r => fmtInt(r.perfSummary?.ttft?.p95Ms)],
            ['Decode (tok/s)', r => fmt(r.perfSummary?.decode?.avgTokensPerSec)],
            ['Server Prefill (tok/s)', r => fmt(r.perfSummary?.server?.prefillTokensPerSec)],
            ['Server Decode (tok/s)', r => fmt(r.perfSummary?.server?.decodeTokensPerSec)],
            ['Total Time (s)', r => fmt(r.timeMs / 1000)],
            ['Total Tokens', r => fmtK(r.tokens || 0)],
        ];
        for (const [label, fn] of metrics) {
            html += '<tr><td style="font-weight:500">' + label + '</td>';
            const vals = sel.map(fn);
            for (const v of vals) html += '<td>' + v + '</td>';
            html += '</tr>';
        }
        html += '</tbody></table></div>';
    }

    // Trend chart: TTFT across all runs
    html += renderTrendChart('TTFT Trend (avg ms)', ALL_RUNS, r => r.perfSummary?.ttft?.avgMs, 'ms');
    html += renderTrendChart('Decode Speed Trend (tok/s)', ALL_RUNS, r => r.perfSummary?.decode?.avgTokensPerSec, 'tok/s');

    document.getElementById('tab-performance').innerHTML = html;
}

function statCard(label, value, unit, sub) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + value + ' <span style="font-size:0.9rem;font-weight:400;color:var(--text-dim)">' + (unit || '') + '</span></div><div class="sub">' + (sub || '') + '</div></div>';
}

function renderTrendChart(title, runs, accessor, unit) {
    const data = runs.map((r, i) => ({ x: i, y: accessor(r), label: modelShort(r.model) }));
    const valid = data.filter(d => d.y != null);
    if (valid.length < 2) return '';

    const W = 700, H = 180, PAD = 50, PADT = 25, PADR = 20;
    const maxY = Math.max(...valid.map(d => d.y)) * 1.15;
    const minY = 0;
    const xScale = (W - PAD - PADR) / (data.length - 1 || 1);
    const yScale = (H - PADT - 30) / (maxY - minY || 1);

    let pts = '';
    let dots = '';
    let first = true;
    for (const d of data) {
        if (d.y == null) continue;
        const cx = PAD + d.x * xScale;
        const cy = H - 30 - (d.y - minY) * yScale;
        pts += (first ? 'M' : 'L') + cx + ',' + cy;
        const isSel = selectedIndices.has(d.x);
        dots += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (isSel ? 4 : 2.5) + '" fill="' + (isSel ? 'var(--accent)' : 'var(--text-muted)') + '"/>';
        if (isSel) dots += '<text x="' + cx + '" y="' + (cy - 8) + '" text-anchor="middle" style="font-size:9px;fill:var(--text)">' + fmt(d.y) + '</text>';
        first = false;
    }

    // Y-axis labels
    let yLabels = '';
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
        const v = minY + (maxY - minY) * (i / steps);
        const y = H - 30 - (v - minY) * yScale;
        yLabels += '<text x="' + (PAD - 6) + '" y="' + (y + 3) + '" text-anchor="end" style="font-size:9px;fill:var(--text-muted)">' + fmtInt(v) + '</text>';
        yLabels += '<line x1="' + PAD + '" y1="' + y + '" x2="' + (W - PADR) + '" y2="' + y + '" stroke="var(--border)" stroke-dasharray="3,3"/>';
    }

    return '<div class="chart-container"><div class="chart-title">' + title + '</div>' +
        '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px">' +
        yLabels +
        '<path d="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>' +
        dots +
        '</svg></div>';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: QUALITY
// ═══════════════════════════════════════════════════════════════════════════════
function renderQuality() {
    const run = getPrimary();
    const sel = getSelected();
    const { suites } = run;
    const passRate = run.total > 0 ? ((run.passed / run.total) * 100).toFixed(0) : 0;

    let html = '<div class="header"><div class="page-title">✅ Quality</div>';
    html += '<div class="page-subtitle">' + esc(run.model || '?') + ' — ' + passRate + '% pass rate (' + run.passed + '/' + run.total + ')</div></div>';

    // Hero cards
    html += '<div class="hero-grid">';
    html += statCard('Pass Rate', passRate, '%', run.passed + '/' + run.total + ' tests');
    html += statCard('LLM Score', run.llmTotal > 0 ? pct(run.llmPassed, run.llmTotal) : '—', '%', (run.llmPassed || 0) + '/' + (run.llmTotal || 0));
    html += statCard('VLM Score', run.vlmTotal > 0 ? pct(run.vlmPassed, run.vlmTotal) : '—', '%', (run.vlmPassed || 0) + '/' + (run.vlmTotal || 0));
    html += statCard('Failed', String(run.failed), '', run.total + ' total tests');
    html += '</div>';

    // Multi-run comparison
    if (sel.length > 1) {
        // High-level summary comparison
        html += '<div class="section-title">Overall Comparison</div>';
        html += '<div class="table-wrap"><table class="compare-table"><thead><tr><th>Metric</th>';
        for (const r of sel) html += '<th class="model-col">' + esc(modelShort(r.model)) + '<br><span style="font-weight:400;font-size:0.68rem">' + shortDate(r.timestamp) + '</span></th>';
        html += '</tr></thead><tbody>';
        const hasVlm = sel.some(r => r.vlmTotal > 0);
        const hiRows = [
            ['Pass Rate', r => r.total > 0 ? pct(r.passed, r.total) + '%' : '—'],
            ['Score', r => r.passed + '/' + r.total],
            ['LLM Score', r => r.llmTotal > 0 ? (r.llmPassed || 0) + '/' + (r.llmTotal || 0) : '—'],
            ...(hasVlm ? [['VLM Score', r => r.vlmTotal > 0 ? (r.vlmPassed || 0) + '/' + (r.vlmTotal || 0) : '—']] : []),
            ['Failed', r => String(r.failed)],
            ['Time', r => fmt(r.timeMs / 1000) + 's'],
            ['Throughput', r => r.timeMs > 0 && r.tokens ? fmt(r.tokens / (r.timeMs / 1000)) + ' tok/s' : '—'],
        ];
        for (const [label, fn] of hiRows) {
            html += '<tr><td>' + label + '</td>';
            // Find best value for highlighting
            const vals = sel.map(fn);
            for (let i = 0; i < sel.length; i++) {
                const isBest = label === 'Failed' ? vals[i] === String(Math.min(...sel.map(r => r.failed))) :
                    label === 'Pass Rate' ? vals[i] === pct(Math.max(...sel.map(r => r.passed)), sel[0].total) + '%' : false;
                html += '<td' + (isBest && sel.length > 1 ? ' style="color:var(--green);font-weight:600"' : '') + '>' + vals[i] + '</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';

        // Per-suite breakdown
        html += '<div class="section-title">Suite Comparison</div>';
        html += '<div class="table-wrap"><table class="compare-table"><thead><tr><th>Suite</th>';
        for (const r of sel) html += '<th class="model-col">' + esc(modelShort(r.model)) + '</th>';
        html += '</tr></thead><tbody>';
        // Get union of all suite names
        const allSuiteNames = [...new Set(sel.flatMap(r => r.suites.map(s => s.name)))];
        for (const sname of allSuiteNames) {
            html += '<tr><td>' + esc(sname) + '</td>';
            for (const r of sel) {
                const s = r.suites.find(x => x.name === sname);
                if (s) {
                    const total = s.tests.length;
                    const color = scoreColor(s.passed, total);
                    html += '<td><span class="badge" style="background:' + color + '">' + s.passed + '/' + total + '</span></td>';
                } else {
                    html += '<td style="color:var(--text-muted)">—</td>';
                }
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
    }

    // Suite summary
    html += '<div class="section-title">Suite Summary</div>';
    html += '<div class="table-wrap"><table><thead><tr><th>Suite</th><th>Result</th><th>Time</th><th>Pass Rate</th></tr></thead><tbody>';
    for (const s of suites) {
        const total = s.tests.length;
        const pctV = total > 0 ? ((s.passed / total) * 100).toFixed(0) : 0;
        const color = scoreColor(s.passed, total);
        html += '<tr><td>' + esc(s.name) + '</td>';
        html += '<td><span class="badge" style="background:' + color + '">' + s.passed + '/' + total + '</span></td>';
        html += '<td>' + fmt(s.timeMs / 1000) + 's</td>';
        html += '<td><div class="bar-bg"><span class="bar-fill" style="width:' + pctV + '%;background:' + color + '"></span></div> ' + pctV + '%</td>';
        html += '</tr>';
    }
    html += '</tbody></table></div>';

    // Test details
    html += '<div class="section-title">Test Details</div>';
    html += '<div class="table-wrap"><table><thead><tr><th></th><th>Suite</th><th>Test</th><th>Time</th><th>Detail</th></tr></thead><tbody>';
    for (const s of suites) {
        for (const t of s.tests) {
            const icon = t.status === 'pass' ? '✅' : t.status === 'fail' ? '❌' : '⏭️';
            const cls = t.status === 'fail' ? ' class="fail-row"' : '';
            html += '<tr' + cls + '><td>' + icon + '</td>';
            html += '<td style="color:var(--text-muted);font-size:0.75rem">' + esc(s.name) + '</td>';
            html += '<td>' + esc(t.name) + '</td>';
            html += '<td>' + t.timeMs + 'ms</td>';
            html += '<td style="color:var(--text-dim);font-size:0.75rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.detail) + '</td>';
            html += '</tr>';
        }
    }
    html += '</tbody></table></div>';

    document.getElementById('tab-quality').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: VISION
// ═══════════════════════════════════════════════════════════════════════════════
function renderVision() {
    const run = getPrimary();
    const sel = getSelected();

    // Collect VLM tests (from all suites — VLM Scene Analysis + VLM-to-Alert Triage)
    const vlmTests = [];
    for (const s of run.suites) {
        for (const t of s.tests) {
            if (t.fixture) vlmTests.push({ ...t, suite: s.name });
        }
    }

    let html = '<div class="header"><div class="page-title">🖼️ Vision</div>';
    html += '<div class="page-subtitle">' + esc(run.model || '?') + ' — ' + vlmTests.length + ' VLM image tests</div></div>';

    if (vlmTests.length === 0) {
        html += '<div class="empty-state"><div class="icon">📷</div>';
        html += '<div>No VLM image test data in this run.</div>';
        html += '<div style="font-size:0.82rem;margin-top:0.5rem">Run the benchmark with <code>--vlm URL</code> to enable VLM scene analysis.</div></div>';
        document.getElementById('tab-vision').innerHTML = html;
        return;
    }

    // Multi-run comparison mode for vision
    if (sel.length > 1) {
        html += '<div class="section-title">VLM Comparison — ' + sel.length + ' Runs</div>';
        html += '<div class="table-wrap"><table><thead><tr><th>Image</th><th>Test</th>';
        for (const r of sel) html += '<th>' + esc(modelShort(r.model)) + '</th>';
        html += '</tr></thead><tbody>';
        for (const vt of vlmTests) {
            html += '<tr>';
            const imgSrc = vt.fixture && FIXTURE_IMAGES[vt.fixture];
            html += '<td>' + (imgSrc ? '<img src="' + imgSrc + '" style="width:60px;height:40px;object-fit:cover;border-radius:4px">' : '—') + '</td>';
            html += '<td style="font-size:0.78rem">' + esc(vt.name) + '</td>';
            for (const r of sel) {
                const match = r.suites.flatMap(s => s.tests).find(t => t.fixture === vt.fixture);
                if (match) {
                    const icon = match.status === 'pass' ? '✅' : '❌';
                    html += '<td>' + icon + ' <span style="font-size:0.7rem;color:var(--text-dim)">' + esc((match.vlmResponse || match.detail || '').slice(0, 60)) + '</span></td>';
                } else {
                    html += '<td style="color:var(--text-muted)">—</td>';
                }
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
    }

    // Image grid
    html += '<div class="section-title">Scene Analysis Results</div>';
    html += '<div class="vision-grid">';
    for (const t of vlmTests) {
        const imgSrc = t.fixture && FIXTURE_IMAGES[t.fixture];
        const statusBadge = t.status === 'pass'
            ? '<span class="badge" style="background:var(--green)">Pass</span>'
            : '<span class="badge" style="background:var(--red)">Fail</span>';
        html += '<div class="vision-card">';
        if (imgSrc) {
            html += '<img src="' + imgSrc + '" alt="' + esc(t.name) + '" loading="lazy">';
        } else {
            html += '<div class="no-img">🖼️ ' + esc(t.fixture || 'No image') + '</div>';
        }
        html += '<div class="card-body">';
        html += '<div class="card-title">' + statusBadge + ' ' + esc(t.name) + '</div>';
        if (t.vlmPrompt) html += '<div class="card-prompt">"' + esc(t.vlmPrompt.slice(0, 80)) + '"</div>';
        if (t.vlmResponse) {
            html += '<div class="card-response">' + esc(t.vlmResponse) + '</div>';
        } else if (t.detail) {
            html += '<div class="card-response">' + esc(t.detail) + '</div>';
        }
        html += '</div></div>';
    }
    html += '</div>';

    document.getElementById('tab-vision').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT MARKDOWN
// ═══════════════════════════════════════════════════════════════════════════════
function exportMarkdown() {
    const sel = getSelected();
    if (sel.length === 0) return;

    let md = '## HomeSec-Bench Results\\n\\n';

    if (sel.length === 1) {
        const r = sel[0];
        md += '**Model:** ' + (r.model || '?') + '\\n';
        md += '**Date:** ' + new Date(r.timestamp).toISOString().slice(0, 10) + '\\n\\n';
        md += '| Metric | Value |\\n|--------|-------|\\n';
        md += '| Pass Rate | ' + pct(r.passed, r.total) + '% (' + r.passed + '/' + r.total + ') |\\n';
        md += '| LLM Score | ' + pct(r.llmPassed, r.llmTotal) + '% |\\n';
        if (r.vlmTotal > 0) md += '| VLM Score | ' + pct(r.vlmPassed, r.vlmTotal) + '% |\\n';
        md += '| Total Time | ' + fmt(r.timeMs / 1000) + 's |\\n';
        md += '| Tokens | ' + fmtK(r.tokens || 0) + ' |\\n';
        if (r.perfSummary?.ttft?.avgMs) md += '| TTFT avg | ' + fmtInt(r.perfSummary.ttft.avgMs) + 'ms |\\n';
        if (r.perfSummary?.decode?.avgTokensPerSec) md += '| Decode | ' + fmt(r.perfSummary.decode.avgTokensPerSec) + ' tok/s |\\n';
    } else {
        md += '| Metric |';
        for (const r of sel) md += ' ' + (r.model || '?').replace(/\\.gguf$/i, '') + ' |';
        md += '\\n|--------|';
        for (const r of sel) md += '--------|';
        md += '\\n';
        const rows = [
            ['Pass Rate', r => pct(r.passed, r.total) + '%'],
            ['LLM', r => r.llmTotal > 0 ? pct(r.llmPassed, r.llmTotal) + '%' : '—'],
            ['VLM', r => r.vlmTotal > 0 ? pct(r.vlmPassed, r.vlmTotal) + '%' : '—'],
            ['Time', r => fmt(r.timeMs / 1000) + 's'],
            ['Tokens', r => fmtK(r.tokens || 0)],
            ['TTFT', r => r.perfSummary?.ttft?.avgMs != null ? fmtInt(r.perfSummary.ttft.avgMs) + 'ms' : '—'],
            ['Decode', r => r.perfSummary?.decode?.avgTokensPerSec != null ? fmt(r.perfSummary.decode.avgTokensPerSec) + ' tok/s' : '—'],
        ];
        for (const [label, fn] of rows) {
            md += '| ' + label + ' |';
            for (const r of sel) md += ' ' + fn(r) + ' |';
            md += '\\n';
        }
    }

    md += '\\n*Generated by HomeSec-Bench Operations Center*\\n';

    // Copy to clipboard
    const textarea = document.createElement('textarea');
    textarea.value = md.replace(/\\\\n/g, '\\n');
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    toast('📋 Markdown copied to clipboard');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        renderActiveTab();
    });
});

function getActiveTab() {
    return document.querySelector('.tab.active')?.dataset.tab || 'performance';
}

function renderActiveTab() {
    const tab = getActiveTab();
    try {
        if (tab === 'performance') renderPerformance();
        else if (tab === 'quality') renderQuality();
        else if (tab === 'vision') renderVision();
    } catch (e) {
        const panel = document.getElementById('tab-' + tab);
        if (panel) panel.innerHTML = '<div style="color:var(--red);padding:2rem"><strong>Render error:</strong> ' + e.message + '<br><pre>' + e.stack + '</pre></div>';
        console.error('Tab render error:', e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFRESH (called on selection change)
// ═══════════════════════════════════════════════════════════════════════════════
function refresh() {
    buildSidebar();
    updateCompareBtn();
    renderActiveTab();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE RELOAD (stateful — preserves tab + scroll)
// ═══════════════════════════════════════════════════════════════════════════════
const IS_LIVE = ${liveMode ? 'true' : 'false'};

function saveState() {
    try {
        sessionStorage.setItem('_bench_tab', getActiveTab());
        sessionStorage.setItem('_bench_scroll', String(window.scrollY));
        sessionStorage.setItem('_bench_selected', JSON.stringify([...selectedIndices]));
        sessionStorage.setItem('_bench_primary', String(primaryIndex));
    } catch {}
}

function restoreState() {
    try {
        // Restore selection
        const savedSel = sessionStorage.getItem('_bench_selected');
        if (savedSel) {
            const arr = JSON.parse(savedSel).filter(i => i >= 0 && i < ALL_RUNS.length);
            if (arr.length > 0) { selectedIndices = new Set(arr); }
        }
        const savedPrimary = sessionStorage.getItem('_bench_primary');
        if (savedPrimary != null) {
            const pi = parseInt(savedPrimary);
            if (pi >= 0 && pi < ALL_RUNS.length) primaryIndex = pi;
        }
        // Restore tab
        const tab = sessionStorage.getItem('_bench_tab');
        if (tab && tab !== 'performance') {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            const tabEl = document.querySelector('.tab[data-tab="' + tab + '"]');
            if (tabEl) tabEl.classList.add('active');
            const panel = document.getElementById('tab-' + tab);
            if (panel) panel.classList.add('active');
        }
        const scroll = parseInt(sessionStorage.getItem('_bench_scroll') || '0');
        if (scroll > 0) setTimeout(() => window.scrollTo(0, scroll), 50);
    } catch {}
}

if (IS_LIVE) {
    setTimeout(() => { saveState(); location.reload(); }, 5000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-export').addEventListener('click', exportMarkdown);
document.getElementById('btn-compare').addEventListener('click', () => {
    // Toggle compare mode info
    if (selectedIndices.size > 1) renderActiveTab();
});

restoreState();
refresh();
</script>
</body>
</html>`;
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Run if called directly
if (require.main === module) {
    generateReport();
}

function buildLiveBanner(status) {
    if (!status) {
        return `<div class="live-banner"><span class="live-dot"></span> Benchmark starting\u2026</div>`;
    }
    const { suitesCompleted = 0, totalSuites = 0, currentSuite = '', currentTest = '', testsCompleted = 0, startedAt = '' } = status;
    const pct = totalSuites > 0 ? Math.round((suitesCompleted / totalSuites) * 100) : 0;
    const elapsed = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : 0;
    const elapsedStr = elapsed > 60 ? Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's' : elapsed + 's';
    const testInfo = currentTest ? ` — ✅ <em>${escHtml(currentTest)}</em>` : '';
    return `<div class="live-banner">
        <span class="live-dot"></span>
        <strong>LIVE</strong> — Suite ${suitesCompleted}/${totalSuites} (${pct}%)
        ${currentSuite ? ' — 🔧 <em>' + escHtml(currentSuite) + '</em>' : ''}
        ${testInfo}
        <span style="margin-left:auto;font-size:0.78rem">${testsCompleted} tests · ${elapsedStr} elapsed</span>
        <div class="live-progress"><div class="live-progress-bar" style="width:${pct}%"></div></div>
    </div>`;
}

module.exports = { generateReport };
