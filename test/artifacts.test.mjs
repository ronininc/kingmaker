import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isArtifactPath, kindOf, listArtifacts } from '../lib/artifacts.mjs';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'km-home-'));
  for (const d of ['Documents/Kingmaker/Ads', 'Pictures/Kingmaker', 'Desktop', 'rt/data/generated-media']) mkdirSync(join(h, d), { recursive: true });
  const put = (rel, t) => { const p = join(h, rel); writeFileSync(p, 'x'); utimesSync(p, t, t); return p; };
  put('Documents/Kingmaker/proposal.docx', 100); put('Documents/Kingmaker/Ads/brief.pdf', 400);
  put('Pictures/Kingmaker/poster.png', 300);
  put('Desktop/Kingmaker Ad 2026-10-15 12.11.mp4', 500); put('Desktop/taxes-2025.pdf', 600); put('Desktop/.hidden', 700);
  put('Desktop/Kingmaker Reel 9x16 2026-10-15.mp4', 800); put('Desktop/Kingmaker-Update-Setup.mp4x', 900);
  put('rt/data/generated-media/clip.mov', 200);
  return h;
}

test('only Kingmaker\'s own folders are listed, newest first; the Desktop gives only its ads', () => {
  const h = home();
  const list = listArtifacts({ home: h, runtimeHome: join(h, 'rt'), env: { SOLOMON_REPORTS_DIR: join(h, 'none') } });
  assert.deepEqual(list.map((a) => a.name), ['Kingmaker Reel 9x16 2026-10-15.mp4', 'Kingmaker Ad 2026-10-15 12.11.mp4', 'brief.pdf', 'poster.png', 'clip.mov', 'proposal.docx']);
  assert.deepEqual(list.map((a) => a.kind), ['video', 'video', 'document', 'image', 'video', 'document']);
  assert.equal(list.find((a) => a.name === 'poster.png').where, 'Pictures');
});

test('a delete can only reach those files', () => {
  const h = home(); const opts = { home: h, runtimeHome: join(h, 'rt'), env: {} };
  assert.equal(isArtifactPath(join(h, 'Pictures/Kingmaker/poster.png'), opts), true);
  assert.equal(isArtifactPath(join(h, 'Desktop/Kingmaker Ad 2026-10-15 12.11.mp4'), opts), true);
  assert.equal(isArtifactPath(join(h, 'Desktop/taxes-2025.pdf'), opts), false, 'not an ad');
  assert.equal(isArtifactPath(join(h, 'Pictures/Kingmaker/../../Documents/secret.txt'), opts), false);
  assert.equal(isArtifactPath(join(h, 'Pictures/Kingmaker'), opts), false, 'not the folder itself');
  assert.equal(kindOf('a.HEIC'), 'image');
});
