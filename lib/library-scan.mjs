// lib/library-scan.mjs — the scan every Brain Library submission passes before the owner looks at it (owner 2026-10-15:
// "im the only one who gets to do commits to the kingmaker repo same with the brain library they cn make submissions but
// we have to scan them first").
//   • A submission is a pull request that ADDS bench results: new files under bench/, nothing else. It can't change the
//     catalog, the weights list, the README, the scan or the workflow, and it can't overwrite anyone's result.
//   • Each file is read as data and never run. Every field must be one `kingmaker models bench` writes, with its type and
//     a sane range; an unknown field fails the scan. Text a model wrote (tool arguments, the writing test) is short, has
//     no links, no keys or tokens, and no contact details but the bench's own made-up ones.
//   • Passing the scan only makes a pull request ready for the owner's review; the owner still merges by hand, and picks
//     change only through the reviewed rotation commit (lib/brain-library.mjs proposePicks).
// Dependency-free: the library repo runs this same file in its workflow (.github/scan/), and `kingmaker models library
// submit` runs it before anything is sent.

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_RESULTS = 40;
const NAME_RE = /^bench\/(?:vm\/)?[a-z0-9][a-z0-9-]{2,80}\.json$/;
const CHIP_RE = /^Apple M[1-9](?: (?:Pro|Max|Ultra))?(?: \(Virtual\))?$/;
const RAM_GB = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];
// An Ollama tag: name[:tag], namespace/name[:tag], or hf.co/user/repo[:quant]. No other host.
const TAG_RE = /^(?:hf\.co\/[\w.-]+\/[\w.-]+|(?:[a-z0-9][\w-]*\/)?[a-z0-9][\w.-]*)(?::[\w.-]+)?$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const VERSION_RE = /^\d{1,3}(?:\.\d{1,4}){0,3}$/;

// The bench's own made-up people (lib/model-bench.mjs TOOL_CASES): the only contact details a result may hold.
// Models also make up their own: example.com addresses and 555 numbers are fictional by design, so they pass too.
const FIXTURE_EMAIL = /^[a-z0-9._-]+@(?:(?:hectortacos|ruizbakery|lopezcleaning)\.com|example\.(?:com|org|net))$/i;
const FIXTURE_PHONE = /^(?:\+?1)?\D*\(?\d{3}\)?\D*555\D*\d{4}$/;
// Hosts the bench itself names (a model's tag, Ollama's own errors): not links anyone added.
const KNOWN_HOSTS = /\b(?:hf\.co|registry\.ollama\.ai|ollama\.com)\//g;

const LINK = /\b(?:https?:\/\/|www\.|ftp:\/\/|file:\/\/|data:[a-z]+\/)|\b[a-z0-9-]+\.(?:com|net|org|io|ai|app|dev|xyz|ru|cn|tk|ly|gg|co)\/\S/i;
const SECRET = [
  /\bsk-[a-z0-9_-]{16,}/i, /\bgh[pousr]_[a-z0-9]{20,}/i, /\bgithub_pat_[a-z0-9_]{20,}/i, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abpr]-[a-z0-9-]{10,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\./i, /\bhf_[a-z0-9]{30,}/i,
  /\b(?:sk|pk|rk)_(?:live|test)_[a-z0-9]{16,}/i, /\b[a-f0-9]{40,}\b/i,
];
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

const num = (lo, hi) => ({ type: 'number', lo, hi });
const str = (max, re, said) => ({ type: 'string', max, re, said });
const NUM_OR_NULL = { type: 'number|null', lo: -1e6, hi: 1e6 };

// Every path a bench file may hold ([] = any array index), its type and its bounds.
const PASS = { pass: num(0, 500), of: num(0, 500) };
const lane = (p) => ({ [`${p}.pass`]: PASS.pass, [`${p}.of`]: PASS.of, [`${p}.pct`]: num(0, 100), [`${p}.avgMs`]: num(0, 3.6e6),
  [`${p}.by.*.pass`]: PASS.pass, [`${p}.by.*.of`]: PASS.of });
