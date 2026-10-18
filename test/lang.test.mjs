// Kingmaker in any language (lib/lang.mjs): what language a line is in, the conversation's language, the Mac voice for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, heardLanguage, noteHeard, parseVoices, replyLanguage, voiceFor, warmVoices } from '../lib/lang.mjs';
import { transcribe } from '../lib/voice.mjs';

test('detects the language of an answer', () => {
  const cases = { es: 'Hay 11 archivos en tu escritorio.', en: 'There are 11 files on your desktop.', fr: 'Il y a 11 fichiers sur ton bureau.',
    de: 'Auf deinem Schreibtisch sind 11 Dateien.', it: 'Ci sono 11 file sulla tua scrivania.', pt: 'Há 11 arquivos na sua área de trabalho.',
    ja: 'デスクトップに11個のファイルがあります。', zh: '桌面上有11个文件。', ko: '바탕화면에 파일이 11개 있습니다.', ru: 'На рабочем столе 11 файлов.',
    uk: 'На робочому столі є 11 файлів, і їх можна відкрити.', ar: 'يوجد 11 ملفًا على سطح المكتب.', hi: 'आपके डेस्कटॉप पर 11 फ़ाइलें हैं।' };
  for (const [code, text] of Object.entries(cases)) assert.equal(detectLanguage(text), code, text);
  assert.equal(detectLanguage('OK.'), null);
  assert.equal(detectLanguage('11'), null);
});

test('a short line follows the conversation: the language last heard, for 30 minutes', () => {
  const t0 = 1_000_000;
  noteHeard({ code: 'es', p: 0.95 }, t0);
  assert.equal(replyLanguage('OK.', t0 + 1000), 'es');
  noteHeard({ code: 'en', p: 0.3 }, t0 + 2000);              // unsure: keep Spanish
  assert.equal(heardLanguage(t0 + 3000), 'es');
  noteHeard({ code: 'ja', p: 0.99 }, t0 + 4000);             // a switch is immediate
  assert.equal(replyLanguage('OK.', t0 + 5000), 'ja');
  assert.equal(replyLanguage('There are 11 files on your desktop.', t0 + 5000), 'en');   // the answer's own language wins
  assert.equal(heardLanguage(t0 + 4000 + 31 * 60_000), null);
});

test('picks the best installed voice: Premium, then Enhanced, the Mac region first, never a novelty voice', () => {
  const listing = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Mónica (Spanish (Spain)) es_ES    # ¡Hola! Me llamo Mónica.',
    'Paulina             es_MX    # ¡Hola! Me llamo Paulina.',
    'Eddy (Spanish (Mexico)) es_MX    # ¡Hola! Me llamo Eddy.',
    'Kyoko (Enhanced)    ja_JP    # こんにちは! 私の名前はKyokoです。',
    'Flo (Japanese (Japan)) ja_JP    # こんにちは!',
  ].join('\n');
  assert.equal(parseVoices(listing).length, 5);
  warmVoices({ run: () => listing });
  assert.equal(voiceFor('es', { region: 'MX' }), 'Paulina');
  assert.equal(voiceFor('es', { region: 'ES' }), 'Mónica (Spanish (Spain))');
  assert.equal(voiceFor('ja', { region: 'US' }), 'Kyoko (Enhanced)');
  assert.equal(voiceFor('ko'), null);
});

test('transcribe asks whisper to detect the language and reports what it heard', async () => {
  const seen = [];
  // Run the real transcribe against a stand-in whisper: a script that prints text and the detection line.
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'km-whisper-')), w = join(d, 'whisper');
  writeFileSync(w, '#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\ncat > /dev/null\necho "whisper_full_with_state: auto-detected language: es (p = 0.950268)" >&2\necho "Hola, ¿qué tal?"\n');
  chmodSync(w, 0o755);
  const text = await transcribe(new Int16Array(1600), { whisper: w, model: 'm', onLanguage: (l) => seen.push(l) });
  const args = (await import('node:fs')).readFileSync(join(d, 'args'), 'utf8');
  assert.equal(text, 'Hola, ¿qué tal?');
  assert.deepEqual(seen, [{ code: 'es', p: 0.950268 }]);
  assert.match(args, /-l auto/); assert.doesNotMatch(args, /-np/);
});
