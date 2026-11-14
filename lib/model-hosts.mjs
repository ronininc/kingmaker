// lib/model-hosts.mjs — the machines that hold and run Kingmaker's models, and one way to talk to them.
//
// A model host is an Ollama server: this Mac's own (always there), and any others the owner names
// (a second Mac, a GPU box on the same network, a machine reached through a tunnel).
//
// Three rules live here so every command that uses a host gets them the same way:
//
//   KEYS      A host is sent only the key that was set up for that host. The owner's provider keys
//             (the ones named in PROVIDER_KEY_ENVS) are never sent to a model host, and a key is
//             never sent to a host over plain http unless that host is this Mac itself or on the
//             local network.
//   UNKNOWN   A value that could not be measured is `unavailable(reason, fix)`, never a guess and
//             never a zero. Printing goes through show(), which prints the reason.
//   HONESTY   Reading a host changes nothing on it. Only load, unload, pushBlob, create and pull write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LOCAL_HOST_NAME = 'this-mac';
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:11434';
export const HOSTS_FILE = 'model-hosts.json';

// ── unknown values ─────────────────────────────────────────────────────────────────────────────

const UNAVAILABLE = Symbol.for('kingmaker.unavailable');
/** A value that could not be had. `reason` says why; `fix` says what would make it available. */
export function unavailable(reason, fix = null) {
  return Object.freeze({ [UNAVAILABLE]: true, unavailable: true, reason: String(reason || 'not known'), fix: fix ? String(fix) : null });
}
export const isUnavailable = (v) => Boolean(v && typeof v === 'object' && v[UNAVAILABLE] === true);
/** A number only if it really is one: anything else (missing, NaN, negative where that is impossible) is unavailable. */
export function measured(value, reason = 'the host did not report it', { allowZero = true } = {}) {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? n : unavailable(reason);
}
/** Text for a value: the formatted value, or "unavailable (reason)". */
export function show(value, format = (v) => String(v)) {
  if (isUnavailable(value)) return `unavailable (${value.reason})`;
  if (value == null) return 'unavailable (not known)';
  return format(value);
}
/** For JSON output: an unavailable value as plain data, so no reader mistakes it for a number. */
export const plain = (value) => (isUnavailable(value) ? { unavailable: true, reason: value.reason, ...(value.fix ? { fix: value.fix } : {}) } : value);

// ── which kind of host ─────────────────────────────────────────────────────────────────────────

/** A base URL in one form: scheme://host:port, no path, no trailing slash. Bare "host:port" is http. */
export function normalizeUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('a host needs an address, like 192.168.1.20:11434');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let u;
  try { u = new URL(text); } catch { throw new Error(`"${input}" is not an address this can use`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('a host address must start with http:// or https://');
  if (u.username || u.password) throw new Error('put a key in the host\'s key setting, not inside its address');
  // The parser drops a port that is the scheme's default, so ":80" and "no port given" look the same to it.
  // A port the owner typed is kept as typed; only a missing one becomes Ollama's (http) or 443 (https).
  const typed = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]*\]|[^/:?#]*):(\d{1,5})(?:[/?#]|$)/i.exec(text);
  const port = typed ? String(Number(typed[1])) : (u.port || (u.protocol === 'https:' ? '443' : '11434'));
  if (Number(port) < 1 || Number(port) > 65535) throw new Error(`"${input}" has a port that is not a port`);
  return `${u.protocol}//${u.hostname}:${port}`;
}

/**
 * 'local' (this Mac), 'lan' (a private address or a name only a local network resolves), or 'remote' (anything else).
 * Address ranges are applied only to a real IP address. A public name such as "10.models.example.com" merely starts
 * like one and is remote; treating it as local would let a key go to it over plain http.
 */
