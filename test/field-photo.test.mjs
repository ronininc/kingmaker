// A photo from the phone app's camera, end to end (lib/phone-companion.mjs → lib/cli.mjs typed-turn → lib/field-photo.mjs):
// the upload lands where the runtime reads image.path from (Field/<tenant>), rides the next turn (typed or spoken), and
// reaches the tool that can use it — the vision lane (describe), the same lane reading text (OCR), a copy in Kingmaker's
// files, a CRM job with it attached, the image lane drawing from it, a cloud brain that sees — never the local writer,
// which can't (soak 2026-10-16: "Did you get the image I just sent you?" → "No, I didn't receive the image").
// The model, the runtime and the CRM are mocks here; the Mac's own `sips` converts a real HEIC when it is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCompanion } from '../lib/phone-companion.mjs';
import { NO_VISION_LINE, PHOTO_TTL_MS, fieldPhotoTurn, jobAttachment, lookText, photoFresh, photoIntent, saveFolder, savePhoto, uploadType, visionCopy, visionReady, withPath } from '../lib/field-photo.mjs';
import { turn } from '../lib/client.mjs';
import { homeFolder } from '../lib/kingmaker-home.mjs';
import { makeImage } from '../lib/image-lane.mjs';
import { claudeArgs, createClaudeBrain } from '../lib/claude-brain.mjs';
import { codexArgs } from '../lib/chatgpt-brain.mjs';

// CRM jobs are the Ronin add-on's: where it isn't in the checkout, the photo's CRM-job steps are skipped.
const crmJobs = await import('../addons/ronin/test/_bind.mjs').then(() => import('../addons/ronin/crm-jobs.mjs')).catch(() => null);

const at = (p) => new URL(`../${p}`, import.meta.url);
const CREST = at('assets/ronin-inc-crest.png');
const SIPS = '/usr/bin/sips';

// The bundled runtime's vision-lane trigger (solomon-runtime, 2026-10-17: the turn goes to local vision only when its
// words match this), the part Kingmaker's framing relies on: "look at / read … this photo I just sent".
const RUNTIME_VISION = /\b(?:look\s+at|check\s+out|read|describe|what(?:'?s|\s+is)\s+(?:in|on|wrong\s+with)|what\s+do\s+you\s+(?:see|make\s+of)|tell\s+me\s+about)\b[^?.!]*\b(?:this|that|the|my|these|those)\s+(?:[\w'-]+\s+){0,2}(?:image|images|photo|photos|pic|pics|picture|pictures|screenshot|snap|snapshot|shot)(?=\s*(?:[?.!,:;]|$)|\s+(?:i\s+(?:just\s+)?(?:sent|uploaded|shared|took)|i\s+sent\s+you|you\s+sent|here|above|attached)\b)/i;
// The runtime's rule for image.path: inside <SOLOMON_FIELD_UPLOAD_DIR>/<tenantId>, realpath-checked.
function runtimeResolves(image, { uploadDir, tenantId }) {
  const root = resolve(uploadDir, tenantId.replace(/[^\w.-]/g, '_')), abs = resolve(root, image.path);
  try { const rel = relative(realpathSync(root), realpathSync(abs)); return rel && !rel.startsWith('..') && !isAbsolute(rel) ? realpathSync(abs) : null; } catch { return null; }
}

