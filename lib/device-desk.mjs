// THE DEVICE DESK: what the owner says about his Mac's capabilities, and the first-run scan.
//
//   FIRST START   In the background, paced: the inventory (device-scan.mjs) and the key scan (device-keys.mjs, names
//                 only). One line when it is done, said once: what Ghost can drive and how, how many API keys it
//                 found, and the two things it will do only on his word: look online for tools for the apps it can
//                 drive only by hand, and put the keys in the vault. A map older than a week is refreshed on start.
//   SAID / TYPED  "scan my Mac" (or :scan)              rescan now (read-only)
//                 "what can you drive" (or :tools)       the summary and the proposals
//                 "find tools for my apps"               the owner's consent to the online search (kept, so later
//                                                        scans search too; "stop looking online" withdraws it)
//                 "put my keys in the vault" (:key import)  READ BACK (names and providers), then only on yes
//                 "install <tool>"                       READ BACK (package, pinned version, licence, flags), then only
//                                                        on yes; then the engine's own RED proposal to register it
//                 "get me a Groq key"                    READ BACK (free tier, what it powers, what is his), then on yes
//                                                        its key page in his visible Chrome + a hidden paste box for it
//                                                        (key-acquire.mjs); pasting and Save is his act
//                 "set up my keys"                       READ BACK the catalog's gaps, then one provider at a time
//                 "save it" / "save the Groq key"        READ BACK, then on his spoken yes: the clipboard, read once
//   YES           A read-back waits for the owner's word: typed at this console, or said while awake when the voice
//                 is his word (voice authority 'owner', or 'verified' with the enrolled voice's attestation). A local
//                 program (`kingmaker say`, MCP) never reaches the desk. A read-back lapses after two minutes.

import { closestCapabilityLine, cooperativePacer, deviceMapPath, mapCounts, readDeviceMap, realWorld, scanDevice, scanDue, writeDeviceMap } from './device-scan.mjs';
import { importKeysToVault, importLine, importReadBack, providersLine, scanKeys } from './device-keys.mjs';
import { findCandidates, matchProposal, proposalLine } from './device-candidates.mjs';
import { acquisitionReadBack, handOffToAcquisition, toolsDir } from './device-tools.mjs';
import { acquireKey, acquireReadBack, catalogGaps, freeCatalog, matchCatalog, saveFromClipboard, setupKeys, setupReadBack, storedLine } from './key-acquire.mjs';
import { ronin } from './addons.mjs';

export const ASK_TTL_MS = 120_000;

