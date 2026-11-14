// addons/ronin/office.mjs — the Ronin office inside a running Kingmaker (lib/cli.mjs cmdStart starts it when the Ronin
// add-on is here): the Kingmaker desk and the Build Room brains' desks docked to the Ronin CRM, owner calls, and
// terminal-free pairing. → { pairIfNeeded } (kingmaker://pair asks again through it).
import { createBrainDeskHost, BRAIN_DESKS, DESK_ACCOUNTS } from './brain-desks.mjs';
import { readOwnerCallConfig, runOwnerCallLoop } from './owner-call.mjs';
import { maintainRoninDeskDock, readRoninDeskConfig, storedRoninDeskToken } from './ronin-desk-dock.mjs';
import { markNeedsRepair, pairingDockEnv, pairingReason, pairWithRonin } from './ronin-pairing.mjs';
import { engineAlerter, readTextWatchConfig, runTextWatchLoop } from './text-watch.mjs';
import { ownerCall } from './core.mjs';

export function startRoninOffice({ paths, port, nonce, signal, log, ringer, version }) {
  // The Ronin office: the Kingmaker desk and the Build Room brains' desks hosted here, and owner calls. Started now if
  // the office is on, and again after this Mac pairs on the site (lib/ronin-pairing.mjs), with no restart. A dock
  // whose key the CRM refuses (revoked on the site, a lost Mac, re-pair, expiry) stops and this Mac asks to pair again.
  const runningDocks = new Set();
  let ownerCallsStarted = false;
  let textWatchStarted = false;
  const roninDockBase = () => ({
    RONIN_CRM_URL: readRoninDeskConfig(paths).crm,
    SOLOMON_URL: `http://127.0.0.1:${port}`,
    KINGMAKER_BRAIN: process.env.KINGMAKER_BRAIN || 'kingmaker',
    KINGMAKER_BRAINS: process.env.KINGMAKER_BRAINS || 'kingmaker,grok,claude,codex',
    KINGMAKER_STATE: 'idle',
    KINGMAKER_WORKFLOW: 'Ronin Inc local host',
    RONIN_DESK_KEYCHAIN_SERVICE: process.env.RONIN_DESK_KEYCHAIN_SERVICE || 'ronin-crm-prod',
    RONIN_DESK_KEYCHAIN_ACCOUNT: process.env.RONIN_DESK_KEYCHAIN_ACCOUNT || 'KINGMAKER_DESK_TOKEN',
  });
  const onDeskRefused = () => { markNeedsRepair(paths); void pairIfNeeded(); };
  const startRoninHosts = () => {
    if (!readRoninDeskConfig(paths).enabled) return;
    const dockEnv = roninDockBase();
    const dock = (slug, env, extra = {}) => {
      if (runningDocks.has(slug) || !storedRoninDeskToken(env)) return;
      runningDocks.add(slug);
      void maintainRoninDeskDock({ env: { ...env, ...pairingDockEnv(paths, slug) }, signal, log: (...parts) => console.log(...parts), onUnauthorized: onDeskRefused, ...extra })
        .catch((error) => console.error(`! ${slug === 'kingmaker' ? 'Ronin desk host' : `${slug} desk host`} stopped: ${error.message}`))
        .finally(() => runningDocks.delete(slug));
    };
    dock('kingmaker', dockEnv);
    // The Build Room brains' desks (Muse, Claude, Codex, grok-bot), hosted here, each with its own key and its own
    // local brain answering what Seeker asks. A desk docks only when its key is installed.
    for (const slug of BRAIN_DESKS) {
      const deskEnv = { ...dockEnv, KINGMAKER_BRAIN: slug, KINGMAKER_WORKFLOW: `${slug} · hosted by Kingmaker`, RONIN_DESK_KEYCHAIN_ACCOUNT: DESK_ACCOUNTS[slug] };
      if (!storedRoninDeskToken(deskEnv)) continue;
      dock(slug, deskEnv, { ...createBrainDeskHost(slug, { paths, port, log }), expectDesk: slug });
    }
    // Owner calls (lib/owner-call.mjs): only when the owner turned them on (kingmaker owner-call on). The loop re-reads
    // the switch every tick, so `kingmaker owner-call off` stops the polling without a restart.
    if (!ownerCallsStarted && readOwnerCallConfig(paths).enabled) {
      ownerCallsStarted = true;
      void runOwnerCallLoop({ paths, signal, log, phone: ringer })   // the paired phone rings first (lib/phone-ring.mjs)
        .catch((error) => console.error(`! Owner calls stopped: ${error.message}`));
    }
    startTextWatch();
  };
  // The unanswered-text watch (text-watch.mjs): only when the owner turned it on (kingmaker text-watch on). It flags the
  // CRM with the Kingmaker desk key when this Mac has one, else through the engine with the :key ronin-crm key (the
  // master key); the CRM alerts the owner only. It never contacts the person who texted. Not tied to the office switch:
  // the master key alone is enough.
  const startTextWatch = () => {
    if (textWatchStarted || !readTextWatchConfig(paths).enabled) return;
    textWatchStarted = true;
    const engine = nonce && typeof ownerCall === 'function' ? engineAlerter(ownerCall, port, nonce) : null;
    void runTextWatchLoop({ paths, signal, log, deps: { engine } })
      .catch((error) => console.error(`! Text watch stopped: ${error.message}`))
      .finally(() => { textWatchStarted = false; });
  };
  // Terminal-free pairing: a Ronin Mac with no working key shows a code and opens Connections; the owner approves it on
  // the site and this Mac saves its keys in the Keychain and docks. Nothing here approves; a Mac that is not a Ronin
  // install (no office, no lock, nobody asked) never asks.
  const pairIfNeeded = async () => {
    const reason = pairingReason(paths);
    if (!reason) return;
    log('ronin_pairing', { reason });
    try {
      await pairWithRonin({ paths, version, signal, log: (line) => console.log(line) });
      startRoninHosts();
    } catch (error) {
      if (!signal.aborted) console.error(`! Ronin pairing: ${error.message}`);
    }
  };
  startRoninHosts();
  startTextWatch();
  void pairIfNeeded();
  return { pairIfNeeded };
}
