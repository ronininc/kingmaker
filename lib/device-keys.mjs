// API KEYS ALREADY ON THIS MAC → KINGMAKER'S VAULT.
//
// Operator (2026-10-08): "find and drop the proper api keys in its vault to use … since it's local there's no reason
// he can't … see and use api keys".
//
//   SCAN    Known local stores only, read-only: the engine source checkout's own server/.env, every
//           ~/Projects/<project>/.env* (top level only), ~/.zshrc and ~/.zprofile exports, the window app's runtime
//           .env and Kingmaker's own (the engine's documented config file in each runtime home: READ, never written;
//           the window app's encrypted vault is not read, it has no read path for another process), and the env
//           blocks of the MCP servers configured on this Mac. The result is key NAMES, the provider each belongs
//           to and the file it is in. Never a value: values are parsed as bytes and checked for shape in place,
//           never decoded to a string, never kept, logged, printed, spoken or returned (only the import below
//           reads one again, and only to hand it to the vault).
//   SKIP    Anything that is not an API key or token: passwords, private keys, seed phrases, payment cards,
//           placeholders, references to other variables, and the engine's own launch secrets.
//   IMPORT  Only on the owner's word ("put my keys in the vault", read back, then yes): the matched keys go to
//           the engine's governed vault path in ONE owner-console call (POST /api/key-handoff/console/import, the
//           launch nonce), which seals each into the credentials vault and writes one receipt. The bytes are
//           zero-filled after the call. An engine build without that route falls back to the per-provider key
//           handoff (start → /console/seal → leave sealed) for the providers its catalog knows.
//
// Nothing here mints a token on a website or types a key into a form.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { ownerCall } from './client.mjs';
import { ronin } from './addons.mjs';

export const MAX_KEY_BYTES = 4096;
export const MIN_KEY_BYTES = 12;
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const IMPORT_MAX = 64;

/** Where keys are looked for, highest priority first (a name found twice is imported from the first). */
export function keySources({ home = homedir(), ghostRuntimeHome = null, list = (d) => readdirSync(d), isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } } } = {}) {
  const support = join(home, 'Library', 'Application Support');
  const projects = join(home, 'Projects');
  let dirs = [];
  try { dirs = list(projects).filter((n) => !n.startsWith('.')).sort(); } catch { /* no Projects folder */ }
  const out = [
    // A project's own server keys first (an engine source checkout keeps its keys in server/.env).
    ...dirs.map((d) => ({ kind: 'project-server', file: join(projects, d, 'server', '.env') })),
    ...(ghostRuntimeHome ? [{ kind: 'ghost', file: join(ghostRuntimeHome, '.env') }] : []),
    { kind: 'window-app', file: join(support, 'solomon-desktop', 'runtime', '.env') },
    { kind: 'shell', file: join(home, '.zshrc') },
    { kind: 'shell', file: join(home, '.zprofile') },
  ];
  for (const d of dirs) {
    let names = [];
    try { names = list(join(projects, d)); } catch { continue; }
    for (const n of names.sort()) if (/^\.env(\..+)?$/.test(n) && !/\.(bak|swp|orig)(-|$)|~$/.test(n)) out.push({ kind: 'project', file: join(projects, d, n) });
  }
  const seen = new Set();
  return out.filter((s) => { if (seen.has(s.file) || !isFile(s.file)) return false; seen.add(s.file); return true; });
}

// ── Names → providers ────────────────────────────────────────────────────────────────────────────────────