function call(ca, { port, method = 'GET', path, body = null, type = null, cookie = null }) {
  return new Promise((done, reject) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(type !== null ? { 'content-type': type } : body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}) };
    const req = request({ host: '127.0.0.1', port, method, path, ca, agent: false, headers }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (d) => { data += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } done({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    req.on('error', reject);
    req.end(body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}
async function pairedPhone(t, opts = {}) {
  const state = mkdtempSync(join(tmpdir(), 'km-field-'));
  const turns = [];
  const voice = { hear: async (buf) => (buf.length ? 'what does the sign say' : ''), speak: async () => null };
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, tailscale: () => null, voice, onTurn: (text, meta) => { turns.push({ text, meta }); }, ...opts });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const up = await companion.start();
  const port = Number(new URL(up.app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const code = (await call(ca, { port, method: 'POST', path: '/admin/pair-link' })).json.code;
  const paired = await call(ca, { port, method: 'POST', path: '/pair-code', body: { code } });
  const cookie = /km=[a-f0-9]{48}/.exec(String(paired.headers['set-cookie']))[0];
  const fieldDir = join(homeFolder('field', { env: { ...process.env, SOL_GHOST_HOME: state }, make: false }), 'primary');
  return { state, port, ca, cookie, turns, fieldDir, uploadDir: homeFolder('field', { env: { ...process.env, SOL_GHOST_HOME: state }, make: false }) };
}

// A mock of the engine's /api/conversation/turn: its vision lane (the trigger, the image.path rule, the file's bytes to the
// model) and everything else as an ordinary answer. `model` stands in for the local vision model.
function runtimeMock({ uploadDir, model, seen }) {
  return async (url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    const image = body.image ? runtimeResolves(body.image, { uploadDir, tenantId: body.tenantId }) : null;
    let spoken = 'Okay.';
    if (RUNTIME_VISION.test(body.userText)) spoken = image ? await model({ jpegBase64: readFileSync(image).toString('base64'), prompt: body.userText }) : "I don't have an image on this turn.";
    return new Response(JSON.stringify({ ok: true, data: { spokenResponse: spoken, conversationId: body.conversationId || 'c1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('what the turn wants done with the photo', () => {
  const cases = {
    'what is this?': 'look', 'Did you get the image I just sent you?': 'look', 'A, did you get the image I just sent you?': 'look', 'what do you see': 'look',
    'how much is this worth': 'look', 'is this a Clover terminal?': 'look', '': 'look',
    'read it': 'read', 'what does the sign say': 'read', 'read the menu': 'read', 'transcribe this receipt': 'read', 'copy the text off this': 'read',
    'save this': 'save', 'save it to my documents': 'save', 'save the photo to my pictures': 'save',
    'make a poster from this photo': 'edit', 'turn it into a cartoon': 'edit',
    'send this to Hector': 'use', 'attach this to the Taco Joe ticket': 'use', 'write a proposal for Taco Joe from these menu photos': 'use',
    "what's the weather today": 'none', 'add milk to my shopping list': 'none',
  };
  for (const [t, want] of Object.entries(cases)) assert.equal(photoIntent(t), want, t);
  assert.equal(saveFolder('save the photo to my pictures'), 'pictures');
  assert.equal(saveFolder('save it'), 'documents');
  // Framed the way the runtime's vision lane listens for, whatever the owner's words were.
  for (const t of ['what is this?', 'how much is this worth', 'what does the sign say', '']) {
    for (const intent of ['look', 'read']) assert.match(lookText(t, intent), RUNTIME_VISION, `${intent}: ${t}`);
  }
  assert.match(lookText('what does the sign say', 'read'), /^Read the text in this photo I just sent: what does the sign say$/);
  // The bar's attachment convention: the path in the message, quoted when it has a space.
  assert.equal(withPath('send this to Hector', '/a/b c.jpg'), 'send this to Hector "/a/b c.jpg"');
  assert.equal(withPath('send it', '/a/b.jpg'), 'send it /a/b.jpg');
});

test('upload types, freshness, and the vision-ready copy', async () => {
  assert.equal(uploadType('image/jpeg; charset=x', 'a.bin'), 'image/jpeg');
  assert.equal(uploadType('', 'IMG_0001.HEIC'), 'image/heic', 'iOS can send HEIC with no type');
  assert.equal(uploadType('application/octet-stream', 'clip.MOV'), 'video/quicktime');
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(photoFresh({ path: '/p', receivedAt: '2026-10-17T11:50:00Z' }, now), true);
  assert.equal(photoFresh({ path: '/p', receivedAt: new Date(now - PHOTO_TTL_MS - 1000).toISOString() }, now), false, 'a stale photo does not ride');
  assert.equal(photoFresh(null, now), false);
  // JPEG/PNG under 8 MB: as is, no sips.
  let ran = 0; const run = (bin, args, o, cb) => { ran++; cb(null, ''); };
  assert.deepEqual(await visionCopy('/x/a.jpg', 'image/jpeg', { size: 100, run }), { path: '/x/a.jpg', mimeType: 'image/jpeg', converted: false });
  assert.equal(ran, 0);
  // HEIC: sips makes a JPEG beside it (never enlarged: no -Z for a small one); if sips fails, the original stays.
  const calls = [];
  const fake = (bin, args, o, cb) => { calls.push(args); cb(args[0] === '-g' ? null : new Error('no'), args[0] === '-g' ? 'pixelWidth: 4032\n  pixelHeight: 3024' : ''); };
  assert.deepEqual(await visionCopy('/x/IMG.HEIC', 'image/heic', { size: 100, run: fake }), { path: '/x/IMG.HEIC', mimeType: 'image/heic', converted: false });
  assert.deepEqual(calls[1].slice(0, 7), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z']);
  assert.equal(calls[1].at(-1), '/x/IMG.jpg');
  if (!existsSync(SIPS)) return;
  const dir = mkdtempSync(join(tmpdir(), 'km-sips-'));
  try {
    execFileSync(SIPS, ['-s', 'format', 'heic', CREST.pathname, '--out', join(dir, 'IMG 1.HEIC')], { stdio: 'ignore' });
    const v = await visionCopy(join(dir, 'IMG 1.HEIC'), 'image/heic');
    assert.deepEqual(v, { path: join(dir, 'IMG 1.jpg'), mimeType: 'image/jpeg', converted: true });
    assert.deepEqual([...readFileSync(v.path).subarray(0, 3)], [0xff, 0xd8, 0xff], 'a real JPEG');
    assert.match(execFileSync(SIPS, ['-g', 'pixelWidth', v.path], { encoding: 'utf8' }), /pixelWidth: 792/, 'not enlarged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('does this Mac have a model the vision lane will look with', async () => {
  const tags = (names) => async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });
  assert.equal(await visionReady({ env: {}, fetchImpl: tags(['qwen3:1.7b', 'gemma3:4b']) }), true);
  assert.equal(await visionReady({ env: {}, fetchImpl: tags(['qwen3:1.7b', 'huihui_ai/qwen3-abliterated:8b']) }), false);
  assert.equal(await visionReady({ env: { SOLOMON_VISION_MODEL: 'x' }, fetchImpl: () => { throw new Error('not asked'); } }), true);
  assert.equal(await visionReady({ env: {}, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), null, 'Ollama down: unknown, the lane says what happened');
});

test('phone camera → stored where the runtime reads → on the turn → vision, OCR, save, CRM job', { timeout: 60_000 }, async (t) => {
  const p = await pairedPhone(t);
  const photo = readFileSync(CREST);
  const up = await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=menu.png', body: photo, type: 'image/png', cookie: p.cookie });
  assert.equal(up.status, 200);
  assert.equal(up.json.ok, true); assert.equal(up.json.attached, true); assert.equal(up.json.type, 'image/png');
  // Stored under Field/primary (the owner's tenant), whole, with no .part left.
  const stored = join(p.fieldDir, up.json.saved);
  assert.deepEqual(readFileSync(stored), photo);
  assert.deepEqual(readdirSync(p.fieldDir).filter((n) => n.endsWith('.part')), []);

  // Typed on the phone: the turn carries it, on the phone's own thread; the runtime's path rule accepts it.
  assert.equal((await call(p.ca, { port: p.port, method: 'POST', path: '/turn', body: { text: 'what does the menu say?' }, cookie: p.cookie })).status, 200);
  const first = p.turns.at(-1);
  assert.equal(first.text, 'what does the menu say?');
  assert.match(first.meta.conversationId, /^phone-[a-f0-9]{6}$/);
  assert.equal(first.meta.image.path, stored); assert.equal(first.meta.image.mimeType, 'image/png'); assert.equal(first.meta.image.filename, up.json.saved);
  assert.equal(runtimeResolves(first.meta.image, { uploadDir: p.uploadDir, tenantId: 'primary' }), realpathSync(stored));
  // One turn sees one photo.
  await call(p.ca, { port: p.port, method: 'POST', path: '/turn', body: { text: 'thanks' }, cookie: p.cookie });
  assert.equal(p.turns.at(-1).meta.image, null);
  // Two photos in the same second (the camera names each one image.jpg): both kept.
  const [x1, x2] = await Promise.all([1, 2].map((n) => call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=image.jpg', body: Buffer.alloc(500, n), type: 'image/jpeg', cookie: p.cookie })));
  assert.notEqual(x1.json.saved, x2.json.saved);
  for (const [r, n] of [[x1, 1], [x2, 2]]) assert.deepEqual(readFileSync(join(p.fieldDir, r.json.saved)), Buffer.alloc(500, n));
  // Spoken on a call from the phone: the next photo rides that turn the same way.
  const again = await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=sign.png', body: photo, type: 'image/png', cookie: p.cookie });
  const spoken = await call(p.ca, { port: p.port, method: 'POST', path: '/voice/turn', body: Buffer.alloc(16000 * 2, 1), type: 'application/octet-stream', cookie: p.cookie });
  assert.deepEqual(spoken.json, { ok: true, heard: 'what does the sign say' });
  assert.equal(p.turns.at(-1).text, 'what does the sign say');
  assert.equal(p.turns.at(-1).meta.image.path, join(p.fieldDir, again.json.saved));

  // The engine side, with the runtime and the models mocked: each tool gets the photo.
  const seen = [], looked = [], said = [];
  const model = async ({ jpegBase64, prompt }) => { looked.push({ bytes: Buffer.from(jpegBase64, 'base64'), prompt }); return /Read the text/.test(prompt) ? 'TACOS $3 · HORCHATA $2' : 'A gold crest on black.'; };
  const fetchImpl = runtimeMock({ uploadDir: p.uploadDir, model, seen });
  const governed = async (words, image) => { const r = await turn(4999, { text: words, image, conversationId: first.meta.conversationId, fetchImpl }); said.push(r.spoken); return r; };
  const opened = [];
  const crm = crmJobs?.createCrmJobs({ open: async (body) => { opened.push(body); return { ok: true, json: { data: { task_id: 't1', job: { title: 'Proposal for Taco Joe' }, agent: { local: true }, status: 'queued' } } }; }, read: async () => null, say: async (l) => said.push(l), setTimer: () => null });
  const deps = { governed, say: async (l) => said.push(l), visionReady: async () => true, crmJob: crm ? (words, attachments) => crm.handle(words, { attachments }) : null,
    save: (image, o) => savePhoto(image, { ...o, env: { ...process.env, SOL_GHOST_HOME: p.state } }) };
  const image = first.meta.image;

  // 1. Vision: "what is this?" goes to the runtime's vision lane with the image; the model gets the photo's own bytes.
  assert.deepEqual(await fieldPhotoTurn({ text: 'what is this?', image, deps }), { via: 'vision', intent: 'look' });
  assert.equal(seen.at(-1).tenantId, 'primary'); assert.equal(seen.at(-1).image.path, stored); assert.equal(seen.at(-1).conversationId, first.meta.conversationId);
  assert.deepEqual(looked.at(-1).bytes, photo);
  assert.equal(said.at(-1), 'A gold crest on black.');
  // The soak's own words reach it too (they used to go to the writer, which never saw the photo).
  assert.equal((await fieldPhotoTurn({ text: 'Did you get the image I just sent you?', image, deps })).via, 'vision');
  assert.equal(said.at(-1), 'A gold crest on black.');

  // 2. OCR: "read the menu" is the same lane asked to read the text.
  assert.equal((await fieldPhotoTurn({ text: 'read the menu', image, deps })).via, 'vision');
  assert.match(looked.at(-1).prompt, /^Read the text in this photo I just sent: read the menu/);
  assert.equal(said.at(-1), 'TACOS $3 · HORCHATA $2');

  // 3. Save: a copy in Kingmaker's Documents (the Artifacts tab), the Field original kept.
  assert.equal((await fieldPhotoTurn({ text: 'save this to my documents', image, deps })).via, 'save');
  const docs = homeFolder('documents', { env: { ...process.env, SOL_GHOST_HOME: p.state }, make: false });
  assert.deepEqual(readFileSync(join(docs, up.json.saved)), photo);
  assert.ok(existsSync(stored));
  assert.match(said.at(-1), /^Saved your photo in Kingmaker's Documents/);

  // 4. CRM (the Ronin add-on): a work request from the photo is a job with the photo attached; the governed turn never runs for it.
  if (crm) {
    const before = seen.length;
    assert.equal((await fieldPhotoTurn({ text: "write a proposal for Taco Joe's from these menu photos", image, deps })).via, 'crm-job');
    assert.equal(seen.length, before);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].kind, 'write'); assert.equal(opened[0].request, "write a proposal for Taco Joe's from these menu photos");
    assert.deepEqual(opened[0].attachments, [{ kind: 'field-photo', path: stored, filename: up.json.saved, mimeType: 'image/png', bytes: photo.length, receivedAt: image.receivedAt }]);
    assert.match(opened[0].detail, new RegExp(`Attached from the owner's phone .*${up.json.saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(opened[0].asked_by_person, true);
  }

  // 5. Anything else about the photo: the governed brain, the photo's path in the words (send it, attach it): the same
  //    approval gates as any send or CRM write (the mock answers; nothing here approves).
  assert.equal((await fieldPhotoTurn({ text: 'attach this to the Taco Joe ticket', image, deps })).via, 'governed');
  assert.equal(seen.at(-1).userText, `attach this to the Taco Joe ticket "${stored}"`);
  assert.equal(seen.at(-1).image.path, stored);
  // Words not about the photo: the image rides alone, the words unchanged.
  assert.equal((await fieldPhotoTurn({ text: "what's the weather today", image, deps })).via, 'governed');
  assert.equal(seen.at(-1).userText, "what's the weather today");
});

test('a Mac with no model that sees says so plainly, or a cloud brain that sees looks; never silence', async () => {
  const image = { path: '/f/primary/2026 iPhone menu.jpg', mimeType: 'image/jpeg', filename: '2026 iPhone menu.jpg' };
  const said = [], governed = [];
  const deps = { governed: async (w) => governed.push(w), say: async (l) => said.push(l), visionReady: async () => false };
  assert.equal((await fieldPhotoTurn({ text: 'what is this?', image, deps })).via, 'no-vision');
  assert.deepEqual(said, [NO_VISION_LINE('2026 iPhone menu.jpg')]);
  assert.match(said[0], /no model here can see images/);
  assert.deepEqual(governed, []);
  const asked = [];
  const brain = { sees: true, runTurn: async (text, opts) => asked.push({ text, opts }) };
  assert.equal((await fieldPhotoTurn({ text: 'what is this?', image, deps: { ...deps, brain } })).via, 'brain');
  assert.deepEqual(asked, [{ text: 'what is this?', opts: { image } }]);
  // Unknown (Ollama didn't answer): the lane itself is asked, and says what happened.
  assert.equal((await fieldPhotoTurn({ text: 'what is this?', image, deps: { ...deps, visionReady: async () => null } })).via, 'vision');
  assert.deepEqual(governed, ['Look at this photo I just sent: what is this?']);
});

test('the image lane draws from the photo; without the engine it says so', async () => {
  const image = { path: '/f/primary/a.jpg', filename: 'a.jpg' };
  const said = [], drew = [];
  const deps = { governed: async () => assert.fail('not governed'), say: async (l) => said.push(l), edit: async (w, path) => { drew.push({ w, path }); return { ok: true, file: '/p.png', ms: 80_000 }; } };
  assert.equal((await fieldPhotoTurn({ text: 'make a poster from this photo', image, deps })).via, 'edit');
  assert.deepEqual(drew, [{ w: 'make a poster from this photo', path: '/f/primary/a.jpg' }]);
  assert.equal((await fieldPhotoTurn({ text: 'make a poster from this photo', image, deps: { ...deps, edit: null } })).via, 'edit-unavailable');
  assert.match(said.at(-1), /image engine isn't set up/);
  // makeImage starts from the photo: stable-diffusion.cpp's -i and --strength.
  const dir = mkdtempSync(join(tmpdir(), 'km-img2img-'));
  try {
    const photo = join(dir, 'menu.jpg'); copyFileSync(CREST, photo);
    let argv = null;
    const setup = { ready: true, bin: '/sd', diffusion: '/d', vae: '/v', llm: '/l', out: dir };
    const r = await makeImage('make a poster from this photo', { setup, initImage: photo, fetchImpl: async () => new Response('{}'), run: (bin, args, o, cb) => { argv = args; writeFileSync(args.at(-1), 'png'); cb(null); } });
    assert.equal(r.ok, true);
    assert.deepEqual(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 4), ['-i', photo, '--strength', '0.6']);
    const plain = []; await makeImage('make a poster', { setup, fetchImpl: async () => new Response('{}'), run: (bin, args, o, cb) => { plain.push(...args); writeFileSync(args.at(-1), 'png'); cb(null); } });
    assert.ok(!plain.includes('-i'), 'a plain drawing has no start image');
    assert.equal((await makeImage('x', { setup, initImage: join(dir, 'gone.jpg') })).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cloud brains see the photo: Claude may Read exactly that file, Codex attaches it', async () => {
  const path = '/Users/o/Library/Application Support/sol-ghost/Files/Field/primary/2026 iPhone menu.jpg';
  const a = claudeArgs({ text: 'hi', mcpConfigPath: '/m.json', images: [path] });
  assert.ok(a.includes(`Read(/${path})`)); assert.ok(a.includes('Bash') && a.includes('Write'), 'still no shell, no writes');
  assert.ok(!claudeArgs({ text: 'hi', mcpConfigPath: '/m.json' }).some((x) => /^Read\(\/\//.test(x)), 'no photo, no extra Read');
  const c = codexArgs({ text: 'hi', port: 1, outFile: '/o', images: [path] });
  assert.deepEqual(c.slice(c.indexOf('--image'), c.indexOf('--image') + 2), ['--image', path]);
  const state = mkdtempSync(join(tmpdir(), 'km-brain-photo-'));
  try {
    const calls = [];
    const brain = createClaudeBrain({ paths: { state }, port: 4999, say: async () => {}, env: { HOME: state, PATH: '' }, run: (bin, args, o, cb) => { calls.push(args); cb(null, JSON.stringify({ result: 'A menu.', session_id: 's' }), ''); } });
    assert.equal(brain.sees, true);
    await brain.runTurn('what is this?', { image: { path, mimeType: 'image/jpeg' } });
    assert.ok(calls[0].includes(`Read(/${path})`));
    assert.match(calls[0][1], new RegExp(`^what is this\\?\\n\\n\\(The owner sent a photo from their phone with this message: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(image/jpeg\\)`));
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('uploads end cleanly: HEIC made readable, too big refused, empty refused, a video is kept but not looked at', { timeout: 60_000 }, async (t) => {
  const conv = [];
  const toVision = async (path, mimeType) => { conv.push({ path, mimeType }); const out = path.replace(/\.[^.]+$/, '.jpg'); copyFileSync(path, out); return { path: out, mimeType: 'image/jpeg', converted: true }; };
  const p = await pairedPhone(t, { maxUpload: 64 * 1024, toVision });
  // HEIC from an iPhone, sent with no type: stored as is, and a JPEG beside it is what the turn carries.
  const heic = await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=IMG_0001.HEIC', body: Buffer.alloc(2000, 7), type: '', cookie: p.cookie });
  assert.equal(heic.status, 200); assert.equal(heic.json.type, 'image/heic'); assert.equal(heic.json.attached, true);
  assert.equal(conv.length, 1); assert.equal(conv[0].mimeType, 'image/heic');
  await call(p.ca, { port: p.port, method: 'POST', path: '/turn', body: { text: 'what is this' }, cookie: p.cookie });
  assert.equal(p.turns.at(-1).meta.image.mimeType, 'image/jpeg'); assert.match(p.turns.at(-1).meta.image.path, /IMG_0001\.jpg$/);
  assert.equal(p.turns.at(-1).meta.image.filename, heic.json.saved, 'the owner sees the name they sent');
  // Too big: 413, nothing kept, nothing attached.
  const big = await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=huge.jpg', body: Buffer.alloc(200 * 1024, 1), type: 'image/jpeg', cookie: p.cookie }).catch((e) => ({ status: 0, error: e }));
  assert.equal(big.status, 413, 'refused with a reason the phone shows');
  // Empty: 400.
  const empty = await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=e.jpg', body: Buffer.alloc(0), type: 'image/jpeg', cookie: p.cookie });
  assert.equal(empty.status, 400);
  // A video: saved, not the photo for the next turn (the phone sends a frame of it as a photo).
  const vid = await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=clip.mov', body: Buffer.alloc(3000, 2), type: 'video/quicktime', cookie: p.cookie });
  assert.equal(vid.status, 200); assert.equal(vid.json.attached, false);
  await call(p.ca, { port: p.port, method: 'POST', path: '/turn', body: { text: 'hi' }, cookie: p.cookie });
  assert.equal(p.turns.at(-1).meta.image, null);
  await new Promise((r) => setTimeout(r, 100));
  const left = readdirSync(p.fieldDir);
  assert.deepEqual(left.filter((n) => n.endsWith('.part')), [], 'no half files');
  assert.ok(!left.some((n) => /huge|e\.jpg$/.test(n)), 'the refused uploads are not kept');
  // Unpaired: 401.
  assert.equal((await call(p.ca, { port: p.port, method: 'POST', path: '/field/upload?name=x.jpg', body: Buffer.alloc(10, 1), type: 'image/jpeg' })).status, 401);
});

test('the phone app: camera photos go as upright JPEGs, videos with a frame, retried, with progress; its script parses', { timeout: 60_000 }, async (t) => {
  const p = await pairedPhone(t);
  const page = (await call(p.ca, { port: p.port, path: '/', cookie: p.cookie })).text;
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const s of scripts) assert.doesNotThrow(() => new Script(s), 'the served script is valid JavaScript');
  const js = scripts.join('\n');
  assert.match(page, /<input id="file" type="file" accept="image\/\*,video\/\*" capture="environment" multiple hidden>/);
  assert.match(js, /createImageBitmap\(f,\{imageOrientation:'from-image'\}\)/, 'decoded upright (HEIC included, by Safari)');
  assert.match(js, /toBlob\(b=>r\(b\),'image\/jpeg',\.86\)/);
  assert.match(js, /MAXPX=2560/);
  assert.match(js, /for\(let i=0;i<3;i\+\+\)/, 'two retries');
  assert.match(js, /x\.upload\.onprogress/, 'progress');
  assert.match(js, /e\.status===413/);
  assert.match(js, /videoFrame\(f\)/);
  assert.match(js, /\.replace\(\/\\\.\[\^\.\]\+\$\/,''\)/, 'regex escapes survive the page template');
});

test('the engine routes a photo turn to the photo desk before any lane that cannot see it', () => {
  const cli = readFileSync(at('lib/cli.mjs'), 'utf8');
  assert.match(cli, /import \{ fieldPhotoTurn, visionReady \} from '\.\/field-photo\.mjs'/);
  const desk = cli.indexOf('if (img && !skill) {');
  assert.ok(desk > 0, 'the photo desk branch');
  // It comes first in the turn's chain: before CRM skills, installs, the follow-up writer, jobs and the fast lanes.
  for (const later of ["else if (skill) { log('crm_skill_turn'", 'else if (!programs.length && installRequest(text))', 'isEditFollowUp(text)', 'else if (!programs.length && crmJobs && cal().crmJobs.on && await crmJobs.handle(text))', 'await fastLane(text, framed, pin)']) {
    assert.ok(cli.indexOf(later) > desk, later);
  }
  const branch = cli.slice(desk, cli.indexOf("else if (skill) { log('crm_skill_turn'"));
  assert.match(branch, /governed: \(words, image\) => session\.runTurn\(words, \{ \.\.\.turnOpts, image \}\)/);
  assert.match(branch, /crmJob: crmJobs && cal\(\)\.crmJobs\.on \? \(words, attachments\) => crmJobs\.handle\(words, \{ attachments \}\) : null/);
  assert.match(branch, /makeImage\(words, \{ setup: imageSetup, initImage: path \}\)/);
  assert.match(branch, /brain,/);
});

test('a CRM job carries the photo; the words that only point at it no longer read as a picture request', () => {
  if (crmJobs) {
    const { workRequest } = crmJobs;
    assert.equal(workRequest("write a proposal for Taco Joe's from these menu photos"), null, 'without a photo it stays a picture-ish line');
    assert.deepEqual(workRequest("write a proposal for Taco Joe's from these menu photos", { attached: true }), { request: "write a proposal for Taco Joe's from these menu photos", kind: 'write' });
    assert.equal(workRequest('make a poster from this photo', { attached: true }), null, 'a drawing is still the image lane');
  }
  const att = jobAttachment({ path: CREST.pathname, mimeType: 'image/png', receivedAt: 'r' });
  assert.equal(att.bytes, readFileSync(CREST).length); assert.equal(att.filename, 'ronin-inc-crest.png');
});
