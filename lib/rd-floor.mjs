// lib/rd-floor.mjs — the R&D floor: Kingmaker's analysis engine over REA (morluto/rea).
//
// What was already here (left as it is): lib/rea.mjs, the connector check that reads code for unprompted access,
// and the clone skill's reverse-engineer-anything text, which teaches the method and does not run an engine.
// This module is the missing piece: five modules an operator can run, and a licence gate in front of them.
//
// The gate ran before anything was imported (order 1b72e5c0). REA itself is MIT. Its runtime graph is not all
// MIT/Apache/BSD: openpgp is LGPL-3.0+ and optional frida is LGPL-2.0. Those stay out of this repository.
// Kingmaker never fetches the package (no npx, no npm install). An operator who already has the audited
// version may run it as a separate process. Paid providers are refused. GPL/LGPL engines are quarantined.
// AGPL is refused. The floor only reads: it does not drive a browser, attach to a process, or write a tree.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const REA_PIN = Object.freeze({
  repo: 'https://github.com/morluto/rea',
  commit: '40b9c03f996270e944ff07cafb63be15ce903708',
  committed: '2026-10-28',
  version: '6.8.0',
  package: 'rea-agents',
  license: 'MIT',
});

/** SPDX names Kingmaker may take into its own tree (pack.json: MIT, Apache-2.0, BSD, MPL, OFL, plus the other permissive grants REA's lockfile actually uses). */
const ALLOW = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'MPL-2.0', 'OFL-1.1', 'BlueOak-1.0.0', 'Zlib', 'WTFPL', 'Python-2.0']);

const FREE_PROVIDERS = Object.freeze(['ghidra', 'kuna']);
const REFUSED_PROVIDERS = new Set(['hopper', 'ida', 'jeb', 'hex-rays']);

/** Path segments the floor will not hand to an external engine. */
const CREDENTIAL_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', 'Keychains', '.solomon-secure', '.git-credentials', '.npmrc', '.pypirc', '.vault-token']);

const SAFE_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'JAVA_HOME']);
/** Free-engine settings only. REA_ANALYSIS_PROVIDER is never copied: it can name Hopper. */
const REA_ENV = new Set([
  'REA_GHIDRA_STARTUP_TIMEOUT_MS', 'REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS', 'REA_GHIDRA_PROJECT_PATH',
  'REA_GHIDRA_PROGRAM_NAME', 'REA_GHIDRA_LANGUAGE_ID', 'REA_GHIDRA_COMPILER_SPEC_ID', 'REA_GHIDRA_SEED_FILE',
  'REA_GHIDRA_DISABLED_ANALYZERS', 'REA_JADX_MCP_JAR', 'REA_JADX_HEAP_MIB', 'REA_KUNA_COMMAND', 'REA_KUNA_CACHE_DIR',
  'REA_WABT_BIN_DIRECTORY',
]);

const HOLD_LIVE = 'The floor only reads. It does not drive a browser, attach to a process, or write a tree.';

/**
 * Pure: what one SPDX expression may do in Kingmaker.
 * allow — MIT/Apache/BSD or another permissive grant on the pack list (an OR keeps the permissive choice).
 * quarantine — copyleft that is not AGPL (GPL, LGPL), or a licence we will not guess. Not imported.
 * refuse — AGPL, a proprietary/commercial grant, or no licence at all. Never imported. AGPL is never a client-work import.
 */
export function classifyLicense(expression) {
  const text = unwrap(String(expression ?? '').trim());
  if (!text || /^(none|unlicensed)$/i.test(text)) return 'refuse';
  const ors = splitTop(text, 'OR').map((part) => {
    const ands = splitTop(part, 'AND').map(atomDecision);
    if (ands.includes('refuse')) return 'refuse';
    if (ands.includes('quarantine')) return 'quarantine';
    return 'allow';
  });
  if (ors.includes('allow')) return 'allow';
  if (ors.includes('quarantine')) return 'quarantine';
  return 'refuse';
}

function unwrap(value) {
  let text = value.trim();
  for (;;) {
    if (!text.startsWith('(') || !text.endsWith(')')) return text;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      if (depth === 0 && i < text.length - 1) { wraps = false; break; }
    }
    if (!wraps || depth !== 0) return text;
    text = text.slice(1, -1).trim();
  }
}

