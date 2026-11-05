import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../dashboard.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../dashboard-view.mjs', import.meta.url), 'utf8');

test('dashboard uses only the shared Ronin Armor checkout routes', () => {
  assert.match(source, /https:\/\/www\.ronininc\.org\/armor\/checkout\?purpose=download/);
  assert.match(source, /https:\/\/www\.ronininc\.org\/armor\/checkout\?purpose=discord-membership/);
  assert.doesNotMatch(source, /dot\.cards|cash\.app|whop\.com|stripe\.com/i);
});

test('checkout return is not represented as an entitlement or activation grant', () => {
  assert.match(source, /Returning from payment does not activate this installation/);
  assert.doesNotMatch(source, /payment(?:Return|Success|Complete).*activated\s*=\s*true/is);
});

test('activation requires the remote entitlement verifier and keeps Discord admission separate', () => {
  assert.match(source, /verifyEntitlement:\s*\(\) => account\.verifyEntitlement\(\)/);
  assert.match(source, /Protected Discord admission remains a separate verified security step/);
  assert.match(source, /alreadyActive/);
  assert.match(source, /hasPaidActivation\(identityDir, currentIdentity\)/);
  assert.doesNotMatch(source, /dot\.cards|cash\.app|whop\.com|stripe\.com/i);
});
