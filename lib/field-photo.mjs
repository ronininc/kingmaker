// lib/field-photo.mjs — a photo from the phone (the camera, the library, or a frame of a field video), on the turn that
// comes after it. The phone app (lib/phone-companion.mjs) saves it under Field/<tenant> and hands it to the next turn
// as `image` { path, mimeType, filename, receivedAt }; this module decides which tool takes it, so the photo is never
// dropped by a lane that can't see it (soak 2026-10-16: "Did you get the image I just sent you?" → the local writer,
// which never saw it: "No, I didn't receive the image").
//
//   look / read   the governed brain's local vision lane (the engine's vision turn: describe it, read the text off it). The
//                 words go in the way that lane is asked ("Look at this photo I just sent: …"), with the image. A Mac
//                 with no model that sees images says so plainly, or a cloud brain the owner chose looks instead.
//   save          a copy in Kingmaker's own Documents (or Pictures), the folders the Artifacts tab shows. Local, Kingmaker's
//                 own folder: no approval, like the Field copy itself.
//   job           a work request ("write a proposal for Taco Joe's from these menu photos") is a job on the CRM's board,
//                 the photo riding the job as an attachment (lib/crm-jobs.mjs).
//   edit          "make a poster from this photo": the image lane draws with the photo as its starting picture.
//   anything else the governed brain, with the image and the photo's path in the words (the bar's own attachment
//                 convention: a file's path, quoted, in the message), so every tool that takes a file path has it, and
//                 anything outward (sending it, a CRM write) waits at the same approval gates as ever.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { homeFolder } from './kingmaker-home.mjs';

/** A photo older than this doesn't ride a turn: a picture from this morning is not what "what is this?" means now. */
export const PHOTO_TTL_MS = 30 * 60_000;
/** the engine's vision lane (the bundled runtime) reads an image file up to 8 MB, and decodes it with sharp: JPEG and PNG
 *  for sure, HEIC not (sharp's prebuilt libvips has no HEVC decoder). */
export const VISION_MAX_BYTES = 8_000_000;
export const VISION_READY_TYPES = /^image\/(jpeg|png)$/i;
/** The model names the engine's vision lane picks from (the same pattern as the bundled runtime), so "this Mac can see"
 *  means what the lane will actually use. SOLOMON_VISION_MODEL pins one. */
export const VISION_NAMES = /vision|llava|bakllava|moondream|minicpm-?v|(?:^|[^a-z])vl(?:[^a-z]|$)|qwen2\.5-vl|qwen3\.5|gemma3|internvl|pixtral/i;

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
/** Pure: the upload's type — the header the phone sent, else the file's extension (iOS sends HEIC with an empty type). */
export function uploadType(header, name) {
  const h = String(header || '').split(';')[0].trim().toLowerCase();
  if (h && h !== 'application/octet-stream') return h;
  return MIME_BY_EXT[extname(String(name || '')).toLowerCase()] || h || 'application/octet-stream';
}

/** Pure: is this pending photo still for the next turn? */
export const photoFresh = (p, now = Date.now(), ttl = PHOTO_TTL_MS) => Boolean(p?.path) && now - Date.parse(p.receivedAt || 0) <= ttl;

/** The longest side a photo is given for the vision lane (it looks at 1024 px; the rest is for reading small text). */
export const VISION_MAX_PX = 2560;

/**
 * Make an upload readable by the vision lane: a HEIC/HEIF/WebP photo, or one over 8 MB, becomes a JPEG next to it (at
 * most VISION_MAX_PX on its long side, never enlarged) with macOS's own `sips`; a JPEG or PNG under the limit stays as it
 * is. Resolves { path, mimeType, converted } — the original when conversion isn't needed or fails (the lane then says it
 * couldn't read it, never silently).
 */
export function visionCopy(path, mimeType, { size = null, run = execFile, sips = '/usr/bin/sips' } = {}) {
  const bytes = size ?? (() => { try { return statSync(path).size; } catch { return 0; } })();
  if (VISION_READY_TYPES.test(mimeType || '') && bytes <= VISION_MAX_BYTES) return Promise.resolve({ path, mimeType, converted: false });
  const out = `${path.replace(/\.[^./ ]+$/, '')}.jpg`;
  const target = out === path ? `${path.replace(/\.[^./ ]+$/, '')} (vision).jpg` : out;
  const sh = (args) => new Promise((resolve) => run(sips, args, { timeout: 60_000 }, (error, stdout) => resolve(error ? null : String(stdout ?? ''))));
  return (async () => {
    const dims = (await sh(['-g', 'pixelWidth', '-g', 'pixelHeight', path])) || '';
    const long = Math.max(...[...dims.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])), 0);
    const made = await sh(['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', ...(long > VISION_MAX_PX ? ['-Z', String(VISION_MAX_PX)] : []), path, '--out', target]);
    return made !== null && existsSync(target) ? { path: target, mimeType: 'image/jpeg', converted: true } : { path, mimeType, converted: false };
  })();
}