function atomDecision(raw) {
  const base = String(raw).replace(/^\(+|\)+$/g, '').trim().split(/\s+WITH\s+/i)[0].trim();
  if (!base) return 'refuse';
  if (ALLOW.has(base)) return 'allow';
  if (/public[ -]domain/i.test(base)) return 'allow';
  if (/^AGPL/i.test(base) || /affero/i.test(base)) return 'refuse';
  if (/proprietary|commercial|BUSL|SSPL|Commons-Clause/i.test(base)) return 'refuse';
  if (/GPL|LGPL/i.test(base)) return 'quarantine';
  return 'quarantine';
}

function splitTop(input, op) {
  const parts = [];
  let depth = 0;
  let buf = '';
  const word = op;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    const ahead = input.slice(i);
    if (depth === 0 && (i === 0 || /\s/.test(input[i - 1])) && ahead.startsWith(word) && (ahead.length === word.length || /\s/.test(ahead[word.length]))) {
      parts.push(buf.trim());
      buf = '';
      i += word.length - 1;
      continue;
    }
    buf += c;
  }
  parts.push(buf.trim());
  return parts.filter(Boolean);
}

/** npm runtime inventory at the pin: 180 locked runtime packages. Development packages are not in the published tarball and are not imported. */
export const NPM_RUNTIME = Object.freeze({
  inventory: 'licenses/npm-dependencies.txt',
  runtimePackages: 180,
  allow: 178,
  quarantine: Object.freeze([
    Object.freeze({ name: 'openpgp@6.3.2', license: 'LGPL-3.0+', why: 'Required dependency. src/process/DetachedPgpSignature.ts imports it to check a detached signature. LGPL-3.0+ is not on Kingmaker\'s import list.' }),
    Object.freeze({ name: 'frida@17.23.2', license: 'LGPL-2.0 WITH WxWindows-exception-3.1', why: 'Optional dependency for live instrumentation. The WxWindows exception does not turn it into MIT, Apache, or BSD.' }),
  ]),
});

/**
 * Every repository and engine the pin pulls in, decided before import. `imported` is false on every row:
 * nothing in this list was copied into Kingmaker. `decision` is the import decision from classifyLicense.
 */
