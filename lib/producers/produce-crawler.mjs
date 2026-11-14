// Crawler producer — the ingest-site-crawl tool's engine: the CRM build's
// own web crawler, worker/site-crawl.ts `crawlSite()` — a pure module, the
// transport injected; here it is plain global fetch (this node's direct
// egress handles it; no relay needed). Reusing the shipped crawler — not a
// stand-in — is what makes the output real product output.
//
// Contract: argv --out <jobDir> --url <site> [--max-pages n] [--max-checks n];
// writes output.txt + output.meta.json (outputChars + outputSha256 in meta);
// one summary line; non-zero exit on failure.
//
// Binding: KINGMAKER_SITE_CRAWL_MODULE — path to worker/site-crawl.ts
// (default: the fleet's crm-seo-aeo-build checkout, this node's proven copy).
// Node's type stripping imports the .ts module directly.
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt("--out");
const TARGET = opt("--url");
const MAX_PAGES = Number(opt("--max-pages") ?? 30);
const MAX_CHECKS = Number(opt("--max-checks") ?? 220);
if (!OUT || !TARGET) { console.error("usage: produce-crawler.mjs --out <dir> --url <url> [--max-pages n] [--max-checks n]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const { crawlSite } = await import(process.env.KINGMAKER_SITE_CRAWL_MODULE ?? "/home/hatch/workspace/crm-seo-aeo-build/worker/site-crawl.ts");
const UA = "RoninSiteCrawl/1.0 (kingmaker producer)";

const fetchImpl = (url, init = {}) =>
  fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) }, redirect: "follow" });

const record = new Set();
const report = await crawlSite(TARGET, {
  fetchImpl, maxPages: MAX_PAGES, maxChecks: MAX_CHECKS, deadlineMs: 120000, concurrency: 6,
  checkExternal: true, userAgent: UA, record,
});
const recorded = [...record].sort();
const out =
  `WEB CRAWLER INGEST — same-site crawl report\n` +
  `tool: worker/site-crawl.ts (crawlSite)\n` +
  `target: ${TARGET}\nmaxPages: ${MAX_PAGES}\tmaxChecks: ${MAX_CHECKS}\tcheckExternal: true\n\n` +
  `=== CRAWL REPORT (JSON) ===\n${JSON.stringify(report, null, 2)}\n\n` +
  `=== RECORDED URLS (${recorded.length}) ===\n${recorded.join("\n")}\n`;
writeFileSync(`${OUT}/output.txt`, out);
writeFileSync(`${OUT}/output.meta.json`, JSON.stringify({
  tool: "worker/site-crawl.ts crawlSite", target: TARGET,
  pagesChecked: report.pages_checked, assetsChecked: report.assets_checked,
  externalChecked: report.external_checked, brokenPages: report.broken_pages.length,
  brokenAssets: report.broken_assets.length, brokenExternal: report.broken_external.length,
  blockedExternal: report.blocked_external.length, truncated: report.truncated,
  elapsedMs: report.elapsed_ms, recordedUrls: recorded.length,
  outputChars: out.length, outputSha256: createHash("sha256").update(out, "utf8").digest("hex"),
}, null, 2));
console.log(`crawl done: pages=${report.pages_checked} assets=${report.assets_checked} external=${report.external_checked} brokenPages=${report.broken_pages.length} brokenAssets=${report.broken_assets.length} truncated=${report.truncated} recorded=${recorded.length} output=${out.length} chars`);
