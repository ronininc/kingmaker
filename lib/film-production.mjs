// Bounded data-to-film adapter. Model output is data, never executable Python or shell.
// Callers must supply authorized executable paths; no install, download, model or key access.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, stat, statfs, realpath, open, unlink } from 'node:fs/promises';
import { resolve, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const builder = fileURLToPath(new URL('../assets/film/scene-builder.py', import.meta.url));
const fail = (s) => { throw new Error(`film-production: ${s}`); };
const num = (v, lo, hi, name) => Number.isFinite(v) && v >= lo && v <= hi ? v : fail(`invalid ${name}`);
const integer = (v, lo, hi, name) => Number.isInteger(v) ? num(v, lo, hi, name) : fail(`invalid ${name}`);
const vec = (v, lo, hi, name) => Array.isArray(v) && v.length === 3 ? v.map(n => num(n, lo, hi, name)) : fail(`invalid ${name}`);
const text = (v, max, name) => typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v) ? v : fail(`invalid ${name}`);
// A format-valid MP4 is not evidence of cinematic fidelity or general intelligence.
export const FILM_CAPABILITIES = Object.freeze({
  profile: 'procedural-proof',
  primitives: true, transformAnimation: true, existingAudioMix: true,
  assetImport: false, pbrTextures: false, skeletalAnimation: false,
  facialAnimation: false, generatedVoice: false, temporalQualityReview: false,
  productionQualityCertified: false,
});
export function requireFilmQuality(target = 'procedural-proof') {
  if (target !== FILM_CAPABILITIES.profile)
    fail(`quality target ${String(target)} is unsupported; this producer only provides procedural-proof. Required production assets, PBR materials, character rig/animation, audio and visual review are not implemented. No silent downgrade.`);
  return FILM_CAPABILITIES;
}
export function validateFilmPlan(raw) {
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 256 * 1024) fail('plan exceeds 256 KiB');
    raw = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, ''));
  }
  if (!raw || raw.schema !== 'kingmaker.film-plan/1') fail('expected kingmaker.film-plan/1');
  requireFilmQuality(raw.qualityTarget);
  const width = integer(raw.width, 64, 1920, 'width'), height = integer(raw.height, 64, 1920, 'height');
  if (width % 2 || height % 2) fail('dimensions must be even');
  const fps = integer(raw.fps, 1, 60, 'fps');
  if (!Array.isArray(raw.shots) || !raw.shots.length || raw.shots.length > 24) fail('expected 1–24 shots');
  const ids = new Set();
  const shots = raw.shots.map((s) => {
    const id = text(s.id, 48, 'shot id');
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail('unsafe or duplicate shot id');
    ids.add(id);
    if (!Array.isArray(s.objects) || !s.objects.length || s.objects.length > 64) fail('expected 1–64 scene objects');
    const objects = s.objects.map(o => {
      if (!['cube', 'sphere', 'cylinder', 'plane', 'text'].includes(o.kind)) fail('unsupported primitive');
      const x = { kind: o.kind, position: vec(o.position, -100, 100, 'position'), scale: vec(o.scale, 0.001, 100, 'scale'), color: vec(o.color, 0, 1, 'color'), rotation: vec(o.rotation ?? [0, 0, 0], -360, 360, 'rotation'), emission: num(o.emission ?? 0, 0, 10, 'emission') };
      if (o.kind === 'text') x.text = text(o.text, 200, 'text');
      if (o.endPosition) x.endPosition = vec(o.endPosition, -100, 100, 'endPosition');
      if (o.endRotation) x.endRotation = vec(o.endRotation, -360, 360, 'endRotation');
      return x;
    });
    const camera = { position: vec(s.camera?.position, -100, 100, 'camera position'), target: vec(s.camera?.target, -100, 100, 'camera target'), lens: num(s.camera?.lens ?? 45, 10, 120, 'lens') };
    if (camera.position.every((n, i) => n === camera.target[i])) fail('camera equals target');
    return { id, frames: integer(s.frames, 1, fps * 30, 'frames'), objects, camera, background: vec(s.background ?? [0.015, 0.02, 0.03], 0, 1, 'background') };
  });
  if (shots.reduce((n, s) => n + s.frames, 0) > fps * 180) fail('film exceeds 180 seconds');
  const out = { schema: raw.schema, qualityTarget: 'procedural-proof', title: text(raw.title, 120, 'title'), width, height, fps, shots };
  if (raw.audio) {
    if (typeof raw.audio.path !== 'string' || isAbsolute(raw.audio.path) || raw.audio.path.split(/[\\/]/).includes('..')) fail('audio must be workDir-relative');
    out.audio = { path: raw.audio.path, source: text(raw.audio.source, 500, 'audio source'), license: text(raw.audio.license, 500, 'audio license') };
  }
  return out;
}
export function runFilmTool(bin, args, { cwd, timeoutMs = 120000, signal } = {}) {
  return new Promise((done, reject) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, signal, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PWD: cwd } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${bin}: ${error.message}; ${String(stderr).slice(-800)}; ${String(stdout).slice(-1200)}`));
      else done({ stdout: String(stdout), stderr: String(stderr).slice(-800) });
    });
  });
}
async function probeVideo(file, tools, run, options) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], options);
  const p = JSON.parse(stdout), video = p.streams?.find(s => s.codec_type === 'video');
  if (!video || !Number.isFinite(Number(p.format?.duration))) fail('output is not a playable video');
  return { width: video.width, height: video.height, frames: Number(video.nb_read_frames), duration: Number(p.format.duration), audio: p.streams.some(s => s.codec_type === 'audio') };
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function produceFilm({ plan: raw, workDir, tools, run = runFilmTool, signal, onProgress = () => {}, frameBudgetSec = 30, maxRunMs = 300000, qualityTarget = 'procedural-proof' } = {}) {
  requireFilmQuality(qualityTarget);
  const plan = validateFilmPlan(raw);
  num(frameBudgetSec, 0.1, 120, 'frameBudgetSec'); integer(maxRunMs, 1000, 3600000, 'maxRunMs');
  for (const name of ['blender', 'ffmpeg', 'ffprobe']) if (typeof tools?.[name] !== 'string' || !isAbsolute(tools[name])) fail(`caller must supply approved ${name} absolute path`);
  const root = await realpath(workDir);
  const disk = await statfs(root);
  const estimated = plan.width * plan.height * 4 * plan.shots.reduce((n, s) => n+s.frames, 0) + 32 * 1024 * 1024;
  if (disk.bavail * disk.bsize < estimated + 256 * 1024 * 1024) fail('insufficient free space for bounded render plus 256 MiB reserve');
  let audio;
  if (plan.audio) {
    audio = await realpath(resolve(root, plan.audio.path));
    if (!audio.startsWith(root + sep) || !(await stat(audio)).isFile()) fail('audio escapes workDir or is not a file');
  }
  // Exclusive run lock prevents parallel renders by this adapter on the same workDir.
  const lockPath = join(root, '.kingmaker-film.lock');
  const lock = await open(lockPath, 'wx').catch(() => fail('another film run holds this workDir; do not remove a live lock'));
  let dir, record;
  const started = Date.now();
  const invoke = (bin, args) => {
    const remaining = maxRunMs - (Date.now() - started);
    if (remaining <= 0) fail('run deadline exceeded');
    return run(bin, args, { cwd: dir, timeoutMs: remaining, signal });
  };
  try {
    dir = await mkdtemp(join(root, 'film-'));
    record = { schema: 'kingmaker.film-production/2', status: 'running', plan, jobs: [], deliverable: null, audio: audio ? 'pending' : 'not-run', limitations: ['Procedural scene-graph renderer; no photorealistic character generation, lip sync, fleet dispatch, or independent aesthetic review.'] };
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
    const clips = [];
    for (let i = 0; i < plan.shots.length; i++) {
      const shot = plan.shots[i], frames = join(dir, shot.id); await mkdir(frames);
      const spec = join(dir, `${shot.id}.json`); await writeFile(spec, JSON.stringify({ ...plan, shots: [shot] }));
      const args = ['--background', '--factory-startup', '--disable-autoexec', '--threads', '1', '--python', builder, '--', spec, frames];
      onProgress({ stage: 'render', shot: shot.id, index: i, total: plan.shots.length });
      const firstStart = Date.now();
      await invoke(tools.blender, [...args, '1', '1']);
      const firstSec = (Date.now() - firstStart) / 1000;
      if (firstSec > frameBudgetSec) fail(`shot ${shot.id} first frame exceeded budget (${firstSec.toFixed(2)}s > ${frameBudgetSec}s); no silent quality reduction`);
      if (shot.frames > 1) await invoke(tools.blender, [...args, '2', String(shot.frames)]);
      for (let n = 1; n <= shot.frames; n++) {
        const file = join(frames, `${String(n).padStart(4, '0')}.png`);
        const handle = await open(file, 'r');
        try { const header = Buffer.alloc(8); const {bytesRead} = await handle.read(header, 0, 8, 0);
          if (bytesRead !== 8 || !header.equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail(`invalid frame ${shot.id}/${n}`);
        } finally { await handle.close(); }
      }
      const clip = join(dir, `${shot.id}.mp4`);
      await invoke(tools.ffmpeg, ['-y', '-v', 'error', '-threads', '1', '-framerate', String(plan.fps), '-start_number', '1', '-i', join(frames, '%04d.png'), '-frames:v', String(shot.frames), '-c:v', 'libx264', '-profile:v', 'baseline', '-crf', '20', '-pix_fmt', 'yuv420p', clip]);
      const media = await probeVideo(clip, tools, invoke);
      if (media.frames !== shot.frames || media.width !== plan.width || media.height !== plan.height) fail(`shot ${shot.id} media mismatch`);
      record.jobs.push({ shot: shot.id, frames: media.frames, seconds: (Date.now() - firstStart) / 1000, firstFrameSec: firstSec }); clips.push(clip);
    }
    onProgress({ stage: 'assemble', total: plan.shots.length });
    const list = join(dir, 'edit.txt'); await writeFile(list, clips.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const file = join(dir, 'proof-cut.mp4'), seconds = plan.shots.reduce((n, s) => n + s.frames, 0) / plan.fps;
    await invoke(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...(audio ? ['-i', audio] : []), '-map', '0:v:0', ...(audio ? ['-map', '1:a:0', '-af', 'apad', '-c:a', 'aac'] : ['-an']), '-c:v', 'copy', '-t', String(seconds), '-movflags', '+faststart', file]);
    const media = await probeVideo(file, tools, invoke);
    if (media.width !== plan.width || media.height !== plan.height || media.frames !== plan.shots.reduce((n,s) => n+s.frames,0) || Math.abs(media.duration-seconds) > 1/plan.fps + 0.05 || (!!audio !== media.audio)) fail('assembled output failed media verification');
    record.status = 'completed'; record.audio = audio ? 'mixed' : 'not-run';
    record.deliverable = { path: file, sha256: await hashFile(file), ...media };
    onProgress({ stage: 'completed', file });
    return { ok: true, file, record, recordPath: join(dir, 'film-record.json') };
  } catch (error) {
    if (record) { record.status = 'failed'; record.reason = String(error.message); }
    throw error;
  } finally {
    try { if (record) await writeFile(join(dir, 'film-record.json'), JSON.stringify(record, null, 2)); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
