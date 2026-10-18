// Kingmaker's Chrome connector, bootstrapped the same way the window app does it, with the same code:
// the bundle's desktop/chrome-connector-setup.mjs and desktop/chrome-extension-update.mjs, imported from
// the installed app (Kingmaker runs as Electron-as-Node, so the asar is readable). The extension's native
// host talks to the engine's server on 127.0.0.1:3001, not to a window, so Kingmaker serves it as-is.
//
// Setup writes the native-messaging host manifest and the connector's folder on the Desktop (the engine's setup names it).
// Chrome lets only you add an unpacked extension: chrome://extensions → Developer mode → Load unpacked →
// that folder, once. After that every Kingmaker start keeps the loaded copy current (as the window does).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function bundleModules(paths) {
  const desk = paths.desktopModules;
  const setup = await import(pathToFileURL(join(desk, 'chrome-connector-setup.mjs')).href);
  const update = await import(pathToFileURL(join(desk, 'chrome-extension-update.mjs')).href);
  return { setup, update };
}

export function connectorSources(paths, supportDir, home = homedir()) {
  const root = join(paths.resources, 'chrome-connector');
  const fork = paths.runtimeSource === 'fork';
  return {
    bundledDir: fork ? paths.fork.extension : join(root, 'extensions', 'solomon-google-browser'),
    nativeHostSource: fork ? paths.fork.nativeHost : join(root, 'desktop', 'chrome-native-host.mjs'),
    supportDir,
    legacyFolder: join(home, 'Desktop', 'Solomon Chrome Connector'),
  };
}

/** Pure: one plain line for a sync status. */
export function connectorLine(status) {
  switch (status?.state) {
    case 'not-set-up': return 'Chrome connector: not set up. Run `kingmaker chrome` once.';
    case 'missing': return 'Chrome connector: the loaded folder is gone. Run `kingmaker chrome` to put it back.';
    case 'held': return `Chrome connector: update held (${status.reason ?? 'needs your review'}).`;
    case 'needs-click': return 'Chrome connector: updated. Click reload on it in chrome://extensions once.';
    case 'updated': return `Chrome connector: updated to ${status.version ?? 'the bundled version'}.`;
    default: return status?.state ? `Chrome connector: ${status.state}${status.version ? ` (${status.version})` : ''}.` : 'Chrome connector: status unknown.';
  }
}

/** Keep an installed connector current (every start), or set it up first when `setup` is asked for. */
export async function syncChromeConnector(paths, { setup = false } = {}) {
  const { setup: s, update: u } = await bundleModules(paths);
  const supportDir = s.chromeConnectorSupportDir();
  const sources = connectorSources(paths, supportDir);
  let created = null;
  // runtime = the binary the native host runs under; the window app passes its own, Kingmaker the same one.
  // runtime = what runs the native host: this Node in fork mode, the app's binary (as Node) otherwise.
  if (setup) created = s.setupChromeConnector({ source: sources.bundledDir, nativeSource: sources.nativeHostSource, runtime: paths.runtimeSource === 'fork' ? process.execPath : paths.binary });
  // A bundle ships a signed integrity record for its extension; the source tree is its own truth, so fork
  // mode computes the record from the files themselves (the same function the build uses).
  const trust = paths.runtimeSource === 'fork'
    ? { integrity: u.buildExtensionIntegrity({ extensionDir: sources.bundledDir, nativeHostPath: sources.nativeHostSource }), pinned: null }
    : u.loadBundleTrust({
      integrityPath: join(paths.runtimeDir ?? join(paths.resources, 'solomon-runtime'), 'chrome-connector', u.INTEGRITY_FILE),
      updateManifestPath: join(paths.runtimeDir ?? join(paths.resources, 'solomon-runtime'), 'solomon-update-manifest.json'),
    });
  const status = u.syncInstalledExtension({ ...sources, integrity: trust.integrity, pinned: trust.pinned });
  return { status, line: connectorLine(status), created };
}
