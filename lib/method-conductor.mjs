// lib/method-conductor.mjs — the method conductor (owner item 15, 2026-11-05): the channel that turns
// Brain Library METHOD FILES into conducted action. The thesis of item 15: method files are the
// capability layer. Kingmaker establishes flagship capability by reading a method file and
// conducting the actions in that method file — the capability lives in the FILE (its inputs are
// the dials/thresholds, its steps are the procedure), not in this code. This conductor is the
// exact same baseline system on every install; a future capability update is a new or edited
// method file in catalog/methods/, streamed down and conducted. Training modules
// (catalog/training/, lib/module-reader.mjs) teach how to reason; method files script what to do.
//
// The conduction channel, end to end:
//   1. DISCOVER — through the Brain Library: the default index is brain-library's
//      METHODS_INDEX_URL (catalog/methods/index.json, schema kingmaker.methods/1), parsed by
//      brain-library's normalizeMethodsIndex. No catalog path is hardcoded here.
//   2. STREAM + DIGEST — the chosen method file's text is pulled through the library read path
//      (readText, injectable exactly like the module reader's) and digested: the fenced
//      ```kingmaker-method JSON block is parsed into { id, version, inputs, steps[] }.
//      A method file in the wild is markdown a human can read; the executable block is its
//      machine layer, and the prose mirror beside it must say the same thing.
//   3. CONDUCT — the steps run IN ORDER through the typed step vocabulary below, against a
//      caller-supplied workDir. Every step lands in a step-by-step execution TRACE.
//
// Step vocabulary (the ONLY actions a method file can conduct — an allowlist, fail-closed):
//   inspect        { path, into? }                      workDir-relative existence/kind/size, recorded
//   read-json      { path, into }                       parse a JSON file into a named store
//   read-json-dir  { path, into }                       parse every *.json in a dir into a record array (each record gains _file)
//   read-text      { path, into }                       read a text file into a named store
//   guard          { assert, else:{status, reason} }    precondition/disqualifier; a failed guard HALTS the conduction, nothing further runs
//   evaluate-signals { from, into, scoreInto, rules[] } declarative signal rules (see evaluateRule); fires signals + net score
//   band           { scoreFrom, into, statusInto, requiredInputs, bands, default, cap? }
//                                                       verdict banding; any required input null → verdict null, status 'dials-unset'
//   render         { path, template }                   substitute {{...}} placeholders, write a text file (creates parent dirs)
//   write-json     { path, value }                      substitute placeholders deep in `value`, write JSON
//   append-jsonl   { path, value }                      append one substituted JSON line
//   verify         { assertions[] }                     re-read files/stores and assert field/text facts; a failed assertion FAILS the conduction
//   check-tool     { command, candidates? }             locate a binary on PATH or at a candidate path (existence + executable bit; never runs it)
//   declare        { action, reason }                   a step this run does NOT execute (needs a live server, a binary this node
//                                                       lacks, an owner's act...). Recorded in the trace as 'declared' — never faked.
//   note           { text }                             a trace note, substituted
// Any other step type is REFUSED (trace status 'refused', conduction halts): a method file can
// never smuggle in an action the baseline system does not already know how to conduct.
//
// Placeholders: {{inputs.<name>}}, {{method.id}} / {{method.version}}, and {{<store>.<field…>}}
// for any store a step filled (target, evidence, signals, score, verdict…). A placeholder that
// is the ENTIRE string resolves to the raw value (object/array/number); embedded placeholders
// stringify. All step paths resolve inside workDir — a path escaping workDir is refused.
//
// Interface (item 16's loop consumes exactly this):
//   const conductor = createMethodConductor();                    // or { indexUrl, readText } for tests/fixtures
//   await conductor.listMethods();
//     // → [{ id, title, domain, quality, version, stepCount, inputKeys }]   (digests every indexed file)
//   await conductor.conduct(idOrQuery, { workDir, inputs?, now?, traceFile? });
//     // idOrQuery: an exact method id, or a substring matched against id/title/domain (first match wins)
//     // inputs:   per-run overrides merged over the method file's own inputs (the file's values are the defaults)
//     // now:      injectable clock (ms epoch or Date) for date-sensitive rules (domain age, expiry windows)
//     // traceFile: optional workDir-relative path; the trace is also written there as JSON
//     // → {
//     //     method: { id, title, version, domain, file, sha256 },
//     //     status: 'completed' | 'halted' | 'failed',
//     //     haltedAt: <step id> | null, reason: <string> | null,
//     //     inputs: { …effective inputs after overrides… },
//     //     outputs: { <store name>: <value> },          // every store the steps filled (target, signals, score, verdict…)
//     //     declared: [ { step, action, reason } ],      // the steps recorded as declared-not-executed
//     //     trace: [ { n, id, type, status, detail, result? } ]
//     //       status ∈ 'executed' | 'declared' | 'halted' | 'failed' | 'refused'
//     //   }
//   parseMethodFile(text) is exported pure for tests and tooling.