const SHAPE = {
  schema: num(1, 1), slug: str(80, /^[a-z0-9][a-z0-9-]*$/), startedAt: str(30, ISO_RE), finishedAt: str(30, ISO_RE),
  context: num(512, 1_048_576), maxResidentGb: num(0.5, 1024), simulated: { type: 'null|object' }, cooldownS: num(0, 3600),
  // What made the file (lib/model-bench.mjs benchProvenance): Kingmaker's version and its checkout's commit and branch.
  kingmaker: { type: 'null|object' }, 'kingmaker.version': { type: 'string|null', max: 24, re: /^[\w.+-]+$/ },
  'kingmaker.commit': { type: 'string|null', max: 40, re: /^[0-9a-f]{40}$/ }, 'kingmaker.branch': { type: 'string|null', max: 80, re: /^[\w./-]+$/ },
  'host.chip': str(40, CHIP_RE), 'host.model': str(20, /^[A-Za-z]+\d+,\d+$|^VirtualMac\d+,\d+$/), 'host.ramGb': { type: 'number', in: RAM_GB },
  'host.macos': str(12, VERSION_RE), 'host.ollama': str(12, VERSION_RE),
  'simulated.asGb': { type: 'number', in: RAM_GB }, 'simulated.context': num(512, 1_048_576), 'simulated.gpuBudgetGib': num(0, 1024),
  'simulated.gpuTotalGib': num(0, 1024), 'simulated.honest': str(400), 'simulated.maxLoadedModels': num(1, 16), 'simulated.numParallel': num(1, 16),
  'simulated.overheadGib': num(0, 1024), 'simulated.schedulerSaw.available': str(16, /^[\d.]+ ?[KMGT]i?B$/), 'simulated.schedulerSaw.free': str(16, /^[\d.]+ ?[KMGT]i?B$/),
  results: { type: 'array', max: MAX_RESULTS },
  'results[].model': str(120, TAG_RE, false), 'results[].at': str(30, ISO_RE), 'results[].context': num(512, 1_048_576),
  'results[].capabilities': { type: 'array', max: 12 }, 'results[].capabilities[]': str(16, /^[a-z_-]+$/),
  'results[].loadS': num(0, 3600), 'results[].firstReplyS': num(0, 3600), 'results[].error': str(300),
  'results[].resident.sizeGb': num(0, 1024), 'results[].resident.gpuGb': num(0, 1024), 'results[].resident.contextLength': num(0, 1_048_576),
  'results[].speed.promptTokS': num(0, 50_000), 'results[].speed.genTokS': num(0, 2000), 'results[].speed.genTokens': num(0, 100_000),
  // What the model read (prefill) and how much of a repeated system brief it read again (lib/model-bench.mjs prefixReuse).
  'results[].speed.promptTokens': { type: 'number|null', lo: 0, hi: 1e6 }, 'results[].speed.promptMs': { type: 'number|null', lo: 0, hi: 3.6e6 },
  'results[].speed.prefix': { type: 'null|object' }, 'results[].speed.prefix.firstTokens': { type: 'number|null', lo: 0, hi: 1e6 },
  'results[].speed.prefix.secondTokens': { type: 'number|null', lo: 0, hi: 1e6 }, 'results[].speed.prefix.firstMs': { type: 'number|null', lo: 0, hi: 3.6e6 },
  'results[].speed.prefix.secondMs': { type: 'number|null', lo: 0, hi: 3.6e6 }, 'results[].speed.prefix.reusedPct': { type: 'number|null', lo: 0, hi: 100 },
  'results[].memory.footprintPeakGb': num(0, 1024), 'results[].memory.minMemLevel': num(0, 100), 'results[].memory.peakRssGb': num(0, 1024),
  'results[].memory.runnersSeen': num(0, 64), 'results[].memory.steadyRssGb': num(0, 1024), 'results[].memory.swapDeltaMb': num(-1e6, 1e6),
  'results[].thermal.*.freePct': num(0, 100), 'results[].thermal.*.speedLimit': NUM_OR_NULL, 'results[].thermal.*.warning': { type: 'string|number|null', max: 40 },
  ...lane('results[].tools.twoStep'), ...lane('results[].tools.native'), ...lane('results[].route'), ...lane('results[].write'),
  'results[].tools.*.cases': { type: 'array', max: 100 }, 'results[].tools.*.cases[].id': str(8, /^[a-z]\d{1,2}$/), 'results[].tools.*.cases[].kind': str(10, /^[a-z]+$/),
  'results[].tools.*.cases[].pass': { type: 'boolean' }, 'results[].tools.*.cases[].error': str(300),
  'results[].tools.*.cases[].got': { type: 'array', max: 8 }, 'results[].tools.*.cases[].got[].name': str(40, /^[a-z_]+$/), 'results[].tools.*.cases[].got[].ms': num(0, 3.6e6),
  'results[].tools.*.cases[].got[].why': str(40, /^[a-z_]+$/),
  'results[].tools.*.cases[].got[].arguments': { type: 'object', keys: /^[\w -]{1,40}$/, max: 12 }, 'results[].tools.*.cases[].got[].arguments.*': { type: 'string|number|boolean|null', max: 300, said: true },
  'results[].route.cases': { type: 'array', max: 100 }, 'results[].route.cases[].kind': str(10, /^[a-z]+$/), 'results[].route.cases[].pass': { type: 'boolean' },
  'results[].route.cases[].text': str(200, null, true), 'results[].route.cases[].want': str(12, /^[a-z]+$/), 'results[].route.cases[].got': { type: 'string|null', max: 12, re: /^[a-z]*$/ },
  'results[].write.cases': { type: 'array', max: 20 }, 'results[].write.cases[].id': str(8, /^[a-z]\d{1,2}$/), 'results[].write.cases[].kind': str(10, /^[a-z]+$/),
  'results[].write.cases[].pass': { type: 'boolean' }, 'results[].write.cases[].text': { type: 'string', max: 1200, said: true },
};
for (const k of Object.keys(SHAPE)) if (SHAPE[k].type === 'string' && SHAPE[k].said === undefined) SHAPE[k].said = SHAPE[k].max > 40;