export const AUDIT = Object.freeze([
  row('rea', 'REA (morluto/rea)', REA_PIN.repo, REA_PIN.commit, 'MIT', 'allow', 'The toolkit\'s own licence. Not imported: the published package\'s runtime graph contains the two quarantined npm packages below, so the tree stays out of this repository.'),
  row('openpgp', 'openpgp', 'https://github.com/openpgpjs/openpgp', '6.3.2', 'LGPL-3.0+', 'quarantine', NPM_RUNTIME.quarantine[0].why),
  row('frida', 'Frida', 'https://github.com/frida/frida', '17.23.2', 'LGPL-2.0 WITH WxWindows-exception-3.1', 'quarantine', NPM_RUNTIME.quarantine[1].why),
  row('jadx-headless-mcp', 'jadx-headless-mcp', 'https://github.com/1013503897/jadx-headless-mcp', '5844800a486d2248fa949b74c9896285f5b54de2', 'Apache-2.0', 'allow', 'Submodule pin. Not checked out and not imported. Android inspection uses a JAR the operator already has (REA_JADX_MCP_JAR).'),
  row('jadx', 'JADX', 'https://github.com/skylot/jadx', 'v1.5.6', 'Apache-2.0', 'allow', 'Bring-your-own Android decompiler. Not bundled.'),
  row('apktool', 'Apktool', 'https://github.com/iBotPeaches/Apktool', 'master', 'Apache-2.0', 'allow', 'Bring-your-own resource decoder. The floor does not run it: decoding writes a tree.'),
  row('binwalk', 'Binwalk', 'https://github.com/ReFirmLabs/binwalk', '4fdab3d464d97b68e0af9088df3f9e2e1545b21c', 'MIT', 'allow', 'Submodule pin v3.1.0. Not checked out and not imported. Firmware region inspection can use an operator-supplied binary.'),
  row('unblob', 'Unblob', 'https://github.com/onekey-sec/unblob', '1fcc7a0a584a70a96c31f5a276c20944d199a089', 'MIT', 'allow', 'Submodule pin 26.6.4. Not checked out and not imported. Same firmware path as Binwalk.'),
  row('ghidra-nativeaot', 'ghidra-nativeaot', 'https://github.com/Washi1337/ghidra-nativeaot', 'effeb734fc570c32650f88b159608979dc7b423e', 'MIT', 'allow', 'Submodule pin. Not checked out and not imported. REA ships its own derived parser and the MIT notices.'),
  row('wakaru', 'Wakaru', 'https://github.com/pionxzh/wakaru', '8219bf5016a063d7fb215101a8c45d5959ec733f', 'Apache-2.0', 'allow', 'Submodule pin v1.14.0. Not checked out and not imported. JavaScript recovery stays a separate operator tool.'),
  row('wabt', 'WABT', 'https://github.com/WebAssembly/wabt', 'ff0ef7e0009402740c805a9744c09b05be063e48', 'Apache-2.0', 'allow', 'v1.0.42, bring-your-own via REA_WABT_BIN_DIRECTORY. Not bundled.'),
  row('evmole', 'evmole', 'https://github.com/cdump/evmole', '0.9.3', 'MIT', 'allow', 'npm runtime dependency for EVM interface inference. Not copied here; it rides inside the operator\'s rea process.'),
  row('ghidra', 'Ghidra', 'https://github.com/NationalSecurityAgency/ghidra', '12.1.4', 'Apache-2.0', 'allow', 'Bring-your-own native engine. Not bundled. Standalone programs under Ghidra\'s GPL/ directory are not imported and are not dispatched.'),
  row('kuna', 'Kuna', 'https://github.com/Noelo-Lab/kuna', 'v1.833', 'Apache-2.0', 'allow', 'Bring-your-own native engine. REA does not download it. Free alternative to Ghidra on the binary module.'),
  row('ilspy', 'ILSpy', 'https://github.com/icsharpcode/ILSpy', 'master', 'MIT', 'allow', 'Optional .NET decompiler, not a REA dependency and not bundled. Managed inspection dispatched here is REA\'s own reader.'),
  row('mitmproxy', 'mitmproxy', 'https://github.com/mitmproxy/mitmproxy', '6c09d56e4c29a92f5ad01b03199977584b8ea14f', 'MIT', 'allow', 'v12.2.3, bring-your-own, for saved capture decoding. The floor does not start a proxy.'),
  row('adb', 'Android Debug Bridge', 'https://android.googlesource.com/platform/packages/modules/adb', 'main', 'Apache-2.0', 'allow', 'Source licence Apache-2.0. A full SDK download has its own terms. The floor does not drive a device.'),
  row('pwntools', 'pwntools', 'https://github.com/Gallopsled/pwntools', '3ad86ec5adab1abf9781ca7552a6f5d7cff7a33c', 'MIT', 'allow', '4.15.0 is MIT. The ELF profile also loads Unicorn, which is GPL, so that profile is not dispatched.'),
  row('pyelftools', 'pyelftools', 'https://github.com/eliben/pyelftools', 'v0.33', 'Public-domain', 'allow', 'Public-domain dedication. Used by the pwntools ELF profile, which the floor does not dispatch.'),
  row('pwndbg', 'pwndbg', 'https://github.com/pwndbg/pwndbg', '55596aa676a2756efb8d67034f31675170eabe48', 'MIT', 'allow', 'MIT debugger extension. It runs on GNU GDB, which is GPL-3.0, so the floor does not dispatch that workflow.'),
  row('unicorn', 'Unicorn', 'https://github.com/unicorn-engine/unicorn', '2.1.2', 'GPL-2.0', 'quarantine', 'Instruction emulation inside the caller-supplied ELF profile. Not imported. Not dispatched.'),
  row('gdb', 'GNU GDB', 'https://sourceware.org/gdb/', 'caller', 'GPL-3.0-or-later', 'quarantine', 'Debugger for the pwndbg core-file workflow. Not imported. Not dispatched.'),
  row('rizin', 'Rizin', 'https://github.com/rizinorg/rizin', 'caller', 'LGPL-3.0', 'quarantine', 'Disassembler REA can shell out to. Not imported. Not dispatched.'),
  row('cutter', 'Cutter', 'https://github.com/rizinorg/cutter', 'caller', 'GPL-3.0', 'quarantine', 'Rizin GUI. Not imported. Not dispatched.'),
  row('objdump', 'GNU objdump (binutils)', 'https://sourceware.org/binutils/', 'caller', 'GPL-3.0-or-later', 'quarantine', 'Not imported. Not dispatched.'),
  row('tshark', 'Wireshark tshark and capinfos', 'https://www.wireshark.org/', '4.x', 'GPL-2.0', 'quarantine', 'Packet captures need tshark. Not imported. The network module reads HAR, SAZ and qlog instead.'),
  row('sigrok', 'sigrok-cli', 'https://sigrok.org/', '0.7.2', 'GPL-3.0', 'quarantine', 'Logic-trace decoding. Not imported. Not dispatched.'),
  row('openjdk', 'OpenJDK', 'https://openjdk.org/', 'caller', 'GPL-2.0-only WITH Classpath-exception-2.0', 'quarantine', 'Not imported. A JDK the operator already installed is what Ghidra and JADX run on. Kingmaker does not ship Java.'),
  row('hopper', 'Hopper Disassembler', 'https://www.hopperapp.com/', 'commercial', 'proprietary', 'refuse', 'Paid proprietary disassembler. Free tier of this floor does not install it, trial it, or pass --provider hopper.'),
  row('ida', 'IDA Pro and Hex-Rays', 'https://hex-rays.com/', 'commercial', 'proprietary', 'refuse', 'Paid proprietary decompiler. ida-pro-mcp is MIT and is not imported either: it is useless without IDA, which this floor refuses.'),
  row('jeb', 'JEB', 'https://www.pnfsoftware.com/jeb/', 'commercial', 'proprietary', 'refuse', 'Paid proprietary decompiler. Not dispatched.'),
]);