import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { METHODS_INDEX_URL, normalizeMethodsIndex } from './brain-library.mjs';

const defaultReadText = (loc) => readFile(loc, 'utf8');
const DAY_MS = 86_400_000;

/** Pure: extract + parse the executable block of a method file's markdown text. */
export function parseMethodFile(text) {
  const m = /```kingmaker-method\r?\n([\s\S]*?)```/.exec(String(text));
  if (!m) throw new Error('method-conductor: method file carries no ```kingmaker-method block');
  let spec;
  try { spec = JSON.parse(m[1]); } catch (e) { throw new Error(`method-conductor: executable block is not valid JSON (${e.message})`); }
  if (!spec.id || !Array.isArray(spec.steps) || spec.steps.some((s) => !s.id || !s.type)) {
    throw new Error(`method-conductor: executable block is malformed (id=${spec?.id ?? '?'}) — every step needs an id and a type`);
  }
  return { id: spec.id, version: spec.version ?? '0', title: spec.title ?? spec.id, domain: spec.domain ?? null, inputs: spec.inputs ?? {}, steps: spec.steps, requiresFetchedDetails: spec.requiresFetchedDetails === true };
}

const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const resolveRef = (ref, ctx) => (ref && typeof ref === 'object' && 'input' in ref ? ctx.inputs[ref.input] : ref && typeof ref === 'object' && 'value' in ref ? ref.value : ref);

function substitute(value, ctx) {
  if (typeof value === 'string') {
    const whole = /^\{\{([^}]+)\}\}$/.exec(value.trim());
    if (whole) { const v = getPath(ctx, whole[1].trim()); return v === undefined ? value : v; }
    return value.replace(/\{\{([^}]+)\}\}/g, (_, p) => { const v = getPath(ctx, p.trim()); return v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ctx)]));
  return value;
}

/** One signal-rule condition against one record (or the whole set, for aggregates). */
function evalCondition(cond, record, allRecords, ctx, now) {
  if (cond.aggregate === 'verifiedShare') {
    const ok = allRecords.filter((r) => r.ok === true);
    if (!ok.length) return false;
    const share = ok.filter((r) => r.verified === true).length / ok.length;
    if ('gte' in cond) return share >= resolveRef(cond.gte, ctx);
    if ('lt' in cond) return share < resolveRef(cond.lt, ctx);
    return false;
  }
  if (cond.other) {
    const o = cond.other;
    return allRecords.some((r) => r.source === o.source && r.ok === true && compare(getPath(r, o.field), o, ctx));
  }
  const v = record ? getPath(record, cond.field) : undefined;
  return compare(v, cond, ctx, now) || condSpecial(v, cond, ctx, now);
}
function compare(v, cond, ctx, now) {
  if ('equals' in cond) return v === resolveRef(cond.equals, ctx);
  if ('exists' in cond) return (v !== undefined && v !== null) === cond.exists;
  if ('gte' in cond) return typeof v === 'number' && v >= resolveRef(cond.gte, ctx);
  if ('gt' in cond) return typeof v === 'number' && v > resolveRef(cond.gt, ctx);
  if ('lte' in cond) return typeof v === 'number' && v <= resolveRef(cond.lte, ctx);
  if ('lt' in cond) return typeof v === 'number' && v < resolveRef(cond.lt, ctx);
  return false;
}
function condSpecial(v, cond, ctx, now) {
  if ('containsAny' in cond) return typeof v === 'string' && cond.containsAny.some((n) => v.toLowerCase().includes(String(n).toLowerCase()));
  if ('ageDaysGte' in cond || 'ageDaysLt' in cond) {
    const t = Date.parse(v); if (!Number.isFinite(t)) return false;
    const age = (now - t) / DAY_MS;
    return 'ageDaysGte' in cond ? age >= resolveRef(cond.ageDaysGte, ctx) : age < resolveRef(cond.ageDaysLt, ctx);
  }
  if ('withinDays' in cond) { const t = Date.parse(v); if (!Number.isFinite(t)) return false; const d = (t - now) / DAY_MS; return d >= 0 && d <= resolveRef(cond.withinDays, ctx); }
  if ('anyItem' in cond) return Array.isArray(v) && v.some((it) => compare(getPath(it, cond.anyItem.itemField) ?? it?.[cond.anyItem.itemField], cond.anyItem, ctx));
  if ('allItems' in cond) return Array.isArray(v) && v.length > 0 && v.every((it) => compare(it?.[cond.allItems.itemField], cond.allItems, ctx));
  return false;
}