// ── WHAT THE OWNER WANTS DONE WITH THE PHOTO ─────────────────────────────────────────────────────────────────────────
const PHOTO_NOUN = String.raw`(?:photos?|pictures?|pics?|images?|shots?|snaps?|screenshots?|menus?|signs?|receipts?|labels?|cards?|flyers?|documents?|pages?)`;
const REF = new RegExp(String.raw`\b(?:this|that|these|those|it|the|my)\s+(?:[\w'-]+\s+){0,2}?${PHOTO_NOUN}\b|\b(?:this|that|it|these|those|them)\b`, 'i');
const SAVE = /^(?:please\s+)?(?:save|keep|store|file|copy|put|add)\b(?![\s\S]*\b(?:crm|ticket|job|merchant|lead|deal|text|words)\b)[\s\S]{0,80}?(?:\b(?:to|in|into|on)\s+(?:my\s+|the\s+|kingmaker'?s?\s+)?(?:files?|documents?|docs|folder|knowledge|notes?|library|pictures?|photos?|artifacts?)\b|$)/i;
const READ = /\b(?:read|transcribe|ocr|type\s+out|copy\s+(?:out\s+)?the\s+(?:text|words)|extract\s+the\s+(?:text|words)|pull\s+the\s+(?:text|words))\b|\bwhat\s+(?:does|do)\s+(?:it|this|that|they|these|those|the\s+[\w'-]+)\s+say\b|\b(?:text|words|writing)\s+(?:on|in|off|from)\b/i;
const EDIT = /\b(?:edit|retouch|touch\s+up|enhance|restyle|redraw|stylize|cartoon(?:ize)?|turn\s+(?:it|this|that|the\s+\w+)\s+into|make\s+(?:it|this|that)\s+(?:look|into)|remove\s+the\s+background)\b|\b(?:make|draw|generate|create|design|paint|render)\b[\s\S]{0,40}\b(?:posters?|logos?|flyers?|banners?|icons?|art|illustrations?|renders?|images?|pictures?)\b[\s\S]{0,30}\b(?:from|of|out\s+of|using|with|based\s+on)\s+(?:this|that|it|the|my)\b/i;
// A vision question that needs no "this": "what do you see?", "describe", "look", "did you get it?".
const LOOK_ALONE = /^(?:(?:hey\s+)?kingmaker[,\s]+)?(?:what\s+(?:do|can)\s+you\s+see|tell\s+me\s+what\s+you\s+see|describe|look|did\s+you\s+(?:get|receive|see)\s+(?:it|that|this|them|my\s+\w+))\b/i;
const LOOK = /\b(?:what(?:'?s|\s+is|\s+are)|who(?:'?s|\s+is)|which|identify|describe|look\s+at|see|seeing|check\s+(?:out|this)|tell\s+me\s+about|did\s+you\s+(?:get|receive)|got\s+(?:it|the|my)|how\s+(?:much|many|old|big)|is\s+(?:this|that|it|there)|are\s+(?:these|those|there)|can\s+you)\b/i;

/**
 * Pure: what the turn wants done with the photo it carries — 'save', 'edit', 'read' (the text on it), 'look' (what's in
 * it), 'use' (another tool, about the photo: send it, attach it…) or 'none' (the words aren't about the photo).
 * The CRM job is decided by lib/crm-jobs.mjs (workRequest), not here.
 */
export function photoIntent(text) {
  const t = String(text || '').trim();
  if (!t) return 'look';
  const ref = REF.test(t) || new RegExp(String.raw`\b${PHOTO_NOUN}\b`, 'i').test(t);
  if (ref && SAVE.test(t)) return 'save';
  if (EDIT.test(t)) return 'edit';
  if (READ.test(t)) return 'read';
  if ((ref && LOOK.test(t)) || LOOK_ALONE.test(t)) return 'look';
  return ref ? 'use' : 'none';
}

/** Pure: where "save this" puts it — Kingmaker's Pictures when the owner says so, else its Documents. */
export const saveFolder = (text) => (/\b(?:to|in|into)\s+(?:my\s+|the\s+|kingmaker'?s?\s+)?(?:pictures?|photos?)\b/i.test(String(text || '')) ? 'pictures' : 'documents');

/** Pure: the words for the engine's vision lane, asked the way it listens for (it describes, or reads, and answers them). */
export function lookText(text, intent = 'look') {
  const t = String(text || '').trim();
  const lead = intent === 'read' ? 'Read the text in this photo I just sent' : 'Look at this photo I just sent';
  return t ? `${lead}: ${t}` : `${lead}.`;
}

/** Pure: the bar's attachment convention — the file's path in the message, quoted when it has a space. */
export function withPath(text, path) {
  const p = String(path || '');
  if (!p) return String(text || '');
  return `${String(text || '').trim()} ${/\s/.test(p) ? `"${p}"` : p}`.trim();
}

/** Pure: the photo as a CRM job attachment (no bytes: the job carries where it is on this Mac and what it is). */
export function jobAttachment(image, { stat = statSync } = {}) {
  let bytes = null; try { bytes = stat(image.path).size; } catch { /* gone: still named */ }
  return { kind: 'field-photo', path: image.path, filename: image.filename || basename(image.path), mimeType: image.mimeType || uploadType('', image.path), ...(bytes != null ? { bytes } : {}), ...(image.receivedAt ? { receivedAt: image.receivedAt } : {}) };
}

/** Does this Mac have a model the engine's vision lane will look with? true/false, or null when Ollama didn't answer
 *  (then the lane itself says what happened). Never throws. */
export async function visionReady({ env = process.env, base = env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  if (String(env.SOLOMON_VISION_MODEL ?? '').trim()) return true;
  try {
    const r = await fetchImpl(`${String(base).replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.models || []).some((m) => VISION_NAMES.test(String(m?.name || m?.model || '')));
  } catch { return null; }
}

/** Copy the photo into Kingmaker's own Documents or Pictures (the Artifacts tab). { ok, file } or { ok:false, reason }. */
export function savePhoto(image, { folder = 'documents', env = process.env, home = homedir() } = {}) {
  try {
    if (!existsSync(image.path)) return { ok: false, reason: 'the photo is no longer in Field' };
    const dir = homeFolder(folder, { env, home });
    const name = basename(image.path);
    let file = join(dir, name);
    for (let i = 2; existsSync(file); i++) file = join(dir, `${name.replace(/(\.[^.]+)?$/, ` ${i}$1`)}`);
    copyFileSync(image.path, file);
    return { ok: true, file };
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 120) }; }
}

export const NO_VISION_LINE = (name) => `Your photo is on this Mac (Field, ${name}), but no model here can see images yet, so I can't tell you what's in it. Pick one that says "sees images" in the model picker (Gemma 3 4B is small), then ask again.`;

/**
 * One turn that carries a phone photo. `deps`:
 *   governed(text, image)   the governed brain's turn (session.runTurn with the image): vision lane, files, CRM, gates
 *   say(line)               a line to the owner (the bar, the phone, spoken)
 *   brain                   the cloud brain the owner chose, or null: { runTurn(text, { image }), sees: bool } (one that
 *                           sees gets the photo itself: Claude may Read that one file, Codex attaches it with --image)
 *   crmJob(text, attachments)  lib/crm-jobs.mjs handle(): true when it took the turn as a job (only when jobs are on)
 *   edit(text, path)        the image lane with the photo as its start ({ ok, file, ms } | { ok:false, reason }), or null
 *   visionReady()           true / false / null (unknown)
 *   save(image, { folder }) the copy into Kingmaker's folders
 * Resolves { via, intent } — which tool took it.
 */
export async function fieldPhotoTurn({ text, framed = text, image, deps }) {
  const { governed, say, brain = null, crmJob = null, edit = null, visionReady: ready = async () => null, save = savePhoto, log = () => {} } = deps;
  const name = image.filename || basename(image.path);
  const intent = photoIntent(text);
  const done = (via) => { log('field_photo_turn', { intent, via }); return { via, intent }; };
  if (intent === 'save') {
    const r = save(image, { folder: saveFolder(text) });
    await say(r.ok ? `Saved your photo in Kingmaker's ${saveFolder(text) === 'pictures' ? 'Pictures' : 'Documents'} (Artifacts in the bar): ${basename(r.file)}.` : `I couldn't save the photo: ${r.reason}.`);
    return done('save');
  }
  if (crmJob && intent !== 'look' && intent !== 'read' && await crmJob(text, [jobAttachment(image)])) return done('crm-job');
  if (intent === 'edit') {
    if (!edit) { await say(`I can't draw from a photo on this Mac yet: the image engine isn't set up. Your photo is saved in Field (${name}).`); return done('edit-unavailable'); }
    await say('Working from your photo on this Mac. About a minute and a half.');
    const r = await edit(text, image.path);
    await say(r.ok ? `Done in ${Math.round(r.ms / 1000)} seconds. It's saved with Kingmaker's files (Artifacts in the bar).` : `I couldn't make it from your photo: ${r.reason}.`);
    return done('edit');
  }
  if (intent === 'look' || intent === 'read') {
    const can = await ready();
    if (can === false) {
      if (brain?.sees) { await brain.runTurn(framed, { image }); return done('brain'); }
      await say(NO_VISION_LINE(name));
      return done('no-vision');
    }
    await governed(lookText(framed, intent), image);
    return done('vision');
  }
  // 'use': the words are about the photo, so its path rides them (send it, attach it…); 'none': the image rides alone.
  const words = intent === 'use' ? withPath(framed, image.path) : framed;
  // A brain that sees (Claude, ChatGPT) gets the photo itself and a line saying where it is; one that can't, the path.
  if (brain) { await brain.runTurn(brain.sees ? framed : words, { image }); return done('brain'); }
  await governed(words, image);
  return done('governed');
}