/** [name pattern, provider id, label, money?] — the providers people keep keys for. First match wins. */
const BASE_KEY_PROVIDERS = [
  [/^(?:SOLOMON_)?OPENAI_(?:API_)?KEY$|^OPENAI_ADMIN_KEY$/, 'openai', 'OpenAI'],
  [/^(?:SOLOMON_)?ANTHROPIC_(?:API_)?KEY$|^CLAUDE_API_KEY$/, 'anthropic', 'Anthropic'],
  [/^(?:GITHUB|GH)_(?:TOKEN|PAT|API_KEY|API_TOKEN|ACCESS_TOKEN|PERSONAL_ACCESS_TOKEN)$|^HOMEBREW_GITHUB_API_TOKEN$/, 'github', 'GitHub'],
  [/^STRIPE_(?:SECRET_KEY|API_KEY|RESTRICTED_KEY|SK|LIVE_SECRET_KEY|TEST_SECRET_KEY)$/, 'stripe', 'Stripe', true],
  [/^(?:SOLOMON_)?TAVILY_API_KEY$/, 'tavily', 'Tavily'],
  [/^(?:CLOUDFLARE|CF)_(?:API_TOKEN|API_KEY|ACCOUNT_API_TOKEN)$/, 'cloudflare', 'Cloudflare'],
  [/^(?:SOLOMON_)?GROQ_API_KEY$/, 'groq', 'Groq'],
  [/^(?:SOLOMON_)?(?:MOONSHOT|KIMI)_API_KEY$/, 'moonshot', 'Kimi (Moonshot)'],
  [/^(?:SOLOMON_)?(?:NVIDIA|NIM|NGC)_API_KEY$/, 'nvidia', 'NVIDIA NIM'],
  [/^(?:GOOGLE|GEMINI|GOOGLE_AI|GOOGLE_GENERATIVE_AI)_API_KEY$/, 'google', 'Google AI'],
  [/^GOOGLE_MAPS_API_KEY$|^GOOGLE_PLACES_API_KEY$/, 'google-maps', 'Google Maps'],
  [/^(?:HF|HUGGINGFACE|HUGGING_FACE_HUB|HUGGINGFACEHUB_API)_TOKEN$|^HF_API_KEY$/, 'huggingface', 'Hugging Face'],
  [/^REPLICATE_API_(?:TOKEN|KEY)$/, 'replicate', 'Replicate'],
  [/^ELEVEN(?:_?LABS)?_API_KEY$|^XI_API_KEY$/, 'elevenlabs', 'ElevenLabs'],
  [/^OPENROUTER_API_KEY$/, 'openrouter', 'OpenRouter'],
  [/^MISTRAL_API_KEY$/, 'mistral', 'Mistral'],
  [/^DEEPSEEK_API_KEY$/, 'deepseek', 'DeepSeek'],
  [/^(?:PERPLEXITY|PPLX)_API_KEY$/, 'perplexity', 'Perplexity'],
  [/^(?:XAI|GROK)_API_KEY$/, 'xai', 'xAI'],
  [/^TOGETHER(?:_AI)?_API_KEY$/, 'together', 'Together AI'],
  [/^FIREWORKS_API_KEY$/, 'fireworks', 'Fireworks'],
  [/^COHERE_API_KEY$|^CO_API_KEY$/, 'cohere', 'Cohere'],
  [/^FIRECRAWL_API_KEY$/, 'firecrawl', 'Firecrawl'],
  [/^SERPER_API_KEY$/, 'serper', 'Serper'],
  [/^SERPAPI_(?:API_)?KEY$/, 'serpapi', 'SerpApi'],
  [/^BRAVE_(?:SEARCH_)?API_KEY$/, 'brave', 'Brave Search'],
  [/^EXA_API_KEY$/, 'exa', 'Exa'],
  [/^APOLLO_API_KEY$/, 'apollo', 'Apollo'],
  [/^HUNTER_API_KEY$/, 'hunter', 'Hunter'],
  [/^TWILIO_(?:API_KEY|API_SECRET|AUTH_TOKEN)$/, 'twilio', 'Twilio'],
  [/^SENDGRID_API_KEY$/, 'sendgrid', 'SendGrid'],
  [/^RESEND_API_KEY$/, 'resend', 'Resend'],
  [/^MAILGUN_API_KEY$/, 'mailgun', 'Mailgun'],
  [/^POSTMARK_(?:API_|SERVER_)?TOKEN$/, 'postmark', 'Postmark'],
  [/^SLACK_(?:BOT_|USER_|APP_)?TOKEN$/, 'slack', 'Slack'],
  [/^DISCORD_(?:BOT_)?TOKEN$/, 'discord', 'Discord'],
  [/^TELEGRAM_(?:BOT_)?TOKEN$/, 'telegram', 'Telegram'],
  [/^NOTION_(?:API_KEY|TOKEN|INTEGRATION_TOKEN)$/, 'notion', 'Notion'],
  [/^AIRTABLE_(?:API_KEY|TOKEN|PAT)$/, 'airtable', 'Airtable'],
  [/^LINEAR_API_KEY$/, 'linear', 'Linear'],
  [/^VERCEL_(?:TOKEN|API_TOKEN)$/, 'vercel', 'Vercel'],
  [/^NETLIFY_(?:AUTH_)?TOKEN$/, 'netlify', 'Netlify'],
  [/^SUPABASE_(?:SERVICE_ROLE_KEY|ANON_KEY|ACCESS_TOKEN|KEY)$/, 'supabase', 'Supabase'],
  [/^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/, 'aws', 'AWS'],
  [/^ALPACA_(?:API_KEY(?:_ID)?|SECRET_KEY|API_SECRET(?:_KEY)?)$|^APCA_API_(?:KEY_ID|SECRET_KEY)$/, 'alpaca', 'Alpaca', true],
  [/^SQUARE_(?:ACCESS_TOKEN|API_KEY)$/, 'square', 'Square', true],
  [/^CLOVER_(?:API_TOKEN|ACCESS_TOKEN|API_KEY)$/, 'clover', 'Clover', true],
  [/^CJ_(?:ACCESS_TOKEN|API_KEY)$/, 'cj', 'CJ Dropshipping'],
  [/^EBAY_(?:APP_ID|CLIENT_SECRET|CERT_ID|AUTH_TOKEN|API_KEY|ACCESS_TOKEN)$/, 'ebay', 'eBay'],
  [/^SHOPIFY_(?:ACCESS_TOKEN|API_KEY|API_SECRET|ADMIN_API_TOKEN)$/, 'shopify', 'Shopify'],
  [/^(?:META|FB|FACEBOOK|INSTAGRAM|IG)_(?:ACCESS_TOKEN|APP_SECRET|PAGE_TOKEN|API_KEY)$/, 'meta', 'Meta'],
  [/^TRIPO_API_KEY$/, 'tripo', 'Tripo'],
  [/^FAL_(?:KEY|API_KEY)$/, 'fal', 'fal.ai'],
  [/^RUNWAY(?:ML)?_API_(?:KEY|SECRET)$/, 'runway', 'Runway'],
  [/^LUMA_API_KEY$/, 'luma', 'Luma'],
  [/^STABILITY_API_KEY$/, 'stability', 'Stability AI'],
  [/^MAPBOX_(?:ACCESS_)?TOKEN$|^MAPBOX_API_KEY$/, 'mapbox', 'Mapbox'],
  [/^OPENWEATHER(?:MAP)?_API_KEY$/, 'openweather', 'OpenWeather'],
  [/^NPM_TOKEN$/, 'npm', 'npm'],
  [/^SENTRY_(?:AUTH_TOKEN|API_KEY)$/, 'sentry', 'Sentry'],
  [/^PINECONE_API_KEY$/, 'pinecone', 'Pinecone'],
  [/^LANGCHAIN_API_KEY$|^LANGSMITH_API_KEY$/, 'langsmith', 'LangSmith'],
  [/^DEEPGRAM_API_KEY$/, 'deepgram', 'Deepgram'],
  [/^ASSEMBLYAI_API_KEY$/, 'assemblyai', 'AssemblyAI'],
  [/^YOUTUBE_API_KEY$/, 'youtube', 'YouTube'],
];
/** Every provider a key name can belong to: the core's, then an add-on's (the Ronin add-on adds the Ronin CRM's). */
export const KEY_PROVIDERS = Object.freeze([...BASE_KEY_PROVIDERS]);
/** The core's providers, then an add-on's (read when used: add-ons load after this module). */
const keyProviders = () => (ronin?.KEY_PROVIDERS ? [...KEY_PROVIDERS, ...ronin.KEY_PROVIDERS] : KEY_PROVIDERS);

