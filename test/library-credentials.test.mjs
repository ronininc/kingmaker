import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialProvider, headersFor, noCredentials, redactError, tetherCredentialProvider } from '../lib/library-credentials.mjs';

test('the default provider reads no credential from the environment', async () => {
  const previous = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    KINGMAKER_LIBRARY_TOKEN: process.env.KINGMAKER_LIBRARY_TOKEN,
    KINGMAKER_BRAIN_LIBRARY_TOKEN: process.env.KINGMAKER_BRAIN_LIBRARY_TOKEN,
  };
  process.env.GITHUB_TOKEN = 'env-secret';
  process.env.KINGMAKER_LIBRARY_TOKEN = 'library-secret';
  process.env.KINGMAKER_BRAIN_LIBRARY_TOKEN = 'entitlement-secret';
  try {
    assert.equal(await noCredentials.credential(), null);
    const headers = headersFor('https://api.github.com/repos/ronininc/kingmaker-brain-library/releases/assets/1', { accept: 'application/octet-stream' }, null);
    assert.equal(headers.authorization, undefined);
    assert.equal(JSON.stringify(headers).includes('secret'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an injected credential is not attached to the release CDN and is redacted from errors', async () => {
  const provider = createCredentialProvider({ get: async () => 'super-secret-token' });
  const credential = await provider.credential();
  assert.equal(credential.header, 'authorization');
  assert.match(credential.value, /^Bearer super-secret-token$/);
  const api = headersFor('https://api.github.com/repos/ronininc/kingmaker-brain-library/releases/assets/1', {}, credential);
  const cdn = headersFor('https://release-assets.githubusercontent.com/signed', {}, credential);
  assert.match(api.authorization, /super-secret-token/);
  assert.equal(cdn.authorization, undefined);
  const error = redactError(new Error(`request failed authorization=${credential.value}`));
  assert.equal(error.message.includes('super-secret-token'), false);
});

test('the tether provider is a stub and does not read a token file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-'));
  const tokenPath = join(dir, 'kingmaker.sock.owner.token');
  writeFileSync(tokenPath, 'vault-secret\n', { mode: 0o600 });
  const provider = tetherCredentialProvider({ socketPath: join(dir, 'kingmaker.sock'), tokenPath });
  assert.equal(provider.wired, false);
  assert.equal(provider.kind, 'launcher-tether');
  assert.equal(await provider.credential(), null);
  assert.equal(JSON.stringify(provider).includes('vault-secret'), false);
});