/** Pure-ish: fire the declarative signal rules over a record set. Raise rules read verified ok records only. */
export function evaluateSignals(records, rules, ctx, now) {
  const signals = [];
  let score = 0;
  for (const rule of rules) {
    let fired = null;
    if (rule.source === '*') {
      if ((rule.when ?? []).every((c) => evalCondition(c, null, records, ctx, now))) fired = { file: null };
    } else {
      for (const r of records) {
        if (r.source !== rule.source || r.ok !== true) continue;
        if (rule.direction === 'raise' && r.verified !== true) continue; // unverified evidence raises nothing, ever
        if ((rule.when ?? []).every((c) => evalCondition(c, r, records, ctx, now))) { fired = { file: r._file ?? null }; break; }
      }
    }
    if (fired) { signals.push({ signal: rule.signal, direction: rule.direction, evidenceFile: fired.file }); score += rule.direction === 'raise' ? 1 : -1; }
  }
  return { signals, score };
}

function findOnPath(command, candidates, ctx) {
  const tried = [];
  for (const c of candidates ?? []) {
    const p = substitute(c, ctx);
    if (typeof p !== 'string' || !p) continue;
    tried.push(p);
    try { accessSync(p, fsConstants.X_OK); return { found: true, path: p, via: 'candidate' }; } catch { /* next */ }
  }
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const p = join(dir, command);
    try { accessSync(p, fsConstants.X_OK); return { found: true, path: p, via: 'PATH' }; } catch { /* next */ }
  }
  return { found: false, path: null, via: null, candidatesTried: tried };
}