export function hostKind(url) {
  const { hostname } = new URL(normalizeUrl(url));
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return 'local';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b2, c, d] = v4.slice(1).map(Number);
    if ([a, b2, c, d].some((n) => n > 255)) return 'remote';
    if (a === 127) return 'local';
    if (a === 10 || (a === 192 && b2 === 168) || (a === 169 && b2 === 254) || (a === 172 && b2 >= 16 && b2 <= 31) || (a === 100 && b2 >= 64 && b2 <= 127)) return 'lan';
    return 'remote';
  }
  if (h.includes(':')) { // an IPv6 address
    if (h === '::1') return 'local';
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return 'lan';
    return 'remote';
  }
  // A name. One with no dot, or ending in a suffix only a local network answers for, is on the local network.
  if (!h.includes('.') || /\.(local|lan|internal|home\.arpa)$/.test(h)) return 'lan';
  return 'remote';
}

// ── the key rule ───────────────────────────────────────────────────────────────────────────────

/** The owner's provider keys. None of these is ever sent to a model host, whatever its settings say. */
export const PROVIDER_KEY_ENVS = Object.freeze([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN',
  'GITHUB_TOKEN', 'GH_TOKEN', 'CLOUDFLARE_API_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY',
]);
const isProviderKeyEnv = (name) => PROVIDER_KEY_ENVS.includes(String(name || '').toUpperCase());

/**
 * The headers to send to this host. A host gets a key only when its own entry names the environment variable
 * that holds it (`keyEnv`), that variable is not one of the owner's provider keys, and the connection would not
 * expose it: https anywhere, or plain http only to this Mac or the local network.
 * → { headers, key: 'none' | 'sent' | 'withheld', why }
 */
export function credentialFor(host, env = process.env) {
  const none = (key, why) => ({ headers: {}, key, why });
  const keyEnv = String(host?.keyEnv ?? '').trim();
  if (!keyEnv) return none('none', 'no key is set up for this host');
  if (isProviderKeyEnv(keyEnv)) return none('withheld', `${keyEnv} is one of your provider keys; it is never sent to a model host. Give this host its own key.`);
  const value = String(env[keyEnv] ?? '').trim();
  if (!value) return none('none', `${keyEnv} is not set in this shell`);
  for (const name of PROVIDER_KEY_ENVS) {
    if (env[name] && String(env[name]).trim() === value) return none('withheld', `${keyEnv} holds the same value as ${name}; a provider key is never sent to a model host`);
  }
  const url = normalizeUrl(host.url);
  const kind = hostKind(url);
  if (url.startsWith('http://') && kind === 'remote') return none('withheld', 'this host is reached over plain http across the internet; a key would be readable on the way. Use https or a tunnel.');
  return { headers: { authorization: `Bearer ${value}` }, key: 'sent', why: `the host's own key (${keyEnv})` };
}

// ── the host list ──────────────────────────────────────────────────────────────────────────────

const NAME_OK = /^[a-z0-9][a-z0-9-]{0,30}$/;
const hostsPath = (stateDir) => join(stateDir, HOSTS_FILE);

/** This Mac's own Ollama: OLLAMA_HOST when it points at this Mac, else the default address. */
export function localHost(env = process.env) {
  let url = DEFAULT_LOCAL_URL;
  try { const fromEnv = env.OLLAMA_HOST ? normalizeUrl(env.OLLAMA_HOST) : null; if (fromEnv && hostKind(fromEnv) === 'local') url = fromEnv; } catch { /* keep the default */ }
  return { name: LOCAL_HOST_NAME, url, kind: 'local', keyEnv: null };
}

/** This Mac first, then the hosts the owner added. A damaged file reads as "none added". */
export function loadHosts(stateDir, env = process.env) {
  const hosts = [localHost(env)];
  let doc = null;
  try { doc = JSON.parse(readFileSync(hostsPath(stateDir), 'utf8')); } catch { /* none yet */ }
  for (const h of Array.isArray(doc?.hosts) ? doc.hosts : []) {
    try {
      if (!NAME_OK.test(String(h?.name)) || h.name === LOCAL_HOST_NAME) continue;
      const url = normalizeUrl(h.url);
      hosts.push({ name: h.name, url, kind: hostKind(url), keyEnv: h.keyEnv ? String(h.keyEnv) : null });
    } catch { /* skip an entry that no longer parses */ }
  }
  return hosts;
}

