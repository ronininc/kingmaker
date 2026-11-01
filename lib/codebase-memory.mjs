/**
 * lib/codebase-memory.mjs
 *
 * Kingmaker integration for codebase-memory-mcp (DeusData, MIT).
 * v0.12.1, verified SHA256.
 *
 * A persistent code knowledge graph: index any repo once, then query
 * structure instead of re-reading files. 99% fewer tokens on codebase
 * questions. All local, no telemetry, single static binary.
 *
 * The binary downloads on first use (verified against pinned SHA256),
 * not bundled in the repo. Falls back gracefully if unavailable.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const VERSION = 'v0.12.1';
const BASE_URL = `https://github.com/DeusData/codebase-memory-mcp/releases/download/${VERSION}`;

// Pinned SHA256 checksums (from upstream checksums.txt, verified 2026-10-18).
const CHECKSUMS = {
  'darwin-arm64': '9bfcbe38414b47969a3e1d1c1999f5357409387c86fa3d24221b5458267660d2',
  'darwin-amd64': 'ca6e64397a8ae80cec898a8205a6aa16750ac798acc05a0c3ed983837944a581',
  'linux-arm64': '8575f126092660b93b170bdc2e06f3ef2dd28d3cc49ad6d0895dc3e4767219cd',
  'linux-amd64': '8453015145f072c1b9b019cbdd02cea8cc6f18cc5e116036dd20992631c638c7',
};

function platformKey() {
  const p = os.platform();
  const a = os.arch();
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-amd64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  if (p === 'linux' && a === 'x64') return 'linux-amd64';
  return null;
}

function binaryDir() {
  const home = os.homedir();
  return path.join(home, '.kingmaker', 'vendor', 'codebase-memory-mcp', VERSION);
}

function binaryPath() {
  return path.join(binaryDir(), 'codebase-memory-mcp');
}

/** Check if the binary is installed and executable. */
export async function isInstalled() {
  try {
    await fs.access(binaryPath(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download and verify the binary. Idempotent — skips if already installed.
 * Returns { ok: true, path } or { ok: false, reason }.
 */
export async function ensureInstalled({ onProgress = null } = {}) {
  if (await isInstalled()) {
    return { ok: true, path: binaryPath(), cached: true };
  }
  const key = platformKey();
  if (!key) {
    return { ok: false, reason: `unsupported platform: ${os.platform()}/${os.arch()}` };
  }
  const expectedSha = CHECKSUMS[key];
  const url = `${BASE_URL}/codebase-memory-mcp-${key}.tar.gz`;
  const dir = binaryDir();
  await fs.mkdir(dir, { recursive: true });
  const tarPath = path.join(dir, 'dist.tar.gz');

  try {
    if (onProgress) onProgress('downloading');
    await execFileAsync('curl', ['-sL', '-o', tarPath, url]);

    if (onProgress) onProgress('verifying');
    const data = await fs.readFile(tarPath);
    const actualSha = createHash('sha256').update(data).digest('hex');
    if (actualSha !== expectedSha) {
      await fs.unlink(tarPath).catch(() => {});
      return {
        ok: false,
        reason: `checksum mismatch: expected ${expectedSha.slice(0, 12)}..., got ${actualSha.slice(0, 12)}... — refusing to install`,
      };
    }

    if (onProgress) onProgress('extracting');
    await execFileAsync('tar', ['-xzf', tarPath, '-C', dir]);
    await fs.unlink(tarPath).catch(() => {});
    await fs.chmod(binaryPath(), 0o755);

    // Confirm it runs.
    await execFileAsync(binaryPath(), ['--version']);
    return { ok: true, path: binaryPath(), cached: false };
  } catch (err) {
    return { ok: false, reason: `install failed: ${err.message}` };
  }
}

/**
 * Index a repository. Returns { ok: true } or { ok: false, reason }.
 * Indexing is incremental after the first build — the watcher handles edits.
 */
export async function indexRepo(repoPath) {
  const inst = await ensureInstalled();
  if (!inst.ok) return inst;
  try {
    await execFileAsync(binaryPath(), ['index', repoPath], { timeout: 300000 });
    return { ok: true, repoPath };
  } catch (err) {
    return { ok: false, reason: `index failed: ${err.message}` };
  }
}

/**
 * Query the knowledge graph. `tool` is one of the 14 MCP tools
 * (e.g. 'trace_path', 'graph_search', 'dead_code', 'impact_analysis').
 * Returns { ok: true, result } or { ok: false, reason }.
 */
export async function query(tool, args = {}) {
  const inst = await ensureInstalled();
  if (!inst.ok) return inst;
  try {
    const { stdout } = await execFileAsync(
      binaryPath(),
      ['query', tool, JSON.stringify(args)],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    return { ok: true, result: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, reason: `query failed: ${err.message}` };
  }
}

/** Convenience: trace who calls a function (inbound call chain). */
export async function traceCallers(functionName, depth = 5) {
  return query('trace_path', { function_name: functionName, direction: 'inbound', depth });
}

/** Convenience: find dead code. */
export async function findDeadCode() {
  return query('dead_code', {});
}

/** Convenience: impact analysis for a proposed change. */
export async function impactAnalysis(target) {
  return query('impact_analysis', { target });
}

export const INTEGRATION = {
  name: 'codebase-memory-mcp',
  version: VERSION,
  license: 'MIT',
  upstream: 'https://github.com/DeusData/codebase-memory-mcp',
};