/** What is never a key to import, whatever it is called. */
const SKIP_RULES = Object.freeze([
  [/(?:^|_)(?:PASSWORD|PASSWD|PASS|PWD|PASSPHRASE)(?:_|$)/, 'password'],
  [/PRIVATE_KEY|(?:^|_)PEM(?:_|$)|(?:^|_)SSH_KEY/, 'private-key'],
  [/(?:^|_)(?:SEED|MNEMONIC|RECOVERY_PHRASE)(?:_|$)/, 'seed-phrase'],
  [/(?:^|_)(?:CARD|CC|CVV|CVC|PAN|CARD_NUMBER)(?:_|$)|(?:^|_)PIN(?:_|$)|SSN|ROUTING|ACCOUNT_NUMBER|IBAN/, 'payment-or-identity'],
  [/WALLET|SIGNING|ENCRYPTION|ENCRYPT_KEY|JWT_SECRET|SESSION_SECRET|COOKIE_SECRET|WEBHOOK_SECRET|NONCE|ATTESTATION|HANDOFF|MASTER_KEY|VAULT_KEY|SEAL/, 'own-secret'],
]);

const KEYISH_KNOWN = /(?:API_?KEY|APIKEY|_TOKEN|_PAT|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SECRET_KEY|CLIENT_SECRET|API_SECRET(?:_KEY)?|APP_SECRET|_KEY|_SK|APP_ID|CERT_ID|KEY_ID)$/;
/** An API credential by its name alone, whoever the provider (FOO_API_KEY, FOO_ACCESS_TOKEN, AZURE_SPEECH_KEY). */
const KEYISH_UNKNOWN = /_?(?:API_?KEY|APIKEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|BOT_TOKEN|TOKEN|ACCESS_?KEY(?:_ID)?|SECRET_?ACCESS_?KEY|SECRET_?KEY|API_SECRET|CLIENT_SECRET|SUBSCRIPTION_KEY|SPEECH_KEY)$/;

