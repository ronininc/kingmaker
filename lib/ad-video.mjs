// lib/ad-video.mjs — "make an ad" makes a real video, entirely on this Mac (owner 2026-10-15: "it should have created me an
// actual video file and then delivered it to me on my desktop … take a screen recording of its own functions while it was
// working, and showcase its different tool usage … and then give me a voiceover … with Kokoro").
//   1. Script: the model chosen in the bar writes 4–5 scenes, each tied to something Kingmaker really does on screen.
//   2. Footage: Kingmaker performs each scene through its own bar while macOS records the screen (screencapture -v).
//   3. Voice: Kokoro, Kingmaker's own voice, reads each scene's line.
//   4. Cut: ffmpeg fits each clip to its line, puts the caption on it, adds a title card, and joins them into an MP4.
//   5. Delivery: ~/Desktop/Kingmaker Ad <date>.mp4.
// Nothing leaves the Mac. ffmpeg must ship inside Kingmaker.app for an ordinary Mac (Resources/bin/ffmpeg); a developer's
// Homebrew copy is only the fallback.

import { homeFolder } from './kingmaker-home.mjs';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { meter, meterFail } from './token-meter.mjs';

/** What Kingmaker can really show on screen, scene by scene. The model picks from these and nothing else. */
export const DEMOS = Object.freeze({
  // A written answer from the local writer (with the facts): "what can you do" goes to the brain's system report instead.
// `cap`: the most seconds a scene's recording runs (screencapture -v can't be stopped early: it ignores SIGINT); the clip
// is then cut to end just after the action lands. `front`: the app brought forward once Kingmaker has acted, so the
// result is in the shot (Chrome opened "in a new window" on another Space, 2026-10-15, and the clip showed wallpaper).
// "how many files on my desktop" was dropped: it went to a web search and answered with an article about desktop clutter.
  bar: { what: 'the Kingmaker bar answering, in one sentence, what Kingmaker is', bar: 'in one sentence, tell me what Kingmaker is', framed: true, cap: 18 },
  open_site: { what: 'Kingmaker opening YouTube in the browser when asked', bar: 'open youtube', front: 'Google Chrome', cap: 12 },
  // Worded for the local writer: "draft … to a customer for their order" went to the CRM brain as a CRM draft awaiting "go ahead".
  draft: { what: 'Kingmaker writing a short, warm thank-you note in the bar', bar: 'write a short, warm thank-you note for a friend who helped me move', cap: 18 },
  picture: { what: 'a picture Kingmaker made on this Mac, shown full screen', picture: true, cap: 8 },
});
const DEMO_KEYS = Object.keys(DEMOS);

