// lib/model-hosts-cli.mjs — the model-host commands, hooked from `kingmaker models` (lib/cli.mjs cmdModels)
// and from `kingmaker doctor`.
//
//   models hosts                              every host, whether it answers, what it holds
//   models hosts add <name> <address> [--key-env NAME]
//   models hosts remove <name>
//   models ps [--host <name>]                 what is loaded, and whose it is
//   models warm <model> [time] [--host <name>] [--evict]
//   models stop <model|all> [--host <name>] [--everyone]
//   models sync <model|--all> --to <name> [--from <name>] [--force] [--dry-run]
//   models speed <model> [--host <name>] [--runs N] [--warmup] [--predict N] [--json]
//
// A figure that could not be measured is printed as "unavailable (why)". None of these commands prints a
// number it did not read or time.

import { statfsSync } from 'node:fs';
import { freemem } from 'node:os';
import { findHost, hostClient, isUnavailable, loadHosts, LOCAL_HOST_NAME, measured, probeHost, removeHost, saveHost, show, unavailable } from './model-hosts.mjs';
import { isOurs, parseKeepAlive, readOurs, stopModels, warmModel } from './model-residency.mjs';
import { measureSpeed, speedAsJson, speedLines } from './model-speed.mjs';
import { localModelsDir, planSync, syncModel } from './model-sync.mjs';

export const MODEL_HOST_VERBS = Object.freeze(['hosts', 'ps', 'warm', 'stop', 'sync', 'speed']);

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const positional = (args, takesValue = []) => args.filter((a, i) => !a.startsWith('--') && !(i > 0 && takesValue.includes(args[i - 1])));
const gb = (bytes) => `${(bytes / 2 ** 30).toFixed(2)} GB`;
const VALUE_FLAGS = ['--host', '--to', '--from', '--runs', '--predict', '--key-env', '--context'];

/** How much this Mac may hold loaded at once: the owner's override, else its MEASURED free memory
 * (what is actually available to hold models right now — no class table carries a figure anymore).
 * Other hosts: not known. */
export function memoryBudgetBytes(host, { env = process.env, freeBytes = freemem() } = {}) {
  const override = Number(env.KINGMAKER_MODEL_BUDGET_GB);
  if (Number.isFinite(override) && override > 0) return override * 2 ** 30;
  if (host.kind !== 'local') return unavailable(`${host.name} is another machine and its memory limit is not known here`, 'set KINGMAKER_MODEL_BUDGET_GB for this command, or pass --evict to allow unloading');
  return Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes : unavailable('this Mac\'s free memory could not be measured');
}

/** One host's lines for `models hosts` and for doctor. `rows` get { ok: true|false|null, text, fix }. ok null = information. */
export function hostReportRows(probe, { ours = {}, pinned = [] } = {}) {
  const rows = [];
  const where = `${probe.name}${probe.url ? ` (${probe.url})` : ''}`;
  if (!probe.reachable) {
    rows.push({ ok: false, text: `model host ${where}: not answering${probe.error ? ` (${probe.error})` : ''}`,
      fix: probe.name === LOCAL_HOST_NAME ? 'Open Ollama on this Mac (or: brew services start ollama).' : `Check that ${probe.name} is on and reachable, or remove it: kingmaker models hosts remove ${probe.name}` });
    return rows;
  }
  rows.push({ ok: true, text: `model host ${where}: answering in ${show(probe.latencyMs, (v) => `${v} ms`)}, Ollama ${show(probe.version)}, ${show(probe.installedCount, (v) => `${v} model${v === 1 ? '' : 's'} installed`)}` });
  if (probe.credential?.key === 'withheld') rows.push({ ok: false, text: `key for ${probe.name}: not sent`, fix: probe.credential.why });
  else if (probe.credential?.key === 'sent') rows.push({ ok: null, text: `key for ${probe.name}: ${probe.credential.why}` });
  if (probe.kind === 'remote' && probe.url?.startsWith('http://')) rows.push({ ok: false, text: `${probe.name} is reached over plain http across the internet`, fix: 'Anyone on the way can read what is sent. Use https or a tunnel.' });
  if (isUnavailable(probe.resident)) rows.push({ ok: null, text: `loaded on ${probe.name}: unavailable (${probe.resident.reason})` });
  else if (!probe.resident.length) rows.push({ ok: null, text: `loaded on ${probe.name}: nothing` });
  else for (const m of probe.resident) {
    const whose = isOurs(ours, probe.name, m.name, pinned) ? 'Kingmaker\'s' : 'not loaded by Kingmaker';
    rows.push({ ok: null, text: `loaded on ${probe.name}: ${m.name}, ${show(m.bytes, gb)} in memory, ${show(m.gpuBytes, gb)} on the GPU (${whose})` });
  }
  return rows;
}