/**
 * Pure: what a variable NAME is. → { provider, label, money } | { skip: reason }.
 * An unknown provider counts only for a plainly API-credential-shaped name (FOO_API_KEY, FOO_ACCESS_TOKEN). The engine's
 * and Ghost's own settings are never keys, except a provider key they are configured with
 * (SOLOMON_OPENALEPH_API_KEY is OpenAleph's key).
 */
export function classifyKeyName(name) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]{1,80}$/.test(n)) return { skip: 'not-a-name' };
  for (const [rx, reason] of SKIP_RULES) if (rx.test(n)) return { skip: reason };
  for (const [rx, provider, label, money] of keyProviders()) if (rx.test(n) && KEYISH_KNOWN.test(n)) return { provider, label, money: money === true };
  const own = /^(?:SOLOMON_|SOL_GHOST_|OLLAMA_)/.exec(n);
  if (own && !/_(?:API_KEY|API_TOKEN|ACCESS_TOKEN)$/.test(n)) return { skip: 'own-secret' };
  const bare = own ? n.slice(own[0].length) : n;
  if (KEYISH_UNKNOWN.test(bare)) {
    const prefix = bare.replace(KEYISH_UNKNOWN, '').replace(/_+$/, '');
    if (prefix.length >= 2) return { provider: prefix.toLowerCase().replace(/_/g, '-'), label: prefix.replace(/_/g, ' '), money: false };
  }
  return { skip: 'not-a-key' };
}

// ── Values, as bytes ─────────────────────────────────────────────────────────────────────────────────────

const PLACEHOLDERS = ['your', 'xxxx', 'changeme', 'change-me', 'change_me', 'replace', 'placeholder', 'example', 'dummy', 'todo', 'insert', 'redacted', '****', '...', 'sk-...', 'none', 'null', 'undefined', 'test-key', 'fake', 'sample', '<', '>'];

