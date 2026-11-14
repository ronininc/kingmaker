#!/usr/bin/env node
// scripts/release-gate.mjs — the STAGED release gate (finish plan Phase 2, 2026-10-21).
//
// Why this exists: v0.4.2 shipped an archive whose app failed the installer's own
// signature test, because every check ran against the BUILD TREE while the tar
// carried a different payload. Nobody ever tested the thing that actually ships.
// This gate tests the thing that actually ships:
//
//   1. verifyParts — the written parts hash to the manifest (lib/release-manifest).
//   2. EXTRACT those parts into a staging dir, exactly as an owner's Mac will.
//   3. EXACT-APP — the extracted Kingmaker.app's tree hash must equal the source
//      app's tree hash. If the archive carries anything but the app that was
//      inspected and signed, the release is refused. No exceptions.
//   4. ISSUANCE — the manifest's recorded provenance: the installer and the
//      launcher in this release must have been built from the release's own
//      source tree (repo + commit). The 4.2 acceptance run failed exactly
//      here — an old-line installer inside a new-line release.
//   5. SIGNATURE — the extracted app must pass the installer's own test: strict
//      codesign verify + a designated requirement whose signer hash (leaf OR
//      root — a self-signed identity phrases as root; see lib/release-identity)
//      equals the pinned Kingmaker Release certificate, and not be ad-hoc.
//
// The decision core is pure and platform-free (the codesign probe is injected),
// so the gate's logic is testable anywhere; on the release Mac the CLI builds
// the probe itself with codesign, the same calls installer/engine.sh makes.
//
//   node scripts/release-gate.mjs --manifest <kingmaker-manifest.json> --parts <dir> --app <Kingmaker.app>
//   → prints a JSON verdict; exit 0 only when every check passes.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issuanceProblems, readManifest, verifyParts } from '../lib/release-manifest.mjs';
import { leafFromRequirement, readPin } from '../lib/release-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Tree hash — the exact-app guarantee                                 */
/* ------------------------------------------------------------------ */

/** Deterministic recursive hash of a directory tree: sorted relative paths,
 *  each file's sha256, each symlink's target. Two trees with the same hash
 *  carry the same files with the same bytes — the archive either contains
 *  THE app or it does not ship. */
export function treeHash(root) {
  const entries = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (e.isSymbolicLink()) entries.push({ rel, type: 'link', target: readlinkSync(p) });
      else if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const h = createHash('sha256');
        h.update(readFileSync(p));
        entries.push({ rel, type: 'file', size: lstatSync(p).size, sha256: h.digest('hex') });
      }
    }
  };
  walk(root);
  const h = createHash('sha256');
  h.update(JSON.stringify(entries));
  return { hash: h.digest('hex'), files: entries.filter((e) => e.type === 'file').length, entries };
}

/** Pure: the differences between two treeHash entry lists, human-readable. */
export function treeDiff(a, b) {
  const problems = [];
  const mapA = new Map(a.entries.map((e) => [e.rel, e]));
  const mapB = new Map(b.entries.map((e) => [e.rel, e]));
  for (const [rel, e] of mapA) {
    const o = mapB.get(rel);
    if (!o) problems.push(`staged app is missing ${rel}`);
    else if (e.type !== o.type) problems.push(`${rel}: type differs (${e.type} vs ${o.type})`);
    else if (e.type === 'file' && e.sha256 !== o.sha256) problems.push(`${rel}: content differs from the inspected app`);
    else if (e.type === 'link' && e.target !== o.target) problems.push(`${rel}: symlink target differs`);
  }
  for (const rel of mapB.keys()) if (!mapA.has(rel)) problems.push(`staged app carries an extra ${rel} the inspected app does not have`);
  return problems;
}

/* ------------------------------------------------------------------ */
/* The signature decision — the installer's own test, replicated       */
/* ------------------------------------------------------------------ */

/** Pure: decide from a codesign probe whether an app passes the installer's
 *  signature test. probe = { strictOk, requirementText, detailsText }.
 *  pin = the pinned leaf SHA-1 (uppercase hex) or null. */
export function decideSignature(probe, pin) {
  const problems = [];
  if (!pin) problems.push('no Kingmaker Release certificate is pinned (lib/release-identity.json)');
  if (!probe) return { ok: false, leaf: null, pinMatches: false, adhoc: false, problems: [...problems, 'no codesign probe (not run on macOS)'] };
  if (!probe.strictOk) problems.push('codesign --verify --deep --strict failed on the staged app');
  const adhoc = /Signature=adhoc/.test(String(probe.detailsText ?? ''));
  if (adhoc) problems.push('the staged app is ad-hoc signed (Signature=adhoc)');
  const leaf = leafFromRequirement(probe.requirementText ?? '');
  if (!leaf) problems.push('the staged app has no certificate signer in its designated requirement');
  const pinMatches = Boolean(pin && leaf && leaf === String(pin).toUpperCase());
  if (pin && leaf && !pinMatches) problems.push(`the staged app is signed by ${leaf}, not the pinned Kingmaker Release certificate ${pin}`);
  return { ok: problems.length === 0, leaf, pinMatches, adhoc, problems };
}

/** Build the probe on macOS with the same codesign calls the installer makes.
 *  Off macOS (or if codesign is absent) returns null — the decision then
 *  refuses on the missing probe rather than waving the release through. */