/** The video tools: Kingmaker's own copies first (an ordinary Mac has no Homebrew), then a developer's. */
export function videoTools({ appRoot = '/Applications/Kingmaker.app', env = process.env, exists = existsSync } = {}) {
  const pick = (name) => [env[`KINGMAKER_${name.toUpperCase()}`], join(appRoot, 'Contents', 'Resources', 'bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find((p) => p && exists(p)) || null;
  const t = { ffmpeg: pick('ffmpeg'), ffprobe: pick('ffprobe'), screencapture: exists('/usr/sbin/screencapture') ? '/usr/sbin/screencapture' : null };
  return { ...t, ready: Boolean(t.ffmpeg && t.ffprobe && t.screencapture), missing: Object.entries(t).filter(([, v]) => !v).map(([k]) => k) };
}

/** System Settings, Privacy & Security, Screen & System Audio Recording (opened for the person; never changed by Kingmaker). */
export const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
export const SCREEN_RECORDING_WHY = 'macOS won\'t let me record the screen, and only you can allow that: I can\'t grant it myself. '
  + 'I\'ve opened the setting: turn Kingmaker on under Screen & System Audio Recording (if it is already on, remove it with the minus button and add it again with plus), '
  + 'reopen Kingmaker when macOS asks, then ask me for the ad again.';

/** Pure: is this a request for an ad (a video), as opposed to other writing? */
export function isAdRequest(text) {
  return /\b(make|mak|create|produce|shoot|film|put together)\b.{0,40}\b(ads?|adds?|advert(isement)?s?|commercials?|promos?|promo video|video ad)\b/i.test(String(text || ''));
}

/** Pure: a model's reply → { title, scenes: [{demo, voiceover, caption}] }, or null. Tolerates <think>, fences and chatter. */
export function parseScript(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j; try { j = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const scenes = (Array.isArray(j?.scenes) ? j.scenes : [])
    .map((s) => ({ demo: String(s?.demo || '').trim(), voiceover: String(s?.voiceover || '').replace(/\s+/g, ' ').trim().slice(0, 260), caption: String(s?.caption || '').replace(/\s+/g, ' ').trim().slice(0, 48) }))
    .filter((s) => DEMO_KEYS.includes(s.demo) && s.voiceover);
  if (scenes.length < 2) return null;
  return { title: String(j.title || 'Kingmaker').slice(0, 60), scenes: scenes.slice(0, 6) };
}

/** The script when the model can't give one: the same shape, the plain facts. */
export const FALLBACK_SCRIPT = Object.freeze({
  title: 'Kingmaker',
  scenes: [
    { demo: 'bar', voiceover: 'This is Kingmaker. AI that runs on your own Mac. Download it, click, and it sets itself up.', caption: 'AI on your own Mac' },
    { demo: 'open_site', voiceover: 'It does things, not just chat. Ask, and it opens your apps and websites.', caption: 'It does things' },
    { demo: 'draft', voiceover: 'It writes for you too: notes, replies and proposals, drafted on your Mac, and nothing you share ever leaves it.', caption: 'Private by design' },
    { demo: 'picture', voiceover: 'It even makes pictures, right here, with no cloud and no fees.', caption: 'No cloud. No fees.' },
  ],
});

const SYSTEM = (facts) => `You write 30-second video ads. Reply with JSON only, no other text:
{"title":"...","scenes":[{"demo":"<one of: ${DEMO_KEYS.join(', ')}>","voiceover":"<two spoken sentences, 14 to 24 words in all>","caption":"<on-screen words, at most 5>"}]}
Write 4 or 5 scenes. Each scene is shown with real footage of Kingmaker doing this:
${DEMO_KEYS.map((k) => `- ${k}: ${DEMOS[k].what}`).join('\n')}
The voiceover must match what is on screen in that scene. Use only these facts; never invent features or prices:
${facts}`;

/** Ask the chosen local model for the script (Ollama). Never throws: falls back to FALLBACK_SCRIPT.
 *  `policy` (lib/eviction-policy.mjs): this is a TRANSIENT load — admitted through the reflex seat
 *  keeper's pair cap when the console hands its policy in and released through the keeper when the
 *  call ends; a refusal is the plain-facts fallback with the reason attached, never a load on hope.
 *  Without a policy, the legacy call: keep_alive 0, the model unloads itself as it answers. */
export async function writeScript({ request, model, facts, base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, ''), fetchImpl = fetch, timeoutMs = 240_000, policy = null }) {
  let adm = null;
  try {
    if (policy) {
      adm = await policy.admit({ model, intent: 'transient', legacy: 0 });
      if (!adm.ok) return { ...FALLBACK_SCRIPT, by: 'fallback', refused: adm.reason };
    }
    const r = await fetchImpl(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, stream: false, keep_alive: adm ? adm.keepAlive : 0, options: { temperature: 0.6 }, messages: [{ role: 'system', content: SYSTEM(facts) }, { role: 'user', content: request }] }) });
    const j = r.ok ? await r.json() : null;
    if (j) meter(j, { lane: 'writer', kind: 'turn', model }); else meterFail({ lane: 'writer', model });
    const parsed = j ? parseScript(j?.message?.content) : null;
    return parsed ? { ...parsed, by: model } : { ...FALLBACK_SCRIPT, by: 'fallback' };
  } catch (error) { meterFail({ lane: 'writer', model, error }); return { ...FALLBACK_SCRIPT, by: 'fallback' }; }
  finally { if (adm?.ok && adm.via === 'keeper') await policy.release(model); }
}

