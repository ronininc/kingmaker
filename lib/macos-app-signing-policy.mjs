// Read-only app signer preflight. A pass is not authorization to release.
// Deliberately not wired into any default installer, updater, or publication lane.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KINGMAKER_BUNDLE_ID, appRequirement } from './release-identity.mjs';

const TEAM = /^[A-Z0-9]{10}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const HEX40 = /^[A-Fa-f0-9]{40}$/;
const APPLE_DEVELOPER_ID_OID = '1.2.840.113635.100.6.1.13';
const APPLE_DEVELOPER_ID_CA_OID = '1.2.840.113635.100.6.2.6';

export function appSigningPolicy(opts = {}) {
  const { lane, expectedVersion, expectedTeam, legacyLeaf } = opts;
  if (typeof expectedVersion !== 'string' || !VERSION.test(expectedVersion)) throw new Error('Pin the exact release version.');
  if (lane === 'developer-id') {
    if (typeof expectedTeam !== 'string' || !TEAM.test(expectedTeam) || legacyLeaf !== undefined) throw new Error('Select exactly one approved Developer ID Team ID.');
    // Apple TN3127: valid Apple anchor, exact app ID, Developer ID issuing CA,
    // Developer ID Application leaf extension, and exact Apple Team ID.
    const requirement = `identifier "${KINGMAKER_BUNDLE_ID}" and anchor apple generic and certificate 1[field.${APPLE_DEVELOPER_ID_CA_OID}] exists and certificate leaf[field.${APPLE_DEVELOPER_ID_OID}] exists and certificate leaf[subject.OU] = "${expectedTeam}"`;
    return Object.freeze({ lane, expectedVersion, expectedTeam, requirement });
  }
  if (lane === 'legacy') {
    if (typeof legacyLeaf !== 'string' || !HEX40.test(legacyLeaf) || expectedTeam !== undefined) throw new Error('Select exactly one legacy leaf pin.');
    return Object.freeze({ lane, expectedVersion, requirement: appRequirement(legacyLeaf) });
  }
  throw new Error('Explicitly select developer-id or legacy; there is no default or dual-trust fallback.');
}

function show(r) { return String(r?.stdout ?? '') + '\n' + String(r?.stderr ?? ''); }
function pass(r) { return r?.status === 0; }

export function preflightAppSigner(appPath, opts, { run = spawnSync, platform = process.platform } = {}) {
  const policy = appSigningPolicy(opts);
  if (platform !== 'darwin') return { ok: false, lane: policy.lane, problems: ['Actual verification requires macOS.'] };
  const invoke = (bin, args) => run(bin, args, { encoding: 'utf8', timeout: 30_000 });
  const pl = key => invoke('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')]);
  const release = pl('CFBundleShortVersionString');
  const bundle = pl('CFBundleIdentifier');
  const strict = invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const exact = invoke('/usr/bin/codesign', ['--verify', '--strict', `-R=${policy.requirement}`, appPath]);
  const detailResult = invoke('/usr/bin/codesign', ['-d', '--verbose=4', appPath]);
  const details = show(detailResult);
  const problems = [];
  if (!pass(release) || release.stdout.trim() !== policy.expectedVersion) problems.push('bundle version differs from the selected release');
  if (!pass(bundle) || bundle.stdout.trim() !== KINGMAKER_BUNDLE_ID || !/^Identifier=com\.ronininc\.solghost$/m.test(details)) problems.push('bundle identifier differs');
  if (!pass(strict)) problems.push('strict nested code signature verification failed');
  if (!pass(exact)) problems.push('selected app signer requirement failed');
  if (!pass(detailResult) || /^Signature=adhoc$/m.test(details)) problems.push('signature details missing, unsigned, or ad-hoc');
  if (!/flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/i.test(details)) problems.push('hardened runtime is missing');
  if (policy.lane === 'developer-id') {
    if (!details.split(/\r?\n/).includes(`TeamIdentifier=${policy.expectedTeam}`)) problems.push('Developer ID TeamIdentifier differs');
    if (!/^Timestamp=\S.+$/m.test(details)) problems.push('secure timestamp is missing');
    const assess = invoke('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    if (!pass(assess) || !/^source=Notarized Developer ID\s*$/m.test(show(assess))) problems.push('Gatekeeper did not accept the app as Notarized Developer ID');
    const stapled = invoke('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    if (!pass(stapled)) problems.push('app stapled ticket validation failed');
  }
  return { ok: problems.length === 0, lane: policy.lane, problems };
}
