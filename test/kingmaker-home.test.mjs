// One hidden Kingmaker folder (lib/kingmaker-home.mjs): nothing in sight; what an older version left out moves in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeFolder, kingmakerHome, tidyDesktop } from '../lib/kingmaker-home.mjs';
import { reportsDir } from '../lib/evidence.mjs';
import { officeDir } from '../lib/office.mjs';
import { imageLaneSetup } from '../lib/image-lane.mjs';

const H = '/U/me/Library/Application Support/sol-ghost/Files';
test('everything goes in Files inside the hidden data folder (or KINGMAKER_HOME / SOL_GHOST_HOME)', () => {
  assert.equal(kingmakerHome({}, '/U/me'), H);
  assert.equal(kingmakerHome({ SOL_GHOST_HOME: '/S' }, '/U/me'), '/S/Files');
  assert.equal(kingmakerHome({ KINGMAKER_HOME: '/Volumes/X/KM' }, '/U/me'), '/Volumes/X/KM');
  assert.equal(homeFolder('ads', { env: {}, home: '/U/me', make: false }), `${H}/Ads & Reels`);
  assert.equal(reportsDir({}, '/U/me'), `${H}/Reports`);
  assert.equal(officeDir({ home: '/U/me', env: {} }), `${H}/Documents`);
  assert.equal(imageLaneSetup({ state: '/S', env: {}, home: '/U/me', exists: () => false }).out, `${H}/Pictures`);
});

test('tidy: Desktop leftovers by Kingmaker\'s names only, and the old visible folders, all move in; never an overwrite', () => {
  const h = mkdtempSync(join(tmpdir(), 'km-home-')), desk = join(h, 'Desktop'), env = {};
  const hidden = kingmakerHome(env, h);
  mkdirSync(join(desk, 'Kingmaker — Reports'), { recursive: true });
  writeFileSync(join(desk, 'Kingmaker — Reports', 'r1.html'), 'x'); writeFileSync(join(desk, 'Kingmaker — Reports', '.DS_Store'), '');
  writeFileSync(join(desk, 'Kingmaker Ad 2026-10-15 12.00.mp4'), 'a');
  writeFileSync(join(desk, 'Kingmaker-pair-QR.png'), 'q');
  writeFileSync(join(desk, 'My taxes.pdf'), 'mine'); writeFileSync(join(desk, 'Screenshot 2026-10-15 at 1.00.00 PM.png'), 's');
  mkdirSync(join(h, 'Documents/Kingmaker/Ads & Reels'), { recursive: true });
  writeFileSync(join(h, 'Documents/Kingmaker/Ads & Reels/Kingmaker Ad 2026-10-15 12.00.mp4'), 'older');
  writeFileSync(join(h, 'Documents/Kingmaker/proposal.docx'), 'p');
  mkdirSync(join(h, 'Pictures/Kingmaker'), { recursive: true }); writeFileSync(join(h, 'Pictures/Kingmaker/poster.png'), 'i');
  const moved = tidyDesktop({ env, home: h });
  assert.equal(moved.length, 6);
  assert.deepEqual(readdirSync(desk).sort(), ['My taxes.pdf', 'Screenshot 2026-10-15 at 1.00.00 PM.png']);   // the owner's and macOS's stay
  assert.deepEqual(readdirSync(join(hidden, 'Ads & Reels')).sort(), ['Kingmaker Ad 2026-10-15 12.00 2.mp4', 'Kingmaker Ad 2026-10-15 12.00.mp4']);
  for (const f of ['Reports/r1.html', 'Phone/Kingmaker-pair-QR.png', 'proposal.docx', 'Pictures/poster.png']) assert.ok(existsSync(join(hidden, f)), f);
  assert.ok(!existsSync(join(h, 'Documents/Kingmaker')) && !existsSync(join(h, 'Pictures/Kingmaker')) && !existsSync(join(desk, 'Kingmaker — Reports')));
  assert.equal(tidyDesktop({ env, home: h }).length, 0);
});
