// lib/lang.mjs — Kingmaker in any language (the owner, 2026-10-15: "voice auto responds in the language its spoken to …
// the transitions need to be seamless when language swapping").
//
//   heard: whisper detects the language of each utterance (voice.mjs transcribe, -l auto); noteHeard() keeps the latest.
//   said:  each answer is spoken in its own language: detectLanguage() on the answer, else the language last heard.
//          English keeps Kokoro (it only speaks English); every other language speaks with the Mac's own voice for
//          it. The Mac's voices are listed once, up front (warmVoices), so a switch costs nothing mid-conversation.
import { spawnSync } from 'node:child_process';

const NAMES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
  ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', bn: 'Bengali', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', sv: 'Swedish', el: 'Greek', cs: 'Czech', ro: 'Romanian', hu: 'Hungarian',
  da: 'Danish', fi: 'Finnish', nb: 'Norwegian', ms: 'Malay', ca: 'Catalan', hr: 'Croatian', sk: 'Slovak', fil: 'Filipino', sw: 'Swahili' };
export const languageName = (code) => NAMES[code] || code;

// Latin-script languages by their commonest short words (and a few letters only they use).
const WORDS = {
  en: 'the and you that have for not with this but are what how can was your from they will there about would which their is on my of to it there\'s i\'m don\'t',
  es: 'el la los las que del y en un una es por para con no se su al lo como más pero sus le ya hay muy cuántos tengo mi tu tus son está están estoy eres también qué dónde',
  fr: 'le la les des et est un une que qui dans pour pas sur avec ce il elle nous vous je sont au du mais ou mon ton ta tes combien aussi',
  de: 'der die das und ist nicht ein eine ich sie wir mit auf für den dem des sich auch zu wie mein dein deine deinem habe hat haben sind gibt viele',
  it: 'il lo gli di che è e un una per non con sono mi ho ci del della nel come anche questo quanti sulla tua tuo',
  pt: 'o os que do da em um uma é não para com se por mais mas como eu você meu tenho quantos isso na no sua seu há são também',
  nl: 'de het een en is van dat niet ik je op te met voor zijn er maar ook hoe wat mijn hoeveel',
  pl: 'nie się jest to że na i w z do co jak ale czy mam mój ile tak',
  tr: 'bir ve bu da de ne için ile çok ben sen mi değil var nasıl kaç benim',
  vi: 'và của là có không các những được một trong cho tôi bạn này đó bao nhiêu',
  id: 'dan yang di ini itu dengan untuk tidak ada saya anda dari ke berapa apa',
  sv: 'och att det som en är på för med inte jag du har vad hur många min',
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
const MARKS = { es: /[ñ¿¡]/, pt: /[ãõ]|ção\b/, it: /\b\w+zione\b|\bè\b/, de: /ß|[äöü]/,  fr: /[œ]|\b(c'est|j'ai|qu'il)\b/, pl: /[łśźżąęń]/, tr: /[ığş]/, vi: /[ơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/, sv: /å/ };

/** The language of a piece of text (ISO 639-1), or null when there's too little to tell. */
export function detectLanguage(text) {
  const t = String(text || '').normalize('NFC');
  const count = (re) => (t.match(re) || []).length;
  const letters = count(/\p{L}/gu) || 1;
  if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) / letters > 0.05) return 'ja';
  if (count(/\p{Script=Hangul}/gu) / letters > 0.2) return 'ko';
  if (count(/\p{Script=Han}/gu) / letters > 0.2) return 'zh';
  if (count(/\p{Script=Arabic}/gu) / letters > 0.3) return 'ar';
  if (count(/\p{Script=Hebrew}/gu) / letters > 0.3) return 'he';
  if (count(/\p{Script=Thai}/gu) / letters > 0.3) return 'th';
  if (count(/\p{Script=Devanagari}/gu) / letters > 0.3) return 'hi';
  if (count(/\p{Script=Bengali}/gu) / letters > 0.3) return 'bn';
  if (count(/\p{Script=Greek}/gu) / letters > 0.3) return 'el';
  if (count(/\p{Script=Cyrillic}/gu) / letters > 0.3) return /[іїєґ]/i.test(t) ? 'uk' : 'ru';
  const words = t.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (!words.length) return null;
  const score = {};
  for (const [k, set] of Object.entries(SETS)) { let n = 0; for (const w of words) if (set.has(w)) n++; score[k] = n + (MARKS[k]?.test(t.toLowerCase()) ? 2 : 0); }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, n] = ranked[0], second = ranked[1][1];
  if (n < (words.length <= 3 ? 1 : 2) || n === second) return null;
  return best;
}

// ── THE CONVERSATION'S LANGUAGE: the last one the owner spoke (whisper's detection) or typed.
let heard = null;
/** whisper said what language an utterance was in ({code, p}); a confident one becomes the conversation's. */
export function noteHeard({ code, p = 1 } = {}, now = Date.now()) {
  if (!code || p < 0.5) return heard?.code ?? null;
  heard = { code: code === 'no' ? 'nb' : code, at: now };
  return heard.code;
}
export const heardLanguage = (now = Date.now(), within = 30 * 60_000) => (heard && now - heard.at < within ? heard.code : null);
/** The language an answer should be spoken in: its own, else the conversation's, else English. */
export const replyLanguage = (text, now = Date.now()) => detectLanguage(text) || heardLanguage(now) || 'en';

// ── THE MAC'S VOICES: `say -v ?` once ("Name  xx_YY  # sample"), the best one per language.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy)\b/;
const ELOQUENCE = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;
let voices = null;
export function parseVoices(listing) {
  const out = [];
  for (const line of String(listing).split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3})_([A-Za-z0-9]{2,4})\s+#/.exec(line);
    if (m && !NOVELTY.test(m[1])) out.push({ name: m[1].trim(), lang: m[2], region: m[3] });
  }
  return out;
}
/** List the Mac's voices now (call once at start, so a language switch never waits on it). */
export function warmVoices({ run = () => spawnSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8', timeout: 5000 }).stdout } = {}) {
  try { voices = parseVoices(run() || ''); } catch { voices = []; }
  return voices.length;
}
/** The best installed voice for a language: Premium, then Enhanced, then a regular one, Eloquence last; the Mac's
 *  own region first (es_MX on a Mexican Mac). null when none is installed. */
export function voiceFor(code, { region = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || '') } = {}) {
  if (!voices) warmVoices();
  const lang = code === 'nb' ? 'nb' : code === 'fil' ? 'fil' : code;
  const pool = voices.filter((v) => v.lang === lang || (lang === 'nb' && v.lang === 'no'));
  if (!pool.length) return null;
  const rank = (v) => (/Premium/.test(v.name) ? 0 : /Enhanced/.test(v.name) ? 1 : ELOQUENCE.test(v.name) ? 3 : 2) * 2 + (v.region === region ? 0 : 1);
  return [...pool].sort((a, b) => rank(a) - rank(b))[0].name;
}