function writeHosts(stateDir, added) {
  mkdirSync(dirname(hostsPath(stateDir)), { recursive: true });
  writeFileSync(hostsPath(stateDir), `${JSON.stringify({ schema: 'kingmaker.model-hosts/1', hosts: added.map(({ name, url, keyEnv }) => ({ name, url, ...(keyEnv ? { keyEnv } : {}) })) }, null, 2)}\n`, { mode: 0o600 });
}

/** Add or replace a host. Only the NAME of the variable holding its key is stored, never the key. */
export function saveHost(stateDir, { name, url, keyEnv = null }, env = process.env) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!NAME_OK.test(n)) throw new Error('a host name is lower-case letters, digits and dashes, like "studio" or "gpu-box"');
  if (n === LOCAL_HOST_NAME) throw new Error(`"${LOCAL_HOST_NAME}" is this Mac; it is always in the list`);
  if (keyEnv != null && !/^[A-Z][A-Z0-9_]{1,60}$/.test(String(keyEnv))) throw new Error('--key-env takes the NAME of an environment variable, like STUDIO_OLLAMA_KEY');
  if (keyEnv && isProviderKeyEnv(keyEnv)) throw new Error(`${keyEnv} is one of your provider keys and is never sent to a model host. Give this host its own key.`);
  const entry = { name: n, url: normalizeUrl(url), keyEnv: keyEnv || null };
  const others = loadHosts(stateDir, env).filter((h) => h.name !== LOCAL_HOST_NAME && h.name !== n);
  writeHosts(stateDir, [...others, entry]);
  return { ...entry, kind: hostKind(entry.url) };
}

export function removeHost(stateDir, name, env = process.env) {
  const n = String(name ?? '').trim().toLowerCase();
  const added = loadHosts(stateDir, env).filter((h) => h.name !== LOCAL_HOST_NAME);
  if (!added.some((h) => h.name === n)) return false;
  writeHosts(stateDir, added.filter((h) => h.name !== n));
  return true;
}

/** The host with this name, or (no name) this Mac. Throws with the list when the name is not known. */
export function findHost(stateDir, name, env = process.env) {
  const hosts = loadHosts(stateDir, env);
  if (!name) return hosts[0];
  const n = String(name).trim().toLowerCase();
  const hit = hosts.find((h) => h.name === n);
  if (!hit) throw new Error(`no host named "${name}". Known: ${hosts.map((h) => h.name).join(', ')}. Add one: kingmaker models hosts add <name> <address>`);
  return hit;
}

export const hostsFileExists = (stateDir) => existsSync(hostsPath(stateDir));

// ── talking to a host ──────────────────────────────────────────────────────────────────────────

const hex64 = (d) => { const m = /^(?:sha256[:-])?([0-9a-f]{64})$/i.exec(String(d ?? '')); if (!m) throw new Error(`"${d}" is not a sha256 digest`); return m[1].toLowerCase(); };

/**
 * A client for one host. Every call carries only that host's own key (credentialFor) and a time limit.
 * Reads: version, tags, ps, show, hasBlob. Writes: load, unload, pushBlob, create, pull.
 */
