#!/usr/bin/env node
// Read-only owner-lane checks. This never builds, signs, enrolls devices, writes remote state or uploads.
import { constants as fsConstants, accessSync, existsSync, lstatSync, readFileSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { REQUIRED_RUNTIMES } from './release-parts.mjs';
import { checkPayload, ESSENTIAL } from '../lib/payload.mjs';
import { issuanceProblems, manifestProblems, shipProblems, verifyParts, sha256File } from '../lib/release-manifest.mjs';
import { readPin, appRequirement } from '../lib/release-identity.mjs';
import { verifyManifestBytes } from '../lib/release-signing.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GIB = 1024 ** 3;
const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const SAFE_NAME = /^(?!\.)[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANIFEST = 'kingmaker-manifest.json';
const REQUIRED_PATHS = [...REQUIRED_RUNTIMES, 'kingmaker-runtime/app/dist/index.html'];
const envHas = (env, key) => Object.hasOwn(env, key);
const silentCommand = (cmd, args) => spawnSync(cmd, args, {
  encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0' },
});
const regular = (file) => lstatSync(file, { throwIfNoEntry: false })?.isFile();
function boundedFile(file, max) {
  const s = lstatSync(file, { throwIfNoEntry: false });
  return s?.isFile() && s.size <= max ? readFileSync(file) : null;
}
function jsonFile(file, max = GIB / 1024) {
  const raw = boundedFile(file, max);
  return raw === null ? null : JSON.parse(raw);
}
function safePayloadRows(root, data) {
  if (!Array.isArray(data?.files) || !data.files.length) return false;
  const names = new Set();
  for (const f of data.files) {
    if (typeof f?.path !== 'string' || names.has(f.path) || !DIGEST.test(f.sha256 ?? '') || !Number.isSafeInteger(f.size) || f.size < 0) return false;
    const segments = f.path.split('/');
    if (segments.some((p) => !p || p === '.' || p === '..' || /[\\\u0000-\u001f]/.test(p))) return false;
    let loc = root;
    for (const [i, part] of segments.entries()) {
      loc = join(loc, part);
      const st = lstatSync(loc, { throwIfNoEntry: false });
      if (!st || (i === segments.length - 1 ? !st.isFile() : !st.isDirectory())) return false;
    }
    names.add(f.path);
  }
  return ESSENTIAL.every((p) => names.has(p));
}
function enrollmentUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}

// CLI dependencies are overridable only by tests importing this function, not by CLI flags or environment.
export async function preflight(options, { env = process.env, host = { platform: process.platform, arch: process.arch }, command = silentCommand,
  fsCapacity = statfsSync, pin = readPin(), publicKey = () => readFileSync(join(ROOT, 'lib', 'kingmaker-release-public.pem'), 'utf8') } = {}) {
  const checks = [];
  const phase = options.phase ?? 'artifact';
  const hostOnly = phase === 'host';
  if (phase !== 'host' && phase !== 'artifact') throw Error('Invalid phase.');
  function check(id, pass, success, blocker, facts) {
    checks.push({ id, status: pass ? 'pass' : 'blocked', detail: pass ? success : blocker, ...(facts ? { facts } : {}) });
    return pass;
  }
  const mac = check('host', host.platform === 'darwin' && host.arch === 'arm64', 'Apple silicon macOS.', 'Use the approved Apple silicon macOS release host, not Linux or a generic CI runner.');
  let pkg = null;
  try { pkg = options.source ? jsonFile(join(options.source, 'package.json')) : null; } catch {}
  const locked = options.source && SHA.test(options.sourceCommit ?? '') && command('/usr/bin/git', ['-C', options.source, 'rev-parse', 'HEAD']).stdout?.trim() === options.sourceCommit.toLowerCase();
  const clean = locked && (() => {
    const r = command('/usr/bin/git', ['-C', options.source, 'status', '--porcelain', '--untracked-files=no']);
    return r.status === 0 && !r.stdout?.trim();
  })();
  check('source', clean && /^\d+\.\d+\.\d+$/.test(pkg?.version ?? ''), 'Exact clean source checkout and package version.', 'Point --source and --source-commit at the exact clean intended release checkout.');

  const app = hostOnly ? null : options.app, resources = app && join(app, 'Contents', 'Resources');
  const runtime = resources && join(resources, 'sol-ghost');
  const missingRuntimes = REQUIRED_PATHS.filter((name) => !resources || !existsSync(join(resources, name)));
  const engine = app && join(app, 'Contents', 'MacOS', 'KingmakerEngine');
  const appCode = Boolean(mac && pin && app && regular(engine) && command('/usr/bin/codesign', ['--verify','--deep','--strict', '-R='+appRequirement(pin.sha1), app]).status === 0);
  const codeFacts = appCode ? (command('/usr/bin/codesign', ['-d', '--verbose=4', app]).stderr ?? '') : '';
  const hardened = appCode && /\bflags=[^\n]*\bruntime\b/.test(codeFacts);
  const innerDeveloperId = /^Authority=Developer ID Application:/m.test(codeFacts);
  if (!hostOnly) check('app-code-signature', appCode && hardened, 'The packaged app meets the pinned Kingmaker certificate and hardened runtime.', 'Supply the exact signed packaged Kingmaker.app: pinned app identity, hardened runtime, no ad-hoc substitution.', { innerDeveloperId, outerAppleNotaryIsSeparate: true });
  let p = null;
  try { p = runtime && jsonFile(join(runtime, 'payload.json'), 20 * 1024 * 1024); } catch {}
  let payloadOk = false;
  try {
    if (appCode && !missingRuntimes.length && safePayloadRows(runtime, p) && p.version === pkg?.version &&
        checkPayload(runtime, { installed: true }).ok) {
      payloadOk = true;
      for (const f of p.files) {
        const path = join(runtime, f.path);
        if (lstatSync(path).size !== f.size || await sha256File(path) !== f.sha256) { payloadOk = false; break; }
      }
    }
  } catch { payloadOk = false; }
  if (!hostOnly) check('runtime', payloadOk, 'Bundled runtime closure and payload-file checks passed.', 'Rebuild the full runtime from the intended checkout and provide its complete, version-matched payload inventory.', { missingRuntimes });

  let built = null;
  try { built = !hostOnly && options.buildReceipt && jsonFile(options.buildReceipt); } catch {}
  let appMeta = null;
  if (appCode) {
    try { const p = command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]); if (p.status === 0) appMeta = JSON.parse(p.stdout); } catch {}
  }
  const engineBuild = appMeta?.KingmakerEngineBuild ?? appMeta?.SolomonRuntimeBuild;
  const native = Boolean(appCode && command('/usr/bin/lipo',['-verify_arch', 'arm64', engine]).status === 0);
  const rtCommit = options.engineSource && SHA.test(options.engineCommit ?? '') &&
    command('/usr/bin/git', ['-C', options.engineSource, 'rev-parse', 'HEAD']).stdout?.trim() === options.engineCommit.toLowerCase();
  const provenance = Boolean(native && payloadOk && rtCommit && appMeta?.CFBundleShortVersionString === pkg?.version &&
    typeof engineBuild === 'string' && Boolean(engineBuild.trim()) && built?.sourceCommit === options.sourceCommit &&
    built?.engineCommit === options.engineCommit && built?.appVersion === pkg?.version &&
    built?.engineBuild === engineBuild && DIGEST.test(built?.engineSha256 ?? '') &&
    await sha256File(engine).catch(() => '') === built.engineSha256);
  if (!hostOnly) check('build-provenance', provenance, 'Source/runtime receipts match the inspected arm64 app bytes and bundle metadata.', 'Provide exact engine checkout/commit and the matching owner-lane receipt with source commit, package version, engine build marker, and SHA-256 of KingmakerEngine.');

  if (hostOnly) {
    const cleanEngine = rtCommit && (() => {
      const r = command('/usr/bin/git', ['-C', options.engineSource, 'status', '--porcelain', '--untracked-files=no']);
      return r.status === 0 && !r.stdout?.trim();
    })();
    check('engine-source', cleanEngine && regular(join(options.engineSource,'desktop','run-electron-builder.mjs')),
      'Exact clean engine checkout and existing packager entry.', 'Provide the approved engine checkout and its full source commit, with the existing macOS packager.');
    const node = options.nodeVersion ?? process.versions.node;
    const [a,b,c] = node.split('.').map(Number);
    const nodeOK = a > 24 || (a === 24 && (b > 22 || (b === 22 && c >= 1)));
    const sdk = Boolean(mac && command('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path']).status === 0 &&
      command('/usr/bin/xcrun',['--find','swiftc']).status === 0);
    check('build-dependencies', nodeOK && sdk, 'Node meets the project floor, and the macOS SDK and Swift compiler are available.',
      'Use Node 24.22.1 or newer and the approved Xcode/macOS SDK; no tools are installed by this command.');
    // Before packaging there is no signed app or archive. The operator supplies a
    // nonsecret input inventory from the approved acquisition lane, not a new key.
    let verifiedKinds = [];
    try {
      const root = options.runtimeDir;
      const plan = options.runtimePlan && jsonFile(options.runtimePlan);
      if (root && plan?.engineCommit === options.engineCommit && plan?.sourceCommit === options.sourceCommit &&
          Array.isArray(plan?.inputs) && plan.inputs.length === REQUIRED_RUNTIMES.length && lstatSync(root).isDirectory()) {
        const kinds = new Set(), files = new Set();
        for (const item of plan.inputs) {
          if (!REQUIRED_RUNTIMES.includes(item?.kind) || kinds.has(item.kind) ||
              files.has(item?.file) || !SAFE_NAME.test(item?.file ?? '') || !DIGEST.test(item?.sha256 ?? '') ||
              !Number.isSafeInteger(item?.size) || item.size <= 0) break;
          const path = join(root,item.file);
          if (!regular(path) || lstatSync(path).size !== item.size || await sha256File(path) !== item.sha256) break;
          kinds.add(item.kind); files.add(item.file);
        }
        verifiedKinds = [...kinds];
      }
    } catch {}
    check('runtime-inputs', verifiedKinds.length === REQUIRED_RUNTIMES.length,
      'Owner-provided local runtime inputs match the source-linked inventory and actual bytes.',
      'Supply --runtime-dir and --runtime-plan from the approved acquisition lane; no network acquisition occurs.', { missingKinds: REQUIRED_RUNTIMES.filter((k) => !verifiedKinds.includes(k)) });
  }

  let unpacked = 0;
  if (appCode) {
    const r = command('/usr/bin/du', ['-sk', app]);
    if (r.status === 0) unpacked = Number(/^\d+/.exec(r.stdout ?? '')?.[0] ?? 0) * 1024;
  }
  const writable = (dir) => {
    try { if (!lstatSync(dir).isDirectory()) return false; accessSync(dir, fsConstants.W_OK); return true; } catch { return false; }
  };
  const free = (dir) => {
    try { const s = fsCapacity(dir); return Number(s.bavail) * Number(s.bsize); } catch { return 0; }
  };
  const planned = options.minimumFreeGib ?? 32;
  const minimum = Math.max(planned * GIB, unpacked * 3 + 2 * GIB);
  for (const name of hostOnly ? ['scratch'] : ['scratch', 'staging']) {
    const dir = options[name], freeBytes = dir ? free(dir) : 0;
    check(name+'-capacity', Boolean(dir && writable(dir) && freeBytes >= minimum), 'Writable local volume with adequate preflight headroom.',
      'Supply an existing writable '+name+' directory with the stated free bytes. This check does not reserve space.', { freeBytes, minimumBytes: minimum, appAllocatedBytes: unpacked || null });
  }

  const signingIdentity = typeof env.KINGMAKER_SIGN_IDENTITY === 'string' ? env.KINGMAKER_SIGN_IDENTITY : '';
  const identities = mac ? command('/usr/bin/security', ['find-identity','-v','-p','codesigning']) : {};
  const entries = String(identities.stdout ?? '').split('\n');
  const developerId = signingIdentity.startsWith('Developer ID Application:') && identities.status === 0 && entries.some((l) => l.includes('"'+signingIdentity+'"'));
  check('developer-id', developerId, 'Configured Developer ID identity is present in the usable local code-signing inventory.', 'Select the approved Developer ID Application identity on the owner release host; this does not attempt signing.');
  const appSigner = pin && identities.status === 0 && entries.some((l) => l.toUpperCase().includes(pin.sha1.toUpperCase()));
  check('app-signing-identity', Boolean(appSigner), 'Pinned Kingmaker app identity is in the local code-signing inventory.', 'Make the existing pinned Kingmaker signing identity available locally. Do not rotate pins or export keys to CI.');
  const profile = typeof env.KINGMAKER_NOTARY_PROFILE === 'string' ? env.KINGMAKER_NOTARY_PROFILE : '';
  const toolsOk = mac && command('/usr/bin/xcrun',['--find','notarytool']).status === 0 && command('/usr/bin/xcrun',['--find','stapler']).status === 0;
  const notaryOk = Boolean(toolsOk && profile && options.checkNotary && command('/usr/bin/xcrun',['notarytool','history','--keychain-profile',profile,'--output-format','json']).status === 0);
  if (hostOnly && !options.checkNotary && toolsOk) checks.push({id:'outer-notary',status:'not-checked',detail:'Apple tools present. Add --check-notary to verify the local profile with a read-only history query.'});
  else check('outer-notary', notaryOk, 'Outer installer: notarytool and stapler found; configured profile passed a read-only Apple history request.', 'Outer installer: use the approved notary profile and pass --check-notary to verify it read-only. Without verification, this gate remains blocked.');

  const hasEnroll = !hostOnly && enrollmentUrl(env.KINGMAKER_ENROLL_URL) && envHas(env, 'KINGMAKER_ENROLL_CODE');
  if (!hostOnly) check('enrollment-config', hasEnroll, 'An HTTPS enrollment URL and enrollment-code variable are configured; code value not read.', 'Configure the existing HTTPS enrollment endpoint and code variable on the approved host. This does not mint keys or validate the code.');

  if (hostOnly) return {
    phase,
    readyForOwnerBuild: checks.every((c) => c.status === 'pass' || c.status === 'not-checked'),
    readyForPublication: false, checks,
    publicationBlockers: ['Artifact phase, actual signing and notarization, signed staging, enrollment, and exact clean customer install are not verified.'],
    scope: 'Read-only host and acquisition input checks. No install, build, private key read, signing, upload, enrollment or publish performed.',
  };

  let manifest = null, signatureOk = false, packagePolicy = false, physicalOk = false, pubKeyFingerprint = null;
  const assets = options.staging;
  if (assets) {
    try {
      const path = join(assets, MANIFEST), raw = boundedFile(path, 1024 * 1024), sig = boundedFile(path+'.sig', 8 * 1024);
      if (raw && sig) {
        const key = publicKey(); pubKeyFingerprint = createHash('sha256').update(key).digest('hex');
        signatureOk = verifyManifestBytes(raw, sig.toString('utf8'), key);
        if (signatureOk) manifest = JSON.parse(raw);
      }
      if (manifest) {
        packagePolicy = Boolean(clean && manifest.tag === 'v'+pkg.version && manifest.requires?.arch === 'arm64' &&
          manifest.issuance?.tree?.commit === options.sourceCommit && manifest.app?.solomonBuild === engineBuild &&
          !manifestProblems(manifest).length && !issuanceProblems(manifest, {required: true}).length &&
          !shipProblems(manifest, {pkgVersion: pkg.version, pin, enroll: hasEnroll ? {url:'https://configured.invalid',code:'present'} : null}).length);
        const parts = manifest.parts;
        const launcher = manifest.launcher;
        if (packagePolicy && Array.isArray(parts) && parts.every((p) => SAFE_NAME.test(p.name) && regular(join(assets,p.name))) &&
            SAFE_NAME.test(launcher.archive) && regular(join(assets,launcher.archive))) {
          const lp = join(assets,launcher.archive);
          physicalOk = (await verifyParts(manifest, assets)).ok &&
            lstatSync(lp).size === launcher.size && await sha256File(lp) === launcher.sha256;
        }
      }
    } catch { /* never forward tool logs, untrusted file text, paths, or configuration values */ }
  }
  check('offline-signature', signatureOk, 'Exact manifest bytes verify against the embedded public key.', 'Place the paired manifest and detached signature from the approved offline signing lane in staging; no private key is needed here.', { publicKeyPemSha256: pubKeyFingerprint });
  check('manifest-policy', packagePolicy, 'Signed manifest version, source, architecture, runtime marker, and production ship policy agree.', 'Regenerate the signed manifest from the exact app/source; resolve production provenance/version/Launcher pin/enrollment policy mismatches.');
  check('staged-assets', physicalOk, 'Local staged payload parts and Launcher archive match the signed pins.', 'Stage the exact signed release parts and Launcher archive; every size and hash must match.');
  return {
    phase,
    readyForOwnerBuild: checks.every((c) => c.status === 'pass'),
    readyForPublication: false,
    checks,
    publicationBlockers: [
      ...(appCode && !innerDeveloperId ? ['The pinned inner app does not have a Developer ID authority. Outer installer notarization is not proof that the inner app passes Gatekeeper. Do not re-sign the inner app to a different identity; prove the approved exact distribution path on a clean Mac.'] : []),
      'Exact packaged app/tree equivalence, outer installer notarization/stapling, clean customer install/UI, enrollment and remote stage/promotion still require independent verification.',
    ],
    scope: 'Read-only prerequisites only. No publishing, signing, notarizing, device enrollment or remote writes were performed.',
  };
}

