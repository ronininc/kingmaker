/**
 * scrapling tests — fake transport only. ZERO network: the transport is
 * an injected fake that records its calls; a call the governance layer
 * refuses must never reach it.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScraplingAdapter, FETCHER_CLASSES } from '../lib/scrapling-adapter.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'km42-scrapling-'));
const auditPath = join(dir, 'audit.jsonl');

const calls = [];
const fakePage = {
  status: 200,
  url: 'https://example.com/article',
  text: 'A perfectly ordinary article about sovereign computing.',
  markdown: '# Ordinary article\n',
  selections: {
    css: { 'h1.title': ['Ordinary Article'], '.price': ['$10', '$20'] },
    xpath: { '//a/@href': ['/one', '/two'] },
  },
};
const fakeTransport = async ({ fetcherClass, mode, url }) => {
  calls.push({ fetcherClass, mode, url });
  if (url.includes('boom')) throw new Error('socket exploded');
  if (url.includes('weird')) return { nope: true };
  return fakePage;
};

const adapter = createScraplingAdapter({
  transport: fakeTransport,
  auditPath,
  allowlist: ['example.com', '*.allowed.org'],
});

// 1. Allowed fetch returns an evidence record and hits the transport once.
const r1 = await adapter.fetchPage({ url: 'https://example.com/article' });
check('allowed fetch ok', r1.ok === true && r1.verified === true);
check('evidence shape (source/outlet/date)', r1.source === 'scrapling/http' && r1.outlet === 'example.com' && typeof r1.date === 'string');
check('transport received Fetcher class for http mode', calls.length === 1 && calls[0].fetcherClass === 'Fetcher');

// 2. Stealth mode routes to StealthyFetcher.
const r2 = await adapter.fetchPage({ url: 'https://example.com/article', mode: 'stealth' });
check('stealth fetch routes to StealthyFetcher', r2.ok === true && calls[1].fetcherClass === 'StealthyFetcher');
check('fetcher class map matches upstream README', FETCHER_CLASSES.http === 'Fetcher' && FETCHER_CLASSES.stealth === 'StealthyFetcher');

// 3. Unlisted host is refused BEFORE the transport runs.
const before = calls.length;
const r3 = await adapter.fetchPage({ url: 'https://evil.example.net/x' });
check('unlisted host refused', r3.ok === false && r3.refused === true);
check('refusal never reached the transport', calls.length === before);

// 4. Non-http schemes refused.
const r4 = await adapter.fetchPage({ url: 'file:///etc/passwd' });
check('file:// scheme refused', r4.ok === false && r4.refused === true && calls.length === before);

// 5. Wildcard suffix matches subdomains (and the bare suffix host).
const r5 = await adapter.fetchPage({ url: 'https://docs.allowed.org/page' });
check('wildcard suffix allows subdomain', r5.ok === true);

// 6. Extract reads the mirrored page shape.
const r6 = await adapter.extract({ url: 'https://example.com/article', selector: '.price' });
check('css extract returns values', r6.ok === true && r6.data.count === 2 && r6.data.values[0] === '$10');
const r7 = await adapter.extract({ url: 'https://example.com/article', selector: '//a/@href', using: 'xpath' });
check('xpath extract returns values', r7.ok === true && r7.data.count === 2);

// 7. Markdown lane.
const r8 = await adapter.markdown({ url: 'https://example.com/article' });
check('markdown returns upstream markdown', r8.ok === true && r8.data.markdown.startsWith('# Ordinary'));

// 8. Transport failure fails closed.
const r9 = await adapter.fetchPage({ url: 'https://example.com/boom' });
check('transport error fails closed', r9.ok === false && r9.refused === true);

// 9. Malformed page refused.
const r10 = await adapter.fetchPage({ url: 'https://example.com/weird' });
check('malformed page refused', r10.ok === false && r10.refused === true);

// 10. No transport wired → refuse by default (live wiring is a Cage act).
const bare = createScraplingAdapter({ auditPath: join(dir, 'bare.jsonl'), allowlist: ['example.com'] });
const r11 = await bare.fetchPage({ url: 'https://example.com/article' });
check('no transport wired refuses', r11.ok === false && /no transport wired/.test(r11.reason));

// 11. CSAM content in a result aborts, logged without content.
const badTransport = async () => ({ status: 200, url: 'https://example.com/x', text: 'this mentions child porn', markdown: '' });
const bad = createScraplingAdapter({ transport: badTransport, auditPath: join(dir, 'bad.jsonl'), allowlist: ['example.com'] });
const r12 = await bad.fetchPage({ url: 'https://example.com/x' });
check('CSAM result auto-aborts', r12.ok === false && r12.aborted === true);

// 12. Audit chain verifies and carries intent + refusal entries.
check('audit chain verifies', adapter.verifyAudit().ok === true);
import { readFileSync } from 'node:fs';
const logText = readFileSync(auditPath, 'utf8');
check('audit logged intent before transport', logText.includes('"action":"scrape.intent"'));
check('audit logged the refusal', logText.includes('"action":"scrape.refused"'));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
