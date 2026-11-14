// The security-diagnostics corpus for Kingmaker's knowledge library.
//
// The list of what to take is catalog/corpora/security-diagnostics.json. This module plans the
// download from that list, fetches the chosen files from Hugging Face, and rewrites each one as
// plain Markdown under <sources>/security-diagnostics/<corpus id>/. The knowledge build that
// Kingmaker already runs (lib/knowledge.mjs: extract, then index) reads Markdown from the sources
// folder, so the corpus ends up as the security-diagnostics.db SQLite shard with no change to the
// engine folder.
//
// The dataset is gated: the files need a Hugging Face token whose account has accepted the
// dataset's terms. The token is read from HF_TOKEN and sent only to huggingface.co. Everything
// fetched is treated as text to index. Nothing from it is executed or imported.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog', 'corpora', 'security-diagnostics.json');
export const HF_HOST = 'https://huggingface.co';
/** One Markdown file is closed and the next one opened at about this size. */
export const PART_BYTES = 4 * 1024 * 1024;
/** A JSON (not JSONL) file is parsed in memory, so it has its own ceiling. */
export const JSON_PARSE_MAX_BYTES = 256 * 1024 * 1024;

export function loadManifest(path = MANIFEST_PATH) {
  const m = JSON.parse(readFileSync(path, 'utf8'));
  if (m.schema !== 'kingmaker.corpus/1') throw new Error(`unknown corpus schema: ${m.schema}`);
  for (const key of ['id', 'field']) if (!/^[a-z0-9][a-z0-9-]*$/.test(String(m[key] ?? ''))) throw new Error(`corpus ${key} must be a plain lower-case name`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(m.source?.repo ?? ''))) throw new Error('corpus source.repo must be owner/name');
  if (!/^[0-9a-f]{40}$/.test(String(m.source?.revision ?? ''))) throw new Error('corpus source.revision must be a full commit id, so the content cannot change underneath us');
  if (!m.license?.note || !m.license?.use) throw new Error('corpus license note and use must be recorded');
  if (!Array.isArray(m.include) || !m.include.length) throw new Error('corpus include list is empty');
  for (const f of m.include) if (!/^[a-z0-9][a-z0-9-]*$/.test(f)) throw new Error(`include folder is not a plain name: ${f}`);
  return m;
}

/** Where Kingmaker's knowledge sources live, the same place lib/knowledge.mjs reads. */
export function defaultSourcesDir(env = process.env) {
  if (env.SOLOMON_CORPUS_DIR) return env.SOLOMON_CORPUS_DIR;
  const state = String(env.SOL_GHOST_HOME ?? '').trim() || join(homedir(), 'Library/Application Support/sol-ghost');
  return join(String(env.SOL_GHOST_RUNTIME_HOME || join(state, 'runtime')), 'data', 'knowledge', 'sources');
}

const safeRelPath = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s && s !== '.' && s !== '..' && !/[\0-\x1f]/.test(s));

/**
 * Choose the files to fetch from a folder listing (the Hugging Face tree API's rows).
 * Returns { take, skipped }. A file is taken once per content id, so the dataset's
 * repeated copies are fetched a single time.
 */
export function planFetch(tree, manifest) {
  const include = new Set(manifest.include);
  const exts = new Set(manifest.extensions ?? ['.json', '.jsonl']);
  const maxBytes = (manifest.maxFileMB ?? 64) * 1024 * 1024;
  const skipName = manifest.skipNamePattern ? new RegExp(manifest.skipNamePattern) : null;
  const seen = new Set();
  const take = [];
  const skipped = [];
  const rows = [...(tree ?? [])].filter((r) => r?.type === 'file').sort((a, b) => String(a.path).localeCompare(String(b.path)));
  for (const row of rows) {
    const path = row.path;
    const skip = (reason) => skipped.push({ path: String(path), reason });
    if (!safeRelPath(path)) { skip('unsafe path'); continue; }
    const folder = path.split('/')[0];
    if (!path.includes('/') || !include.has(folder)) { skip('folder not in include list'); continue; }
    if (!exts.has(extname(path).toLowerCase())) { skip('file type not taken'); continue; }
    if (skipName?.test(basename(path))) { skip('named as a duplicate'); continue; }
    const size = Number(row.lfs?.size ?? row.size);
    if (!Number.isFinite(size) || size <= 0) { skip('no size'); continue; }
    if (size > maxBytes) { skip(`over the ${manifest.maxFileMB ?? 64} MB per-file limit`); continue; }
    const contentId = String(row.lfs?.oid ?? row.oid ?? '');
    if (contentId && seen.has(contentId)) { skip('same content as a file already taken'); continue; }
    if (contentId) seen.add(contentId);
    take.push({ path, size, sha256: /^[0-9a-f]{64}$/.test(row.lfs?.oid ?? '') ? row.lfs.oid : null });
  }
  return { take, skipped, bytes: take.reduce((n, f) => n + f.size, 0) };
}