const FLAGS = new Map([['--phase','phase'],['--runtime-dir','runtimeDir'],['--runtime-plan','runtimePlan'],['--source','source'],['--source-commit','sourceCommit'],['--engine-source','engineSource'],['--engine-commit','engineCommit'],['--app','app'],['--build-receipt','buildReceipt'],['--scratch','scratch'],['--staging','staging'],['--minimum-free-gib','minimumFreeGib']]);
export function parseArgs(argv) {
  const out = {};
  for (let i=0; i<argv.length; i++) {
    const raw = argv[i];
    if (raw === '--check-notary' && !out.checkNotary) { out.checkNotary=true; continue; }
    const key = FLAGS.get(raw);
    const value = argv[++i];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(out,key)) throw Error('Invalid or repeated option.');
    if (key === 'phase') {
      if (value !== 'host' && value !== 'artifact') throw Error('Expected host or artifact phase.');
      out.phase=value;
    } else if (key === 'minimumFreeGib') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10000) throw Error('Minimum free GiB must be a positive integer within 1..10000.');
      out[key]=Number(value);
    } else out[key] = key.endsWith('Commit') ? value.toLowerCase() : resolve(value);
  }
  return out;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const out = await preflight(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(out, null, 2)); process.exitCode = out.readyForOwnerBuild ? 0 : 1;
  } catch { console.error('Preflight could not read the supplied configuration. Correct the options and try again.'); process.exitCode = 2; }
}
