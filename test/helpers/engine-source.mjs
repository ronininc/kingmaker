// Where the tests find the engine's source, and a visible skip reason when it is not there.
//
// A public Kingmaker checkout does not carry the engine: solomon/ is written by the operator import
//   node scripts/import-solomon.mjs --from ~/Projects/TSS --ref <commit>
// (lib/fork.mjs FORK_DIR; never exported). Tests that check the imported tree look there first, or at
// KINGMAKER_ENGINE_SRC (the same variable test/owner-keys.proof.mjs, test/owner-voice.test.mjs and
// scripts/release-parts.mjs read) when it points at an imported engine tree elsewhere on this machine.
// When neither has what a test needs, the test is SKIPPED with a reason naming the missing file: a skip,
// not a pass, so the run's skip count shows the engine checks did not happen.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { forkLayout } from '../../lib/fork.mjs';

const candidates = [forkLayout().root, process.env.KINGMAKER_ENGINE_SRC && resolve(process.env.KINGMAKER_ENGINE_SRC)].filter(Boolean);

/** The engine root holding every one of `files` (relative paths), or null. */
export function engineRootWith(...files) {
  return candidates.find((root) => files.every((f) => existsSync(join(root, f)))) ?? null;
}

/** False when an engine root holds every one of `files`; otherwise the skip reason to show. */
export function engineSkip(...files) {
  if (engineRootWith(...files)) return false;
  return `skipped: the engine source is not imported (needs ${files.join(', ')} under ${candidates.join(' or ')}; run scripts/import-solomon.mjs or set KINGMAKER_ENGINE_SRC to an imported engine tree)`;
}
