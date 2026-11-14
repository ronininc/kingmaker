/**
 * scrapling/lib/scrapling-adapter.mjs
 *
 * The governed intake-scraper adapter for Scrapling (D4Vinci/Scrapling,
 * BSD-3-Clause). Kingmaker-side wrapper in the house pattern — the same
 * shape as LittleBrother's public methods:
 *
 *   - The upstream INTERFACE is mirrored, not imported. Upstream is a
 *     Python library: `Fetcher.get(url)` for fast HTTP, `StealthyFetcher`
 *     for rendered/stealth fetching; a fetched page offers `.css()`,
 *     `.xpath()` and `.markdown()`. This adapter exposes that shape as
 *     fetchPage / extract / markdown over an INJECTED transport. The
 *     transport is the only thing that would ever touch the network or a
 *     Python bridge, and wiring a live one is a Cage-intake act — this
 *     module ships no network code.
 *   - Egress is governed host-side: every URL is checked against the
 *     declared allowlist BEFORE the transport runs (deny by default —
 *     an empty allowlist reaches nothing, the cell-governor posture).
 *     Intent is written to the hash-chained audit log before the call;
 *     outcomes and refusals are written after.
 *   - Extracted text passes the CSAM seed screen before it reaches the
 *     caller (abort, logged WITHOUT content, no override — the
 *     darkweb-search / LittleBrother discipline).
 *   - Results are evidence records: { source, outlet, date, data,
 *     verified } — the LittleBrother evidence shape, so intake lands in
 *     the same record discipline as the rest of the intel lane.
 *
 * Transport contract (injected):
 *   transport({ fetcherClass, mode, url }) → page, where fetcherClass is
 *   'Fetcher' (mode 'http') or 'StealthyFetcher' (mode 'stealth'), and
 *   page is the upstream response as data:
 *   { status, url, text, markdown, selections: { css: {sel: [..]},
 *     xpath: {expr: [..]} } }
 */

import { fileURLToPath } from 'node:url';
import { openAuditLog } from '../../lib/audit-chain.mjs';
import { createEgressGuard, csamHit, refused } from '../../lib/governance.mjs';

export const FETCHER_CLASSES = Object.freeze({ http: 'Fetcher', stealth: 'StealthyFetcher' });
export const ADAPTER_METHODS = Object.freeze(['fetchPage', 'extract', 'markdown']);

function defaultAuditPath() {
  return fileURLToPath(new URL('../audit/scrapling-audit.jsonl', import.meta.url));
}

export function createScraplingAdapter({
  transport,
  auditLog = null,
  auditPath = null,
  allowlist = [],
  spine = 'custom',
} = {}) {
  const audit = auditLog ?? openAuditLog(auditPath ?? defaultAuditPath(), {
    genesisLabel: 'scrapling-adapter-audit-genesis',
  });
  const egress = createEgressGuard({ allow: allowlist, auditLog: audit, actor: 'scrapling' });
  const log = (action, detail, meta = {}) =>
    audit.append({ actor: 'scrapling', action, detail, meta: { spine, ...meta } });

  function evidence(mode, page, data) {
    return {
      ok: true,
      source: `scrapling/${mode}`,
      outlet: (() => { try { return new URL(page.url).hostname; } catch { return 'unknown'; } })(),
      date: new Date().toISOString(),
      data,
      verified: Number.isInteger(page.status) && page.status >= 200 && page.status < 300,
    };
  }

  /**
   * The one path to the transport: intent → egress → screen → transport.
   * Governance refusals return as result objects; transport failures
   * fail closed (no retry, no fallback fetcher).
   */
  async function governedFetch(url, mode) {
    if (!url || typeof url !== 'string') throw new Error('scrapling: a URL string is required');
    if (!(mode in FETCHER_CLASSES)) return refused(`scrapling: unknown mode '${mode}' — http | stealth`);
    log('scrape.intent', `mode=${mode} url=${url.slice(0, 200)}`, { mode, url: url.slice(0, 200) });

    const gate = egress.check(url);
    if (!gate.ok) {
      log('scrape.refused', gate.reason, { mode });
      return gate;
    }
    if (typeof transport !== 'function') {
      const r = refused('scrapling: no transport wired — live fetching is a Cage-intake act, refused by default');
      log('scrape.refused', r.reason, { mode });
      return r;
    }
    let page;
    try {
      page = await transport({ fetcherClass: FETCHER_CLASSES[mode], mode, url });
    } catch (err) {
      const r = refused(`scrapling: transport failed (fail-closed): ${err.message}`);
      log('scrape.error', r.reason, { mode });
      return r;
    }
    if (!page || typeof page !== 'object' || typeof page.text !== 'string') {
      const r = refused('scrapling: transport returned a malformed page — refused');
      log('scrape.error', r.reason, { mode });
      return r;
    }
    if (csamHit(page.text) || csamHit(page.markdown ?? '')) {
      log('csam-abort', `mode=${mode} where=result — content withheld by policy`, { mode });
      return { ok: false, aborted: true, reason: 'CSAM auto-abort: no override path exists' };
    }
    log('scrape', `mode=${mode} host=${gate.host} status=${page.status} chars=${page.text.length}`, {
      mode, host: gate.host, status: page.status ?? null,
    });
    return { ok: true, page };
  }

  /** Fetch one page (upstream: Fetcher.get / StealthyFetcher.fetch). */
  async function fetchPage({ url, mode = 'http' } = {}) {
    const r = await governedFetch(url, mode);
    if (!r.ok) return r;
    return evidence(mode, r.page, {
      status: r.page.status ?? null,
      url: r.page.url ?? url,
      text: r.page.text,
    });
  }

  /** Fetch and extract by CSS selector or XPath (upstream: page.css / page.xpath). */
  async function extract({ url, selector, using = 'css', mode = 'http' } = {}) {
    if (!selector || typeof selector !== 'string') throw new Error('scrapling extract: a selector string is required');
    if (using !== 'css' && using !== 'xpath') return refused(`scrapling extract: using must be 'css' or 'xpath'`);
    const r = await governedFetch(url, mode);
    if (!r.ok) return r;
    const found = r.page.selections?.[using]?.[selector];
    const values = Array.isArray(found) ? found : [];
    return evidence(mode, r.page, { status: r.page.status ?? null, selector, using, values, count: values.length });
  }

  /** Fetch a page as clean Markdown (upstream: page.markdown()). */
  async function markdown({ url, mode = 'http' } = {}) {
    const r = await governedFetch(url, mode);
    if (!r.ok) return r;
    return evidence(mode, r.page, { status: r.page.status ?? null, markdown: r.page.markdown ?? '' });
  }

  return Object.freeze({
    fetchPage,
    extract,
    markdown,
    methods: ADAPTER_METHODS,
    auditPath: audit.path,
    verifyAudit: () => audit.verify(),
  });
}