function luhn(bytes) {
  let sum = 0; let dbl = false;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    let d = bytes[i] - 0x30;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Pure: is this value (bytes) shaped like an API key? → 'ok' | the reason it is not. Works on the bytes in place;
 * the lower-cased copy made for the placeholder check is zero-filled before returning.
 */
export function keyShape(bytes) {
  if (!bytes || bytes.length === 0) return 'empty';
  if (bytes[0] === 0x24 /* $ */ || bytes[0] === 0x60 /* ` */) return 'reference';
  if (bytes.length < MIN_KEY_BYTES) return 'too-short';
  if (bytes.length > MAX_KEY_BYTES) return 'too-long';
  if (bytes.indexOf('-----BEGIN') >= 0) return 'private-key';
  let digits = true;
  for (const b of bytes) {
    if (b <= 0x20 || b >= 0x7f || b === 0x22 || b === 0x27 || b === 0x5c) return 'not-a-key';
    if (b < 0x30 || b > 0x39) digits = false;
  }
  if (digits) return bytes.length >= 13 && bytes.length <= 19 && luhn(bytes) ? 'payment-card' : 'not-a-key';
  const lower = Buffer.from(bytes);
  try {
    for (let i = 0; i < lower.length; i += 1) if (lower[i] >= 0x41 && lower[i] <= 0x5a) lower[i] += 0x20;
    if (PLACEHOLDERS.some((p) => lower.indexOf(p) >= 0)) return 'placeholder';
    if (lower.every((b) => b === lower[0])) return 'placeholder';
    if (lower.indexOf('://') >= 0) return 'not-a-key'; // a URL (often with a password inside), not a key
  } finally { lower.fill(0); }
  return 'ok';
}

/**
 * Pure: the assignments in an env / shell file, as {name, start, end} (the value is buf.subarray(start, end), never
 * copied or decoded). Handles `NAME=v`, `export NAME=v`, 'single' and "double" quotes; a value with an escape or
 * a $(…) is reported as a reference. Comments and other shell lines are ignored.
 */
export function parseAssignments(buf) {
  const out = [];
  const n = buf.length;
  let i = 0;
  while (i < n) {
    let end = buf.indexOf(0x0a, i);
    if (end < 0) end = n;
    let s = i;
    let e = end;
    if (e > s && buf[e - 1] === 0x0d) e -= 1;
    while (s < e && (buf[s] === 0x20 || buf[s] === 0x09)) s += 1;
    if (s < e && buf[s] !== 0x23) {
      if (buf.subarray(s, Math.min(e, s + 7)).equals(Buffer.from('export '))) { s += 7; while (s < e && buf[s] === 0x20) s += 1; }
      let k = s;
      while (k < e && ((buf[k] >= 0x41 && buf[k] <= 0x5a) || (buf[k] >= 0x61 && buf[k] <= 0x7a) || (buf[k] >= 0x30 && buf[k] <= 0x39) || buf[k] === 0x5f)) k += 1;
      const name = k > s ? buf.subarray(s, k).toString('ascii') : '';
      let v = k;
      while (v < e && buf[v] === 0x20) v += 1;
      if (name && /^[A-Za-z_]/.test(name) && v < e && buf[v] === 0x3d /* = */) {
        v += 1;
        while (v < e && buf[v] === 0x20) v += 1;
        let vs = v; let ve = v; let reference = false;
        if (buf[v] === 0x22 || buf[v] === 0x27) {
          const q = buf[v];
          vs = v + 1; ve = vs;
          while (ve < e && buf[ve] !== q) { if (buf[ve] === 0x5c || (q === 0x22 && buf[ve] === 0x24)) reference = true; ve += 1; }
          if (ve >= e) reference = true; // unterminated
        } else {
          while (ve < e && buf[ve] !== 0x20 && buf[ve] !== 0x09 && buf[ve] !== 0x3b /* ; */) ve += 1;
          if (buf[vs] === 0x24 || buf[vs] === 0x60) reference = true;
        }
        out.push({ name, start: vs, end: ve, reference });
      }
    }
    i = end + 1;
  }
  return out;
}

// ── MCP config env blocks (JSON: parsing makes strings; they are shape-checked and dropped at once) ─────────

function mcpEnvSources(home) {
  const support = join(home, 'Library', 'Application Support');
  return [
    join(support, 'Claude', 'claude_desktop_config.json'), join(home, '.claude.json'), join(home, '.mcp.json'), join(home, '.cursor', 'mcp.json'),
    join(home, '.codeium', 'windsurf', 'mcp_config.json'), join(support, 'Code', 'User', 'mcp.json'), join(home, '.gemini', 'settings.json'),
  ];
}

function* mcpEnvBlocks(parsed) {
  const blocks = [parsed?.mcpServers, parsed?.servers];
  if (parsed?.projects && typeof parsed.projects === 'object') for (const p of Object.values(parsed.projects)) blocks.push(p?.mcpServers);
  for (const b of blocks) if (b && typeof b === 'object') for (const cfg of Object.values(b)) if (cfg?.env && typeof cfg.env === 'object') yield cfg.env;
}

// ── The scan (names only) ────────────────────────────────────────────────────────────────────────────────

const tilde = (p, home) => (home && String(p).startsWith(`${home}${sep}`) ? `~${String(p).slice(home.length)}` : String(p));

/**
 * Read every source and report what is there: entries {name, provider, label, money, file, source} (no values),
 * byProvider counts, and skipped counts by reason. `readBytes(file)` is injectable; every buffer it returns is
 * zero-filled once its names are read.
 */
export function scanKeys({ home = homedir(), ghostRuntimeHome = null, sources, readBytes = (p) => readFileSync(p), includeMcp = true } = {}) {
  const list = sources ?? keySources({ home, ghostRuntimeHome });
  const entries = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const src of list) {
    let buf;
    try { buf = readBytes(src.file); } catch { continue; }
    if (!buf || buf.length > MAX_ENV_FILE_BYTES) { buf?.fill?.(0); continue; }
    try {
      for (const a of parseAssignments(buf)) {
        const what = classifyKeyName(a.name);
        if (what.skip) { if (what.skip !== 'not-a-key' && what.skip !== 'not-a-name') skip(what.skip); continue; }
        const shape = a.reference ? 'reference' : keyShape(buf.subarray(a.start, a.end));
        if (shape !== 'ok') { skip(shape); continue; }
        entries.push({ name: a.name, provider: what.provider, label: what.label, money: what.money, file: tilde(src.file, home), source: src.kind });
      }
    } finally { buf.fill(0); }
  }
  if (includeMcp) {
    for (const file of mcpEnvSources(home)) {
      let buf;
      try { buf = readBytes(file); } catch { continue; }
      if (!buf || buf.length > 32 * MAX_ENV_FILE_BYTES) { buf?.fill?.(0); continue; }
      let parsed = null;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = null; } finally { buf.fill(0); }
      if (!parsed) continue;
      for (const env of mcpEnvBlocks(parsed)) {
        for (const [name, value] of Object.entries(env)) {
          const what = classifyKeyName(name);
          if (what.skip) { if (what.skip !== 'not-a-key' && what.skip !== 'not-a-name') skip(what.skip); continue; }
          const bytes = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
          const shape = keyShape(bytes);
          bytes.fill(0);
          if (shape !== 'ok') { skip(shape); continue; }
          entries.push({ name, provider: what.provider, label: what.label, money: what.money, file: tilde(file, home), source: 'mcp-config' });
        }
      }
      parsed = null;
    }
  }
  const byProvider = {};
  for (const e of chooseImports(entries)) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
  return { scannedAt: new Date().toISOString(), found: chooseImports(entries).length, occurrences: entries.length, byProvider, entries, skipped };
}