const TITLE_KEYS = ['title', 'name', 'id', 'cve_id', 'cve', 'technique', 'question', 'instruction', 'prompt', 'topic'];

function flatten(value, label, out, depth) {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') { const t = value.trim(); if (t) out.push(label ? `${label}: ${t}` : t); return; }
  if (typeof value === 'number' || typeof value === 'boolean') { if (label) out.push(`${label}: ${value}`); return; }
  if (Array.isArray(value)) { for (const item of value) flatten(item, label, out, depth + 1); return; }
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) flatten(v, label ? `${label}.${k}` : k, out, depth + 1);
}

/** One record of any shape as a Markdown section. Null when it holds no text. */
export function recordToMarkdown(record, fallbackTitle = 'Entry') {
  const lines = [];
  flatten(record, '', lines, 0);
  if (!lines.length) return null;
  let title = fallbackTitle;
  if (record && typeof record === 'object' && !Array.isArray(record)) {
    for (const key of TITLE_KEYS) {
      const v = record[key];
      if (typeof v === 'string' && v.trim()) { title = v.trim(); break; }
    }
  }
  title = title.replace(/\s+/g, ' ').slice(0, 120);
  return `## ${title}\n\n${lines.join('\n\n')}\n`;
}

/** The records inside a parsed JSON document: a list, a wrapper around one list, or the document itself. */
export function recordsOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object') {
    const lists = Object.values(doc).filter((v) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object'));
    if (lists.length === 1) return lists[0];
  }
  return [doc];
}

function moveFile(from, to) {
  try { renameSync(from, to); } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    copyFileSync(from, to); rmSync(from, { force: true });
  }
}

// Parts are written into a staging folder and moved into place only by publish(), so a file that
// fails part-way leaves nothing where the knowledge build looks for Markdown.
function partWriter(destBase, heading, stagingDir) {
  let part = 0, bytes = 0, text = '', records = 0;
  const staged = [];
  const flush = () => {
    if (!text) return;
    part += 1;
    const name = `${basename(destBase)}${part > 1 ? `.part${part}` : ''}.md`;
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, name), `# ${heading}${part > 1 ? ` (part ${part})` : ''}\n\n${text}`);
    staged.push(name);
    text = ''; bytes = 0;
  };
  return {
    add(md) { if (!md) return; text += `${md}\n`; bytes += Buffer.byteLength(md); records += 1; if (bytes >= PART_BYTES) flush(); },
    publish() {
      flush();
      mkdirSync(dirname(destBase), { recursive: true });
      const files = staged.map((name) => { const to = join(dirname(destBase), name); moveFile(join(stagingDir, name), to); return to; });
      rmSync(stagingDir, { recursive: true, force: true });
      return { files, records };
    },
    discard() { rmSync(stagingDir, { recursive: true, force: true }); },
  };
}

/**
 * Rewrite one downloaded .json or .jsonl file as Markdown beside `destBase`.
 * The Markdown is built in `stagingDir` and moved into place only when the whole input has
 * converted. A JSONL line that is not valid JSON stops the conversion with an error and leaves
 * no Markdown behind, so a cut-off download is never indexed, in whole or in part.
 */
