// Browser producer — the ingest-browser-capture tool's engine: Playwright +
// its staged Chromium, one page captured headless as an ingest artifact.
// Egress goes through the sibling egress-relay.mjs (see its header: the
// sanctioned egress proxy kills CONNECTs carrying a HeadlessChrome
// User-Agent, so the browser talks to a loopback relay that replays a clean
// CONNECT). The relay binds an EPHEMERAL port — background tools run
// concurrently, and a fixed port makes parallel captures kill each other.
//
// Contract (shared by all producers in this folder): argv --out <jobDir>
// plus the tool's own args; writes <jobDir>/output.txt and
// <jobDir>/output.meta.json (meta carries outputChars + outputSha256);
// prints one summary line; exits non-zero on failure.
//
// Binding: KINGMAKER_PLAYWRIGHT_PACKAGE — a package.json whose node_modules
// carry playwright (default: the fleet light-ui harness's, this node's
// proven install).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt("--out");
const TARGET = opt("--url");
const SETTLE_MS = Number(opt("--settle-ms") ?? 3000);
if (!OUT || !TARGET) { console.error("usage: produce-browser.mjs --out <dir> --url <url> [--settle-ms n]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const require = createRequire(process.env.KINGMAKER_PLAYWRIGHT_PACKAGE ?? "/home/hatch/workspace/light-ui-design-pass/harness/package.json");
const { chromium } = require("playwright");

// --- start the egress relay on an ephemeral loopback port, wait for READY ---
const relay = spawn("node", [`${HERE}/egress-relay.mjs`, "0"], { stdio: ["ignore", "pipe", "inherit"] });
const relayPort = await new Promise((resolve, reject) => {
  let buf = "";
  relay.stdout.on("data", (d) => {
    buf += String(d);
    const m = buf.match(/READY (\d+)/);
    if (m) resolve(Number(m[1]));
  });
  relay.on("error", reject);
  setTimeout(() => reject(new Error("egress relay did not become ready")), 10000);
}).catch((e) => { relay.kill(); throw e; });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  proxy: { server: `http://127.0.0.1:${relayPort}` },
});
try {
  const page = await browser.newPage();
  const resp = await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(SETTLE_MS); // let late DOM/text settle; networkidle never settles on beacon-heavy pages (analytics)
  const data = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
    return {
      finalUrl: location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content ?? "",
      lang: document.documentElement.lang ?? "",
      text: document.body?.innerText ?? "",
      links: [...document.querySelectorAll("a[href]")].map((a) => ({ href: abs(a.getAttribute("href")), text: (a.innerText || "").trim().slice(0, 80) })),
      assets: [
        ...[...document.querySelectorAll("img[src]")].map((e) => abs(e.getAttribute("src"))),
        ...[...document.querySelectorAll("script[src]")].map((e) => abs(e.getAttribute("src"))),
        ...[...document.querySelectorAll('link[href]')].map((e) => abs(e.getAttribute("href"))),
      ],
    };
  });
  const version = browser.version();
  const links = [...new Map(data.links.map((l) => [l.href, l])).values()];
  const assets = [...new Set(data.assets)];
  const out =
    `HEADLESS BROWSER INGEST — page capture\n` +
    `tool: playwright / Chromium ${version} (via loopback egress relay)\n` +
    `requested_url: ${TARGET}\nfinal_url: ${data.finalUrl}\nhttp_status: ${resp.status()}\n` +
    `title: ${data.title}\ndescription: ${data.description}\nlang: ${data.lang}\n` +
    `\n=== PAGE TEXT ===\n${data.text.trim()}\n` +
    `\n=== LINKS (${links.length}) ===\n` + links.map((l) => `${l.href}\t${l.text}`).join("\n") + "\n" +
    `\n=== ASSETS (${assets.length}) ===\n` + assets.join("\n") + "\n";
  writeFileSync(`${OUT}/output.txt`, out);
  writeFileSync(`${OUT}/output.meta.json`, JSON.stringify({
    tool: `playwright / Chromium ${version}`, target: TARGET, finalUrl: data.finalUrl,
    httpStatus: resp.status(), title: data.title, textChars: data.text.trim().length,
    links: links.length, assets: assets.length, outputChars: out.length,
    outputSha256: createHash("sha256").update(out, "utf8").digest("hex"),
  }, null, 2));
  console.log(`captured ${data.finalUrl} status=${resp.status()} text=${data.text.trim().length} chars links=${links.length} assets=${assets.length} output=${out.length} chars`);
} finally {
  await browser.close();
  relay.kill();
}