const run = (bin, args, opts = {}) => new Promise((resolve) => execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, ...opts },
  (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '').slice(-600) })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds of a media file (ffprobe), or 0. */
export async function mediaSeconds(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number.parseFloat(r.stdout) || 0;
}

// Words on the picture are drawn by macOS itself (AppKit through osascript's JavaScript): every Mac has it, while ffmpeg's
// own text filter is often not built in (Homebrew's isn't). ffmpeg then only lays the picture over the video.
const TEXT_PNG = `ObjC.import('AppKit');
function run(argv) {
  const spec = JSON.parse(argv[0]), W = spec.width, H = spec.height;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  const c = (a) => $.NSColor.colorWithCalibratedRedGreenBlueAlpha(a[0], a[1], a[2], a[3]);
  c(spec.background).setFill; $.NSRectFill($.NSMakeRect(0, 0, W, H));
  const drawn = spec.lines.map((l) => {
    const font = (l.font && $.NSFont.fontWithNameSize(l.font, l.size)) || $.NSFont.boldSystemFontOfSize(l.size);
    const attrs = $.NSDictionary.dictionaryWithObjectsForKeys($([font, c(l.color), $(l.kern || 0)]), $([$.NSFontAttributeName, $.NSForegroundColorAttributeName, $.NSKernAttributeName]));
    const s = $.NSString.alloc.initWithUTF8String(l.text);
    return { s, attrs, size: s.sizeWithAttributes(attrs) };
  });
  const gap = spec.gap || 0, total = drawn.reduce((t, d) => t + d.size.height, 0) + gap * (drawn.length - 1);
  let y = (H + total) / 2;
  for (const d of drawn) { y -= d.size.height; d.s.drawAtPointWithAttributes($.NSMakePoint((W - d.size.width) / 2, y), d.attrs); y -= gap; }
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(spec.out, true);
  return spec.out;
}`;

/** Draw lines of text into a PNG (centred). spec: { out, width, height, background:[r,g,b,a], gap, lines:[{text, size, color:[r,g,b,a], font?, kern?}] } */
export async function textPng(spec, { work }) {
  const script = join(work, 'text-png.js');
  if (!existsSync(script)) writeFileSync(script, TEXT_PNG);
  const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify(spec)]);
  return r.ok && existsSync(spec.out) ? spec.out : null;
}

// Video is encoded by Apple's VideoToolbox, which every Mac has: the ffmpeg that ships in Kingmaker.app is LGPL-only (no x264).
const H264 = ['-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-b:v', '10M'];

/**
 * Pure: which part of a scene's recording to use, and how fast, so the scene is as long as its voice (`secs`) and ends
 * just after the action landed (`landed`, seconds into the recording; `recorded`, the recording's length). Footage longer
 * than the voice is sped up (at most `maxSpeed`), then its start is dropped; shorter footage holds its last frame.
 */
export function footageWindow({ secs, landed, recorded, tail = 1.5, maxSpeed = 2.5 }) {
  const to = Math.min(recorded, Math.max(1, landed + tail));
  const speed = Math.min(maxSpeed, Math.max(1, to / secs));
  const from = Math.max(0, to - secs * speed);
  const r = (n) => Math.round(n * 100) / 100;
  return { from: r(from), to: r(to), speed: r(speed) };
}

/** Pure: the ffmpeg arguments for one scene: the chosen window of the clip (sped up if need be) fitted to 1920×1080, held to
 *  `secs`, its caption laid over it, its voice. */