export async function convertFile(rawFile, destBase, { heading = basename(rawFile), stagingDir = join(dirname(destBase), `.staging-${basename(destBase)}-${process.pid}`) } = {}) {
  const out = partWriter(destBase, heading, stagingDir);
  try {
    if (extname(rawFile).toLowerCase() === '.jsonl') {
      let n = 0;
      const rl = createInterface({ input: createReadStream(rawFile), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        n += 1;
        let rec;
        try { rec = JSON.parse(line); } catch (err) { throw new Error(`line ${n} of ${basename(rawFile)} is not valid JSON: ${err.message}`); }
        out.add(recordToMarkdown(rec, `${heading} #${n}`));
      }
    } else {
      if (statSync(rawFile).size > JSON_PARSE_MAX_BYTES) throw new Error(`${basename(rawFile)} is too large to parse as one JSON document`);
      const records = recordsOf(JSON.parse(readFileSync(rawFile, 'utf8')));
      records.forEach((rec, i) => out.add(recordToMarkdown(rec, `${heading} #${i + 1}`)));
    }
  } catch (err) {
    out.discard();
    throw err;
  }
  return out.publish();
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/** The folder listing for every included folder, at the pinned revision. Public: no token needed. */
export async function listTree(manifest, { fetchImpl = fetch } = {}) {
  const rows = [];
  for (const folder of manifest.include) {
    let url = `${HF_HOST}/api/datasets/${manifest.source.repo}/tree/${manifest.source.revision}/${enc(folder)}?recursive=true`;
    for (let page = 0; url && page < 50; page += 1) {
      const res = await fetchImpl(url);
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`listing ${folder} failed: HTTP ${res.status}`);
      rows.push(...await res.json());
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers?.get?.('link') ?? '');
      url = next && next[1].startsWith(`${HF_HOST}/`) ? next[1] : null;
    }
  }
  return rows;
}

/**
 * Fetch the planned files and write them as Markdown under <sourcesDir>/<field>/<id>/.
 * Each file is downloaded to a holding folder beside the sources, checked for size (and
 * SHA-256 where the listing gives one), converted, then removed. A receipt records what
 * was written. Returns { state, written, failed, receipt }.
 */
