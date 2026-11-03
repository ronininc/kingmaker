#!/usr/bin/env node
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine build owns these resources. sol-ghost is deliberately separate: it
// comes from the signature/hash-verified Kingmaker payload after this check.
export const ENGINE_RUNTIME_COMPONENTS = Object.freeze([
  'kingmaker-runtime',
  'voice-runtime',
  'guardrails-runtime',
  'guardrails-config',
  'agent-runtime',
  'knowledge-runtime',
  'playwright-browsers',
  'chrome-connector',
  'app.asar',
]);

export const REQUIRED_RUNTIMES = Object.freeze([...ENGINE_RUNTIME_COMPONENTS, 'sol-ghost']);

// Markers are files the product actually opens, not sentinel files made only to
// satisfy packaging. Generic components must additionally contain a real file.
export const COMPONENT_MARKERS = Object.freeze({
  'kingmaker-runtime': Object.freeze(['server/index.mjs', 'app/dist/index.html']),
  'voice-runtime': Object.freeze(['stt/whisper-cli', 'models/stt/ggml-base.bin']),
  'app.asar': Object.freeze(['desktop/headless-server.mjs']),
});

function realFiles(root, relative = '') {
  const dir = relative ? join(root, relative) : root;
  const found = [];
  for (const name of readdirSync(dir)) {
    const rel = relative ? `${relative}/${name}` : name;
    const st = lstatSync(join(root, rel));
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error(`unsafe runtime entry: ${rel}`);
    if (st.isDirectory()) found.push(...realFiles(root, rel));
    else found.push(rel);
  }
  return found;
}

export function validateEngineRuntimeClosure(root) {
  root = resolve(root);
  for (const component of ENGINE_RUNTIME_COMPONENTS) {
    const path = join(root, component);
    let st;
    try { st = lstatSync(path); } catch { throw new Error(`engine resource tree is incomplete: missing ${component}`); }
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error(`engine resource component is unsafe: ${component}`);
    for (const marker of COMPONENT_MARKERS[component] ?? []) {
      let markerStat;
      try { markerStat = lstatSync(join(path, marker)); } catch { throw new Error(`engine resource tree is incomplete: missing ${component}/${marker}`); }
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size === 0) throw new Error(`engine runtime marker is not a nonempty regular file: ${component}/${marker}`);
    }
    const files = st.isFile() ? [component] : realFiles(path);
    if (!files.length) throw new Error(`engine resource component is empty: ${component}`);
  }
  return { root, components: [...ENGINE_RUNTIME_COMPONENTS] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateEngineRuntimeClosure(process.argv[2] ?? '');
    console.log(`verified ${result.components.length} engine runtime components at ${result.root}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
