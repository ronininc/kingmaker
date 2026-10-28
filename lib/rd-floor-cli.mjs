// `kingmaker rd`: the R&D floor from the terminal (lib/rd-floor.mjs).
//   kingmaker rd                         the five modules
//   kingmaker rd map | audit | doctor
//   kingmaker rd route <absolute-path>
//   kingmaker rd run <module> <command> [--provider ghidra|kuna] [--timeout seconds] [path…] [extra…]
import { execFileSync } from 'node:child_process';
import { auditText, commandRecord, findReaBinary, mapText, REA_PIN, readReaVersion, routeTarget, runAnalysis, versionAdmitted } from './rd-floor.mjs';

const USAGE = `usage:
  kingmaker rd                         module map
  kingmaker rd map | audit | doctor    map, the licence audit, or whether rea ${REA_PIN.version} is on PATH
  kingmaker rd route <absolute-path>
  kingmaker rd run <module> <command> [--provider ghidra|kuna] [--timeout seconds] <absolute-path>… [extra…]
Paths come first, then a search string or an address when the command needs one. Kingmaker does not download REA.`;

/** Pure: flags and words for `rd run`, after the module and command. Paths are the leading words, up to the command's path count; the rest are extras. */
export function parseRunTail(args, record) {
  const positionals = [];
  let provider = null;
  let timeoutMs = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--') continue;
    if (arg === '--provider') {
      const value = args[i + 1];
      if (value == null || String(value).startsWith('--')) return { error: '--provider needs ghidra or kuna.' };
      provider = String(value);
      i += 1;
      continue;
    }
    if (arg === '--timeout') {
      const value = args[i + 1];
      if (value == null || !/^\d+$/.test(String(value))) return { error: '--timeout needs a number of seconds.' };
      timeoutMs = Number(value) * 1000;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `${arg} isn't an rd option. The floor adds --json itself.` };
    positionals.push(arg);
  }
  const maxT = record?.targets?.[1] ?? positionals.length;
  const n = Math.min(maxT, positionals.length);
  return { provider, timeoutMs, targets: positionals.slice(0, n), extras: positionals.slice(n) };
}

export async function cmdRd(args, deps = {}) {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const [verb = 'map', ...rest] = args;
  const json = rest.includes('--json');
  const plain = rest.filter((arg) => arg !== '--json');
  if (verb === 'map') {
    out(json ? JSON.stringify({ text: mapText() }) : mapText());
    return 0;
  }
  if (verb === 'audit') {
    out(json ? JSON.stringify({ text: auditText(), pin: REA_PIN }) : auditText());
    return 0;
  }
  if (verb === 'route') {
    const route = routeTarget(plain[0]);
    if (!route.ok) { err(`✗ ${route.reason}\n${USAGE}`); return 2; }
    if (json) out(JSON.stringify(route));
    else if (!route.command) { err(route.reason); return 2; }
    else out(`${route.module} ${route.command}${route.dispatch ? '' : ` — not run from here. ${route.reason}`}`);
    return route.command ? 0 : 2;
  }
  if (verb === 'doctor') {
    const bin = (deps.findRea ?? findReaBinary)({ env: deps.env ?? process.env, exists: deps.exists });
    const version = bin ? (deps.versionOf ? await deps.versionOf(bin) : readReaVersion(bin, deps.execFileSync ?? execFileSync)) : '';
    const admitted = Boolean(bin) && versionAdmitted(version);
    const report = { ok: admitted, bin, version: version || null, pin: REA_PIN.version };
    if (json) out(JSON.stringify(report));
    else if (admitted) out(`rea ${version} at ${bin}. Pin ${REA_PIN.version} matches. Paid providers stay off.`);
    else out(bin ? `rea at ${bin} reports "${version || 'no version'}". This floor audited ${REA_PIN.version} only.` : `rea ${REA_PIN.version} is not on PATH. Kingmaker will not download it. Install that version yourself, or set KINGMAKER_REA.`);
    return admitted ? 0 : 1;
  }
  if (verb === 'run') {
    const [module, command, ...tail] = plain;
    if (!module || !command) { err(USAGE); return 2; }
    const parsed = parseRunTail(tail, commandRecord(module, command));
    if (parsed.error) { err(`✗ ${parsed.error}\n${USAGE}`); return 2; }
    const result = await (deps.run ?? runAnalysis)({
      module, command, targets: parsed.targets, extras: parsed.extras, provider: parsed.provider, timeoutMs: parsed.timeoutMs ?? undefined,
    }, deps);
    if (json) out(JSON.stringify(result));
    else if (!result.ok && result.reason) err(`✗ ${result.reason}`);
    else {
      if (result.stdout) out(String(result.stdout).trimEnd());
      if (result.stderr) err(String(result.stderr).trimEnd());
      if (result.truncated) err('Output was cut: the floor keeps the first part of a long analysis.');
    }
    if (result.ok) return 0;
    if (['usage', 'bad-target', 'refused', 'quarantine', 'held'].includes(result.code)) return 2;
    return 1;
  }
  err(USAGE);
  return 2;
}
