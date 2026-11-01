// lib/image-lane.mjs — the fast layer's image lane: "make a poster …" draws on this Mac with Z-Image-Turbo through
// stable-diffusion.cpp (Metal), no cloud. Proven 2026-10-14 on a 24 GB M5 Pro: 1024² in ~77 s, 6.2 GB of GPU memory.
// The Ollama models are let go first (keep_alive 0): with the 8B writer still loaded the Mac fell to 1.2 GB free.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FOLDERS, kingmakerHome } from './kingmaker-home.mjs';

export function imageLaneSetup({ state, env = process.env, home = homedir(), exists = existsSync }) {
  const models = join(state, 'models', 'image');
  const setup = {
    bin: env.KINGMAKER_SD_CLI || join(home, 'Projects', 'stable-diffusion.cpp', 'build', 'bin', 'sd-cli'),
    diffusion: join(models, 'diffusion', 'z_image_turbo-Q4_K.gguf'),
    vae: join(models, 'vae', 'ae.safetensors'),
    llm: join(models, 'text_encoders', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
    out: join(kingmakerHome(env, home), FOLDERS.pictures),   // Kingmaker's hidden folder, not ~/Pictures
  };
  const missing = ['bin', 'diffusion', 'vae', 'llm'].filter((k) => !exists(setup[k]));
  return { ...setup, ready: missing.length === 0, missing };
}

// Words in the prompt about words make Z-Image write some. Its encoder (Qwen) was trained hard on rendering Chinese and
// English text, and at cfg 1.0 a "no …" is not followed: "no other text or captions" put invented lettering (often
// Chinese) on pictures that asked for none (the owner, 2026-10-16: "why do i keep getting weird chinese and random
// language text on images"). So text is mentioned only when the owner asked for some, and then only those words.
// A quotation counts only as a pair ("…", “…”, or ‘…’ standing apart from a word): a lone apostrophe ("a woman’s face")
// is not a request for lettering.
const ASKS_FOR_WORDS = /"[^"]+"|“[^”]+”|(?:^|[\s(\[])‘[^’]+’(?![\p{L}\p{N}])|\b(?:saying|says|that says|reads?|reading|titled|named|caption(?:ed)?|headline|slogan|tagline|logo|lettering|with the (?:words?|text|name|title))\b/iu;

/** Pure: the drawing prompt from what the owner said ("make a poster for taco night" → "a poster for taco night, …"). */
export function imagePrompt(text) {
  const t = String(text || '').trim().replace(/^(please\s+)?(can you\s+)?(make|draw|generate|create|design|paint|render)\s+(me\s+)?/i, '').replace(/[.!?]+$/, '');
  const style = 'high quality, sharp detail, clean composition';
  return (ASKS_FOR_WORDS.test(t) ? `${t}, the words spelled exactly as given, ${style}` : `${t}, pure illustration, ${style}`).slice(0, 1200);
}

async function freeOllama(base, fetchImpl) {
  try {
    const ps = await (await fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) })).json();
    await Promise.all((ps.models || []).map((m) => fetchImpl(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(5000) }).catch(() => null)));
  } catch { /* Ollama isn't running: nothing to free */ }
}

/** How far a drawing from a photo may move away from it (stable-diffusion.cpp --strength: 0 keeps it, 1 ignores it). */
export const FROM_PHOTO_STRENGTH = 0.6;

/** Draw it. Resolves { ok, file, ms } or { ok:false, reason }. `initImage`: a photo to start from (a field photo from the
 *  phone, "make a poster from this photo"): stable-diffusion.cpp's img2img (-i, --strength), same model, same folder.
 *  `policy` (lib/eviction-policy.mjs): on an active co-residency plan the pre-draw free goes through the
 *  reflex seat keeper and the pinned seat is SPARED; anywhere else the legacy free below runs as-is. */
export async function makeImage(text, { setup, initImage = null, base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, ''), fetchImpl = fetch, run = execFile, now = Date.now, policy = null } = {}) {
  if (!setup?.ready) return { ok: false, reason: `the image engine isn't set up on this Mac (missing: ${(setup?.missing || ['setup']).join(', ')})` };
  if (initImage && !existsSync(initImage)) return { ok: false, reason: 'the photo to start from is gone' };
  mkdirSync(setup.out, { recursive: true });
  const file = join(setup.out, `kingmaker-${new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  if (policy?.active) await policy.freeAll().catch(() => null);
  else await freeOllama(base, fetchImpl);
  const t0 = now();
  return new Promise((resolve) => {
    run(setup.bin, ['--diffusion-model', setup.diffusion, '--vae', setup.vae, '--llm', setup.llm, '-p', imagePrompt(text),
      // --mmap: the weights are file-backed pages macOS can drop instead of swapping; --vae-tiling: the 1024² decode in
      // tiles. Measured 2026-10-15 on the 24 GB M5 Pro, same prompt and seed: free memory at its lowest 8% → 41%, swap
      // +1.1 GB → +0, sd-cli resident 6.6 GB → 0.5 GB, 91 → 101 s, the picture the same (SSIM 0.98).
      '--cfg-scale', '1.0', '--steps', '8', '-W', '1024', '-H', '1024', '--diffusion-fa', '--mmap', '--vae-tiling',
      ...(initImage ? ['-i', initImage, '--strength', String(FROM_PHOTO_STRENGTH)] : []), '-o', file], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    (error) => resolve(error || !existsSync(file) ? { ok: false, reason: String(error?.message || 'no image came out').slice(0, 200) } : { ok: true, file, ms: now() - t0 }));
  });
}
