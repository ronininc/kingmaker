// addons/ronin/cli.mjs — the Ronin add-on's own commands, reached through `kingmaker <command>` when the add-on is on
// this Mac (lib/cli.mjs hands them over; without the add-on they say so and exit 2):
//   kingmaker pair [--status]                      pair this Mac with Ronin CRM (docs/ronin-pairing.md)
//   kingmaker crm-lock [status|<tenant>]           one Kingmaker, one company's CRM (docs/crm-tenant-lock.md)
//   kingmaker owner-call setup|doctor|test|on|off|status   FaceTime Audio calls to the owner (docs/OWNER-CALL.md)
//   kingmaker office ronin …|muse …                the Ronin desk and the Muse office
//   kingmaker text-watch status|on|off|add|remove|after   an owner call when a watched contact's text waits unanswered
import { execFileSync } from 'node:child_process';
import { setActiveRoninAppProfile } from './app-profile.mjs';
import { DESK_ACCOUNTS } from './brain-desks.mjs';
import { activeCrmLock, crmLockChangeBlocked, setCrmLock } from './crm-lock.mjs';
import { ensureMuseOffice, museStatus, newMuseMessage, retryMuseMessage, routeMuseMessage } from './muse-office.mjs';
import { ownerCallCommand } from './owner-call.mjs';
import { askRoninDesk, callRoninDesk, readRoninDeskConfig, roninDeskReplies, runRoninDeskDock, setRoninDeskEnabled } from './ronin-desk-dock.mjs';
import { textWatchCommand } from './text-watch.mjs';
import { GRANT_SLOTS, keychainHas, markPairingWanted, pairWithRonin, readPairingState, showCodeOnMac, storeDeskKey } from './ronin-pairing.mjs';

export const RONIN_COMMANDS = Object.freeze(['pair', 'crm-lock', 'owner-call', 'office', 'text-watch']);

