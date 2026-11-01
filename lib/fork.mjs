// Fork mode: run the engine's server straight from the engine's source, imported into this checkout with its UI
// stripped (an operator-only mode). No app bundle and no window code are involved.
//
// The environment is the headless launcher's own: the source's desktop/headless-server.mjs exports
// ensureRuntimeBootstrap() and buildBackendEnv(), the same functions the packaged no-window server uses.
// Only what a build step would have produced is pointed back at the source tree here.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The folder an operator checkout carries the engine's source in (scripts/import-*.mjs writes it; never exported). */
export const FORK_DIR = 'solomon';

export function forkLayout(repoRoot = REPO_ROOT) {
  const root = join(repoRoot, FORK_DIR);
  return {
    root,
    serverEntry: join(root, 'server', 'src', 'index.ts'),
    tsx: join(root, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    desktop: join(root, 'desktop'),
    sidecars: join(root, 'server', 'voice-sidecar'),
    extension: join(root, 'extensions', 'solomon-google-browser'),
    nativeHost: join(root, 'desktop', 'chrome-native-host.mjs'),
    knowledgeFields: join(root, 'contracts', 'knowledge-fields.json'),
  };
}

/** Is the engine's source here to run? (`installed` = its server dependencies are in place too.) */
export function forkState(repoRoot = REPO_ROOT, exists = existsSync) {
  const f = forkLayout(repoRoot);
  const present = exists(f.serverEntry);
  return { present, installed: present && exists(f.tsx), layout: f };
}

/** Kingmaker runs the engine as its noncommercial developer edition: PAID_CORE's gating, its own label. */
export const KINGMAKER_RUNTIME_EDITION = 'DEV_NONCOMMERCIAL';

/**
 * The server's env and argv in fork mode. `resources` is where native runtimes live (voice binaries,
 * guardrails, knowledge venv): an installed Solomon.app's Resources until Ghost builds its own.
 */
export async function forkBackendLaunch({ env, runtimeHome, resources, port, searchPort = 8890, runtimeEdition = KINGMAKER_RUNTIME_EDITION, runtimeSurface = 'merchant', repoRoot = REPO_ROOT, exists = existsSync }) {
  const f = forkLayout(repoRoot);
  const hs = await import(pathToFileURL(join(f.desktop, 'headless-server.mjs')).href);
  const bootstrap = hs.ensureRuntimeBootstrap({ runtimeHome, env, port, searchPort, runtimeEdition, runtimeSurface });
  const layout = { packaged: false, resourceRoot: resources, runtimeBundleRoot: f.root, frontendDist: '', authorityBootstrapPath: '', buildStampPath: '' };
  const base = hs.buildBackendEnv({ env, layout, bootstrap, port, searchPort, runtimeEdition, runtimeSurface, exists });
  // Built artifacts the source run does not have: there is no UI to serve, no build stamp, no generated
  // knowledge foundation. Unset rather than point at files that do not exist.
  for (const key of ['SOLOMON_FRONTEND_DIST', 'SOLOMON_AUTHORITY_BOOTSTRAP_PATH', 'SOLOMON_BUILD_STAMP_PATH', 'SOLOMON_KNOWLEDGE_FOUNDATION_ROOT']) delete base[key];
  // The build copies these workers next to the bundled server; in the source tree they live in voice-sidecar/.
  const sidecar = (name) => join(f.sidecars, name);
  Object.assign(base, {
    SOLOMON_PACKAGED_RUNTIME: '0',
    SOLOMON_MEDIAPIPE_WORKER: sidecar('mediapipe_task_context.py'),
    SOLOMON_RIVER_WORKER: sidecar('river_routing_worker.py'),
    SOLOMON_DIMOS_MCP_SCRIPT: sidecar('dimos_mcp_server.py'),
    SOLOMON_DIMOS_SKILLS_SCRIPT: sidecar('dimos_skills.py'),
    SOLOMON_OPEN3D_WORKER: sidecar('open3d_spatial_worker.py'),
    ...(exists(f.knowledgeFields) ? { SOLOMON_KNOWLEDGE_FIELDS: f.knowledgeFields } : {}),
  });
  return {
    env: base,
    bootstrap,
    args: ['--experimental-sqlite', '--disable-warning=DEP0040', `--env-file=${bootstrap.envPath}`, f.tsx, f.serverEntry],
    layout: f,
  };
}