export function hostClient(host, { fetchImpl = fetch, env = process.env, timeoutMs = 8000 } = {}) {
  const base = normalizeUrl(host.url);
  const cred = credentialFor({ ...host, url: base }, env);
  const call = async (path, { method = 'GET', body = undefined, headers = {}, limit = timeoutMs, duplex = undefined } = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers: { ...cred.headers, ...headers }, body, signal: AbortSignal.timeout(limit), ...(duplex ? { duplex } : {}),
    });
    return res;
  };
  const json = async (path, payload = undefined, opts = {}) => {
    const res = await call(path, payload === undefined ? opts : { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, ...opts });
    if (!res.ok) { const text = await res.text().catch(() => ''); throw new Error(`${host.name} answered ${res.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`); }
    return res.json();
  };
  /** A streamed reply (one JSON object per line): returns the last object, calling onLine for each. */
  const streamed = async (path, payload, { limit, onLine = () => {} } = {}) => {
    const res = await call(path, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, limit });
    if (!res.ok) { const text = await res.text().catch(() => ''); throw new Error(`${host.name} answered ${res.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`); }
    let last = null, buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        last = JSON.parse(line); onLine(last);
        if (last.error) throw new Error(`${host.name}: ${last.error}`);
      }
    }
    if (buf.trim()) { last = JSON.parse(buf); onLine(last); if (last.error) throw new Error(`${host.name}: ${last.error}`); }
    return last;
  };
  return {
    host: { ...host, url: base, kind: hostKind(base) }, credential: { key: cred.key, why: cred.why },
    version: async () => (await json('/api/version')).version ?? null,
    tags: async () => (await json('/api/tags')).models ?? [],
    ps: async () => (await json('/api/ps')).models ?? [],
    show: (model) => json('/api/show', { model }),
    hasBlob: async (digest) => (await call(`/api/blobs/sha256:${hex64(digest)}`, { method: 'HEAD' })).status === 200,
    /** Upload one blob. The host checks the bytes against the digest and refuses a mismatch. */
    pushBlob: async (digest, body, { bytes = null, limit = 6 * 60 * 60 * 1000 } = {}) => {
      const res = await call(`/api/blobs/sha256:${hex64(digest)}`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...(bytes != null ? { 'content-length': String(bytes) } : {}) }, limit, duplex: 'half' });
      if (res.status !== 201 && res.status !== 200) { const text = await res.text().catch(() => ''); throw new Error(`${host.name} refused the upload (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`); }
      return true;
    },
    create: (payload, opts = {}) => streamed('/api/create', { ...payload, stream: true }, { limit: 30 * 60 * 1000, ...opts }),
    pull: (model, opts = {}) => streamed('/api/pull', { model, stream: true }, { limit: 6 * 60 * 60 * 1000, ...opts }),
    /** Load a model and hold it for `keepAlive` (Ollama's forms: '30m', '24h', -1 for "until told"). Generates nothing. */
    load: (model, keepAlive = '30m') => json('/api/generate', { model, keep_alive: keepAlive, stream: false }, { limit: 5 * 60 * 1000 }),
    unload: (model) => json('/api/generate', { model, keep_alive: 0, stream: false }, { limit: 60 * 1000 }),
    generateStream: (payload, opts = {}) => streamed('/api/generate', { ...payload, stream: true }, { limit: 10 * 60 * 1000, ...opts }),
  };
}

/**
 * Everything one look at a host can tell, each field a real value or unavailable(). Never throws.
 * → { name, url, kind, reachable, latencyMs, version, models, installedCount, resident, credential }
 */
export async function probeHost(host, { fetchImpl = fetch, env = process.env, timeoutMs = 4000, now = () => performance.now() } = {}) {
  const out = { name: host.name, url: null, kind: null, reachable: false, latencyMs: unavailable('the host did not answer'), version: unavailable('the host did not answer'),
    models: unavailable('the host did not answer'), installedCount: unavailable('the host did not answer'), resident: unavailable('the host did not answer'), credential: null, error: null };
  let client;
  try { client = hostClient(host, { fetchImpl, env, timeoutMs }); } catch (e) { out.error = e.message; return out; }
  out.url = client.host.url; out.kind = client.host.kind; out.credential = client.credential;
  const t0 = now();
  try {
    const version = await client.version();
    out.reachable = true;
    out.latencyMs = Math.max(0, Math.round(now() - t0));
    out.version = version ? String(version) : unavailable('the host answered without a version');
  } catch (e) {
    out.error = /timed? ?out|abort/i.test(e.message) ? `no answer within ${Math.round(timeoutMs / 1000)} s` : e.message;
    return out;
  }
  try { const tags = await client.tags(); out.models = tags; out.installedCount = tags.length; } catch (e) { out.models = unavailable(e.message); out.installedCount = unavailable(e.message); }
  try {
    out.resident = (await client.ps()).map((m) => ({
      name: m.name ?? m.model, digest: m.digest ?? null,
      bytes: measured(m.size, 'the host did not report this model\'s size in memory', { allowZero: false }),
      gpuBytes: measured(m.size_vram, 'the host did not report how much of it is on the GPU'),
      expiresAt: m.expires_at ?? null,
    }));
  } catch (e) { out.resident = unavailable(e.message); }
  return out;
}