/** One of RONIN_COMMANDS. ctx: the core's { resolvePaths, readDaemonState, pidAlive, readAnswer, readHidden, runningVersion, DEFAULT_PORT }. */
export async function roninCommand(cmd, args, ctx) {
  const { resolvePaths, readDaemonState, pidAlive, readAnswer, readHidden, DEFAULT_PORT } = ctx;
  if (cmd === 'pair') return cmdPair(args, ctx);
  if (cmd === 'owner-call') return ownerCallCommand(args, { paths: resolvePaths(), readAnswer, readHidden });
  if (cmd === 'text-watch') return textWatchCommand(args, { paths: resolvePaths() });
  if (cmd === 'crm-lock') {
  // One Kingmaker, one company: show or set the CRM this install may link to (crm-lock.mjs).
  const p = resolvePaths(); const [tenant] = args;
  const isRunning = crmLockChangeBlocked(p, { readDaemonState, pidAlive });
  if (tenant && tenant !== 'status') {
    if (isRunning) { console.log('✗ Kingmaker is running. Stop it, set the CRM lock, then start it again; no lock was changed.'); return 2; }
    try { const l = setCrmLock(p, tenant); console.log(`This Kingmaker may now link only to ${l.url}. The lock applies on the next start.`); return 0; } catch (error) { console.log(`✗ ${error.message}`); return 2; }
  }
  const l = activeCrmLock(p); console.log(l ? `Locked: this Kingmaker links only to ${l.url} (${l.tenant}).${isRunning ? ' Restart required if this lock was changed since the current process started.' : ''}` : 'Not locked: no CRM is attached unless the owner connects one.'); return 0;
  }
  if (cmd === 'office') {
  const office = String(args.shift() || '').toLowerCase();
  const paths = resolvePaths();
  if (office === 'ronin') {
    const action = args[0];
    if (action === 'enable') {
      if (crmLockChangeBlocked(paths, { readDaemonState, pidAlive })) { console.error('✗ Kingmaker is running. Stop it, enable the Ronin office, then start it again; no lock state was changed.'); return 2; }
      const config = setRoninDeskEnabled(paths, true);
      try {
        const check = await runRoninDeskDock(['--check']);
        const appProfile = setActiveRoninAppProfile(paths, { port: Number(process.env.SOL_GHOST_PORT) || DEFAULT_PORT });
        console.log(`Ronin desk auto-start enabled for this profile (${config.crm}); lease accepted until ${new Date(check.leaseExpiresAt * 1000).toISOString()}.`);
        console.log(`Installed app profile: ${appProfile.state} on 127.0.0.1:${appProfile.port}.`);
        return 0;
      } catch (error) {
        setRoninDeskEnabled(paths, false);
        console.error(`✗ Ronin desk was not enabled: ${error.message}`);
        return 1;
      }
    }
    if (action === 'disable') {
      if (crmLockChangeBlocked(paths, { readDaemonState, pidAlive })) { console.error('✗ Kingmaker is running. Stop it, disable the Ronin office, then start it again; no lock state was changed.'); return 2; }
      setRoninDeskEnabled(paths, false); console.log('Ronin desk auto-start disabled for this profile. Restart Kingmaker to apply the unlocked profile.'); return 0;
    }
    if (action === 'status') { console.log(JSON.stringify(readRoninDeskConfig(paths), null, 2)); return 0; }
    if (action === 'key') {
      // Save one desk's key from the clipboard: it must be a desk key AND the CRM must say it belongs to that desk.
      const deskSlug = String(args[1] || '').trim();
      const account = DESK_ACCOUNTS[deskSlug];
      if (!account) { console.error(`Usage: kingmaker office ronin key <desk>   (desks: ${Object.keys(DESK_ACCOUNTS).join(', ')}). Copy the key first (Connections → Copy key).`); return 2; }
      let key = '';
      try { key = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' }).replace(/\s+/g, ''); } catch { /* empty clipboard */ }
      if (!key.startsWith('ronin_desk_')) { console.error('✗ The clipboard does not hold a desk key (it starts with ronin_desk_). In Connections click Copy key, then run this again.'); return 1; }
      let bound;
      try { bound = await callRoninDesk({ token: key, name: 'desk_status' }); } catch (error) { console.error(`✗ The CRM did not accept that key (${error.message}). Issue a new one.`); return 1; }
      if (bound?.slug !== deskSlug) { console.error(`✗ That key belongs to the ${bound?.slug || 'unknown'} desk, not ${deskSlug}. Revoke it in Connections, pick ${deskSlug} in the Desk list, and issue again.`); return 1; }
      storeDeskKey(deskSlug, key); // on security(1)'s stdin, never its argv
      key = '';
      console.log(`✓ Saved the ${deskSlug} desk key (${bound.nameplate}) in Keychain. It docks the next time Kingmaker starts.`);
      return 0;
    }
    if (action === 'ask') {
      const [, deskSlug, ...rest] = args;
      const ci = rest.indexOf('--context');
      const context = ci >= 0 ? rest.slice(ci + 1).join(' ').trim() : '';
      const question = (ci >= 0 ? rest.slice(0, ci) : rest).join(' ').trim();
      if (!deskSlug || !question) { console.error('Usage: kingmaker office ronin ask <desk> "<order>" [--context "<everything the job needs>"]   (desks: muse, claude, codex, grok-bot)'); return 2; }
      try { const r = await askRoninDesk({ desk: deskSlug, question, context }); console.log(`Asked ${r.desk}; question ${r.question_id}. Read the answer with: kingmaker office ronin replies`); return 0; }
      catch (error) { console.error(`✗ ${error.message}`); return 1; }
    }
    if (action === 'replies') {
      try {
        const { replies = [] } = await roninDeskReplies({ since: Number(args[1]) || 0 });
        if (!replies.length) console.log('No answers yet.');
        for (const r of replies) console.log(`${r.desk} · ${new Date(r.answered_at * 1000).toLocaleString()}\n  Q: ${r.question}\n  A: ${r.answer}\n`);
        return 0;
      } catch (error) { console.error(`✗ ${error.message}`); return 1; }
    }
    if (action === 'check') args[0] = '--check';
    try { await runRoninDeskDock(args); return 0; }
    catch (error) { console.error(`✗ ${error.message}`); return 1; }
  }
  if (office === 'muse') {
    const [verb = 'status', ...rest] = args;
    if (verb === 'init') {
      const p = ensureMuseOffice(paths);
      console.log(`Muse initialized at ${p.root}. Ronin Inc only; local model; idle workers 0.`);
      return 0;
    }
    if (verb === 'status') { console.log(JSON.stringify(museStatus(paths), null, 2)); return 0; }
    if (verb === 'ask') {
      const question = rest.join(' ').trim();
      if (!question) { console.error('Usage: kingmaker office muse ask "<message>"'); return 2; }
      const result = await routeMuseMessage(paths, newMuseMessage(question));
      console.log(JSON.stringify({ inbox: result.inboxPath, outbox: result.outboxPath, reply: result.answer }, null, 2));
      return 0;
    }
    if (verb === 'retry') {
      const askId = rest[0]?.trim();
      if (!askId || rest.length !== 1) { console.error('Usage: kingmaker office muse retry <ask-id>'); return 2; }
      const result = await retryMuseMessage(paths, askId);
      console.log(JSON.stringify({ attempt_id: result.attemptId, inbox: result.inboxPath, outbox: result.outboxPath, reused: result.reused, reply: result.answer }, null, 2));
      return 0;
    }
    console.error('Usage: kingmaker office muse init|status|ask "<message>"|retry <ask-id>'); return 2;
  }
  console.error('Usage: kingmaker office ronin enable|disable|status|check|key <desk>|ask <desk> "<question>"|replies OR kingmaker office muse init|status|ask "<message>"|retry <ask-id>'); return 2;
  }
  return 2;
}

/** `kingmaker pair`: the terminal fallback for the site's "Pair this Mac" link (Kingmaker.app handles kingmaker://pair
 *  with no terminal). `--status` says what this Mac holds, by name only: never a key, never a code from the CRM. */
async function cmdPair(args, { resolvePaths, readDaemonState, pidAlive, runningVersion }) {
  const paths = resolvePaths();
  if (args.includes('--status')) {
    const state = readPairingState(paths);
    const keys = Object.fromEntries((state?.grants ?? []).map((g) => [g, keychainHas(GRANT_SLOTS[g]) ? 'in Keychain' : 'missing']));
    console.log(JSON.stringify({ paired: Boolean(state?.pairing_id), paired_at: state?.paired_at ?? null, keys, needs_repair: Boolean(state?.needs_repair), declined: Boolean(state?.declined) }, null, 2));
    return 0;
  }
  const daemon = readDaemonState(paths);
  if (daemon?.pid && pidAlive(daemon.pid)) { console.error('✗ Kingmaker is running: on this Mac, open the site (Connections → Pair a Mac) and click "Pair this Mac", or quit Kingmaker first.'); return 2; }
  markPairingWanted(paths);
  try {
    const r = await pairWithRonin({ paths, version: runningVersion(), log: (line) => console.log(line), ui: { code: ({ userCode, expiresIn }) => {
      console.log(`\n  Pairing code: ${userCode}\n  On the site: Connections → Pair a Mac. Type the code and tap Approve (it works for ${Math.round(expiresIn / 60)} minutes).\n`);
      showCodeOnMac({ userCode, expiresIn });
    } } });
    console.log(`✓ Paired. Saved ${r.grants.join(', ')} in the Keychain. Start Kingmaker and it docks by itself.`);
    return 0;
  } catch (error) { console.error(`✗ ${error.message}`); return 1; }
}
