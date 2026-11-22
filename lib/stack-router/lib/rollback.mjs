/**
 * lib/rollback.mjs (router-phase2)
 *
 * One-command rollback for the router state tree — composed, per mapping
 * §8 (ADAPT), from the two rollback mechanisms upstream that restore real
 * bytes (spec §6.3): the migration backup (byte copies of config + data)
 * and the memory copy-on-write checkpoints. The npm-reinstall variant
 * (restores nothing itself) and the deployment status-flip (decoration)
 * are NOT rollback and are not ported.
 *
 * Snapshot integrity follows the helpers-manifest pattern (§6.2, §8
 * PORT) — the only signing scheme in the reference worth taking:
 *   - a canonical manifest (file → SHA-256) for every snapshot,
 *   - signed with an Ed25519 key held OUTSIDE the state tree,
 *   - verified against a PINNED public key before anything is copied,
 *   - fail-closed: a bad signature or one drifted byte refuses the
 *     restore before a single live file is touched.
 * (The witness scheme — seed derived from a public git hash, signatures
 * anyone can forge, hash drift tolerated — is §8 SKIP and stays skipped.)
 *
 * The snapshot set covers the whole Phase-2 state: config, bandit state,
 * memory store, federation registry, and the audit chain head. Restoring
 * returns the tree to the snapshot exactly — tracked files absent from
 * the snapshot are removed — and the restore itself is appended to the
 * (restored) audit chain, so the rollback is part of the record it
 * restores, not an erasure of it.
 */

