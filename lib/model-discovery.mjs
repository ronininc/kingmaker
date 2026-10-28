/**
 * Model ingestion pipeline — Stage 1: Discovery.
 *
 * PORTED from kingmaker-os (runtime/model-discovery.ts) for the app.
 * Native .mjs; TypeScript types stripped, logic identical.
 *
 * Watches the wild for model candidates: Hugging Face trending, X release
 * announcements, GitHub model repos, and community PRs against the brain
 * library. Discovery is read-only — the cage never restricts looking.
 *
 * Every watcher takes its network access as an injected function, so tests
 * never touch the network and a dead source can never kill a run: per-source
 * failures are collected, not thrown.
 *
 * Source of truth: kingmaker-os.
 */

function baseCandidate(partial) {
  return {
    publisherReputation: 'first-time',
    license: 'unknown',
    baseModel: partial.name,
    method: 'unknown',
    quant: 'unknown',
    claimedParamsB: 0,
    estimatedSizeBytes: -1,
    publishedHash: '',
    discoveredAt: new Date().toISOString(),
    notes: '',
    ...partial,
  };
}

/** Hugging Face trending models (by likes). */
export function huggingFaceSource(fetchJson, opts) {
  return {
    name: 'huggingface',
    async poll() {
      const limit = opts?.limit ?? 20;
      const url =
        `https://huggingface.co/api/models?sort=likes&direction=-1` +
        `&limit=${limit}&filter=text-generation`;
      const data = await fetchJson(url);
      if (!Array.isArray(data)) return [];
      const out = [];
      for (const m of data) {
        if (typeof m !== 'object' || m === null) continue;
        const r = m;
        const id = typeof r['id'] === 'string' ? r['id'] : '';
        if (id === '') continue;
        const tags = Array.isArray(r['tags'])
          ? r['tags'].filter((t) => typeof t === 'string')
          : [];
        const license =
          tags.find((t) => t.startsWith('license:'))?.slice('license:'.length) ?? 'unknown';
        const publisher = id.includes('/') ? id.split('/')[0] : 'unknown';
        out.push(
          baseCandidate({
            id: `hf:${id}`,
            name: id,
            source: 'huggingface',
            sourceUrl: `https://huggingface.co/${id}`,
            publisher,
            license,
            baseModel: id.split('/').pop() ?? id,
            quant: quantFromTags(tags, id),
            notes: `likes=${typeof r['likes'] === 'number' ? r['likes'] : 0}`,
          }),
        );
      }
      return out;
    },
  };
}

function quantFromTags(tags, id) {
  const hay = `${tags.join(' ')} ${id}`.toLowerCase();
  if (hay.includes('fp8')) return 'FP8';
  if (hay.includes('fp4')) return 'FP4';
  if (hay.includes('gguf')) return 'GGUF';
  if (hay.includes('int4') || hay.includes('4bit')) return 'INT4';
  if (hay.includes('gptq')) return 'GPTQ';
  if (hay.includes('awq')) return 'AWQ';
  return 'unknown';
}

/** GitHub model repos matching a query (injected search keeps tests offline). */
export function gitHubSource(searchRepos, opts) {
  return {
    name: 'github',
    async poll() {
      const repos = await searchRepos(
        opts?.query ?? 'uncensored llm weights in:name,description',
      );
      return repos.map((r) =>
        baseCandidate({
          id: `gh:${r.fullName}`,
          name: r.fullName,
          source: 'github',
          sourceUrl: r.htmlUrl,
          publisher: r.owner,
          license: r.licenseSpdx === '' ? 'unknown' : r.licenseSpdx,
          baseModel: r.fullName.split('/').pop() ?? r.fullName,
          notes: r.description.slice(0, 280),
        }),
      );
    },
  };
}

const MODEL_URL_RE = /https?:\/\/(?:huggingface\.co|github\.com)\/[^\s)]+/gi;

/** X release announcements (injected post feed — X has no free search API). */
export function xSource(fetchPosts) {
  return {
    name: 'x',
    async poll() {
      const posts = await fetchPosts();
      const out = [];
      for (const post of posts) {
        const urls = post.text.match(MODEL_URL_RE) ?? [];
        for (const raw of urls) {
          const url = raw.replace(/[.,;!?]+$/, '');
          const name = url.split('/').slice(-2).join('/');
          out.push(
            baseCandidate({
              id: `x:${post.author}:${name}`,
              name,
              source: 'x',
              sourceUrl: url,
              publisher: post.author,
              baseModel: name.split('/').pop() ?? name,
              notes: `announced by @${post.author}: ${post.url} — ${post.text.slice(0, 200)}`,
            }),
          );
        }
      }
      return out;
    },
  };
}

/** Community submissions: PRs against ronininc/kingmaker-brain-library (private; the fetcher passed in must authenticate — see libraryToken in lib/brain-library.mjs). */
export function communityPrSource(fetchPrs) {
  return {
    name: 'community-pr',
    async poll() {
      const prs = await fetchPrs();
      return prs.map((pr) =>
        baseCandidate({
          id: `pr:${pr.number}`,
          name: pr.title,
          source: 'community-pr',
          sourceUrl: pr.url,
          publisher: pr.author,
          baseModel: pr.title,
          notes: `PR #${pr.number} by ${pr.author}: ${pr.body.slice(0, 280)}`,
        }),
      );
    },
  };
}

/**
 * Poll every source, dedupe by sourceUrl across sources, and collect
 * per-source failures instead of throwing. One dead source never kills the run.
 */
export async function discoverCandidates(sources, now = new Date()) {
  const seen = new Set();
  const candidates = [];
  const errors = [];
  for (const source of sources) {
    let found;
    try {
      found = await source.poll();
    } catch (err) {
      errors.push({
        source: source.name,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const c of found) {
      if (seen.has(c.sourceUrl)) continue;
      seen.add(c.sourceUrl);
      candidates.push(c);
    }
  }
  return { candidates, errors, polledAt: now.toISOString() };
}