export function createMethodConductor({ indexUrl = METHODS_INDEX_URL, readText = defaultReadText } = {}) {
  let cache = null; // [{ descriptor, loc, spec, text }]

  async function loadLibrary() {
    if (cache) return cache;
    const descriptors = normalizeMethodsIndex(JSON.parse(await readText(indexUrl)));
    const methods = [];
    for (const d of descriptors) {
      const loc = new URL(d.file, indexUrl);
      const text = await readText(loc); // the library read path — the file is streamed, never a hardcoded path
      methods.push({ descriptor: d, loc, text, spec: parseMethodFile(text), sha256: createHash('sha256').update(text).digest('hex') });
    }
    cache = methods;
    return methods;
  }

  /** Discovery + digest of every indexed method file (inputs/steps metadata; this DOES read the files). */
  async function listMethods() {
    const methods = await loadLibrary();
    return methods.map((m) => ({
      id: m.spec.id, title: m.spec.title, domain: m.spec.domain, quality: m.descriptor.quality,
      version: m.spec.version, stepCount: m.spec.steps.length, inputKeys: Object.keys(m.spec.inputs),
      // A method file may declare `requiresFetchedDetails: true` in its executable block: it cannot
      // run without the details the execution loop's fetch leg loads, and the loop's no-guessing
      // gate (lib/execution-loop.mjs, item 17) halts it rather than let it proceed on invented ones.
      requiresFetchedDetails: m.spec.requiresFetchedDetails === true,
    }));
  }

  function pickMethod(methods, idOrQuery) {
    const q = String(idOrQuery ?? '').toLowerCase();
    return methods.find((m) => m.spec.id.toLowerCase() === q)
      ?? methods.find((m) => m.spec.id.toLowerCase().includes(q) || m.spec.title.toLowerCase().includes(q) || String(m.spec.domain ?? '').toLowerCase() === q);
  }

  /**
   * Conduct one method file end to end against `workDir`. See the header for the full contract.
   * The conduction never throws for a method-level problem (missing file, failed guard, bad
   * assertion): it halts/fails with the step named in the trace. It throws only when the method
   * itself cannot be found in the library.
   */
  async function conduct(idOrQuery, { workDir, inputs: overrides = {}, now = Date.now(), traceFile = null } = {}) {
    if (!workDir) throw new Error('method-conductor: conduct() needs a workDir — method steps act inside it and nowhere else');
    const methods = await loadLibrary();
    const method = pickMethod(methods, idOrQuery);
    if (!method) throw new Error(`method-conductor: no method in the library matches "${idOrQuery}"`);
    const spec = method.spec;
    const inputs = { ...spec.inputs, ...overrides };
    const nowMs = now instanceof Date ? now.getTime() : now;
    // The workDir's REAL path is the containment root (pen-test F1): if the workDir itself
    // is reached through a symlink, containment is judged against where it actually is.
    let root = resolve(workDir);
    try { root = realpathSync(root); } catch { /* a not-yet-existing workDir keeps its lexical path */ }
    const ctx = { inputs, method: { id: spec.id, version: spec.version, title: spec.title, domain: spec.domain } };
    const outputs = {};
    const trace = [];
    const declared = [];
    let status = 'completed', haltedAt = null, reason = null;

    // Containment is judged on the REAL path (pen-test F1): the lexical check alone let a
    // symlink inside the workDir smuggle reads/writes outside it. Resolve the nearest
    // existing ancestor (the target itself when it exists; for a write, the parent chain
    // of a not-yet-created file), re-attach any not-yet-existing tail, and refuse when the
    // resolved path lands outside the real workDir — a symlink whose target escapes is
    // refused exactly like a `../` escape. Symlinks resolving INSIDE the workDir stay legal.
    const inWorkDir = (p) => {
      const abs = resolve(root, p);
      if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path "${p}" escapes the workDir`);
      let cur = abs;
      const tail = [];
      for (;;) {
        let st = null;
        try { st = lstatSync(cur); } catch { /* cur does not exist yet — walk to its parent */ }
        if (!st) {
          const parent = dirname(cur);
          if (parent === cur) throw new Error(`path "${p}" escapes the workDir`);
          tail.unshift(basename(cur));
          cur = parent;
          continue;
        }
        let real;
        try { real = realpathSync(cur); } catch {
          // A dangling symlink: judge it by where its target points, never by its name.
          if (!st.isSymbolicLink()) throw new Error(`path "${p}" escapes the workDir`);
          real = resolve(dirname(cur), readlinkSync(cur));
          if (real !== root && !real.startsWith(root + sep)) throw new Error(`path "${p}" escapes the workDir`);
        }
        const resolved = tail.length ? join(real, ...tail) : real;
        if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`path "${p}" escapes the workDir`);
        return resolved;
      }
    };
    const setStore = (name, value) => { if (name) { ctx[name] = value; outputs[name] = value; } };

    for (const step of spec.steps) {
      const entry = { n: step.n ?? trace.length + 1, id: step.id, type: step.type, status: 'executed', detail: '' };
      trace.push(entry);
      try {
        switch (step.type) {
          case 'inspect': {
            const rel = substitute(step.path, ctx);
            let result;
            try { const st = await stat(inWorkDir(rel)); result = { path: rel, exists: true, kind: st.isDirectory() ? 'dir' : 'file', size: st.size }; }
            catch { result = { path: rel, exists: false }; }
            entry.result = result; entry.detail = `inspected ${rel}: ${result.exists ? result.kind : 'absent'}`;
            setStore(step.into, result);
            break;
          }
          case 'read-json': {
            const rel = substitute(step.path, ctx);
            const data = JSON.parse(await readFile(inWorkDir(rel), 'utf8'));
            setStore(step.into, data); entry.detail = `read ${rel}`; entry.result = { path: rel };
            break;
          }
          case 'read-text': {
            const rel = substitute(step.path, ctx);
            const data = await readFile(inWorkDir(rel), 'utf8');
            setStore(step.into, data); entry.detail = `read ${rel} (${data.length} chars)`; entry.result = { path: rel, chars: data.length };
            break;
          }
          case 'read-json-dir': {
            const rel = substitute(step.path, ctx);
            const files = (await readdir(inWorkDir(rel))).filter((f) => f.endsWith('.json')).sort();
            const records = [];
            for (const f of files) { try { records.push({ ...JSON.parse(await readFile(inWorkDir(join(rel, f)), 'utf8')), _file: f }); } catch { /* a malformed record is skipped, never counted — the source method's rule */ } }
            setStore(step.into, records); entry.detail = `read ${records.length} record(s) from ${rel}`; entry.result = { path: rel, records: records.length, files };
            break;
          }
          case 'guard': {
            const a = step.assert ?? {};
            let ok = false, what = '';
            if (a.var) { const v = getPath(ctx[a.var] ?? {}, a.field); ok = 'equals' in a ? v === substitute(a.equals, ctx) : v !== undefined; what = `${a.var}.${a.field}`; }
            else if (a.existsRecord) { const arr = ctx[a.existsRecord.in] ?? []; ok = arr.some((r) => r.source === a.existsRecord.source && compare(getPath(r, a.existsRecord.field), a.existsRecord, ctx)); what = `a ${a.existsRecord.source} record`; }
            else if (a.noRecordWith) { const arr = ctx[a.noRecordWith.in] ?? []; ok = !arr.some((r) => compare(getPath(r, a.noRecordWith.field), a.noRecordWith, ctx)); what = `no record with ${a.noRecordWith.field}`; }
            if (!ok) {
              entry.status = 'halted';
              entry.detail = `guard failed (${what}): ${step.else?.reason ?? 'precondition not met'}`;
              entry.result = { verdictStatus: step.else?.status ?? 'halted' };
              status = 'halted'; haltedAt = step.id; reason = step.else?.reason ?? `guard ${step.id} failed`;
              setStore('verdictStatus', step.else?.status ?? 'halted');
            } else entry.detail = `guard passed (${what})`;
            break;
          }
          case 'evaluate-signals': {
            const records = ctx[step.from] ?? [];
            const { signals, score } = evaluateSignals(records, step.rules ?? [], ctx, nowMs);
            setStore(step.into, signals); setStore(step.scoreInto, score);
            entry.detail = `${signals.length} signal(s) fired, net score ${score}`;
            entry.result = { signals: signals.map((s) => `${s.direction === 'raise' ? '+' : '-'}${s.signal}`), score };
            break;
          }
          case 'band': {
            const score = ctx[step.scoreFrom] ?? 0;
            const unset = (step.requiredInputs ?? []).filter((k) => inputs[k] === null || inputs[k] === undefined);
            let verdict = null, vStatus = 'ok', cappedBy = null;
            if (unset.length) vStatus = 'dials-unset';
            else {
              verdict = step.default ?? null;
              for (const b of step.bands ?? []) { const min = b.minInput ? inputs[b.minInput] : b.min; if (typeof min === 'number' && score >= min) { verdict = b.verdict; break; } }
              if (step.cap && verdict) {
                const rank = { FIT: 3, REVIEW: 2, 'NOT-FIT': 1 };
                const fired = new Set((ctx.signals ?? []).map((s) => s.signal));
                if (!fired.has(step.cap.unlessSignal) && (rank[verdict] ?? 0) > (rank[step.cap.max] ?? 0)) { verdict = step.cap.max; cappedBy = `no ${step.cap.unlessSignal} signal — capped at ${step.cap.max}`; }
              }
            }
            setStore(step.into, verdict); setStore(step.statusInto, vStatus);
            entry.detail = unset.length ? `dials unset (${unset.join(', ')}) — signal list only, no verdict` : `score ${score} → ${verdict}${cappedBy ? ` (${cappedBy})` : ''}`;
            entry.result = { score, verdict, verdictStatus: vStatus };
            break;
          }
          case 'render': {
            const rel = substitute(step.path, ctx);
            const text = substitute(step.template, ctx);
            const abs = inWorkDir(rel);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, text);
            entry.detail = `rendered ${rel} (${text.length} chars)`; entry.result = { path: rel, chars: text.length };
            break;
          }
          case 'write-json': {
            const rel = substitute(step.path, ctx);
            const value = substitute(step.value, ctx);
            const abs = inWorkDir(rel);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`);
            entry.detail = `wrote ${rel}`; entry.result = { path: rel };
            break;
          }
          case 'append-jsonl': {
            const rel = substitute(step.path, ctx);
            const value = substitute(step.value, ctx);
            const abs = inWorkDir(rel);
            await mkdir(dirname(abs), { recursive: true });
            await appendFile(abs, `${JSON.stringify(value)}\n`);
            entry.detail = `appended one line to ${rel}`; entry.result = { path: rel };
            break;
          }
          case 'verify': {
            const failures = [];
            for (const raw of step.assertions ?? []) {
              const a = substitute(raw, ctx);
              let actual, label;
              if (a.file) {
                const text = await readFile(inWorkDir(a.file), 'utf8');
                label = a.file;
                if ('contains' in a) { if (!text.includes(String(a.contains))) failures.push(`${label} does not contain "${a.contains}"`); continue; }
                actual = a.field ? getPath(JSON.parse(text), a.field) : undefined;
              } else { label = `${a.var}.${a.field ?? ''}`; actual = getPath(ctx[a.var] ?? {}, a.field); }
              if ('equals' in a && actual !== a.equals) failures.push(`${label}: expected ${JSON.stringify(a.equals)}, got ${JSON.stringify(actual)}`);
              if ('exists' in a && (actual !== undefined) !== a.exists) failures.push(`${label}: existence check failed`);
            }
            if (failures.length) { entry.status = 'failed'; entry.detail = `verification failed: ${failures.join('; ')}`; entry.result = { failures }; status = 'failed'; haltedAt = step.id; reason = entry.detail; }
            else entry.detail = `verified ${step.assertions.length} assertion(s)`;
            break;
          }
          case 'check-tool': {
            const found = findOnPath(step.command, step.candidates, ctx);
            entry.result = { command: step.command, ...found };
            entry.detail = found.found ? `${step.command} found at ${found.path} (via ${found.via})` : `${step.command} NOT found on PATH${found.candidatesTried?.length ? ` or at ${found.candidatesTried.join(', ')}` : ''}`;
            setStore(step.into, found);
            break;
          }
          case 'declare': {
            const action = substitute(step.action, ctx);
            const why = substitute(step.reason ?? '', ctx);
            entry.status = 'declared'; entry.detail = `declared, not executed: ${action}`;
            entry.result = { action, reason: why };
            declared.push({ step: step.id, action, reason: why });
            break;
          }
          case 'note': {
            entry.detail = String(substitute(step.text ?? '', ctx));
            break;
          }
          default: {
            entry.status = 'refused';
            entry.detail = `unknown step type "${step.type}" — the conductor's vocabulary is an allowlist; conduction halts`;
            status = 'failed'; haltedAt = step.id; reason = entry.detail;
          }
        }
      } catch (e) {
        if (entry.status === 'executed') { entry.status = 'failed'; entry.detail = `${step.type} failed: ${e.message}`; }
        if (status === 'completed') { status = 'failed'; haltedAt = step.id; reason = entry.detail; }
      }
      if (status !== 'completed') break;
    }

    const result = {
      method: { id: spec.id, title: spec.title, version: spec.version, domain: spec.domain, file: method.descriptor.file, sha256: method.sha256 },
      status, haltedAt, reason, inputs, outputs, declared, trace,
    };
    if (traceFile) {
      const abs = inWorkDir(substitute(traceFile, ctx));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, `${JSON.stringify({ method: result.method, status, trace }, null, 2)}\n`);
    }
    return result;
  }

  return { listMethods, conduct };
}

/** One-shot convenience: a fresh conductor, one conduction. */
export async function conductMethod(idOrQuery, opts = {}) {
  const { conductorOpts, ...conductOpts } = opts;
  return createMethodConductor(conductorOpts).conduct(idOrQuery, conductOpts);
}
