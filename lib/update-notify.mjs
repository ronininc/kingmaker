/**
 * Launcher update notification — pure check logic.
 *
 * Compares the installed version against the release manifest and decides
 * whether the user should be told an update exists. The launcher owns the
 * UI (menu bar badge, dialog); this module owns the decision, so it is
 * testable without the app running.
 *
 * Manifest shape: { version: "0.4.0", ... } — kingmaker-manifest.json.
 * Versions compare as numeric dot-separated parts.
 *
 * Pure functions. No I/O, no network.
 */

/** Compare two dot-separated versions. -1 / 0 / 1. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Decide whether an update notification is warranted.
 *
 * @param {Object} args
 * @param {string} args.installedVersion - currently installed version
 * @param {Object} args.manifest - parsed manifest ({ version })
 * @param {string} [args.lastNotifiedVersion] - version already notified about
 * @returns {{ notify: boolean, latestVersion: string|null, reason: string }}
 */
export function checkForUpdate({ installedVersion, manifest, lastNotifiedVersion }) {
  const latestVersion =
    manifest && typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (latestVersion === '') {
    return { notify: false, latestVersion: null, reason: 'no-version-in-manifest' };
  }
  if (String(installedVersion || '').trim() === '') {
    return { notify: false, latestVersion, reason: 'unknown-installed-version' };
  }
  if (compareVersions(installedVersion, latestVersion) >= 0) {
    return { notify: false, latestVersion, reason: 'up-to-date' };
  }
  if (lastNotifiedVersion && compareVersions(lastNotifiedVersion, latestVersion) >= 0) {
    return { notify: false, latestVersion, reason: 'already-notified' };
  }
  return { notify: true, latestVersion, reason: 'update-available' };
}
