import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../lib/phone-companion.mjs';
import { PHONE_ICON, PHONE_ICON_SIZE } from '../lib/phone-icon.mjs';

const pngSize = (b) => { assert.equal(b.subarray(1, 4).toString(), 'PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('the icon the phone is served is really as big as the manifest says', { timeout: 30_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-companion-icon-'));
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', tailscale: () => null, tailscaleEvery: 0 });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const up = await companion.start();
  const ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const get = (url) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? request : httpGet)(u, u.protocol === 'https:' ? { ca } : {}, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); });
    req.on('error', reject); if (req.end) req.end();
  });
  const app = new URL(up.app).origin;
  const manifest = JSON.parse((await get(`${app}/manifest.webmanifest`)).body.toString());
  const entry = manifest.icons.find((i) => i.src === '/icon.png');
  assert.ok(entry, 'the manifest lists /icon.png');
  const icon = await get(`${app}/icon.png`);
  assert.equal(icon.status, 200);
  const [w, h] = pngSize(icon.body);
  assert.equal(`${w}x${h}`, entry.sizes, 'the served icon is exactly the size the manifest declares');
  assert.equal(w, h, 'square');
  assert.equal(w, PHONE_ICON_SIZE);
});

test('the companion\'s default is the square icon, and the engine and the by-hand script serve the square icon, not the raw crest', () => {
  for (const f of ['lib/phone-companion.mjs', 'lib/cli.mjs', 'scripts/phone-companion.mjs', 'scripts/phone-preview.mjs']) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /PHONE_ICON/, f);
});