function row(id, name, from, pin, license, decision, why) {
  const got = classifyLicense(license);
  if (got !== decision) throw new Error(`audit row ${id} declared ${decision} but ${license} classifies as ${got}`);
  return Object.freeze({ id, name, from, pin, license, decision, imported: false, why });
}

const c = (name, extra = {}) => Object.freeze({
  name,
  dispatch: true,
  targets: [1, 1],
  extras: [0, 0],
  provider: null,
  timeoutMs: 120_000,
  ...extra,
});
const held = (name, why = HOLD_LIVE) => Object.freeze({ name, dispatch: false, hold: why, licenseDecision: 'allow' });
const quarantined = (name, engineId) => Object.freeze({
  name,
  dispatch: false,
  licenseDecision: 'quarantine',
  engineId,
  why: AUDIT.find((r) => r.id === engineId)?.why ?? 'Quarantined engine.',
});

/** The five modules. A command with dispatch:true is the only kind `run` will start. */
export const MODULES = Object.freeze([
  Object.freeze({
    id: 'analysis-core',
    name: 'Analysis Core',
    does: 'See which engines are present, inventory an archive, and read an evidence bundle. No decompiler.',
    commands: Object.freeze([
      c('doctor', { targets: [0, 0], provider: 'optional' }),
      c('capabilities', { targets: [0, 0] }),
      c('providers', { targets: [0, 0] }),
      c('inspect-artifact'),
      c('inspect-analysis-view'),
      c('inspect-evidence-bundle'),
      c('inspect-sqlite-database'),
    ]),
  }),
  Object.freeze({
    id: 'mobile-apps',
    name: 'Mobile & Apps',
    does: 'Static reads of JavaScript and Electron trees, Android packages, Apple graphs, and desktop bundles.',
    commands: Object.freeze([
      c('analyze-javascript-application'),
      c('inspect-electron-fuses'),
      c('list-electron-targets', { targets: [0, 0] }),
      c('inspect-android-package'),
      c('inspect-apk-signature'),
      c('identify-flutter-build'),
      c('inspect-dart-aot'),
      c('project-android-application-graph'),
      c('project-apple-application-graph'),
      c('project-harmony-application-graph'),
      c('inspect-desktop-application'),
      c('inspect-macho'),
      c('inspect-plist'),
      held('decode-android-resources', 'Apktool is Apache-2.0, admitted, and not run here: decoding writes a resource tree.'),
      held('list-adb-devices', 'adb\'s source is Apache-2.0. The floor does not drive a device.'),
    ]),
  }),
  Object.freeze({
    id: 'binary-low-level',
    name: 'Binary & Low-Level',
    does: 'Native code through Ghidra or Kuna only, plus the built-in readers (Go, Rust, PE, managed, WASM, firmware, EVM).',
    commands: Object.freeze([
      c('analyze', { provider: 'required', extras: [0, 2], timeoutMs: 300_000 }),
      c('decompile', { provider: 'required', extras: [0, 2], timeoutMs: 300_000 }),
      c('function', { provider: 'required', extras: [0, 2], timeoutMs: 300_000 }),
      c('search', { provider: 'required', extras: [1, 2], timeoutMs: 300_000 }),
      c('xrefs', { provider: 'required', extras: [1, 2], timeoutMs: 300_000 }),
      c('instructions', { provider: 'required', extras: [0, 2], timeoutMs: 300_000 }),
      c('inspect-go-binary'),
      c('inspect-rust-binary'),
      c('inspect-pe-resources'),
      c('inspect-pe-imports'),
      c('inspect-pe-certificates'),
      c('inspect-pe-load-config'),
      c('inspect-managed-artifact'),
      c('inspect-managed-members'),
      c('inspect-wasm-artifact'),
      c('inspect-firmware-regions'),
      c('inspect-evm-interface'),
      c('inspect-python-pyc'),
      c('inspect-erlang-beam'),
      quarantined('inspect-binary-layout', 'unicorn'),
      quarantined('inspect-recorded-crash', 'gdb'),
      quarantined('debug-with-gdb', 'gdb'),
      quarantined('debug-with-rizin', 'rizin'),
      quarantined('execute-rizin-command', 'rizin'),
      quarantined('cutter-command', 'cutter'),
      quarantined('inspect-with-objdump', 'objdump'),
      quarantined('instrument-with-frida', 'frida'),
      held('extract-firmware', 'Binwalk and Unblob are MIT and admitted. Extraction writes a directory, so the floor does not run it.'),
    ]),
  }),
  Object.freeze({
    id: 'network-runtime',
    name: 'Network & Runtime',
    does: 'Read a saved web capture (HAR, SAZ, qlog) and list browser or Electron targets. No live attach.',
    commands: Object.freeze([
      c('inspect-web-network-capture'),
      c('list-browser-targets', { targets: [0, 0] }),
      c('list-javascript-runtime-targets', { targets: [0, 0] }),
      quarantined('inspect-pcap-capture', 'tshark'),
      quarantined('inspect-packet-capture', 'tshark'),
      quarantined('inspect-packet-fields', 'tshark'),
      quarantined('decode-signal-recording', 'sigrok'),
      held('capture-browser-scenario'),
      held('observe-web-session'),
      held('capture-process'),
    ]),
  }),
  Object.freeze({
    id: 'rebuild-verify',
    name: 'Rebuild & Verify',
    does: 'Compare evidence and score a reconstruction. The clone skill still does the edit; this module checks the claim.',
    commands: Object.freeze([
      c('compare', { targets: [2, 2] }),
      c('compare-application-versions', { targets: [2, 2] }),
      c('compare-source-to-bundle', { targets: [2, 2] }),
      c('compare-javascript-export-shapes', { targets: [2, 2] }),
      c('build-reconstruction-obligation-ledger'),
      c('evaluate-reconstruction-coverage'),
      c('compare-managed-members', { targets: [2, 2] }),
      held('evidence-export', 'Export writes a file. The floor only reads an evidence bundle (Analysis Core: inspect-evidence-bundle).'),
    ]),
  }),
]);

