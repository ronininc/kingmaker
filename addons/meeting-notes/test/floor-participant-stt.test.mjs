// LIVE on-Mac STT proof: real speech → the installed whisper runtime → text, through lib/voice.mjs and the participant's
// audio seam. This is the "notes from what people said" half, proven on the owner's Kingmaker Mac (not a fake). It
// synthesizes a line with `say -o` (writes a file, plays NOTHING aloud), converts it to 16 kHz mono PCM with afconvert,
// and transcribes it with Kingmaker.app's bundled whisper-cli + ggml-base model. Skips cleanly where that runtime, say,
// or afconvert are absent (e.g. CI / Linux), so it never falsely fails — and never falsely passes.
//   node --test test/floor-participant-stt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribe } from '../../../lib/voice.mjs';
import { wavToSamples } from '../lib/floor-participant.mjs';

const WHISPER = process.env.SOL_GHOST_WHISPER || '/Applications/Kingmaker.app/Contents/Resources/voice-runtime/stt/whisper-cli';
const MODEL = process.env.SOL_GHOST_WHISPER_MODEL || '/Applications/Kingmaker.app/Contents/Resources/voice-runtime/models/stt/ggml-base.bin';
const have = (bin) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const ready = process.platform === 'darwin' && existsSync(WHISPER) && existsSync(MODEL) && have('say') && have('afconvert');

test('a spoken line → the installed whisper → the words back out (on-Mac STT)', { skip: ready ? false : 'whisper runtime / say / afconvert not available here' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mia-stt-'));
  try {
    const aiff = join(dir, 'line.aiff'); const wav = join(dir, 'line.wav');
    const spoken = "I'll send Pizza Studio the updated quote by Friday";
    execFileSync('say', ['-o', aiff, spoken]); // -o writes a file; nothing is played on the owner's speakers
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    const text = await transcribe(wavToSamples(readFileSync(wav)), { whisper: WHISPER, model: MODEL, language: 'en', prompt: 'Pizza Studio quote Friday' });
    assert.match(text.toLowerCase(), /pizza studio/, `whisper did not return the words: ${JSON.stringify(text)}`);
    assert.match(text.toLowerCase(), /quote/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