/** Pure: what a line asks of the desk, or null (it is the engine's). */
export function deviceIntent(text) {
  const t = String(text ?? '').trim().replace(/[.!?]+$/, '');
  if (/^:scan$/i.test(t) || /^(?:please\s+)?(?:re-?)?scan\s+(?:my|this|the)\s+(?:mac|device|computer|laptop|apps?)\b/i.test(t) || /^(?:take\s+)?(?:an?\s+)?inventory\s+of\s+(?:my|this)\s+(?:mac|device|computer)/i.test(t)) return { kind: 'scan' };
  if (/^:tools$/i.test(t) || /^what\s+(?:apps\s+)?can\s+you\s+(?:drive|control|run|use)(?:\s+on\s+(?:my|this)\s+(?:mac|computer))?$/i.test(t) || /^(?:list|show)\s+(?:the\s+)?(?:tool\s+)?proposals$/i.test(t)) return { kind: 'tools' };
  if (/^(?:stop|don'?t\s+keep)\s+(?:looking|searching)\s+online\b/i.test(t)) return { kind: 'stop-find' };
  if (/^(?:find|look\s+(?:online\s+)?for|search\s+(?:online\s+)?for|get)\s+(?:open[-\s]?source\s+)?(?:tools?|clis?|mcps?|mcp\s+servers?)\s+(?:for\s+)?(?:my|the|all\s+my)\s+apps\b/i.test(t)) return { kind: 'find' };
  if (/^:keys?\s+import$/i.test(t) || /\b(?:put|import|move|load|add|drop|store|seal)\s+(?:all\s+)?(?:my|the)\s+(?:api\s+)?keys\s+(?:in(?:to)?|to)\s+(?:the\s+|your\s+|my\s+)?vault\b/i.test(t)) return { kind: 'keys-import' };
  if (/^(?:what|which)\s+(?:api\s+)?keys\s+(?:did\s+you\s+find|are\s+on\s+(?:my|this)\s+(?:mac|computer))/i.test(t)) return { kind: 'keys' };
  if (/^(?:set\s*up|setup|get)\s+(?:all\s+)?(?:my|the)\s+(?:free\s+)?(?:api\s+)?keys$/i.test(t) || /^:keys?\s+setup$/i.test(t)) return { kind: 'setup-keys' };
  const getKey = /^(?:get|make|create|grab|set\s*up)\s+(?:me\s+)?(?:a|an|my|the)\s+(.{2,40}?)\s+(?:api\s+)?(?:key|token)$/i.exec(t);
  if (getKey) return { kind: 'get-key', arg: getKey[1].trim() };
  if (/^save\s+(?:it|that|this|the\s+key|my\s+key)$/i.test(t)) return { kind: 'save-key', arg: null };
  const saveKey = /^save\s+(?:the|my)\s+(.{2,40}?)\s+(?:api\s+)?(?:key|token)$/i.exec(t);
  if (saveKey) return { kind: 'save-key', arg: saveKey[1].trim() };
  const install = /^(?:install|acquire|get)\s+(?:the\s+)?(.{2,80})$/i.exec(t);
  if (install && !/\b(?:app|update|updates)\b/i.test(install[1])) return { kind: 'install', arg: install[1].trim() };
  return null;
}

/** Pure: may this line approve a read-back? Typed at the console always; spoken only when the voice is his word. */
export function ownerWord({ typed = false, spoken = false, attested = false } = {}, voiceAuthority = 'owner', voiceApproves = true) {
  if (typed) return true;
  if (!spoken || !voiceApproves) return false;
  return voiceAuthority === 'owner' || (voiceAuthority === 'verified' && attested);
}

/** Pure: the first-run line (said once). */
export function firstRunLine(map) {
  const c = mapCounts(map);
  const keys = map.keys?.found ? ` I also found ${c.keys} API ${c.keys === 1 ? 'key' : 'keys'} on this Mac for ${providersLine(map.keys.byProvider, Object.fromEntries((map.keys.entries ?? []).map((e) => [e.provider, e.label])), 4)}: say "put my keys in the vault" and I'll read them back first.` : '';
  const freeGaps = map.keys?.freeTier?.gaps ?? [];
  const free = freeGaps.length ? ` ${freeGaps.length} free ${freeGaps.length === 1 ? 'API' : 'APIs'} Kingmaker can use ${freeGaps.length === 1 ? 'has' : 'have'} no key yet (${(map.keys.freeTier.labels ?? freeGaps).slice(0, 4).join(', ')}${freeGaps.length > 4 ? ', …' : ''}): say "set up my keys" and I'll open each key page with a paste box ready.` : '';
  const search = c.gaps && !map.candidates?.consent?.granted ? ` For the ${c.gaps} I can drive only by hand or script, say "find tools for my apps" and I'll look online for open-source ones (only the app names leave this Mac).` : '';
  return `I've scanned this Mac: ${c.apps} apps. ${c.direct} I can drive directly through their own command line, an MCP server or my engines; the rest through their AppleScript, their links, or the Hands of Horus.${search}${keys}${free}`;
}

/** Pure: the summary for :tools / "what can you drive". */
export function summaryLines(map) {
  if (!map) return ['No scan yet. Say "scan my Mac", or wait: it runs in the background on the first start.'];
  const c = mapCounts(map);
  const lines = [
    `Scanned ${map.scannedAt ?? map.startedAt}: ${c.apps} apps (${c.direct} direct: ${c.cli} with a CLI, ${c.mcpApps} with an MCP server; ${c.applescript} best by AppleScript, ${c.urlScheme} by links, ${c.handsOnly} by the hands only), ${c.clis} CLIs on PATH, ${c.mcpServers} MCP servers configured, ${c.webHosts} web apps in Chrome.`,
    `Gaps: ${c.gaps}. Online search: ${map.candidates?.consent?.granted ? `on (since ${map.candidates.consent.at})` : 'off until you say "find tools for my apps"'}${map.candidates?.lastRun ? `; last run searched ${map.candidates.lastRun.searched}, ${map.candidates.lastRun.remaining} left${map.candidates.lastRun.stoppedFor ? ` (stopped: ${map.candidates.lastRun.stoppedFor})` : ''}` : ''}.`,
  ];
  const props = (map.proposals ?? []).filter((p) => p.state === 'proposed').sort((a, b) => b.score - a.score);
  if (props.length) lines.push(`Proposed (${props.length}): say "acquire <name>" for one; outside code never runs as-is: Kingmaker studies it in quarantine and builds our own.`, ...props.slice(0, 12).map((p) => `  · ${proposalLine(p)}`));
  if (map.keys?.freeTier) lines.push(`Free APIs without a key: ${(map.keys.freeTier.labels ?? []).join(', ') || 'none'}${map.keys.freeTier.gaps?.length ? ' (say "set up my keys")' : ''}.`);
  if (map.keys?.found) lines.push(`API keys on this Mac: ${map.keys.found} (${providersLine(map.keys.byProvider)})${map.keys.imported?.at ? `; in the vault since ${map.keys.imported.at}` : '; not in the vault yet: say "put my keys in the vault"'}.`);
  return lines;
}

/**
 * The desk. `say(line)` speaks + prints; `out(line)` prints only. `port`/`nonce` reach the engine as the owner (vault
 * import, MCP registration). Injectable for tests: world, fetchImpl, scan/keys/find/install implementations.
 */
export function createDeskOfDevice({
  paths, port, nonce, say = async () => {}, out = () => {}, log = () => {}, voiceAuthority = 'owner', voiceApproves = true,
  file = deviceMapPath(paths), world, fetchImpl, now = () => new Date(),
  impl = { scanDevice, scanKeys, findCandidates, importKeysToVault, handOff: handOffToAcquisition, freeCatalog, acquireKey, setupKeys, saveFromClipboard },
  paceFactory = () => cooperativePacer(),
}) {
  let pendingAsk = null;
  let busy = null;
  let lastProvider = null;
  /** Whether his voice is his word can change after the desk is made (voice starts later): read it each time. */
  const approves = () => (typeof voiceApproves === 'function' ? voiceApproves() : voiceApproves) === true;
  const catalog = () => (port && nonce ? impl.freeCatalog({ port, nonce, fetchImpl }) : Promise.resolve({ ok: false, reason: "Kingmaker's engine is not running here." }));
  /** Which free APIs have no key yet, kept in the map for the first-run line and the summary. */
  async function noteFreeTier(map) {
    const c = await catalog().catch(() => null);
    if (!c?.ok || !map) return map;
    const gaps = catalogGaps(c.providers);
    map.keys = { ...(map.keys ?? {}), freeTier: { at: now().toISOString(), gaps: gaps.map((p) => p.id), labels: gaps.map((p) => p.label) } };
    save(map);
    return map;
  }
  const lock = ronin?.activeCrmLock(paths) ?? null; // a Ronin install never sees or drives the other company's apps
  let cached = readDeviceMap(file, undefined, lock);
  const save = (map) => { cached = map; writeDeviceMap(file, map); };
  const read = () => (cached = readDeviceMap(file, undefined, lock) ?? cached);

  async function runScan({ signal, force = false } = {}) {
    const pace = paceFactory();
    try {
      const previous = read();
      const map = await impl.scanDevice({ file, world: world ?? realWorld(), previous, pace, signal, force, now, lock, save: (_f, m) => save(m) });
      // What the owner already decided or was told survives a rescan.
      for (const k of ['announcedAt', 'candidates', 'proposals']) if (map[k] === undefined || map[k] === null) map[k] = previous?.[k] ?? map[k] ?? null;
      if (signal?.aborted) return map;
      map.keys = { ...impl.scanKeys({ home: (world ?? realWorld()).home, ghostRuntimeHome: paths.runtimeHome }), imported: map.keys?.imported ?? null };
      save(map);
      log('device_scan_done', { ...mapCounts(map) });
      return map;
    } finally { pace.stop(); }
  }

  /** His consent to the online search (or its withdrawal), kept in the map. → the map, or null before any scan. */
  function setConsent(granted, by) {
    const map = read();
    if (!map) return null;
    map.candidates ??= { consent: null, searched: {} };
    map.candidates.consent = { granted: granted === true, at: now().toISOString(), by };
    save(map);
    return map;
  }

  async function runFind({ signal } = {}) {
    const map = read();
    if (!map) return null;
    const pace = paceFactory();
    try {
      return await impl.findCandidates({ map, save, fetchImpl: fetchImpl ?? fetch, pace, signal, now, log });
    } finally { pace.stop(); }
  }

  /** First start (and every start): scan when due, then search when he consented. Says one line, once. */
  async function runBackground({ signal, announce = () => {} } = {}) {
    if (busy) return busy;
    busy = (async () => {
      let map = read();
      const due = scanDue(map, now().getTime());
      if (due) map = await runScan({ signal });
      if (!map || signal?.aborted) return map;
      map = await noteFreeTier(map);
      if (!map.announcedAt && map.complete) {
        announce(firstRunLine(map));
        map.announcedAt = now().toISOString();
        save(map);
      }
      if (map.candidates?.consent?.granted) {
        const r = await runFind({ signal });
        if (r?.proposals && !signal?.aborted) log('device_candidates_done', r);
      }
      return read();
    })().catch((error) => { log('device_scan_failed', { message: String(error?.message ?? error).slice(0, 160) }); return null; })
      .finally(() => { busy = null; });
    return busy;
  }

  const result = (extra = {}) => ({ followUp: false, ok: true, route: 'device-desk', disposition: 'device-desk', internetUsed: false, answerChars: 0, spoke: true, ...extra });

  function ask(kind, line, run) {
    pendingAsk = { kind, run, at: now().getTime() };
    return say(line).then(() => result({ followUp: true }));
  }

  /** A line for the desk → a turn-like result, or null when it is the engine's. */
  async function handle(text, who = {}) {
    const intent = deviceIntent(text);
    if (!intent) return null;
    const mine = ownerWord(who, voiceAuthority, approves());
    switch (intent.kind) {
      case 'scan': {
        await say('Scanning this Mac now. It reads app bundles, PATH and config files only.');
        const map = await runScan({ force: true });
        await say(map ? firstRunLine(map) : 'The scan did not finish.');
        return result();
      }
      case 'tools': {
        for (const line of summaryLines(read())) out(`  ${line}`);
        const map = read();
        await say(map ? `${mapCounts(map).apps} apps, ${mapCounts(map).gaps} gaps, ${mapCounts(map).proposals} tools proposed. The list is on screen.` : 'No scan yet.');
        return result();
      }
      case 'keys': {
        const map = read();
        if (!map?.keys) { await say('I have not looked for keys yet. Say "scan my Mac".'); return result(); }
        for (const e of map.keys.entries ?? []) out(`  · ${e.name} (${e.label}) in ${e.file}`);
        await say(map.keys.found ? `${map.keys.found} API keys: ${providersLine(map.keys.byProvider)}. Their names and files are on screen; I never show the keys themselves.` : 'I found no API keys on this Mac.');
        return result();
      }
      case 'find':
      case 'stop-find': {
        if (!mine) { await say('Only your word can change that: type it at the Kingmaker console, or say it in your own voice.'); return result(); }
        const by = who.typed ? 'typed' : 'spoken';
        const map = setConsent(intent.kind === 'find', by) ?? await runScan({}).then(() => setConsent(intent.kind === 'find', by));
        if (intent.kind === 'stop-find') { await say('Done. I won\'t look online for tools unless you ask again.'); return result(); }
        await say(`Looking online for open-source tools for the ${mapCounts(map).gaps} apps I can only drive by hand or script. Only their names go out, to the MCP registry and GitHub. I'll tell you what I find; nothing gets installed without your yes.`);
        void runFind({}).then(async (r) => {
          const m = read();
          const props = (m?.proposals ?? []).filter((p) => p.state === 'proposed').sort((a, b) => b.score - a.score);
          await say(r ? `I searched ${r.searched} apps${r.stoppedFor === 'rate-limited' ? ' (GitHub asked me to slow down; I\'ll carry on next time)' : ''} and proposed ${props.length} tools${props[0] ? `; the best is ${props[0].name} for ${props[0].app}` : ''}. Say "what can you drive" for the list.` : 'The search did not run.');
        }).catch(() => {});
        return result();
      }
      case 'keys-import': {
        const map = read();
        const keys = map?.keys ?? impl.scanKeys({ home: (world ?? realWorld()).home, ghostRuntimeHome: paths.runtimeHome });
        const line = importReadBack(keys);
        if (!line) { await say('I found no API keys on this Mac to put in the vault.'); return result(); }
        for (const e of keys.entries ?? []) out(`  · ${e.name} (${e.label}) from ${e.file}`);
        const asked = mine ? line : `${line.replace(/ Say yes to put them in the vault\.$/, '')} Only your word can put them there: type yes at the Kingmaker console, or say it in your own voice.`;
        return ask('keys-import', asked, async () => {
          const r = await impl.importKeysToVault({ port, nonce, scan: keys, fetchImpl, log });
          const m = read();
          if (m) { m.keys = { ...keys, imported: r.imported?.length ? { at: now().toISOString(), receiptId: r.receiptId ?? null, names: r.imported.map((x) => x.envName), route: r.route } : m.keys?.imported ?? null }; save(m); }
          for (const x of r.refused ?? []) out(`  ✗ ${x.envName}: ${x.reason}`);
          await say(importLine(r));
        });
      }
      case 'get-key': {
        const c = await catalog();
        const p = c.ok ? matchCatalog(c.providers, intent.arg) : null;
        if (!p) return null; // not a free-tier API: the engine's own key handoff answers ("get me a Stripe key")
        lastProvider = { p, at: now().getTime() };
        if (p.stored) { await say(`I already have your ${p.label} key in the vault, so there's nothing to paste. Say "save the ${p.label} key" to replace it with what you've copied.`); return result(); }
        return ask('get-key', acquireReadBack(p), async () => {
          const r = await impl.acquireKey(p, { port, nonce, say, out, fetchImpl, log });
          if (!r.stored && r.action !== 'save') await say(r.action === 'timeout' ? 'The paste box closed after fifteen minutes; nothing was stored.' : 'Nothing stored.');
          const m = read();
          if (m && r.stored) { await noteFreeTier(m); }
        });
      }
      case 'setup-keys': {
        const c = await catalog();
        if (!c.ok) { await say(c.reason); return result(); }
        const gaps = catalogGaps(c.providers);
        const line = setupReadBack(gaps);
        if (!line) { await say('Every free API Kingmaker uses already has a key in the vault.'); return result(); }
        for (const p of gaps) out(`  · ${p.label}: ${p.freeTier} (${p.lane})`);
        return ask('setup-keys', line, async () => {
          const r = await impl.setupKeys(gaps, { port, nonce, say, out, fetchImpl, log });
          const m = read();
          if (m) await noteFreeTier(m);
          await say(`Done${r.stopped ? ' (stopped)' : ''}: ${r.stored.length} stored${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`);
        });
      }
      case 'save-key': {
        // A bare "save it" is the desk's only right after a key page was opened; otherwise it is the engine's.
        if (!intent.arg && (!lastProvider || now().getTime() - lastProvider.at > 30 * 60_000)) return null;
        let p = intent.arg ? null : lastProvider.p;
        if (intent.arg) { const c = await catalog(); p = c.ok ? matchCatalog(c.providers, intent.arg) : null; }
        if (!p) return null;
        lastProvider = { p, at: now().getTime() };
        return ask('save-key', `I'll read your clipboard once and seal it as your ${p.label} key. Say yes.`, async () => {
          const r = await impl.saveFromClipboard(p, { port, nonce, fetchImpl, log });
          await say(r.reason === 'CLIPBOARD_EMPTY' ? 'Your clipboard is empty, so nothing was stored.' : storedLine(p, r));
          const m = read();
          if (m && r.ok) await noteFreeTier(m);
        });
      }
      case 'install': {
        const map = read();
        const p = matchProposal(map, intent.arg);
        if (!p) { await say(`I have no proposal called ${intent.arg}. Say "what can you drive" for the list.`); return result(); }
        return ask('install', acquisitionReadBack(p), async () => {
          const r = await impl.handOff({ port, nonce, proposal: p, fetchImpl });
          if (!r.ok) { await say(`The engine did not take it: ${r.reason}`); return; }
          const m = read();
          const rec = m?.proposals?.find((x) => x.id === p.id);
          if (rec) { rec.state = 'handed-off'; rec.handedOffAt = now().toISOString(); save(m); }
          await say(`Handed to Kingmaker's acquisition loop: ${p.name} is studied in quarantine and rebuilt as our own ${p.app} tool. Nothing from it runs here until you approve what comes out.`);
        });
      }
      default: return null;
    }
  }

  return {
    handle,
    runBackground,
    runScan,
    runFind,
    setConsent,
    /**
     * Hold an action for the owner's word (the same gate every read-back uses: his typed yes at the console or bar, or his
     * voice when voice is his word; a no, or two minutes, drops it). The caller shows the read-back itself.
     */
    holdForOwner(kind, run) { pendingAsk = { kind, run, at: now().getTime() }; },
    /** Is a read-back waiting (a bare yes / no goes here first)? */
    pending() {
      if (pendingAsk && now().getTime() - pendingAsk.at > ASK_TTL_MS) pendingAsk = null;
      return Boolean(pendingAsk);
    },
    /** The owner's yes / no to the waiting read-back. */
    async answer(kind, who = {}) {
      if (!this.pending()) return null;
      if (kind !== 'yes') { pendingAsk = null; await say('Okay, I left it.'); return result(); }
      if (!ownerWord(who, voiceAuthority, approves())) { await say('That needs your word: type yes at the Kingmaker console, or say it in your own voice.'); return result(); }
      const run = pendingAsk.run;
      pendingAsk = null;
      await run();
      return result();
    },
    /** For a bare "I can't" from the engine: the closest capability Ghost has, and the proposal (never a bare can't). */
    capabilityLine(request, spoken) { return closestCapabilityLine(read(), request, spoken); },
    map: read,
    file,
  };
}

/** Pure: the doctor's short device section (read from the map: no scan, no network). */
export function deviceDoctorLines(map) {
  if (!map) return ['· device scan: not run yet (it runs in the background on the first start; or: kingmaker scan)'];
  const c = mapCounts(map);
  const lines = [`· device scan (${String(map.scannedAt ?? map.startedAt).slice(0, 16).replace('T', ' ')}${map.complete ? '' : ', resuming'}): ${c.apps} apps, ${c.direct} direct (CLI/MCP/engine), ${c.applescript} by AppleScript, ${c.urlScheme} by links, ${c.handsOnly} by the hands only; ${c.clis} CLIs, ${c.mcpServers} MCP servers; ${c.gaps} gaps, ${c.proposals} tools proposed${map.candidates?.consent?.granted ? '' : ' (online search off: say "find tools for my apps")'}`];
  if (map.keys) lines.push(`· API keys on this Mac: ${c.keys}${c.keys ? ` for ${providersLine(map.keys.byProvider)}` : ''}${map.keys.imported?.at ? ` (in the vault since ${String(map.keys.imported.at).slice(0, 10)})` : c.keys ? ' (not in the vault yet: say "put my keys in the vault")' : ''}${map.keys.freeTier?.gaps?.length ? `; free APIs with no key: ${map.keys.freeTier.labels.join(', ')} (say "set up my keys")` : ''}`);
  return lines;
}