export function codesignProbe(app, { run = spawnSync } = {}) {
  if (process.platform !== 'darwin') return null;
  const strict = run('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
  const req = run('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  const details = run('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' });
  return {
    strictOk: strict.status === 0,
    requirementText: `${req.stdout ?? ''}\n${req.stderr ?? ''}`,
    detailsText: `${details.stdout ?? ''}\n${details.stderr ?? ''}`,
  };
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

/** Concatenate the manifest's parts (in manifest order) and extract the
 *  archive into stageDir. Returns the extracted Kingmaker.app path. */
export async function extractParts({ manifest, partsDir, stageDir }) {
  mkdirSync(stageDir, { recursive: true });
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xzf', '-', '-C', stageDir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`tar extraction failed (${code}): ${err.trim().slice(-200)}`));
      const app = join(stageDir, 'Kingmaker.app');
      if (!existsSync(app)) return reject(new Error('the archive does not contain Kingmaker.app at its root'));
      resolvePromise(app);
    });
    (async () => {
      for (const p of manifest.parts) {
        await new Promise((res, rej) => {
          const s = createReadStream(join(partsDir, p.name));
          s.once('error', rej);
          s.once('end', res);
          s.pipe(child.stdin, { end: false });
        });
      }
      child.stdin.end();
    })().catch(reject);
  });
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/**
 * verifyStagedRelease({ manifest, partsDir, sourceApp, stageDir, pin, probe })
 *   manifest   parsed release manifest
 *   partsDir   directory holding the written parts + manifest file
 *   sourceApp  the Kingmaker.app that was inspected and signed (build tree)
 *   stageDir   scratch dir to extract into (removed unless keepStage)
 *   pin        pinned leaf SHA-1 (defaults to readPin())
 *   probe      codesign probe for the STAGED app (defaults to codesignProbe
 *              on macOS; injectable for tests)
 */
export async function verifyStagedRelease({ manifest, partsDir, sourceApp, stageDir, pin, probe, keepStage = false, signature = 'require', requireIssuance = false }) {
  const problems = [];
  const checks = {};

  // ISSUANCE — the 2026-10-21 acceptance lesson as a gate. The 4.2
  // acceptance run failed at the installer's signature check because the
  // shipped 0.3.1 launcher ran the old installer, whose trust pin belonged
  // to the old release line, while the new installer existed only as
  // source. A release whose installer/launcher artifacts were not built
  // from the release's own tree (repo + commit, recorded in the manifest)
  // is not issuable — an installer from another tree carries another
  // line's trust pin. Provenance RECORDED but mismatched refuses always;
  // provenance MISSING refuses when the caller requires issuance
  // (release-parts does; older releases predate the record).
  const issuance = issuanceProblems(manifest, { required: requireIssuance });
  checks.issuance = { recorded: Boolean(manifest?.issuance), required: requireIssuance, problems: issuance };
  if (issuance.length && (requireIssuance || manifest?.issuance)) problems.push(...issuance.map((p) => `issuance: ${p}`));

  const parts = await verifyParts(manifest, partsDir);
  checks.parts = parts;
  if (!parts.ok) problems.push(...parts.problems.map((p) => `parts: ${p}`));

  let stagedApp = null;
  if (parts.ok) {
    try {
      stagedApp = await extractParts({ manifest, partsDir, stageDir });
      checks.extracted = { app: stagedApp };
    } catch (e) {
      problems.push(`extraction: ${e.message}`);
    }
  }

  if (stagedApp) {
    const src = treeHash(sourceApp);
    const got = treeHash(stagedApp);
    checks.treeHash = { source: src.hash, staged: got.hash, files: got.files };
    if (src.hash !== got.hash) problems.push(...treeDiff(src, got).slice(0, 10));

    if (signature === 'skip') {
      checks.signature = { skipped: true, note: 'signature check waived by the operator (--skip-codesign); recorded, never silent' };
    } else {
      const thePin = pin ?? readPin()?.sha1 ?? null;
      const theProbe = probe !== undefined ? probe : codesignProbe(stagedApp);
      const sig = decideSignature(theProbe, thePin);
      checks.signature = sig;
      if (!sig.ok) problems.push(...sig.problems);
    }
  }

  if (!keepStage && stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  return { ok: problems.length === 0, problems, checks };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function arg(argv, name, fallback = undefined) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const manifestFile = arg(argv, '--manifest');
  const partsDir = arg(argv, '--parts');
  const app = arg(argv, '--app');
  if (!manifestFile || !partsDir || !app) {
    console.log(JSON.stringify({ ok: false, problems: ['usage: release-gate.mjs --manifest <file> --parts <dir> --app <Kingmaker.app> [--stage <dir>] [--keep-stage]'] }, null, 2));
    return 2;
  }
  const manifest = readManifest(resolve(manifestFile));
  const stageDir = resolve(arg(argv, '--stage', join(HERE, '..', 'dist', '.gate-stage')));
  const verdict = await verifyStagedRelease({
    manifest, partsDir: resolve(partsDir), sourceApp: resolve(app), stageDir,
    keepStage: argv.includes('--keep-stage'),
  });
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.ok ? 0 : 1;
}

function invokedDirectly() {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
}
if (invokedDirectly()) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