const COMMANDS = new Map();
for (const mod of MODULES) {
  for (const command of mod.commands) {
    if (COMMANDS.has(command.name) && command.dispatch) throw new Error(`duplicate dispatched command ${command.name}`);
    if (!COMMANDS.has(command.name)) COMMANDS.set(command.name, { ...command, module: mod.id });
  }
}

export function moduleById(id) {
  return MODULES.find((m) => m.id === id) ?? null;
}

export function commandRecord(moduleId, name) {
  const mod = moduleById(moduleId);
  return mod?.commands.find((command) => command.name === name) ?? null;
}

/** Pure: which module and command a path belongs to, from its suffix. A quarantined command is still named, so the operator sees why it will not run. */
export function routeTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'A path is required.' };
  const base = raw.split('/').pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  const table = {
    '.apk': ['mobile-apps', 'inspect-android-package'],
    '.aab': ['mobile-apps', 'inspect-android-package'],
    '.ipa': ['mobile-apps', 'inspect-artifact'],
    '.asar': ['mobile-apps', 'analyze-javascript-application'],
    '.har': ['network-runtime', 'inspect-web-network-capture'],
    '.saz': ['network-runtime', 'inspect-web-network-capture'],
    '.qlog': ['network-runtime', 'inspect-web-network-capture'],
    '.pcap': ['network-runtime', 'inspect-pcap-capture'],
    '.pcapng': ['network-runtime', 'inspect-pcap-capture'],
    '.cap': ['network-runtime', 'inspect-pcap-capture'],
    '.wasm': ['binary-low-level', 'inspect-wasm-artifact'],
    '.wat': ['binary-low-level', 'inspect-wasm-artifact'],
    '.dll': ['binary-low-level', 'inspect-managed-artifact'],
    '.exe': ['binary-low-level', 'analyze'],
    '.so': ['binary-low-level', 'analyze'],
    '.dylib': ['binary-low-level', 'analyze'],
    '.elf': ['binary-low-level', 'analyze'],
    '.pyc': ['binary-low-level', 'inspect-python-pyc'],
    '.beam': ['binary-low-level', 'inspect-erlang-beam'],
    '.sqlite': ['analysis-core', 'inspect-sqlite-database'],
    '.db': ['analysis-core', 'inspect-sqlite-database'],
    '.macho': ['mobile-apps', 'inspect-macho'],
    '.plist': ['mobile-apps', 'inspect-plist'],
    '.app': ['mobile-apps', 'inspect-desktop-application'],
  };
  if (base === 'package.json' || ext === '.js' || ext === '.mjs' || ext === '.cjs') return routed('mobile-apps', 'analyze-javascript-application');
  const hit = table[ext];
  if (!hit) return { ok: true, module: 'analysis-core', command: null, reason: 'No suffix maps this file. kingmaker rd map lists the five modules.' };
  return routed(hit[0], hit[1]);
}