/**
 * The model-host part of `kingmaker doctor`: every host, this Mac's model folder and its free space.
 * → { rows: [{ ok, text, fix }], passed, failed }
 */
export async function modelHostDoctor({ stateDir, env = process.env, fetchImpl = fetch, pinned = [], freeBytesOf = defaultFreeBytes } = {}) {
  const hosts = loadHosts(stateDir, env);
  const ours = readOurs(stateDir);
  const probes = await Promise.all(hosts.map((h) => probeHost(h, { fetchImpl, env })));
  const rows = probes.flatMap((p) => hostReportRows(p, { ours, pinned }));
  const dir = localModelsDir(env);
  const free = freeBytesOf(dir);
  if (isUnavailable(free)) rows.push({ ok: null, text: `model folder ${dir}: free space unavailable (${free.reason})` });
  else rows.push({ ok: free >= 5 * 2 ** 30, text: `model folder ${dir}: ${gb(free)} free`, fix: 'Under 5 GB free: a model download or copy may not fit. Free some space or move the folder (OLLAMA_MODELS).' });
  return { rows, passed: rows.filter((r) => r.ok === true).length, failed: rows.filter((r) => r.ok === false).length };
}

function defaultFreeBytes(dir) {
  try { const s = statfsSync(dir); return measured(s.bavail * s.bsize, 'the system did not report it'); }
  catch { return unavailable('the folder is not there yet'); }
}

/** Doctor rows as the lines `kingmaker doctor` prints: ✓, ✗ with its fix, or · for information. */
export const doctorLines = (rows) => rows.map((r) => (r.ok === null ? `· ${r.text}` : `${r.ok ? '✓' : '✗'} ${r.text}${r.ok || !r.fix ? '' : `\n    → ${r.fix}`}`));

/** "9 of 11 checks pass. 2 need attention (marked ✗, each with its fix)." counted from printed doctor lines. */
export function scorecardLine(lines) {
  const passed = lines.filter((l) => l.startsWith('✓')).length, failed = lines.filter((l) => l.startsWith('✗')).length;
  if (!passed && !failed) return null;
  return failed ? `${passed} of ${passed + failed} checks pass. ${failed} need${failed === 1 ? 's' : ''} attention (marked ✗, each with its fix on the line below it).` : `All ${passed} checks pass.`;
}

async function installedBytes(client, model) {
  try {
    const hit = (await client.tags()).find((m) => (m.name ?? m.model) === model || `${m.name ?? m.model}:latest` === model || (m.name ?? m.model) === `${model}:latest`);
    if (!hit) return unavailable(`${client.host.name} does not have ${model} installed`, `kingmaker models sync ${model} --to ${client.host.name}`);
    return measured(hit.size, 'the host did not report the model\'s size', { allowZero: false });
  } catch (e) { return unavailable(e.message); }
}