import { createHash, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, copyFileSync,
  mkdirSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

import { openAuditLog } from './audit-chain.mjs';

export const DEFAULT_STATE_FILES = [
  'config.json',
  'bandit-state.json',
  'memory-store.json',
  'federation-registry.json',
  'audit-chain.json',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Deterministic canonical string — same shape as federation's signer. */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

const asPrivateKey = (k) => (typeof k === 'string' ? createPrivateKey(k) : k);
const asPublicKey = (k) => (typeof k === 'string' ? createPublicKey(k) : k);

/**
 * Create a rollback handle.
 *   stateDir     — the live tree (tracked files live directly under it)
 *   snapshotRoot — where timestamped snapshot directories are kept
 *   auditPath    — the tree's audit chain file (usually <stateDir>/audit-chain.json)
 *   files        — tracked relative paths (default: the Phase-2 state set)
 *   signKey      — Ed25519 private key (PEM string or KeyObject), used to
 *                  sign snapshot manifests; held outside the tree
 *   verifyKey    — the PINNED Ed25519 public key manifests are checked
 *                  against before any restore
 */
export function createRollback({ stateDir, snapshotRoot, auditPath = null, files = DEFAULT_STATE_FILES, signKey, verifyKey } = {}) {
  if (!stateDir || !snapshotRoot) throw new Error('rollback: stateDir and snapshotRoot are required');
  if (!signKey) throw new Error('rollback: a signKey is required — unsigned snapshots are not shipped');
  if (!verifyKey) throw new Error('rollback: a pinned verifyKey is required — restores are fail-closed');
  const priv = asPrivateKey(signKey);
  const pub = asPublicKey(verifyKey);
  const tracked = [...files];

  const audit = (action, detail, meta) => {
    if (!auditPath) return;
    openAuditLog(auditPath).append({ actor: 'rollback', action, detail, meta: meta ?? {} });
  };

  function freshSnapshotId() {
    const base = new Date().toISOString().replace(/[:.]/g, '-');
    let id = base;
    let n = 2;
    while (existsSync(join(snapshotRoot, id))) id = `${base}-${n++}`;
    return id;
  }

  /**
   * Snapshot the tracked state files into snapshotRoot/<timestamp>/,
   * with a signed, hash-pinned manifest. Returns { id, dir, manifest }.
   */
  function snapshot() {
    const id = freshSnapshotId();
    const dir = join(snapshotRoot, id);
    mkdirSync(dir, { recursive: true });
    const hashes = {};
    const absent = [];
    for (const rel of tracked) {
      const src = join(stateDir, rel);
      if (!existsSync(src)) {
        absent.push(rel);
        continue;
      }
      const dst = join(dir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      hashes[rel] = sha256(readFileSync(dst)); // hash the copy — what restore will verify
    }
    const manifest = { version: 1, id, createdAt: new Date().toISOString(), files: hashes, absent };
    const sig = sign(null, Buffer.from(canonicalize(manifest), 'utf8'), priv).toString('hex');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(dir, 'manifest.sig'), sig);
    audit('rollback.snapshot', `snapshot ${id} taken (${Object.keys(hashes).length} file(s), ${absent.length} absent)`, {
      snapshotId: id, files: Object.keys(hashes), absent,
    });
    return { id, dir, manifest };
  }

  /** Read + authenticate a snapshot's manifest. Throws on any problem. */
  function loadVerifiedManifest(dir) {
    const manifestPath = join(dir, 'manifest.json');
    const sigPath = join(dir, 'manifest.sig');
    if (!existsSync(manifestPath) || !existsSync(sigPath)) {
      throw new Error('rollback: snapshot is missing its manifest or signature — refusing');
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new Error(`rollback: snapshot manifest is not valid JSON (${e.message}) — refusing`);
    }
    const sig = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'hex');
    let sigOk = false;
    try {
      sigOk = verify(null, Buffer.from(canonicalize(manifest), 'utf8'), pub, sig);
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      throw new Error('rollback: snapshot manifest signature does not verify against the pinned key — refusing (fail-closed)');
    }
    for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
      const p = join(dir, rel);
      if (!existsSync(p)) throw new Error(`rollback: snapshot file '${rel}' is missing — refusing`);
      const actual = sha256(readFileSync(p));
      if (actual !== expected) {
        throw new Error(`rollback: snapshot file '${rel}' has drifted (hash mismatch) — refusing`);
      }
    }
    return manifest;
  }

  /** List snapshots, newest first. Unverifiable entries are marked, never hidden. */
  function list() {
    if (!existsSync(snapshotRoot)) return [];
    return readdirSync(snapshotRoot)
      .filter((name) => statSync(join(snapshotRoot, name)).isDirectory())
      .sort()
      .reverse()
      .map((id) => {
        const dir = join(snapshotRoot, id);
        try {
          const manifest = loadVerifiedManifest(dir);
          return { id, createdAt: manifest.createdAt, files: Object.keys(manifest.files ?? {}), absent: manifest.absent ?? [], verified: true };
        } catch (e) {
          return { id, createdAt: null, files: [], absent: [], verified: false, error: e.message };
        }
      });
  }

  /**
   * Restore a snapshot: verify EVERYTHING first (signature, then every
   * file hash), and only then copy — verify-then-copy, fail-closed.
   * Tracked files the snapshot records as absent are removed, so the
   * tree returns to the snapshot exactly. The restore appends its own
   * entry to the restored audit chain. Returns { ok, id, restored, removed }.
   */
  function restore(id) {
    const dir = join(snapshotRoot, id);
    if (!existsSync(dir)) throw new Error(`rollback: no snapshot '${id}'`);
    const manifest = loadVerifiedManifest(dir); // throws before any write
    const restored = [];
    const removed = [];
    for (const [rel] of Object.entries(manifest.files ?? {})) {
      const dst = join(stateDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(dir, rel), dst);
      restored.push(rel);
    }
    for (const rel of manifest.absent ?? []) {
      const p = join(stateDir, rel);
      if (existsSync(p)) {
        rmSync(p);
        removed.push(rel);
      }
    }
    audit('rollback.restore', `restored snapshot ${id} (${restored.length} file(s) restored, ${removed.length} removed)`, {
      snapshotId: id, restored, removed, snapshotCreatedAt: manifest.createdAt,
    });
    return { ok: true, id, restored, removed };
  }

  return { snapshot, list, restore, stateFiles: [...tracked] };
}