function routed(module, command) {
  const record = commandRecord(module, command);
  return {
    ok: true,
    module,
    command,
    dispatch: record?.dispatch === true,
    reason: record?.dispatch ? null : (record?.why || record?.hold || null),
  };
}

/** Pure: the environment a rea child may see. Kingmaker's keys stay here. Hopper is not selected by an inherited variable. */
export function floorEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null || value === '') continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|CREDENTIAL/i.test(key)) continue;
    if (key === 'REA_ANALYSIS_PROVIDER' || key.startsWith('REA_HOPPER') || key.startsWith('REA_IDA') || key.startsWith('REA_JEB')) continue;
    if (SAFE_ENV.has(key) || REA_ENV.has(key) || /^LC_[A-Z]+$/.test(key)) out[key] = String(value);
  }
  return out;
}

function safeTarget(value, exists) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096) return { ok: false, reason: 'A target path is empty or not usable.' };
  if (value.trim().startsWith('-')) return { ok: false, reason: 'A target cannot be a flag.' };
  if (!isAbsolute(value)) return { ok: false, reason: 'Use an absolute path.' };
  const abs = resolve(value);
  if (abs.split(sep).some((part) => CREDENTIAL_SEGMENTS.has(part))) return { ok: false, reason: 'The floor does not read credential stores.' };
  if (!exists(abs)) return { ok: false, reason: `Not found: ${abs}` };
  return { ok: true, path: abs };
}

function safeExtra(value) {
  const text = String(value ?? '');
  if (!text || text.length > 500 || /[\0\n\r]/.test(text) || text.startsWith('-')) return null;
  return text;
}

/**
 * Pure: the argv the floor would run, or a refusal. Does not look at PATH and does not spawn.
 * `exists` defaults to the real filesystem so a missing target fails closed.
 */