/** `kingmaker models <verb> …` for the verbs in MODEL_HOST_VERBS. Returns the exit code. */
export async function cmdModelHosts(paths, verb, args, { env = process.env, fetchImpl = fetch, out = console.log, err = console.error, pinned = [], ask = null } = {}) {
  const stateDir = paths.state;
  const host = (name) => findHost(stateDir, name, env);
  const client = (name, opts = {}) => hostClient(host(name), { fetchImpl, env, ...opts });
  try {
    if (verb === 'hosts') {
      const [sub, name, address] = positional(args, VALUE_FLAGS);
      if (sub === 'add') {
        if (!name || !address) { err('kingmaker models hosts add <name> <address> [--key-env NAME]'); return 1; }
        const saved = saveHost(stateDir, { name, url: address, keyEnv: flag(args, '--key-env') }, env);
        out(`Added ${saved.name} at ${saved.url} (${saved.kind === 'lan' ? 'on your network' : saved.kind === 'local' ? 'this Mac' : 'over the internet'}).${saved.keyEnv ? ` Its key is read from ${saved.keyEnv}; only the name is stored.` : ''}`);
        if (saved.kind === 'remote' && saved.url.startsWith('http://')) out('! It is reached over plain http. A key is not sent to it that way; use https or a tunnel.');
        return 0;
      }
      if (sub === 'remove') {
        if (!name) { err('kingmaker models hosts remove <name>'); return 1; }
        out(removeHost(stateDir, name, env) ? `Removed ${name}. Nothing on that machine was changed.` : `No host named ${name}.`);
        return 0;
      }
      const ours = readOurs(stateDir);
      for (const h of loadHosts(stateDir, env)) out(doctorLines(hostReportRows(await probeHost(h, { fetchImpl, env }), { ours, pinned })).join('\n'));
      return 0;
    }

    if (verb === 'ps') {
      const c = client(flag(args, '--host'));
      const ours = readOurs(stateDir);
      const loaded = await c.ps();
      if (!loaded.length) { out(`Nothing is loaded on ${c.host.name}.`); return 0; }
      for (const m of loaded) {
        const name = m.name ?? m.model;
        const whose = isOurs(ours, c.host.name, name, pinned) ? 'Kingmaker\'s' : 'not loaded by Kingmaker';
        out(`${name}  ${show(measured(m.size, 'not reported', { allowZero: false }), gb)} in memory, ${show(measured(m.size_vram, 'not reported'), gb)} on the GPU, until ${m.expires_at ?? 'unavailable (not reported)'}  (${whose})`);
      }
      return 0;
    }

    if (verb === 'warm') {
      const [model, time] = positional(args, VALUE_FLAGS);
      if (!model) { err('kingmaker models warm <model> [time, like 30m or 24h] [--host <name>] [--evict]'); return 1; }
      const c = client(flag(args, '--host'));
      const keepAlive = parseKeepAlive(time, '30m');
      // The size of the model's file is only the least it can take: loaded, it also holds its working memory.
      // What it really takes is known only once it has been seen loaded on this host (lib/model-residency.mjs).
      const atLeastBytes = await installedBytes(c, model);
      if (isUnavailable(atLeastBytes) && atLeastBytes.fix) { err(`✗ ${atLeastBytes.reason}.\n    → ${atLeastBytes.fix}`); return 1; }
      let evict = args.includes('--evict');
      let r = await warmModel(c, { stateDir, model, keepAlive, atLeastBytes, budgetBytes: memoryBudgetBytes(c.host, { env }), evict, pinned, log: out });
      if (!r.loaded && r.plan.impossible) { err(`✗ ${r.plan.why}`); return 1; }
      if (!r.loaded && r.plan.action === 'ask') {
        out(r.plan.why);
        for (const o of r.plan.wouldUnload) out(`  would unload: ${o.name}${o.ours ? ' (Kingmaker\'s)' : ' (not loaded by Kingmaker)'}`);
        const yes = ask ? await ask('Unload and load it? [y/N] ') : false;
        if (!yes) { out(`Nothing was changed. To go ahead: kingmaker models warm ${model}${time ? ` ${time}` : ''} --evict${flag(args, '--host') ? ` --host ${flag(args, '--host')}` : ''}`); return 2; }
        evict = true;
        r = await warmModel(c, { stateDir, model, keepAlive, atLeastBytes, budgetBytes: memoryBudgetBytes(c.host, { env }), evict, pinned, log: out });
      }
      if (r.pushedOut?.length) out(`! The host unloaded ${r.pushedOut.join(', ')} by itself to make room.`);
      out(`${model} is loaded on ${c.host.name}, held ${keepAlive === -1 ? 'until you stop it' : `for ${keepAlive}`}.${r.unloaded.length ? ` Unloaded to make room: ${r.unloaded.join(', ')}.` : ''}`);
      return 0;
    }

    if (verb === 'stop') {
      const [target] = positional(args, VALUE_FLAGS);
      if (!target) { err('kingmaker models stop <model|all> [--host <name>] [--everyone]'); return 1; }
      const c = client(flag(args, '--host'));
      const r = await stopModels(c, { stateDir, target, everyone: args.includes('--everyone'), pinned });
      out(r.unloaded.length ? `Unloaded on ${c.host.name}: ${r.unloaded.join(', ')}.` : `Nothing was unloaded on ${c.host.name}.`);
      for (const l of r.left) out(`  left loaded: ${l.name} (${l.why})`);
      return 0;
    }

    if (verb === 'sync') {
      const toName = flag(args, '--to');
      if (!toName) { err('kingmaker models sync <model|--all> --to <host> [--from <host>] [--force] [--dry-run]'); return 1; }
      const from = client(flag(args, '--from')), to = client(toName, { timeoutMs: 15000 });
      if (from.host.url === to.host.url) { err('✗ The source and the destination are the same host.'); return 1; }
      const [one] = positional(args, VALUE_FLAGS);
      const [fromTags, toTags] = await Promise.all([from.tags(), to.tags()]);
      // No model named and no --all is a mistake to report, never "every model": that could move a great deal of data.
      if (!one && !args.includes('--all')) { err('Name a model, or pass --all to copy every model the source has.'); return 1; }
      const plan = planSync({ fromTags, toTags, models: args.includes('--all') ? null : [one] });
      if (!plan.length) { err(`${from.host.name} has no models to copy.`); return 1; }
      const words = { same: 'already the same', missing: 'not on the destination', different: 'a different build is on the destination', 'not-on-source': 'not on the source' };
      for (const row of plan) out(`${row.model}: ${words[row.state]}`);
      if (args.includes('--dry-run')) return 0;
      let failed = 0;
      for (const row of plan) {
        if (row.state === 'not-on-source') { failed += 1; continue; }
        if (row.state === 'same' && !args.includes('--force')) continue;
        out(`Copying ${row.model} from ${from.host.name} to ${to.host.name}`);
        try {
          const r = await syncModel({ model: row.model, from, to, modelsDir: localModelsDir(env), force: args.includes('--force'), log: out });
          const proven = r.how === 'exact-copy' ? r.verified.everyFileOnDestination === true && r.verified.listed : r.verified.sameListingDigest === true;
          out(`${proven ? '✓' : '✗'} ${row.model}: ${r.note}`);
          if (!proven) failed += 1;
        } catch (e) { failed += 1; err(`✗ ${row.model}: ${e.message}`); }
      }
      return failed ? 1 : 0;
    }

    if (verb === 'speed') {
      const [model] = positional(args, VALUE_FLAGS);
      if (!model) { err('kingmaker models speed <model> [--host <name>] [--runs N] [--warmup] [--predict N] [--json]'); return 1; }
      const c = client(flag(args, '--host'));
      const json = args.includes('--json');
      const result = await measureSpeed(c, {
        model, runs: flag(args, '--runs') ? Number(flag(args, '--runs')) : 3, warmup: args.includes('--warmup'),
        numPredict: flag(args, '--predict') ? Number(flag(args, '--predict')) : 200, context: flag(args, '--context') ? Number(flag(args, '--context')) : null,
        log: json ? () => {} : (l) => out(`  ${l}`),
      });
      out(json ? JSON.stringify(speedAsJson(result), null, 2) : speedLines(result).join('\n'));
      return 0;
    }
  } catch (e) {
    err(`✗ ${e.message}`);
    return 1;
  }
  err(`Unknown: kingmaker models ${verb}`);
  return 1;
}
