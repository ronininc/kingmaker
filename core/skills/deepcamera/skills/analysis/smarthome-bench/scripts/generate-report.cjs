#!/usr/bin/env node
/**
 * HTML Report Generator for SmartHome-Bench Video Anomaly Detection Benchmark
 * 
 * Reads JSON result files from the results directory and generates
 * a self-contained HTML report with:
 * - Per-category accuracy breakdown
 * - Confusion matrix (TP/FP/TN/FN)
 * - Overall metrics (accuracy, precision, recall, F1)
 * - Historical model comparison table
 * 
 * Usage:
 *   node generate-report.cjs [results-dir]
 *   Default: ~/.aegis-ai/smarthome-bench
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const RESULTS_DIR = process.argv[2] || path.join(os.homedir(), '.aegis-ai', 'smarthome-bench');

function generateReport(resultsDir = RESULTS_DIR) {
    // Find all result files
    const files = fs.readdirSync(resultsDir)
        .filter(f => f.endsWith('.json') && !f.startsWith('index'))
        .sort()
        .reverse(); // Most recent first

    if (files.length === 0) {
        console.error('No result files found in', resultsDir);
        return null;
    }

    // Load latest result
    const latestFile = path.join(resultsDir, files[0]);
    const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));

    // Load all results for comparison
    const allResults = files.slice(0, 20).map(f => {
        try {
            return JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
        } catch {
            return null;
        }
    }).filter(Boolean);

    // Generate HTML
    const html = buildHTML(latest, allResults);
    const reportPath = path.join(resultsDir, 'report.html');
    fs.writeFileSync(reportPath, html);
    console.error(`Report generated: ${reportPath}`);
    return reportPath;
}

function buildHTML(latest, allResults) {
    const model = latest.model?.vlm || 'Unknown';
    const timestamp = new Date(latest.timestamp).toLocaleString();
    const totalTests = latest.totals?.total || 0;
    const passed = latest.totals?.passed || 0;
    const failed = latest.totals?.failed || 0;
    const skipped = latest.totals?.skipped || 0;
    const timeMs = latest.totals?.timeMs || 0;
    const metrics = latest.metrics || {};
    const overall = metrics.overall || {};
    const perCategory = metrics.perCategory || {};

    // Build category rows
    const categoryRows = Object.entries(perCategory).map(([cat, m]) => {
        const accPct = (m.accuracy * 100).toFixed(1);
        const precPct = (m.precision * 100).toFixed(1);
        const recPct = (m.recall * 100).toFixed(1);
        const f1Pct = (m.f1 * 100).toFixed(1);
        const accClass = m.accuracy >= 0.8 ? 'high' : m.accuracy >= 0.5 ? 'mid' : 'low';
        return `<tr>
            <td class="cat-name">${escHtml(cat)}</td>
            <td class="${accClass}">${accPct}%</td>
            <td>${precPct}%</td>
            <td>${recPct}%</td>
            <td>${f1Pct}%</td>
            <td>${m.tp}</td>
            <td>${m.fp}</td>
            <td>${m.tn}</td>
            <td>${m.fn}</td>
            <td>${m.total}</td>
        </tr>`;
    }).join('\n');

    // Build suite detail rows
    const suiteDetailRows = (latest.suites || []).map(s => {
        const testRows = s.tests.map(t => {
            const statusIcon = t.status === 'pass' ? '✅' : t.status === 'fail' ? '❌' : '⏭️';
            const statusClass = t.status;
            return `<tr class="${statusClass}">
                <td>${statusIcon}</td>
                <td>${escHtml(t.name)}</td>
                <td>${t.status}</td>
                <td>${t.timeMs}ms</td>
                <td class="detail">${escHtml((t.detail || '').slice(0, 100))}</td>
            </tr>`;
        }).join('\n');

        return `<div class="suite-section">
            <h3>${escHtml(s.name)}</h3>
            <div class="suite-stats">
                ✅ ${s.passed} passed · ❌ ${s.failed} failed · ⏭️ ${s.skipped} skipped · ⏱ ${(s.timeMs / 1000).toFixed(1)}s
            </div>
            <table class="tests-table">
                <thead><tr><th></th><th>Test</th><th>Status</th><th>Time</th><th>Detail</th></tr></thead>
                <tbody>${testRows}</tbody>
            </table>
        </div>`;
    }).join('\n');

    // Build comparison table
    const comparisonRows = allResults.map(r => {
        const rModel = r.model?.vlm || 'Unknown';
        const rTime = new Date(r.timestamp).toLocaleDateString();
        const rMetrics = r.metrics?.overall || {};
        const rAcc = ((rMetrics.accuracy || 0) * 100).toFixed(1);
        const rF1 = ((rMetrics.f1 || 0) * 100).toFixed(1);
        const rPassed = r.totals?.passed || 0;
        const rTotal = r.totals?.total || 0;
        const rTimeMs = r.totals?.timeMs || 0;
        return `<tr>
            <td>${escHtml(rModel)}</td>
            <td>${rTime}</td>
            <td>${rPassed}/${rTotal}</td>
            <td>${rAcc}%</td>
            <td>${rF1}%</td>
            <td>${(rTimeMs / 1000).toFixed(0)}s</td>
        </tr>`;
    }).join('\n');

    const overallAccPct = ((overall.accuracy || 0) * 100).toFixed(1);
    const overallPrecPct = ((overall.precision || 0) * 100).toFixed(1);
    const overallRecPct = ((overall.recall || 0) * 100).toFixed(1);
    const overallF1Pct = ((overall.f1 || 0) * 100).toFixed(1);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartHome-Bench Report — ${escHtml(model)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; line-height: 1.6; padding: 2rem; }
.container { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.8rem; color: #58a6ff; margin-bottom: 0.5rem; }
h2 { font-size: 1.3rem; color: #8b949e; margin: 2rem 0 1rem; border-bottom: 1px solid #21262d; padding-bottom: 0.5rem; }
h3 { font-size: 1.1rem; color: #c9d1d9; margin: 1.5rem 0 0.5rem; }
.header { text-align: center; margin-bottom: 2rem; }
.header .subtitle { color: #8b949e; font-size: 0.9rem; }

/* Score cards */
.score-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.score-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1.2rem; text-align: center; }
.score-card .value { font-size: 2rem; font-weight: 700; }
.score-card .label { font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
.score-card.accuracy .value { color: #3fb950; }
.score-card.f1 .value { color: #58a6ff; }
.score-card.precision .value { color: #d2a8ff; }
.score-card.recall .value { color: #f0883e; }
.score-card.tests .value { color: #c9d1d9; }
.score-card.time .value { color: #8b949e; }

/* Confusion matrix */
.confusion-matrix { display: inline-grid; grid-template-columns: auto auto auto; gap: 2px; background: #21262d; border-radius: 8px; overflow: hidden; margin: 1rem 0; }
.cm-cell { padding: 1rem 1.5rem; text-align: center; background: #161b22; }
.cm-header { background: #0d1117; color: #8b949e; font-size: 0.75rem; text-transform: uppercase; }
.cm-tp { color: #3fb950; font-weight: 700; font-size: 1.2rem; }
.cm-fp { color: #f85149; font-weight: 700; font-size: 1.2rem; }
.cm-tn { color: #3fb950; font-weight: 700; font-size: 1.2rem; }
.cm-fn { color: #f85149; font-weight: 700; font-size: 1.2rem; }

/* Tables */
table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #21262d; }
th { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
td { font-size: 0.9rem; }
.high { color: #3fb950; font-weight: 600; }
.mid { color: #f0883e; font-weight: 600; }
.low { color: #f85149; font-weight: 600; }
.cat-name { font-weight: 600; }

/* Suite detail */
.suite-section { margin: 1.5rem 0; padding: 1rem; background: #161b22; border-radius: 8px; }
.suite-stats { font-size: 0.85rem; color: #8b949e; margin-bottom: 0.5rem; }
.tests-table { font-size: 0.85rem; }
.tests-table tr.fail td { color: #f85149; }
.tests-table tr.skip td { color: #8b949e; }
td.detail { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem; color: #8b949e; }

/* System info */
.system-info { font-size: 0.85rem; color: #8b949e; margin: 1rem 0; padding: 1rem; background: #161b22; border-radius: 8px; }
.system-info span { display: inline-block; margin-right: 2rem; }

/* Comparison */
.comparison-table tr:first-child td { font-weight: 600; color: #58a6ff; }

.footer { text-align: center; color: #484f58; font-size: 0.8rem; margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #21262d; }
</style>
</head>
<body>
<div class="container">

<div class="header">
    <h1>🏠 SmartHome-Bench Report</h1>
    <div class="subtitle">
        Video Anomaly Detection Benchmark · ${escHtml(model)} · ${timestamp}
    </div>
</div>

<div class="score-cards">
    <div class="score-card accuracy"><div class="value">${overallAccPct}%</div><div class="label">Accuracy</div></div>
    <div class="score-card f1"><div class="value">${overallF1Pct}%</div><div class="label">F1 Score</div></div>
    <div class="score-card precision"><div class="value">${overallPrecPct}%</div><div class="label">Precision</div></div>
    <div class="score-card recall"><div class="value">${overallRecPct}%</div><div class="label">Recall</div></div>
    <div class="score-card tests"><div class="value">${passed}/${totalTests}</div><div class="label">Passed</div></div>
    <div class="score-card time"><div class="value">${(timeMs / 1000).toFixed(0)}s</div><div class="label">Total Time</div></div>
</div>

<div class="system-info">
    <span>🖥 ${escHtml(latest.system?.cpus || 'Unknown')}</span>
    <span>💾 ${latest.system?.totalRAM_GB || '?'} GB RAM</span>
    <span>🔧 Node ${escHtml(latest.system?.node || '?')}</span>
</div>

<h2>📊 Overall Confusion Matrix</h2>
<div class="confusion-matrix">
    <div class="cm-cell cm-header"></div>
    <div class="cm-cell cm-header">Predicted Normal</div>
    <div class="cm-cell cm-header">Predicted Abnormal</div>
    <div class="cm-cell cm-header">Actual Normal</div>
    <div class="cm-cell cm-tn">TN: ${overall.tn || 0}</div>
    <div class="cm-cell cm-fp">FP: ${overall.fp || 0}</div>
    <div class="cm-cell cm-header">Actual Abnormal</div>
    <div class="cm-cell cm-fn">FN: ${overall.fn || 0}</div>
    <div class="cm-cell cm-tp">TP: ${overall.tp || 0}</div>
</div>

<h2>📋 Per-Category Breakdown</h2>
<table>
    <thead>
        <tr>
            <th>Category</th>
            <th>Accuracy</th>
            <th>Precision</th>
            <th>Recall</th>
            <th>F1</th>
            <th>TP</th>
            <th>FP</th>
            <th>TN</th>
            <th>FN</th>
            <th>Total</th>
        </tr>
    </thead>
    <tbody>
        ${categoryRows}
        <tr style="border-top: 2px solid #30363d; font-weight: 600;">
            <td>Overall</td>
            <td class="${(overall.accuracy || 0) >= 0.8 ? 'high' : (overall.accuracy || 0) >= 0.5 ? 'mid' : 'low'}">${overallAccPct}%</td>
            <td>${overallPrecPct}%</td>
            <td>${overallRecPct}%</td>
            <td>${overallF1Pct}%</td>
            <td>${overall.tp || 0}</td>
            <td>${overall.fp || 0}</td>
            <td>${overall.tn || 0}</td>
            <td>${overall.fn || 0}</td>
            <td>${totalTests}</td>
        </tr>
    </tbody>
</table>

<h2>🧪 Test Details</h2>
${suiteDetailRows}

${allResults.length > 1 ? `
<h2>📈 Model Comparison</h2>
<table class="comparison-table">
    <thead>
        <tr><th>Model</th><th>Date</th><th>Passed</th><th>Accuracy</th><th>F1</th><th>Time</th></tr>
    </thead>
    <tbody>${comparisonRows}</tbody>
</table>
` : ''}

<div class="footer">
    SmartHome-Bench · Based on <a href="https://github.com/Xinyi-0724/SmartHome-Bench-LLM" style="color:#58a6ff">SmartHome-Bench-LLM</a> · DeepCamera / SharpAI
</div>

</div>
</body>
</html>`;
}

function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Run if called directly
if (require.main === module) {
    generateReport();
}

module.exports = { generateReport };