export function planRun(request = {}, { exists = existsSync, env = process.env } = {}) {
  const moduleId = String(request.module ?? '').trim();
  const name = String(request.command ?? '').trim();
  const mod = moduleById(moduleId);
  if (!mod) return fail('usage', `Unknown module "${moduleId}". kingmaker rd map lists them.`);
  const record = commandRecord(moduleId, name);
  if (!record) return fail('usage', `"${name}" is not a ${mod.name} command.`);
  if (/hopper|hex-rays|\bjeb\b|\bida\b/i.test(name)) return fail('refused', 'Paid providers are not on this floor.');
  if (!record.dispatch) {
    if (record.licenseDecision === 'quarantine') return fail('quarantine', record.why, { module: moduleId, command: name });
    return fail('held', record.hold, { module: moduleId, command: name });
  }
  const asked = request.provider == null || request.provider === '' ? null : String(request.provider).trim().toLowerCase();
  if (asked && REFUSED_PROVIDERS.has(asked)) return fail('refused', `${asked} is a paid provider. This floor runs Ghidra or Kuna.`);
  if (asked && !FREE_PROVIDERS.includes(asked)) return fail('usage', `Provider must be ghidra or kuna.`);
  if (record.provider == null && asked) return fail('usage', `${name} does not take a provider.`);
  const provider = record.provider === 'required' ? (asked || 'ghidra') : (record.provider === 'optional' ? asked : null);
  const [minT, maxT] = record.targets;
  const targets = Array.isArray(request.targets) ? request.targets : (request.target ? [request.target] : []);
  if (targets.length < minT || targets.length > maxT) return fail('usage', minT === 0 ? `${name} does not take a path.` : `${name} takes ${minT === maxT ? minT : `${minT} to ${maxT}`} path${maxT === 1 ? '' : 's'}.`);
  const paths = [];
  for (const target of targets) {
    const checked = safeTarget(target, exists);
    if (!checked.ok) return fail('bad-target', checked.reason, { module: moduleId, command: name });
    paths.push(checked.path);
  }
  const [minE, maxE] = record.extras;
  const extrasIn = Array.isArray(request.extras) ? request.extras : [];
  if (extrasIn.length < minE || extrasIn.length > maxE) return fail('usage', `${name} takes ${minE === maxE ? minE : `${minE} to ${maxE}`} extra argument${maxE === 1 ? '' : 's'}.`);
  const extras = [];
  for (const extra of extrasIn) {
    const text = safeExtra(extra);
    if (text == null) return fail('usage', 'An extra argument cannot be a flag or a blank.');
    extras.push(text);
  }
  const timeoutMs = Math.min(600_000, Math.max(1_000, Number(request.timeoutMs) || record.timeoutMs));
  const argv = [name, ...paths, ...extras];
  if (provider) argv.push('--provider', provider);
  argv.push('--json');
  return {
    ok: true,
    code: 'planned',
    module: moduleId,
    command: name,
    provider,
    argv,
    env: floorEnv(env),
    timeoutMs,
    pin: REA_PIN.version,
  };
}

function fail(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

/** Where an operator-installed rea binary is. Never npx, never a download. */
function isExecutableFile(path) {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

export function findReaBinary({ env = process.env, exists = isExecutableFile } = {}) {
  const pinned = String(env.KINGMAKER_REA ?? '').trim();
  const candidates = [];
  if (pinned) candidates.push(pinned);
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (!dir) continue;
    candidates.push(join(dir, 'rea'), join(dir, 'rea-agents'));
  }
  for (const candidate of candidates) {
    if (!candidate || /(?:^|\/)npx$/.test(candidate)) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The audited release is 6.8.0 and no other. A different build has not been through this gate. */
export function versionAdmitted(text) {
  return /(?:^|[\s])v?6\.8\.0(?:[\s]|$)/.test(String(text ?? ''));
}

export function readReaVersion(bin, execFileSync) {
  try {
    return String(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, env: floorEnv(process.env) })).trim();
  } catch (error) {
    return String(error?.stdout ?? '').trim();
  }
}

export function spawnRea(bin, argv, { env, timeoutMs, cwd = '/tmp' } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(bin, argv, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ code: -1, stdout: '', stderr: String(error?.message ?? error), truncated: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const take = (buf, chunk, cap) => {
      if (buf.length >= cap) { truncated = true; return buf; }
      const next = buf + chunk;
      if (next.length <= cap) return next;
      truncated = true;
      return next.slice(0, cap);
    };
    child.stdout?.on('data', (chunk) => { stdout = take(stdout, String(chunk), 1_500_000); });
    child.stderr?.on('data', (chunk) => { stderr = take(stderr, String(chunk), 200_000); });
    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: stderr || String(error.message), truncated }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr, truncated }); });
  });
}

