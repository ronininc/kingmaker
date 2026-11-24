import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTrainingContext } from '../lib/module-reader.mjs';

test('lean lookup reads one pinned bundled knowledge slice without cache or card materialization', async () => {
  const result = await readTrainingContext('no guessing rule method coverage', { maxParts: 1, maxChars: 2000 });
  assert.equal(result.stats.partsLoaded, 1);
  assert.equal(result.stats.partFilesRead.length, 1);
  assert.equal(result.stats.partFilesRead[0], 'reasoning-continuity-fundamentals/parts/no-guessing-rule.md');
  assert.ok(result.stats.bytesLoaded > 0 && result.stats.bytesLoaded <= 2000);
  assert.match(result.text, /copied character for character from a source/);
  assert.equal(result.parts[0].qualityScore, 96);
});