/** Pure: the shape key a concrete path matches ("results.3.tools.native.cases.2.got.0.name" → its rule), or null. */
const RULES = new Map();
function ruleFor(path) {
  const want = path.replace(/\.(\d+)(?=\.|$)/g, '[]');
  if (!RULES.has(want)) RULES.set(want, findRule(want));
  return RULES.get(want);
}
function findRule(want) {
  const parts = want.split('.');
  if (SHAPE[want]) return SHAPE[want];
  for (const key of Object.keys(SHAPE)) {
    const k = key.split('.');
    if (k.length !== parts.length) continue;
    if (k.every((seg, i) => seg === parts[i] || (seg === '*' && !parts[i].endsWith('[]')))) return SHAPE[key];
  }
  return null;
}

/** Pure: what is wrong with a piece of text a model or a person wrote → [] when it is fine. */
export function textProblems(s) {
  const out = [];
  if (CONTROL.test(s)) out.push('has hidden control characters');
  if (LINK.test(s.replace(KNOWN_HOSTS, ''))) out.push('has a link');
  if (SECRET.some((re) => re.test(s))) out.push('looks like a key or token');
  for (const e of s.match(EMAIL) ?? []) if (!FIXTURE_EMAIL.test(e)) { out.push('has an email address'); break; }
  for (const p of s.match(PHONE) ?? []) if (!FIXTURE_PHONE.test(p.trim())) { out.push('has a phone number'); break; }
  return out;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Pure: one bench result (parsed JSON) → the problems in words; [] means it passes. */
export function scanBench(b) {
  const out = [];
  if (typeOf(b) !== 'object') return ['is not a bench result (not a JSON object)'];
  for (const key of ['schema', 'host', 'results']) if (b[key] === undefined) out.push(`has no ${key}`);
  let fields = 0;
  const walk = (v, path) => {
    if ((fields += 1) > 60_000) { if (fields === 60_001) out.push('is far too large'); return; }
    const t = typeOf(v);
    const rule = path ? ruleFor(path) : { type: 'object' };
    if (!rule) {
      // A container on the way to known fields (results.0, results.0.tools, …thermal.before).
      if (t === 'object' && isContainer(path)) { for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`); return; }
      out.push(`${path}: not a field the bench writes`); return;
    }
    if (!rule.type.split('|').includes(t)) { out.push(`${path}: should be ${rule.type}, is ${t}`); return; }
    if (t === 'number') {
      if (!Number.isFinite(v)) out.push(`${path}: not a finite number`);
      else if (rule.in && !rule.in.includes(v)) out.push(`${path}: ${v} is not a Mac memory size`);
      else if ((rule.lo !== undefined && v < rule.lo) || (rule.hi !== undefined && v > rule.hi)) out.push(`${path}: ${v} is out of range`);
    } else if (t === 'string') {
      if (rule.max && v.length > rule.max) out.push(`${path}: longer than ${rule.max} characters`);
      else if (rule.re && !rule.re.test(v)) out.push(`${path}: "${v.slice(0, 40)}" is not in the expected form`);
      else if (rule.said || !rule.re) for (const p of textProblems(v)) out.push(`${path}: ${p}`);
    } else if (t === 'array') {
      if (rule.max !== undefined && v.length > rule.max) out.push(`${path}: more than ${rule.max} entries`);
      v.forEach((x, i) => walk(x, `${path}.${i}`));
    } else if (t === 'object') {
      const keys = Object.keys(v);
      if (rule.max !== undefined && keys.length > rule.max) out.push(`${path}: more than ${rule.max} fields`);
      for (const k of keys) {
        if (rule.keys && !rule.keys.test(k)) { out.push(`${path}: "${k.slice(0, 30)}" is not an argument name`); continue; }
        walk(v[k], path ? `${path}.${k}` : k);
      }
    }
  };
  walk(b, '');
  // Numbers that can't both be true.
  for (const [i, r] of (Array.isArray(b.results) ? b.results : []).entries()) {
    for (const lanePath of [['tools', 'twoStep'], ['tools', 'native'], ['route'], ['write']]) {
      const l = lanePath.reduce((o, k) => o?.[k], r);
      if (l && typeof l.pass === 'number' && typeof l.of === 'number' && l.pass > l.of) out.push(`results.${i}.${lanePath.join('.')}: passed more than it ran`);
    }
  }
  if (b.host?.ramGb && b.maxResidentGb > b.host.ramGb) out.push('maxResidentGb is more than the Mac has');
  return [...new Set(out)].slice(0, 50);
}

const PREFIXES = new Map();
const isContainer = (path) => {
  const want = path.replace(/\.(\d+)(?=\.|$)/g, '[]');
  if (!PREFIXES.has(want)) PREFIXES.set(want, Object.keys(SHAPE).some((k) => matchesPrefix(k, want)));
  return PREFIXES.get(want);
};
function matchesPrefix(key, want) {
  const parts = want.split('.');
  const k = key.split('.');
  if (k.length <= parts.length) return false;
  return parts.every((seg, i) => k[i] === seg || (k[i] === '*' && !seg.endsWith('[]')));
}

/**
 * Pure: a bench result made safe to send. What models wrote in the tool test is kept for the record, but contact
 * details they made up (a gmail address, a real-looking number) become "[email]" / "[phone]", and an argument that came
 * back as an object or list becomes its JSON text (clipped). The scores are untouched. `submit` sends this copy.
 */
export function redactBench(b) {
  const clean = (v) => {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    s = s.replace(EMAIL, (e) => (FIXTURE_EMAIL.test(e) ? e : '[email]')).replace(PHONE, (p) => (FIXTURE_PHONE.test(p.trim()) ? p : '[phone]'));
    return s.replace(CONTROL_ALL, '').slice(0, 300);
  };
  const out = JSON.parse(JSON.stringify(b));
  for (const r of Array.isArray(out?.results) ? out.results : []) {
    for (const lane of Object.values(r?.tools ?? {})) for (const c of lane?.cases ?? []) {
      for (const g of c?.got ?? []) if (g?.arguments && typeof g.arguments === 'object') {
        g.arguments = Object.fromEntries(Object.entries(g.arguments).slice(0, 12).map(([k, v]) => [String(k).replace(/[^\w -]/g, '').slice(0, 40) || 'arg', v === null || typeof v === 'number' || typeof v === 'boolean' ? v : clean(v)]));
      }
    }
    for (const c of r?.write?.cases ?? []) if (typeof c?.text === 'string') c.text = c.text.replace(EMAIL, (e) => (FIXTURE_EMAIL.test(e) ? e : '[email]')).replace(PHONE, (p) => (FIXTURE_PHONE.test(p.trim()) ? p : '[phone]')).replace(CONTROL_ALL, '');
  }
  return out;
}

/**
 * Pure: a whole pull request → { ok, problems }. `files` is the PR's file list as GitHub gives it
 * ([{ filename, status, size?, content? }], content as text). Only added bench files pass; everything else fails it.
 */
export function scanSubmission(files) {
  const problems = [];
  if (!Array.isArray(files) || !files.length) return { ok: false, problems: ['the pull request changes nothing'] };
  if (files.length > 20) problems.push('more than 20 files: send one Mac\'s results per pull request');
  for (const f of files.slice(0, 20)) {
    const name = String(f.filename ?? '');
    if (!NAME_RE.test(name)) { problems.push(`${name.slice(0, 80)}: only new files in bench/ (bench/<chip>-<ram>.json) can be submitted`); continue; }
    if (f.status !== 'added') { problems.push(`${name}: changes a result that is already in the library (send a new file instead)`); continue; }
    const text = typeof f.content === 'string' ? f.content : null;
    if (text === null) { problems.push(`${name}: could not be read`); continue; }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) { problems.push(`${name}: larger than ${MAX_FILE_BYTES / 1024} KB`); continue; }
    let b; try { b = JSON.parse(text); } catch { problems.push(`${name}: is not JSON`); continue; }
    for (const p of scanBench(b)) problems.push(`${name}: ${p}`);
  }
  return { ok: problems.length === 0, problems };
}