export async function fetchCorpus({ manifest = loadManifest(), sourcesDir = defaultSourcesDir(), token = process.env.HF_TOKEN, fetchImpl = fetch, tree = null, log = () => {} } = {}) {
  if (!token) return { state: 'needs-token', reason: 'Set HF_TOKEN to a Hugging Face token whose account has accepted this dataset\'s terms.' };
  const plan = planFetch(tree ?? await listTree(manifest, { fetchImpl }), manifest);
  const destRoot = join(sourcesDir, manifest.field, manifest.id);
  const holding = join(dirname(sourcesDir), 'downloads', manifest.id);
  mkdirSync(holding, { recursive: true });
  const written = [];
  const failed = [];
  for (const file of plan.take) {
    const raw = join(holding, file.path.replaceAll('/', '__'));
    try {
      const res = await fetchImpl(`${HF_HOST}/datasets/${manifest.source.repo}/resolve/${manifest.source.revision}/${enc(file.path)}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401 || res.status === 403) { failed.push({ path: file.path, reason: `access refused (HTTP ${res.status})` }); rmSync(holding, { recursive: true, force: true }); return { state: 'access-refused', reason: 'Hugging Face refused the token. Accept the dataset\'s terms on its page with the token\'s account, then run this again.', written, failed }; }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(raw));
      if (statSync(raw).size !== file.size) throw new Error('size does not match the listing');
      if (file.sha256 && await sha256Of(raw) !== file.sha256) throw new Error('SHA-256 does not match the listing');
      const dest = join(destRoot, file.path.slice(0, -extname(file.path).length));
      const done = await convertFile(raw, dest, { heading: file.path, stagingDir: join(holding, `converting-${file.path.replaceAll('/', '__')}`) });
      written.push({ path: file.path, bytes: file.size, records: done.records, files: done.files.length });
      log(`  done  ${file.path} (${done.records} entries)`);
    } catch (err) {
      failed.push({ path: file.path, reason: err instanceof Error ? err.message : String(err) });
      log(`  FAILED ${file.path}: ${failed.at(-1).reason}`);
    } finally {
      rmSync(raw, { force: true });
    }
  }
  rmSync(holding, { recursive: true, force: true });
  const receipt = {
    id: manifest.id, field: manifest.field, repo: manifest.source.repo, revision: manifest.source.revision,
    license: manifest.license, completedAt: new Date().toISOString(),
    written, failed, skipped: plan.skipped.length,
  };
  const receipts = join(sourcesDir, '.receipts');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, `${manifest.id}.json`), JSON.stringify(receipt, null, 2));
  return { state: failed.length ? (written.length ? 'partial' : 'failed') : 'complete', written, failed, receipt, destRoot };
}

export const corpusInstalled = (manifest, sourcesDir = defaultSourcesDir()) => existsSync(join(sourcesDir, '.receipts', `${manifest.id}.json`)) && existsSync(join(sourcesDir, manifest.field, manifest.id));

/** Where the extracted mirror and the index shards sit for a given sources folder (the layout lib/knowledge.mjs uses). */
export function buildDirs(sourcesDir = defaultSourcesDir(), env = process.env) {
  return {
    sources: sourcesDir,
    extracted: env.SOLOMON_EXTRACTED_DIR ?? join(dirname(sourcesDir), 'extracted'),
    index: env.SOLOMON_INDEX_DIR ?? join(dirname(sourcesDir), 'index'),
  };
}

export const ENGINE_SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'solomon', 'scripts');

/**
 * Build this corpus's SQLite shard now: the engine's extract script, then its index script, for this
 * one field. Kingmaker's background knowledge build skips its work when the library already reports
 * complete, and this field is optional, so a fetch alone would never be indexed on such a Mac.
 * Returns { state: 'built' | 'failed', stage?, shard }.
 */
export function buildShard({ manifest = loadManifest(), sourcesDir = defaultSourcesDir(), scriptsDir = ENGINE_SCRIPTS_DIR, nodeBin = process.execPath, env = process.env, run = spawnSync, log = () => {} } = {}) {
  const dirs = buildDirs(sourcesDir, env);
  const shard = join(dirs.index, `${manifest.field}.db`);
  const childEnv = { ...env, SOLOMON_DATA_DIR: dirname(dirname(sourcesDir)), SOLOMON_CORPUS_DIR: dirs.sources, SOLOMON_EXTRACTED_DIR: dirs.extracted, SOLOMON_INDEX_DIR: dirs.index };
  for (const [stage, script, nodeArgs] of [['extract', 'solomon-extract-knowledge.mjs', []], ['index', 'solomon-index-knowledge.mjs', ['--experimental-sqlite']]]) {
    const file = join(scriptsDir, script);
    if (!existsSync(file)) return { state: 'failed', stage, reason: `${script} is not in ${scriptsDir}`, shard };
    const r = run(nodeBin, [...nodeArgs, file, `--field=${manifest.field}`], { env: childEnv, encoding: 'utf8' });
    log(String(r.stdout ?? '').trim());
    if (r.status !== 0) return { state: 'failed', stage, reason: String(r.stderr ?? '').trim().split('\n').pop() || `exit ${r.status}`, shard };
  }
  return existsSync(shard) ? { state: 'built', shard } : { state: 'failed', stage: 'index', reason: 'the index step ran but wrote no shard', shard };
}

/**
 * Make sure the engine's field contract routes security questions to this field. The engine searches
 * only the fields a question's keywords nominate, so without an entry a question that also matches
 * another field (software, law) would never reach this shard. The entry is optional: a library
 * without the corpus is still complete. Idempotent. Returns true when the file was changed.
 * The engine folder is replaced on every engine import, so scripts/import-solomon.mjs calls this too.
 */
export function applyFieldRoute(contractPath, manifest = loadManifest()) {
  if (!manifest.route?.triggers) return false;
  new RegExp(manifest.route.triggers, 'i');
  const text = readFileSync(contractPath, 'utf8');
  const entry = { field: manifest.field, subdir: manifest.field, optional: true, triggers: manifest.route.triggers, description: manifest.route.description, authorityBias: manifest.route.authorityBias ?? 'REFERENCE' };
  const fields = JSON.parse(text).fields;
  if (!Array.isArray(fields)) throw new Error('field contract has no fields list');
  const have = fields.find((f) => (f.field ?? f.subdir) === manifest.field);
  if (have && JSON.stringify(have) === JSON.stringify(entry)) return false;
  const block = JSON.stringify(entry, null, 2).split('\n').map((l) => `    ${l}`).join('\n');
  let next;
  if (have) {
    const start = text.lastIndexOf('    {', text.indexOf(`"field": "${manifest.field}"`));
    const end = text.indexOf('\n    }', start) + '\n    }'.length;
    next = text.slice(0, start) + block + text.slice(end);
  } else {
    const close = text.lastIndexOf('\n  ]');
    if (close < 0) throw new Error('field contract is not in the expected layout');
    next = `${text.slice(0, close)},\n${block}${text.slice(close)}`;
  }
  JSON.parse(next);
  writeFileSync(contractPath, next);
  return true;
}
