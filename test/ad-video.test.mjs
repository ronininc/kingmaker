// "make an ad" → a real video (lib/ad-video.mjs): the script, the scene cut and the title card, with real ffmpeg when present.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cardArgs, DEMOS, FALLBACK_SCRIPT, footageWindow, isAdRequest, makeAdVideo, mediaSeconds, parseScript, sceneArgs, textPng, videoTools, writeScript } from '../lib/ad-video.mjs';

test('an ad request is told apart from other writing', () => {
  for (const t of ['make an ad about Kingmaker', 'mak an add for the taco shop', 'create a 30 second commercial', 'produce a promo video']) assert.equal(isAdRequest(t), true, t);
  for (const t of ['write the proposal for Hector Tacos', 'open youtube', 'add Maria to the CRM']) assert.equal(isAdRequest(t), false, t);
});

test('a script comes from a reasoning model\'s reply, only with real demos; else the plain-facts script', async () => {
  const reply = '<think>Let me plan the scenes…</think>\n```json\n{"title":"Kingmaker","scenes":[{"demo":"bar","voiceover":"Meet Kingmaker.","caption":"Meet Kingmaker"},{"demo":"teleport","voiceover":"It teleports.","caption":"x"},{"demo":"open_site","voiceover":"Ask, and it opens YouTube.","caption":"It does things"}]}\n```';
  const s = parseScript(reply);
  assert.deepEqual(s.scenes.map((x) => x.demo), ['bar', 'open_site'], 'an invented demo is dropped');
  assert.equal(parseScript('no json here'), null);
  assert.ok(FALLBACK_SCRIPT.scenes.every((x) => x.demo in DEMOS));
  const down = await writeScript({ request: 'make an ad', model: 'm', facts: 'f', fetchImpl: async () => { throw new Error('ollama down'); } });
  assert.equal(down.by, 'fallback'); assert.equal(down.scenes.length, FALLBACK_SCRIPT.scenes.length);
  const sent = [];
  const ok = await writeScript({ request: 'make an ad about Kingmaker', model: 'huihui_ai/deepseek-r1-abliterated:14b', facts: 'FACTS-HERE',
    fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message: { content: reply } }), { status: 200 }); } });
  assert.equal(ok.by, 'huihui_ai/deepseek-r1-abliterated:14b', 'the model chosen in the bar writes it');
  assert.match(sent[0].messages[0].content, /FACTS-HERE/); assert.equal(sent[0].keep_alive, 0, 'the model unloads after, leaving room to draw');
});

test('video tools: Kingmaker\'s own copy first, and what is missing is named', () => {
  const t = videoTools({ appRoot: '/A/Kingmaker.app', env: {}, exists: (p) => p === '/A/Kingmaker.app/Contents/Resources/bin/ffmpeg' || p === '/usr/sbin/screencapture' });
  assert.equal(t.ffmpeg, '/A/Kingmaker.app/Contents/Resources/bin/ffmpeg');
  assert.equal(t.ready, false); assert.deepEqual(t.missing, ['ffprobe']);
});