/** Pure: one entry per key name, from the highest-priority file it is in (the order scanKeys read them). */
export function chooseImports(entries) {
  const seen = new Map();
  for (const e of entries ?? []) if (!seen.has(e.name)) seen.set(e.name, { ...e, alsoIn: (entries ?? []).filter((x) => x.name === e.name && x.file !== e.file).length });
  return [...seen.values()];
}

/** Pure: providers in words ("OpenAI (2), GitHub, Tavily …"). */
export function providersLine(byProvider, labels = {}, max = 8) {
  const rows = Object.entries(byProvider ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const words = rows.slice(0, max).map(([p, n]) => `${labels[p] ?? p}${n > 1 ? ` (${n})` : ''}`);
  return rows.length > max ? `${words.join(', ')} and ${rows.length - max} more` : words.join(', ');
}

/** Pure: the read-back before an import (names and providers, never a value). */
export function importReadBack(scan) {
  const picks = chooseImports(scan?.entries);
  if (!picks.length) return null;
  const labels = Object.fromEntries(picks.map((e) => [e.provider, e.label]));
  const money = [...new Set(picks.filter((e) => e.money).map((e) => e.label))];
  return `I found ${picks.length} API ${picks.length === 1 ? 'key' : 'keys'} on this Mac for ${Object.keys(scan.byProvider).length} ${Object.keys(scan.byProvider).length === 1 ? 'service' : 'services'}: ${providersLine(scan.byProvider, labels)}. `
    + `I'll seal them in Kingmaker's vault, where only its connectors can use them; nothing leaves this Mac and the files stay as they are.`
    + `${money.length ? ` ${money.join(' and ')} ${money.length === 1 ? 'is a money account' : 'are money accounts'}: payments still need your spoken second yes.` : ''} Say yes to put them in the vault.`;
}

// ── The import (the only place a value is read again) ────────────────────────────────────────────────────

/** Read one key's value bytes from its file (a copy; the caller zero-fills it). Null when it is gone or changed shape. */
export function readKeyValue(entry, { home = homedir(), readBytes = (p) => readFileSync(p) } = {}) {
  const file = String(entry.file).startsWith('~/') ? join(home, String(entry.file).slice(2)) : String(entry.file);
  let buf;
  try { buf = readBytes(file); } catch { return null; }
  try {
    if (entry.source === 'mcp-config') {
      let parsed = null;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch { return null; }
      for (const env of mcpEnvBlocks(parsed)) {
        if (typeof env[entry.name] === 'string') {
          const bytes = Buffer.from(env[entry.name], 'utf8');
          if (keyShape(bytes) === 'ok') return bytes;
          bytes.fill(0);
        }
      }
      return null;
    }
    let found = null;
    for (const a of parseAssignments(buf)) if (a.name === entry.name && !a.reference) found = a; // last assignment wins, as in a shell
    if (!found) return null;
    const view = buf.subarray(found.start, found.end);
    return keyShape(view) === 'ok' ? Buffer.from(view) : null;
  } finally { buf.fill(0); }
}

/**
 * Pure: the import body as bytes, built around the key bytes (never a string of a key). Every key byte was checked
 * by keyShape (printable ASCII, no quote or backslash), so it is JSON-safe as is. The caller zero-fills the result.
 */
export function importBody(items, { probe = false } = {}) {
  const parts = [Buffer.from(`{${probe ? '"probe":true,' : ''}"keys":[`, 'utf8')];
  items.forEach((it, i) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{1,80}$/.test(it.envName) || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(it.provider) || !/^[a-z-]{2,20}$/.test(it.source)) throw new Error('BAD_IMPORT_ITEM');
    // JSON-safe as is: printable ASCII with no quote or backslash (the device scan's keyShape already held it to that).
    if (!it.secret?.length || it.secret.length > MAX_KEY_BYTES || it.secret.some((b) => b <= 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c)) throw new Error('NOT_A_KEY_SHAPE');
    parts.push(Buffer.from(`${i ? ',' : ''}{"envName":"${it.envName}","provider":"${it.provider}","source":"${it.source}","secret":"`, 'utf8'), it.secret, Buffer.from('"}', 'utf8'));
  });
  parts.push(Buffer.from(']}', 'utf8'));
  return Buffer.concat(parts);
}

