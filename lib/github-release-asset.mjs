// Public GitHub release assets for the Brain Library.
//
// The direct browser_download_url has returned HTTP 504 HTML for a Modelfile
// while `gh release download` (the asset API, then the redirect) succeeded.
// Every asset is therefore requested from
//   GET /repos/{owner}/{repo}/releases/assets/{id}
// with Accept: application/octet-stream. The redirect is followed by this
// module: the API response is read with redirect manual so a credential, if a
// future tether ever supplies one, is not forwarded to the CDN. The Location
// URL is then fetched with no credential. The browser_download_url is used
// only after the API path fails.
//
// A non-2xx body is never written. An HTML error page is never written, even
// when the status is 200. Unauthenticated callers get 60 requests an hour;
// X-RateLimit-* is watched and a short reset is waited out. A long reset is
// reported and not hammered.
//
// A file already on disk whose SHA-256 matches the catalog is not downloaded
// again.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { headersFor, noCredentials, redactError } from './library-credentials.mjs';

export const ASSET_ACCEPT = 'application/octet-stream';
export const RATE_LIMIT_WAIT_MS = 15_000;

const HTML_START = /^\s*<(!DOCTYPE|html|head|body)\b/i;

export function isHtmlPayload(body, contentType = '') {
  if (/text\/html/i.test(String(contentType || ''))) return true;
  const sample = Buffer.isBuffer(body) ? body.subarray(0, 512).toString('utf8') : String(body ?? '').slice(0, 512);
  return HTML_START.test(sample);
}

export function isModelfile(text) {
  const source = String(text ?? '');
  if (!source.trim() || isHtmlPayload(source)) return false;
  return /^FROM\s+\S+/m.test(source);
}

export function backoffMs(attempt) {
  return Math.min(8_000, 500 * 2 ** attempt);
}

export function assetApiUrl({ owner, repo, assetId }) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`;
}

export function browserDownloadUrl({ owner, repo, release, name }) {
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release)}/${encodeURIComponent(name)}`;
}

export function releaseTagUrl({ owner, repo, release }) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(release)}`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discard(response) {
  try { await response?.body?.cancel?.(); } catch { /* already closed */ }
}

function rateWaitMs(response, now) {
  const rawRetry = response?.headers?.get?.('retry-after');
  if (rawRetry != null && rawRetry !== '') {
    const retryAfter = Number(rawRetry);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  }
  const reset = Number(response?.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now());
  return 60_000;
}

function rememberBudget(response, budget, now) {
  if (!budget || !response?.headers?.get) return;
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(remaining)) budget.remaining = remaining;
  if (Number.isFinite(reset) && reset > 0) budget.resetMs = reset * 1000;
  if (!Number.isFinite(budget.remaining)) budget.remaining = null;
  budget.seenAt = now();
}

async function gateBudget(budget, { sleep, now, rateLimitWaitMs }) {
  if (!budget || budget.remaining == null || budget.remaining > 0) return;
  const wait = Math.max(0, (budget.resetMs || 0) - now());
  if (wait > rateLimitWaitMs) {
    const error = new Error(`GitHub's unauthenticated rate limit is exhausted; retry after ${new Date(budget.resetMs || now()).toISOString()}`);
    error.code = 'RATE_LIMITED';
    error.retryAt = budget.resetMs || null;
    throw error;
  }
  if (wait > 0) await sleep(wait);
  budget.remaining = null;
}

async function backoffOrThrow(response, { attempt, maxAttempts, sleep, now, rateLimitWaitMs, via, budget }) {
  const status = response?.status ?? 0;
  const limited = status === 403 || status === 429;
  if (limited) {
    const wait = rateWaitMs(response, now);
    if (wait > rateLimitWaitMs || attempt >= maxAttempts - 1) {
      const error = new Error(`GitHub rate limit on the ${via} asset path (HTTP ${status}); retry after ${wait}ms`);
      error.code = 'RATE_LIMITED';
      error.status = status;
      error.retryAt = budget?.resetMs || null;
      throw error;
    }
    await sleep(wait);
    if (budget) budget.remaining = null;
    return;
  }
  if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt));
}

/**
 * Resolve the response that carries the asset bytes.
 * Returns { response, via } where via is 'api' or 'direct'.
 * Throws without writing when both paths fail.
 */
