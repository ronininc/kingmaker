import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browseTarget, describeBrowse, openDesktopWall } from '../lib/evidence.mjs';
import { createOwnerSession } from '../lib/session.mjs';

const secrets = { nonce: 'n'.repeat(64), voiceKey: 'k'.repeat(64) };

test('only data.liveWebBrowse.url opens, and only an http(s) page without credentials', () => {
  const raw = (lwb, extra = {}) => ({ ok: true, data: { spokenResponse: 'See https://evil.example/x', ...extra, ...(lwb === undefined ? {} : { liveWebBrowse: lwb }) } });
  assert.deepEqual(browseTarget(raw({ url: 'https://www.bbc.com/news' })), { kind: 'url', target: 'https://www.bbc.com/news', browse: true });
  assert.deepEqual(browseTarget(raw({ url: 'http://example.org' })), { kind: 'url', target: 'http://example.org/', browse: true });
  assert.equal(browseTarget(raw(undefined)), null, 'a link in the answer text is never opened');
  assert.equal(browseTarget(raw(undefined, { output: { liveWebBrowse: { url: 'https://a.example' } } })), null, 'only the turn\'s own directive field');
  assert.equal(browseTarget(raw({ url: null })), null, '"open the browser" with no site opens nothing');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example/', 'https://user:pw@bank.example/', 'not a url', 'x'.repeat(3000)]) {
    assert.equal(browseTarget(raw({ url: bad })), null, bad.slice(0, 30));
  }
  assert.equal(describeBrowse({ where: 'desktop' }), "It's open in Chrome.");
  assert.equal(describeBrowse({ where: null }), '');
});

test('chromeOnly: when Chrome cannot open it, no other browser does and nothing is claimed', async () => {
  const launched = [];
  const wall = await openDesktopWall([{ kind: 'url', target: 'https://example.org/', browse: true }], {
    exec: async () => { throw new Error('not allowed to control Chrome'); },
    launch: async (args) => { launched.push(args); return true; },
    chromeOnly: true,
  });
  assert.equal(wall.where, null);
  assert.deepEqual(launched, [], 'Chrome only; never the default browser');
  assert.equal(describeBrowse(wall), '');
});

test('a turn that says to open a site opens it in Chrome and says so only after it opened', async () => {
  const lines = [];
  const opens = [];
  let opensOk = true;
  const session = createOwnerSession({
    port: 3001, secrets, runtimeHome: null, voiceOut: false, out: (l) => lines.push(l),
    turnImpl: async () => ({ ok: true, spoken: 'Opening bbc.com.', raw: { ok: true, data: { liveWebBrowse: { url: 'https://bbc.com' } } } }),
    openWall: async (targets, opts) => { opens.push({ targets, chromeOnly: opts.chromeOnly }); return { where: opensOk ? 'desktop' : null, windows: opensOk ? 1 : 0, report: false, apps: 0 }; },
  });
  await session.runTurn('open bbc.com', { owner: true });
  assert.deepEqual(opens, [{ targets: [{ kind: 'url', target: 'https://bbc.com/', browse: true }], chromeOnly: true }]);
  assert.equal(lines.at(-1), "  ◆ Opening bbc.com. It's open in Chrome.");
  opensOk = false;
  await session.runTurn('open bbc.com', { owner: true });
  assert.equal(lines.at(-1), '  ◆ Opening bbc.com.', 'nothing claimed when it did not open');
});

test('with the bar (onLinks) a research answer opens nothing: its sources are listed, and the line says so', async () => {
  const lines = []; const opens = []; const listed = [];
  const session = createOwnerSession({
    port: 3001, secrets, runtimeHome: null, voiceOut: false, out: (l) => lines.push(l),
    turnImpl: async () => ({ ok: true, spoken: 'Phoenix hit 118°F.', raw: { ok: true, data: { answerEvidence: { sources: [{ url: 'https://weather.example/phx', state: 'ONLINE_PROVEN', title: 'PHX heat record' }] } } } }),
    openWall: async (targets) => { opens.push(targets); return { where: 'chrome', windows: 1, pages: 1, apps: 0 }; },
    onLinks: (links) => listed.push(links),
  });
  await session.runTurn('how hot did phoenix get', { owner: true });
  assert.deepEqual(opens, [], 'no tab opened by itself');
  assert.deepEqual(listed, [[{ kind: 'page', title: 'PHX heat record', url: 'https://weather.example/phx' }]]);
  assert.equal(lines.at(-1), '  ◆ Phoenix hit 118°F. The sources are in the bar.');
});