/** The catalog providers an older engine build can still take one at a time (its key handoff). */
export const HANDOFF_PROVIDERS = Object.freeze({ github: 'github', stripe: 'stripe' });
const handoffProviders = () => ({ ...HANDOFF_PROVIDERS, ...(ronin?.HANDOFF_PROVIDERS ?? {}) });

/**
 * Import the scan's keys into Kingmaker's vault, as the owner (the launch nonce). → { ok, receiptId, imported, refused,
 * missing, route }. `log` gets events with names only. Every buffer is zero-filled before this returns.
 */
export async function importKeysToVault({ port, nonce, scan, home = homedir(), readBytes, fetchImpl, log = () => {} }) {
  const picks = chooseImports(scan?.entries).slice(0, IMPORT_MAX);
  const items = [];
  const missing = [];
  try {
    for (const e of picks) {
      const secret = readKeyValue(e, { home, ...(readBytes ? { readBytes } : {}) });
      if (!secret) { missing.push(e.name); continue; }
      items.push({ envName: e.name, provider: e.provider, source: e.source, secret });
    }
    if (!items.length) return { ok: false, reason: 'NOTHING_TO_IMPORT', imported: [], refused: [], missing, route: null };
    let body = null;
    let r;
    try {
      body = importBody(items);
      r = await ownerCall(port, '/api/key-handoff/console/import', { nonce, method: 'POST', rawBody: body, timeoutMs: 60_000, ...(fetchImpl ? { fetchImpl } : {}) });
    } finally { body?.fill(0); }
    if (r.status !== 404) {
      const d = r.json?.data ?? {};
      log('device_keys_import', { ok: r.ok, status: r.status, imported: (d.imported ?? []).length, refused: (d.refused ?? []).length, receiptId: d.receiptId ?? null });
      return { ok: r.ok && Array.isArray(d.imported), receiptId: d.receiptId ?? null, imported: d.imported ?? [], refused: d.refused ?? [], appliedToEnv: d.appliedToEnv ?? [], missing, route: 'console/import', error: r.ok ? null : (r.json?.error ?? `HTTP ${r.status}`) };
    }
    // An older engine build: the per-provider handoff for what its catalog knows, left sealed (connecting is a later yes).
    const imported = [];
    const refused = [];
    for (const it of items) {
      const provider = handoffProviders()[it.provider];
      if (!provider || imported.some((x) => x.provider === it.provider)) { refused.push({ envName: it.envName, reason: provider ? 'ONE_PER_PROVIDER_IN_THIS_BUILD' : 'NOT_IN_THIS_BUILD' }); continue; }
      const started = await ownerCall(port, '/api/key-handoff/start', { nonce, method: 'POST', body: { provider }, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null);
      const handoffId = started?.json?.data?.id;
      if (!started?.ok || !/^[A-Za-z0-9_-]{6,80}$/.test(String(handoffId ?? ''))) { refused.push({ envName: it.envName, reason: started?.json?.error ?? 'START_FAILED' }); continue; }
      let sealBytes = null;
      let sealed;
      try {
        sealBytes = Buffer.concat([Buffer.from(`{"handoffId":"${handoffId}","secret":"`, 'utf8'), it.secret, Buffer.from('"}', 'utf8')]);
        sealed = await ownerCall(port, '/api/key-handoff/console/seal', { nonce, method: 'POST', rawBody: sealBytes, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null);
      } finally { sealBytes?.fill(0); }
      if (sealed?.ok && sealed.json?.data?.state === 'SEALED_AWAITING_CONFIRM') {
        await ownerCall(port, `/api/key-handoff/${encodeURIComponent(handoffId)}/decline`, { nonce, method: 'POST', body: {}, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null);
        imported.push({ envName: it.envName, provider: it.provider, row: provider });
      } else {
        await ownerCall(port, `/api/key-handoff/${encodeURIComponent(handoffId)}/cancel`, { nonce, method: 'POST', body: {}, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null);
        refused.push({ envName: it.envName, reason: sealed?.json?.error ?? 'SEAL_FAILED' });
      }
    }
    log('device_keys_import', { ok: imported.length > 0, route: 'handoff', imported: imported.length, refused: refused.length });
    return { ok: imported.length > 0, receiptId: null, imported, refused, missing, route: 'handoff' };
  } finally {
    for (const it of items) it.secret.fill(0);
  }
}

/** Pure: the line said after an import (names and counts, never a value). */
export function importLine(r) {
  if (!r) return 'The import did not run.';
  if (r.reason === 'NOTHING_TO_IMPORT') return 'None of those keys could be read again, so nothing was imported.';
  const n = r.imported?.length ?? 0;
  const refused = r.refused?.length ?? 0;
  if (!n) return `Nothing went into the vault${r.error ? ` (${r.error})` : ''}.${refused ? ` ${refused} ${refused === 1 ? 'key was' : 'keys were'} refused.` : ''}`;
  const providers = [...new Set(r.imported.map((x) => x.provider))];
  const extra = r.route === 'handoff' ? ` This Kingmaker build takes only ${Object.keys(handoffProviders()).join(', ')} keys this way; the rest wait for an update of its engines.` : '';
  return `Sealed ${n} ${n === 1 ? 'key' : 'keys'} for ${providers.length} ${providers.length === 1 ? 'service' : 'services'} in the vault${r.receiptId ? ` (receipt ${r.receiptId})` : ''}.${refused ? ` ${refused} refused.` : ''}${extra}`;
}

export const keyFileLabel = (file) => basename(String(file));