export async function openReleaseAsset({
  owner,
  repo,
  assetId = null,
  release = null,
  name = null,
  range = null,
  credentialProvider = noCredentials,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  maxAttempts = 3,
  rateLimitWaitMs = RATE_LIMIT_WAIT_MS,
  budget = null,
  signal = null,
} = {}) {
  const credential = await credentialProvider.credential?.() ?? null;
  const rangeHeader = range ? { range: `bytes=${range.start}-${range.end}` } : {};
  let lastStatus = 0;

  if (assetId != null) {
    const apiUrl = assetApiUrl({ owner, repo, assetId });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await gateBudget(budget, { sleep, now, rateLimitWaitMs });
        const apiResponse = await fetchImpl(apiUrl, {
          headers: headersFor(apiUrl, { accept: ASSET_ACCEPT, 'user-agent': 'kingmaker' }, credential),
          redirect: 'manual',
          signal,
        });
        rememberBudget(apiResponse, budget, now);
        lastStatus = apiResponse.status;
        if (apiResponse.status >= 300 && apiResponse.status < 400) {
          const location = apiResponse.headers.get('location');
          await discard(apiResponse);
          if (!location) throw new Error(`release asset API redirected without a location (HTTP ${apiResponse.status})`);
          const signed = await fetchBytes(location, { rangeHeader, fetchImpl, signal });
          if (signed.ok) return { response: signed.response, via: 'api' };
          lastStatus = signed.response.status;
          await discard(signed.response);
          if (signed.retry) {
            await backoffOrThrow(signed.response, { attempt, maxAttempts, sleep, now, rateLimitWaitMs, via: 'api redirect', budget });
            continue;
          }
          break;
        }
        if (apiResponse.status >= 200 && apiResponse.status < 300) {
          if (range && apiResponse.status !== 206) {
            const length = Number(apiResponse.headers.get('content-length'));
            const want = range.end - range.start + 1;
            if (Number.isFinite(length) && length > want) {
              await discard(apiResponse);
              throw Object.assign(new Error('the asset API ignored the requested byte range'), { code: 'RANGE_IGNORED' });
            }
          }
          return { response: apiResponse, via: 'api' };
        }
        await discard(apiResponse);
        const retry = apiResponse.status === 403 || apiResponse.status === 429 || apiResponse.status >= 500;
        if (!retry) break;
        await backoffOrThrow(apiResponse, { attempt, maxAttempts, sleep, now, rateLimitWaitMs, via: 'api', budget });
      } catch (error) {
        if (error?.code === 'RATE_LIMITED' || error?.code === 'RANGE_IGNORED') throw redactError(error);
        if (attempt >= maxAttempts - 1) break;
        await sleep(backoffMs(attempt));
      }
    }
  }

  if (release && name) {
    const direct = browserDownloadUrl({ owner, repo, release, name });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const got = await fetchBytes(direct, { rangeHeader, fetchImpl, signal });
        lastStatus = got.response.status;
        if (got.ok) return { response: got.response, via: 'direct' };
        await discard(got.response);
        if (!got.retry) break;
        await backoffOrThrow(got.response, { attempt, maxAttempts, sleep, now, rateLimitWaitMs, via: 'direct', budget });
      } catch (error) {
        if (error?.code === 'RATE_LIMITED') throw redactError(error);
        if (attempt >= maxAttempts - 1) break;
        await sleep(backoffMs(attempt));
      }
    }
  }

  throw redactError(Object.assign(new Error(`release asset download failed (HTTP ${lastStatus || 'none'})`), { status: lastStatus || 0 }));
}

async function fetchBytes(url, { rangeHeader, fetchImpl, signal }) {
  const response = await fetchImpl(url, { headers: { ...rangeHeader, 'user-agent': 'kingmaker' }, redirect: 'follow', signal });
  const status = response.status;
  const ok = status >= 200 && status < 300;
  const retry = status === 403 || status === 429 || status >= 500;
  return { response, ok, retry };
}

