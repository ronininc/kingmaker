#!/usr/bin/env node
// scripts/floor-participant.mjs — run "Mia, backed by Kingmaker" on the office floor.
//
// Resolves where the CRM is and the owner-minted MCP token, then starts lib/floor-participant.mjs: Mia watches the
// floor, joins a room call when it holds a meeting (note-taking on, >= min_people), transcribes on this Mac, and
// proposes tasks the owner approves at the orb. Audio and the full transcript stay on the Mac; only the notes go up.
//
// Kingmaker ships NO CRM and NO assistant identity — this docks to whatever CRM floor the person configures, under the
// name they choose (default "Notes"). Not wired into lib/cli.mjs (the paid Notes add-on installs + wires it). Run directly:
//   RONIN_CRM_MCP_URL=<your CRM>/mcp RONIN_CRM_MCP_TOKEN=<token your CRM minted for this Mac> \
//   node scripts/floor-participant.mjs --name "Mia"
// (The RONIN_* env names are kept for compatibility but take any CRM's values. To read the token from Keychain instead,
//  set KINGMAKER_FLOOR_KEYCHAIN_SERVICE / _ACCOUNT. Nothing points at Ronin or Orosolu by default.)
//
// STT: set SOL_GHOST_WHISPER and SOL_GHOST_WHISPER_MODEL to turn on on-Mac transcription of room audio once a WebRTC
// track source is wired (the audio seam is MeetingParticipant.feedAudio). Without them, Mia records the room's chat.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { crmMcpClient, resolveParticipantConfig, crmOrigin, MeetingParticipant, makeTranscriber, wavToSamples, DEFAULT_NAME } from '../lib/floor-participant.mjs';
import { makeSpeaker } from '../lib/floor-audio-webrtc.mjs';
import { turn as engineTurn } from '../../../lib/client.mjs';

function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
/** Repeatable `--fixture room:Speaker:/path.wav`: a LABELLED spoken-audio fixture fed through the on-Mac STT seam (for a
 *  demo while the live WebRTC room-audio source is not wired). Needs whisper (SOL_GHOST_WHISPER + model) to produce text. */
function fixtures() {
  const out = [];
  process.argv.forEach((v, i) => { if (v === '--fixture' && process.argv[i + 1]) { const m = /^([^:]+):([^:]+):(.+)$/.exec(process.argv[i + 1]); if (m) out.push({ room: m[1], speaker: m[2], path: m[3] }); } });
  return out;
}

/** Best-effort macOS Keychain token, ONLY when the person points at a Keychain item themselves — no built-in CRM. Set
 *  KINGMAKER_FLOOR_KEYCHAIN_SERVICE (and optionally _ACCOUNT) to read it; unset, nothing is read and no CRM is assumed. */
