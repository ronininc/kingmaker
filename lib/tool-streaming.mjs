// lib/tool-streaming.mjs — the tool-streaming provider (tool streaming, 2026-11-11): the
// live path between the Brain Library's tool items and the method conductor.
//
// Before this module, lib/brain-library-access.mjs had NO production caller for tool
// items — it could portion models/training/methods for Data Sets, but nothing in the
// running system ever pulled a tool. The provider is that caller:
//
//   createMethodConductor() builds ONE default provider (this module) unless a caller
//   injects its own — and lib/execution-loop.mjs creates its conductor with no args,
//   so every production conduction carries it. When a conducted step's check-tool
//   misses on PATH, the conductor asks the provider; when a step was declared only
//   because its tool was missing, a tool pulled during that same conduction executes
//   the step for real. `kingmaker tools library pull <id>` (lib/bench-cli.mjs) drives
//   the same provider from the CLI.
//
// The provider is lazy and fail-soft by construction: it reads the tools catalog on
// first use, builds the access layer only when a STAGED tool is actually pulled, and
// answers null for anything not streamable — absence of a catalog, an unstaged
// payload, or an unwritable state dir changes no existing behavior; the step simply
// stays declared, exactly as it did before tools could stream.
//
// State layout (under the Kingmaker state dir, lib/paths.mjs resolvePaths().state,
// overridable per provider — tests and fixtures always override):
//   <state>/brain-library/store/         access-layer residents (pulled archives, hash-accepted)
//   <state>/brain-library/cache/         the bounded stream cache
//   <state>/brain-library/tools/         materialized tool trees + tools-registry.json
//   <state>/brain-library/tool-payloads/ the staged payload store parts are pulled FROM
//                                        (KINGMAKER_TOOL_PAYLOAD_DIR overrides)

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolsIndex, toolForCommand, toolPlatformKey } from './brain-library.mjs';
import { buildCatalogSources, createBrainLibraryAccess } from './brain-library-access.mjs';
import { materializeTool } from './brain-library-fetch.mjs';
import { resolvePaths } from './paths.mjs';

export function createToolStreamingProvider({
  catalogDir = fileURLToPath(new URL('../catalog/', import.meta.url)),
  stateDir = null,
  toolPayloadDir = null,
  toolsDir = null,
  toolsIndex = null,
  platform = toolPlatformKey(),
  addConnector = null,
  log = () => {},
} = {}) {
  const stateRoot = stateDir ?? resolvePaths().state;
  const payloadDir = toolPayloadDir ?? process.env.KINGMAKER_TOOL_PAYLOAD_DIR ?? join(stateRoot, 'brain-library', 'tool-payloads');
  const toolsRoot = toolsDir ?? join(stateRoot, 'brain-library', 'tools');
  let toolsCache = null;
  let accessP = null;
  const ensured = new Map(); // command -> Promise<result|null>

  function tools() {
    if (toolsCache) return toolsCache;
    try { toolsCache = toolsIndex ?? loadToolsIndex({ indexUrl: new URL('tools/index.json', `file://${catalogDir}`) }); }
    catch { toolsCache = []; }
    return toolsCache;
  }
  /** The catalog tool providing `command`, or null. Pure catalog lookup, no state touched. */
  function findTool(command) { return toolForCommand(tools(), command); }
  /** The catalog tool with this exact id, or null. */
  function toolById(id) { return tools().find((t) => t.id === id) ?? null; }

  function access() {
    accessP ??= (async () => {
      const sources = await buildCatalogSources({ catalogDir, toolPayloadDir: payloadDir, toolsIndex: tools() });
      return createBrainLibraryAccess({
        sources,
        storeDir: join(stateRoot, 'brain-library', 'store'),
        cacheDir: join(stateRoot, 'brain-library', 'cache'),
        stateDir: stateRoot,
      });
    })();
    return accessP;
  }

  /**
   * Ensure the tool providing `command` is materialized locally.
   * → null                       the catalog has no tool providing this command
   * → { staged: false, … }       the catalog has it, but this platform's payload is
   *                              declared-not-staged (or undeclared): nothing pullable
   * → { staged: true, … }        pulled, hash-verified, unpacked, registered
   * Throws only on a real pull failure (hash mismatch, corrupt archive) — the
   * conductor records that in the step's trace and the step stays unexecuted.
   */
  function ensureTool(command) {
    if (ensured.has(command)) return ensured.get(command);
    const p = (async () => {
      const tool = findTool(command);
      if (!tool) return null;
      const payload = tool.platforms?.[platform];
      if (!payload) return { staged: false, tool, platform, reason: `${tool.id} declares no build for ${platform}` };
      if (payload.payloadStatus !== 'staged') return { staged: false, tool, platform, reason: `${tool.id} ${tool.version} for ${platform} is declared-not-staged — the payload packaging step has not staged it` };
      const m = await materializeTool(await access(), tool, { platform, toolsDir: toolsRoot, addConnector, log });
      return { staged: true, tool, platform, ...m };
    })();
    ensured.set(command, p);
    return p;
  }

  return { findTool, toolById, ensureTool, platform, toolsDir: toolsRoot, toolPayloadDir: payloadDir, stateDir: stateRoot };
}

/** The conductor's default provider: creation never throws (an inert provider otherwise). */
export function defaultToolProvider(opts = {}) {
  try { return createToolStreamingProvider(opts); }
  catch { return { findTool: () => null, toolById: () => null, ensureTool: async () => null, platform: toolPlatformKey() }; }
}