export function sceneArgs({ clip, voice, caption, secs, out, from = 0, to = null, speed = 1 }) {
  const window = to == null ? '' : `trim=start=${from}:end=${to},`;
  const base = `[0:v]${window}setpts=(PTS-STARTPTS)/${speed},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,`
    + `tpad=stop_mode=clone:stop_duration=${secs},trim=duration=${secs},setpts=PTS-STARTPTS`;
  const v = caption ? `${base}[b];[b][2:v]overlay=(W-w)/2:H-h-110[v]` : `${base}[v]`;
  return ['-y', '-i', clip, '-i', voice, ...(caption ? ['-i', caption] : []), '-filter_complex', `${v};[1:a]apad,atrim=duration=${secs}[a]`,
    '-map', '[v]', '-map', '[a]', ...H264, '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', out];
}

/** Pure: the title card's ffmpeg arguments: its picture (the wordmark and the line) held for `secs`, with its voice. */
export function cardArgs({ voice, card, secs, out }) {
  return ['-y', '-loop', '1', '-framerate', '30', '-t', String(secs), '-i', card, '-i', voice,
    '-filter_complex', `[0:v]scale=1920:1080,fps=30,format=yuv420p[v];[1:a]apad,atrim=duration=${secs}[a]`, '-map', '[v]', '-map', '[a]',
    ...H264, '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', String(secs), out];
}

/**
 * Make the ad. deps: { say(line), show?(line) (in the bar, not spoken), hush?(on) (Kingmaker's voice off/on), barSay(text, framed),
 * synth(text) → {out, dir} | null (Kokoro), makeImage(prompt) → {ok, file}, tools (videoTools()) }. → { ok, file?, seconds?, why?, script }
 * One request, one spoken line (owner 2026-10-15, "double vocal response"): progress goes to the bar as text, the scenes'
 * own answers are shown but not spoken, and the caller speaks the result or the failure once.
 */