function keychainToken(env = process.env) {
  const service = env.KINGMAKER_FLOOR_KEYCHAIN_SERVICE;
  if (process.platform !== 'darwin' || !service) return null;
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-a', env.KINGMAKER_FLOOR_KEYCHAIN_ACCOUNT || 'token', '-w'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

async function main() {
  const cfg = resolveParticipantConfig({ env: process.env });
  const name = arg('--name') || cfg.name || DEFAULT_NAME;
  const mcpUrl = arg('--mcp-url') || cfg.mcpUrl;
  const token = cfg.token || keychainToken();
  if (!mcpUrl) { console.error('No CRM floor configured. Set RONIN_CRM_MCP_URL to your CRM\'s /mcp endpoint (or pass --mcp-url). Kingmaker ships with no CRM.'); process.exit(2); }
  if (!token) { console.error('No MCP token. Set RONIN_CRM_MCP_TOKEN to a token your CRM minted for this Mac (or set KINGMAKER_FLOOR_KEYCHAIN_SERVICE to read it from Keychain).'); process.exit(2); }

  const mcp = crmMcpClient({ url: mcpUrl, token });
  const wsBase = `${crmOrigin(mcpUrl)}/api/office/ws`;
  const transcriber = makeTranscriber({
    transcribe: process.env.SOL_GHOST_WHISPER ? (await import('../../../lib/voice.mjs')).transcribe : null,
    whisper: process.env.SOL_GHOST_WHISPER, model: process.env.SOL_GHOST_WHISPER_MODEL,
    prompt: process.env.KINGMAKER_FLOOR_VOCAB || '',
  });
  const log = (event, data) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  // Per-meeting whisper vocabulary: the CRM's own names (merchants/contacts/campaigns) so homophones resolve the way the
  // owner spells them. Best-effort reads; unknown tools on a given CRM just error and are skipped. Only when STT runs.
  const vocabProvider = transcriber ? async () => {
    const names = new Set();
    for (const [tool, args, keys] of [['find_merchants', { limit: 500 }, ['merchants']], ['list_leads', { limit: 500 }, ['leads']], ['list_campaigns', {}, ['campaigns']], ['situation_report', {}, []]]) {
      try { const r = await mcp.callTool(tool, args); for (const k of keys) for (const row of (r?.[k] || [])) if (row?.name) names.add(String(row.name)); } catch { /* tool absent or errored on this CRM */ }
    }
    return [...names].slice(0, 300);
  } : null;
  // Spoken talk-back (voice "full"): synthesize the reply on the Mac (Kokoro, else `say`) and stream it as the call's
  // outbound audio. The WORDS come from Kingmaker's local engine turn when a port is set (KINGMAKER_PORT/SOL_GHOST_PORT);
  // with no engine reachable she stays silent rather than make something up.
  const speaker = makeSpeaker({ synthesizeKokoroWav: async (t) => (await import('../../../lib/voice.mjs')).synthesizeKokoroWav(t) });
  const enginePort = Number(process.env.KINGMAKER_PORT || process.env.SOL_GHOST_PORT || 0) || null;
  let convId = null;
  const reply = enginePort ? async (text) => { try { const r = await engineTurn(enginePort, { text, conversationId: convId, mode: 'text' }); convId = r.conversationId || convId; return r.spoken || ''; } catch { return ''; } } : null;
  const participant = new MeetingParticipant({ mcp, name, wsBase, transcriber, speaker, reply, log, vocab: process.env.KINGMAKER_FLOOR_VOCAB || '', vocabProvider });

  const ok = await participant.start();
  if (!ok) { console.error('Mia could not get onto the floor (switched off, bad token, or the CRM is unreachable).'); process.exit(1); }
  console.log(`${name} is on the floor at ${wsBase}. Ctrl-C to leave.`);

  // Demo fixtures: once Mia is in each named room, feed the WAV through the STT seam (labelled, not live audio).
  const fx = fixtures();
  if (fx.length && !transcriber) console.warn('--fixture needs whisper (SOL_GHOST_WHISPER + SOL_GHOST_WHISPER_MODEL) to transcribe; ignoring.');
  for (const f of (transcriber ? fx : [])) {
    (async () => {
      for (let i = 0; i < 120 && !participant.meetings.get(f.room); i += 1) await new Promise((r) => setTimeout(r, 500));
      if (!participant.meetings.get(f.room)) { console.warn(`fixture: Mia never joined ${f.room}; not fed`); return; }
      console.log(JSON.stringify({ event: 'fixture_feed', room: f.room, speaker: f.speaker, wav: f.path, note: 'LABELLED spoken-audio fixture (not live WebRTC)' }));
      try { await participant.feedAudio(f.room, f.speaker, wavToSamples(readFileSync(f.path))); } catch (e) { console.warn(`fixture ${f.path}: ${e?.message || e}`); }
    })();
  }
  const bye = async () => { await participant.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

main().catch((e) => { console.error(e?.stack || e?.message || e); process.exit(1); });