const tools = videoTools();
test('a scene and the title card are cut by real ffmpeg, then joined', { skip: !(tools.ffmpeg && tools.ffprobe && process.platform === 'darwin') && 'no ffmpeg or not a Mac' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'ad-test-'));
  try {
    // Fixtures use only what Kingmaker's own (LGPL, VideoToolbox) ffmpeg has, so this runs against it as well as Homebrew's.
    const clip = join(d, 'clip.mov'), voice = join(d, 'vo.mp4');
    execFileSync(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x800:rate=30:duration=2', '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-pix_fmt', 'yuv420p', clip], { stdio: 'pipe' });
    execFileSync(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', voice], { stdio: 'pipe' });
    const caption = await textPng({ out: join(d, 'cap.png'), width: 1400, height: 150, background: [0, 0, 0, 0.65], lines: [{ text: 'It does things', size: 66, color: [1, 1, 1, 1] }] }, { work: d });
    assert.ok(caption, 'macOS drew the caption');
    const seg = join(d, 'seg.mp4');
    execFileSync(tools.ffmpeg, sceneArgs({ clip, voice, caption, secs: 3.5, out: seg }), { stdio: 'pipe' });
    assert.ok(Math.abs((await mediaSeconds(tools.ffprobe, seg)) - 3.5) < 0.2, 'a 2 s clip is held to its 3.5 s line');
    const cardPng = await textPng({ out: join(d, 'card.png'), width: 1920, height: 1080, background: [0, 0, 0, 1], gap: 40,
      lines: [{ text: 'KINGMAKER', size: 150, color: [1, 1, 1, 1], font: 'BodoniSvtyTwoITCTT-Bold', kern: 24 }, { text: 'Your AI, on your Mac.', size: 60, color: [0.29, 0.87, 0.5, 1] }] }, { work: d });
    const card = join(d, 'card.mp4');
    assert.ok(cardPng, 'macOS drew the title card');
    execFileSync(tools.ffmpeg, cardArgs({ voice, card: cardPng, secs: 4, out: card }), { stdio: 'pipe' });
    const list = join(d, 'list.txt'); writeFileSync(list, `file '${seg}'\nfile '${card}'`);
    const out = join(d, 'ad.mp4');
    execFileSync(tools.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { stdio: 'ignore' });
    assert.ok(Math.abs((await mediaSeconds(tools.ffprobe, out)) - 7.5) < 0.3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('one request, one spoken line: progress is shown, the scenes are silent, and the voice comes back even on failure', async () => {
  const said = [], shown = [], hushed = [], staged = []; let opened = 0;
  const tools = { ffmpeg: '/usr/bin/true', ffprobe: '/usr/bin/true', screencapture: '/usr/bin/true', ready: true, missing: [] };
  const r = await makeAdVideo({ request: 'make an ad about Kingmaker', model: 'no-such-model', facts: 'f', deps: {
    tools, stage: (on) => staged.push(on), say: async (l) => said.push(l), show: async (l) => shown.push(l), hush: (on) => hushed.push(on),
    barSay: async () => {}, openSettings: () => { opened += 1; }, synth: async () => ({ out: '/dev/null', dir: '/nonexistent-ad-test' }), makeImage: async () => ({ ok: false }) } });
  assert.equal(r.ok, false); assert.match(r.why, /only you can allow that/); assert.match(r.why, /Screen & System Audio Recording/);
  assert.equal(opened, 1, 'the setting is shown to the person (never changed)');
  assert.deepEqual(said, [], 'nothing is spoken by the flow itself; the caller speaks the result once');
  assert.equal(shown.length, 2);
  assert.equal(hushed[0], true); assert.equal(hushed.at(-1), false, 'the voice is back after a failed run');
  assert.deepEqual(staged, [true, false], 'the bar is staged once and put back once, even on failure');
});

test('each scene ends just after the action lands and is as long as its voice', () => {
  // A quick action, a longer voice: all the footage, its last frame held.
  assert.deepEqual(footageWindow({ secs: 6, landed: 3, recorded: 12 }), { from: 0, to: 4.5, speed: 1 });
  // A slow answer (14 s) under a 6 s line: sped up 2.5x at most, the start dropped, the answer kept.
  assert.deepEqual(footageWindow({ secs: 6, landed: 14, recorded: 18 }), { from: 0.5, to: 15.5, speed: 2.5 });
  // Never past the end of the recording.
  assert.equal(footageWindow({ secs: 4, landed: 20, recorded: 18 }).to, 18);
  const args = sceneArgs({ clip: 'c.mov', voice: 'v.wav', caption: null, secs: 6, out: 'o.mp4', from: 0.5, to: 15.5, speed: 2.5 });
  assert.match(args.join(' '), /trim=start=0\.5:end=15\.5,setpts=\(PTS-STARTPTS\)\/2\.5/);
  assert.ok(!('files' in DEMOS), 'the desktop-files demo answered with a web article; it is gone');
});
