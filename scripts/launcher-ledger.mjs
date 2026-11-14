#!/usr/bin/env node
// scripts/launcher-ledger.mjs — the owner's tool for lib/launcher-issued.json (see lib/launcher-ledger.mjs).
//
//   node scripts/launcher-ledger.mjs add --version <v> [--zip <release zip>] [--app <Ronin Launcher.app>]
//                                        [--channel direct|app-store] [--note <text>] [--issued-at <iso>]
//       Append one issued build. Give the release zip, the installed app, or both. For an App Store copy give
//       --app pointing at the copy the App Store delivered (Apple re-signs it, so the submitted build's
//       fingerprint is not the delivered one); its channel is detected from the receipt inside it.
//   node scripts/launcher-ledger.mjs revoke --fingerprint <sha256> --reason <text>
//       Mark a listed build withdrawn. Never removes it.
//   node scripts/launcher-ledger.mjs check [--app <Ronin Launcher.app>]
//       Validate the list; with --app, say what that launcher is to Kingmaker.
//   node scripts/launcher-ledger.mjs list
//
// Entries are only ever appended or marked revoked. This tool refuses any other change.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleFingerprint, CHANNELS, dockStatus, isAppStoreCopy, LEDGER_FILE, ledgerExtends, ledgerProblems, readLedger } from '../lib/launcher-ledger.mjs';

const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

export function main(argv = process.argv.slice(2), { file = LEDGER_FILE, print = console.log, now = () => new Date().toISOString() } = {}) {
  const cmd = argv[0];
  const before = readLedger(file);
  const save = (next) => {
    const grown = ledgerExtends(before, next);
    if (!grown.ok) { print(`✗ Not written: ${grown.problems.join('; ')}`); return 1; }
    writeFileSync(typeof file === 'string' ? file : fileURLToPath(file), `${JSON.stringify(next, null, 2)}\n`);
    return 0;
  };
  if (cmd === 'list') {
    if (!before.entries.length) print('The list is empty: no Ronin Launcher build is recorded as issued, so every launcher is unknown to Kingmaker.');
    before.entries.forEach((e, i) => print(`${i + 1}. ${e.version} [${e.channel}] issued ${e.issuedAt}${e.revoked ? ` — REVOKED ${e.revoked.at}: ${e.revoked.reason}` : ''}${e.archiveSha256 ? `\n   archive ${e.archiveSha256}` : ''}${e.bundleSha256 ? `\n   bundle  ${e.bundleSha256}` : ''}`));
    return 0;
  }
  if (cmd === 'check') {
    const bad = ledgerProblems(before);
    if (bad.length) { print(`✗ ${bad.join('; ')}`); return 1; }
    print(`✓ ${before.entries.length} issued build(s), list is sound.`);
    const app = arg(argv, '--app');
    if (app) { const s = dockStatus(app, before); print(`${s.docked ? '✓' : '✗'} ${s.why}${s.bundleSha256 ? `\n  bundle ${s.bundleSha256}` : ''}`); return s.docked ? 0 : 1; }
    return 0;
  }
  if (cmd === 'add') {
    const version = arg(argv, '--version'); const zip = arg(argv, '--zip'); const app = arg(argv, '--app');
    if (!version || (!zip && !app)) { print('usage: add --version <v> [--zip <release zip>] [--app <Ronin Launcher.app>] [--channel direct|app-store] [--note <text>]'); return 2; }
    const entry = { version, channel: arg(argv, '--channel') ?? (app && isAppStoreCopy(app) ? 'app-store' : 'direct'), issuedAt: arg(argv, '--issued-at') ?? now() };
    if (!CHANNELS.includes(entry.channel)) { print(`✗ --channel must be one of ${CHANNELS.join(', ')}`); return 2; }
    if (zip) entry.archiveSha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
    if (app) {
      entry.bundleSha256 = bundleFingerprint(app);
      if (!entry.bundleSha256) { print(`✗ ${app} is not a signed app bundle (no Info.plist, code-signature seal or executable).`); return 1; }
    }
    const note = arg(argv, '--note'); if (note) entry.note = note;
    const code = save({ ...before, entries: [...before.entries, entry] });
    if (code === 0) print(`✓ Listed Ronin Launcher ${version} [${entry.channel}] as issued.${entry.archiveSha256 ? `\n  archive ${entry.archiveSha256}` : ''}${entry.bundleSha256 ? `\n  bundle  ${entry.bundleSha256}` : ''}`);
    return code;
  }
  if (cmd === 'revoke') {
    const fp = String(arg(argv, '--fingerprint') ?? '').toLowerCase(); const reason = arg(argv, '--reason');
    if (!fp || !reason) { print('usage: revoke --fingerprint <sha256> --reason <text>'); return 2; }
    const i = before.entries.findIndex((e) => e.archiveSha256 === fp || e.bundleSha256 === fp);
    if (i < 0) { print('✗ No listed build has that fingerprint.'); return 1; }
    if (before.entries[i].revoked) { print('✗ That build is already revoked; a revocation is not reworded.'); return 1; }
    const entries = before.entries.map((e, k) => (k === i ? { ...e, revoked: { at: now(), reason } } : e));
    const code = save({ ...before, entries });
    if (code === 0) print(`✓ Ronin Launcher ${before.entries[i].version} is now revoked. Kingmaker will not dock with it.`);
    return code;
  }
  print('usage: launcher-ledger.mjs add | revoke | check | list   (see the header of this file)');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