/**
 * Plan, then run the operator's audited rea. Missing or unaudited binaries fail closed and nothing is downloaded.
 */
export async function runAnalysis(request, deps = {}) {
  const plan = planRun(request, deps);
  if (!plan.ok) return plan;
  const bin = (deps.findRea ?? findReaBinary)(deps);
  if (!bin) {
    return fail('rea-missing', `rea ${REA_PIN.version} is not on PATH. Kingmaker does not download it (the package graph quarantines openpgp, LGPL-3.0+, and optional frida). Install that exact version yourself, or set KINGMAKER_REA to its binary.`, { plan });
  }
  const version = await (deps.versionOf ?? ((file) => readReaVersion(file, deps.execFileSync)))(bin);
  if (!versionAdmitted(version)) {
    return fail('rea-unaudited', `This floor audited rea-agents ${REA_PIN.version} only. Found: ${version || 'no version'}.`, { plan, version });
  }
  const result = await (deps.spawn ?? spawnRea)(bin, plan.argv, { env: plan.env, timeoutMs: plan.timeoutMs, cwd: deps.cwd });
  return { ok: result.code === 0, code: result.code === 0 ? 'ran' : 'rea-failed', ...result, plan, bin };
}

export function auditSummary() {
  const byDecision = { allow: [], quarantine: [], refuse: [] };
  for (const record of AUDIT) byDecision[record.decision].push(record.id);
  return {
    pin: REA_PIN,
    imported: false,
    agpl: 'none in this pin; the gate refuses AGPL',
    npm: NPM_RUNTIME,
    decisions: byDecision,
    records: AUDIT,
    modules: MODULES.map((mod) => ({
      id: mod.id,
      name: mod.name,
      does: mod.does,
      run: mod.commands.filter((command) => command.dispatch).map((command) => command.name),
      held: mod.commands.filter((command) => command.hold).map((command) => command.name),
      quarantined: mod.commands.filter((command) => command.licenseDecision === 'quarantine').map((command) => command.name),
    })),
  };
}

export function mapText() {
  const lines = ['R&D floor — REA analysis (free engines only)', `Pin: rea-agents ${REA_PIN.version} @ ${REA_PIN.commit.slice(0, 12)} (${REA_PIN.license}). Not imported.`, ''];
  for (const mod of MODULES) {
    lines.push(`${mod.name} (${mod.id})`);
    lines.push(`  ${mod.does}`);
    const run = mod.commands.filter((command) => command.dispatch).map((command) => command.name);
    lines.push(`  run: ${run.join(', ')}`);
    const stopped = mod.commands.filter((command) => !command.dispatch).map((command) => command.name);
    if (stopped.length) lines.push(`  not run from here: ${stopped.join(', ')}`);
    lines.push('');
  }
  lines.push('Audit: kingmaker rd audit');
  lines.push('One file: kingmaker rd route /absolute/path');
  lines.push('Run: kingmaker rd run <module> <command> [--provider ghidra|kuna] /absolute/path');
  return lines.join('\n');
}

export function auditText() {
  const summary = auditSummary();
  const lines = [
    `Licence audit before import — ${REA_PIN.repo}`,
    `Commit ${REA_PIN.commit} (${REA_PIN.committed}), npm ${REA_PIN.package}@${REA_PIN.version}.`,
    'Nothing in this audit was copied into Kingmaker.',
    `npm runtime packages: ${summary.npm.runtimePackages}; allow ${summary.npm.allow}; quarantine ${summary.npm.quarantine.length} (openpgp LGPL-3.0+, frida LGPL-2.0).`,
    'No AGPL repository is in the pin. AGPL classifies as refuse.',
    '',
  ];
  for (const decision of ['refuse', 'quarantine', 'allow']) {
    lines.push(decision.toUpperCase());
    for (const record of AUDIT.filter((item) => item.decision === decision)) {
      lines.push(`- ${record.name} — ${record.license} — ${record.why}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