export async function makeAdVideo({ request, model, facts, deps, now = new Date(), desktop = homeFolder('ads', { make: false }), policy = null }) {   // Kingmaker's folder, not the Desktop
  const { barSay, synth, makeImage: draw } = deps, tools = deps.tools ?? videoTools();
  const note = deps.show ?? deps.say, hush = deps.hush ?? (() => {});
  // stage: true (the bar on camera), 'aside' (still staged, out of the shot: the picture scene), false (put back). Each
  // change is sent once; false is sent even when a scene fails.
  let staged = false;
  const stage = (on) => { if (on !== staged) { staged = on; deps.stage?.(on); } };
  if (!tools.ready) return { ok: false, why: `Making video needs ${tools.missing.join(', ')}, which should ship inside Kingmaker; it isn't on this Mac.` };
  const work = mkdtempSync(join(tmpdir(), 'kingmaker-ad-'));
  try {
    await note(`Making the ad: ${model} is writing the script.`);
    const script = await writeScript({ request, model, facts, policy });
    await note(`Script ready (${script.scenes.length} scenes${script.by === 'fallback' ? ', from the plain facts: the model didn\'t give a usable script' : ''}). Recording Kingmaker at work now: hands off the Mac for about a minute.`);
    const segments = [];
    hush(true); // the scenes play out in the bar silently: the ad has its own voice
    stage(true); // the bar on camera: a fresh chat (not the owner's history), a normal size, staying in front
    for (const [i, s] of script.scenes.entries()) {
      const vo = await synth(s.voiceover);
      if (!vo?.out) return { ok: false, why: 'Kokoro, Kingmaker\'s voice, didn\'t answer', script };
      const voSecs = await mediaSeconds(tools.ffprobe, vo.out), secs = Math.max(3.5, Math.ceil((voSecs + 0.6) * 10) / 10);
      const clip = join(work, `clip${i}.mov`);
      let picture = null;
      if (DEMOS[s.demo].picture) {
        const p = await draw(`a striking, clean poster that says "${s.caption || 'Kingmaker'}" for an AI app that runs on your own Mac, black and green`).catch(() => null);
        if (p?.ok) picture = p.file;
        else { try { rmSync(vo.dir, { recursive: true, force: true }); } catch { /* temp */ } continue; } // nothing to show: no scene
      }
      // Record, then act: the clip starts with the screen as it is and catches the action as it happens.
      const demo = DEMOS[s.demo], started = Date.now();
      const rec = spawn(tools.screencapture, ['-v', '-V', String(demo.cap), '-x', clip], { stdio: 'ignore' });
      const done = new Promise((r) => rec.on('close', r));
      await sleep(700);
      if (picture) { stage('aside'); spawn('/usr/bin/open', ['-a', 'Preview', picture], { stdio: 'ignore' }); await sleep(2500); }
      else if (demo.bar) await barSay(demo.bar, demo.framed ? `${facts}\n\n${demo.bar}` : demo.bar);
      if (demo.front) { spawn('/usr/bin/open', ['-a', demo.front], { stdio: 'ignore' }); await sleep(1500); }
      const landed = (Date.now() - started) / 1000; // the answer (or the app) is on screen by now
      await done;
      if (picture) { await run('/usr/bin/osascript', ['-e', 'tell application "Preview" to close every window']); stage(true); }
      if (!existsSync(clip)) {
        // Only macOS can grant this; Kingmaker never flips it. Show the person the exact switch.
        (deps.openSettings ?? (() => execFile('/usr/bin/open', [SCREEN_RECORDING_PANE], () => {})))();
        return { ok: false, why: SCREEN_RECORDING_WHY, script };
      }
      const caption = s.caption ? await textPng({ out: join(work, `cap${i}.png`), width: 1400, height: 150, background: [0, 0, 0, 0.65],
        lines: [{ text: s.caption, size: 66, color: [1, 1, 1, 1] }] }, { work }) : null;
      const seg = join(work, `seg${i}.mp4`);
      const win = footageWindow({ secs, landed, recorded: (await mediaSeconds(tools.ffprobe, clip)) || demo.cap });
      const r = await run(tools.ffmpeg, sceneArgs({ clip, voice: vo.out, caption, secs, out: seg, ...win }));
      try { rmSync(vo.dir, { recursive: true, force: true }); } catch { /* temp */ }
      if (!r.ok) return { ok: false, why: `ffmpeg couldn't cut scene ${i + 1}: ${r.stderr.slice(-200)}`, script };
      segments.push(seg);
    }
    hush(false); stage(false);
    // The title card: the wordmark, the line, Kingmaker's voice.
    const endLine = 'Kingmaker. Your AI, on your Mac.';
    const endVo = await synth(`${endLine} Download it and click.`);
    const cardPng = endVo?.out ? await textPng({ out: join(work, 'card.png'), width: 1920, height: 1080, background: [0, 0, 0, 1], gap: 40,
      lines: [{ text: 'KINGMAKER', size: 150, color: [1, 1, 1, 1], font: 'BodoniSvtyTwoITCTT-Bold', kern: 24 }, { text: 'Your AI, on your Mac.', size: 60, color: [0.29, 0.87, 0.5, 1] }] }, { work }) : null;
    if (cardPng) {
      const secs = Math.max(4, Math.ceil((await mediaSeconds(tools.ffprobe, endVo.out) + 1) * 10) / 10), card = join(work, 'card.mp4');
      const r = await run(tools.ffmpeg, cardArgs({ voice: endVo.out, card: cardPng, secs, out: card }));
      if (r.ok) segments.push(card);
    }
    const list = join(work, 'list.txt');
    writeFileSync(list, segments.map((f) => `file '${f}'`).join('\n'));
    mkdirSync(desktop, { recursive: true });
    const stamp = `${now.toISOString().slice(0, 10)} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
    const file = join(desktop, `Kingmaker Ad ${stamp}.mp4`);
    const joined = await run(tools.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file]);
    if (!joined.ok || !existsSync(file)) return { ok: false, why: `ffmpeg couldn't join the scenes: ${joined.stderr.slice(-200)}`, script };
    return { ok: true, file, seconds: Math.round(await mediaSeconds(tools.ffprobe, file)), script };
  } finally { hush(false); stage(false); rmSync(work, { recursive: true, force: true }); }
}