/** Buffer a small 2xx body. Refuses HTML and non-2xx. Does not write a file. */
export async function readReleaseBytes(response, { maxBytes, range = null } = {}) {
  if (!response || response.status < 200 || response.status >= 300) {
    const status = response?.status ?? 0;
    await discard(response);
    throw redactError(Object.assign(new Error(`refusing to keep a non-2xx asset body (HTTP ${status})`), { status }));
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (isHtmlPayload('', contentType)) {
    await discard(response);
    throw redactError(new Error(`refusing an HTML error page (HTTP ${response.status})`));
  }
  if (range && response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers?.get?.('content-range') || '');
    if (match && (Number(match[1]) !== range.start || Number(match[2]) !== range.end)) {
      await discard(response);
      throw redactError(new Error(`Content-Range ${response.headers.get('content-range')} did not match bytes ${range.start}-${range.end}`));
    }
  }
  const chunks = [];
  let total = 0;
  let first = true;
  for await (const chunk of response.body) {
    const buf = Buffer.from(chunk);
    if (first) {
      first = false;
      if (isHtmlPayload(buf, contentType)) throw redactError(new Error(`refusing an HTML error page (HTTP ${response.status})`));
    }
    total += buf.length;
    if (maxBytes != null && total > maxBytes) {
      await discard(response);
      throw redactError(new Error(`asset body exceeded ${maxBytes} bytes`));
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Stream a 2xx body to `dest`, hashing as it arrives. The destination is
 * replaced only after the body is accepted. A checksum that does not match
 * deletes the partial file and leaves any previous destination in place.
 */
export async function writeReleaseBody(response, dest, { expectedSha256 = null, expectedSize = null } = {}) {
  if (!response || response.status < 200 || response.status >= 300) {
    const status = response?.status ?? 0;
    await discard(response);
    throw redactError(Object.assign(new Error(`refusing to write a non-2xx asset body (HTTP ${status})`), { status }));
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (isHtmlPayload('', contentType)) {
    await discard(response);
    throw redactError(new Error(`refusing to write an HTML error page (HTTP ${response.status})`));
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.partial`;
  const hash = createHash('sha256');
  const out = createWriteStream(tmp);
    let total = 0;
  let first = true;
  try {
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      if (first) {
        first = false;
        if (isHtmlPayload(buf, contentType)) {
          await discard(response);
          throw new Error(`refusing to write an HTML error page (HTTP ${response.status})`);
        }
      }
      hash.update(buf);
      total += buf.length;
      if (!out.write(buf)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    const sha256 = hash.digest('hex');
    if (expectedSize != null && total !== expectedSize) throw new Error(`asset size ${total} did not match ${expectedSize}`);
    if (expectedSha256 && sha256 !== expectedSha256) throw new Error(`asset SHA-256 ${sha256.slice(0, 12)} did not match ${String(expectedSha256).slice(0, 12)}`);
    renameSync(tmp, dest);
    writeFileSync(`${dest}.sha256`, `${sha256}\n`, { mode: 0o600 });
    return { dest, sha256, bytes: total };
  } catch (error) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw redactError(error);
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** True when `path` exists, has the expected size, and its SHA-256 matches.
 *  A sibling `.sha256` written by a previous check is reused when it is not
 *  older than the file. Nothing else is trusted. */
export async function fileMatches(path, expectedSha256, expectedSize = null) {
  let st;
  try { st = statSync(path); } catch { return false; }
  if (!st.isFile()) return false;
  if (expectedSize != null && st.size !== expectedSize) return false;
  if (!expectedSha256) return false;
  const side = `${path}.sha256`;
  try {
    const sideStat = statSync(side);
    if (sideStat.mtimeMs >= st.mtimeMs) {
      const recorded = readFileSync(side, 'utf8').trim().split(/\s+/)[0];
      if (recorded === expectedSha256) return true;
    }
  } catch { /* hash the file */ }
  const got = await sha256File(path);
  if (got !== expectedSha256) return false;
  writeFileSync(side, `${got}\n`, { mode: 0o600 });
  return true;
}

const rejectedBody = (error) => /HTML error page|non-2xx|Content-Range|exceeded/.test(String(error?.message || error));

async function withDirectFallback(spec, run) {
  try {
    return await run(spec);
  } catch (error) {
    if (spec.assetId == null || spec._directOnly || !spec.release || !spec.name || error?.code === 'RATE_LIMITED' || !rejectedBody(error)) throw error;
    return run({ ...spec, assetId: null, _directOnly: true });
  }
}

export async function downloadReleaseAsset(spec, dest) {
  if (spec.expectedSha256 && await fileMatches(dest, spec.expectedSha256, spec.expectedSize ?? null)) {
    return { dest, sha256: spec.expectedSha256, bytes: spec.expectedSize ?? null, skipped: true, via: 'disk' };
  }
  return withDirectFallback(spec, async (current) => {
    const opened = await openReleaseAsset(current);
    try {
      const written = await writeReleaseBody(opened.response, dest, current);
      return { ...written, skipped: false, via: opened.via };
    } catch (error) {
      await discard(opened.response);
      throw error;
    }
  });
}

export async function downloadReleaseBytes(spec, { maxBytes = null } = {}) {
  return withDirectFallback(spec, async (current) => {
    const opened = await openReleaseAsset(current);
    try {
      const bytes = await readReleaseBytes(opened.response, { maxBytes, range: current.range ?? null });
      return { bytes, via: opened.via, status: opened.response.status };
    } catch (error) {
      await discard(opened.response);
      throw error;
    }
  });
}
