// Unit + integration proof for lib/floor-participant.mjs, against fakes (no CRM, no socket, no mic).
// Covers: the pure note builder and its helpers, the roster, the CRM MCP client's wire shape, and the orchestrator's
// whole join → record → wrap-up → meeting_propose flow (including the two voice modes and the auto-wrap on empty).
//   node --test test/floor-participant.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotes, parseDue, isWrapCommand, isAddressedTo, shouldTakeNotes, Roster,
  crmMcpClient, MeetingParticipant, resolveParticipantConfig, crmOrigin, wavToSamples, buildVocabPrompt, DEFAULT_NAME,
} from '../lib/floor-participant.mjs';
import { wavBytes } from '../../../lib/voice.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXED = Date.UTC(2026, 9, 16, 12, 0, 0); // a Friday noon UTC

test('parseDue reads everyday phrases, else null', () => {
  assert.equal(parseDue('nothing here', FIXED), null);
  assert.ok(parseDue('get it done by EOD', FIXED) > FIXED - 86400_000);
  const tom = parseDue('send it tomorrow', FIXED); const eod = parseDue('by end of day', FIXED);
  assert.ok(tom > eod, 'tomorrow is after today');
  assert.ok(parseDue('finish next week', FIXED) - FIXED >= 6 * 86400_000);
  assert.ok(parseDue('in 3 days', FIXED) - FIXED >= 2 * 86400_000);
  assert.ok(parseDue('have it by Monday', FIXED) > FIXED, 'a weekday resolves to a future date');
});

test('buildNotes extracts action items with owner, evidence and due; decisions; excludes Mia; dedups', () => {
  const utt = [
    { at: 1, speaker: 'Robbie', text: "Okay so I'll send the Pizza Studio quote by Friday" },
    { at: 2, speaker: 'Mia', text: 'Noted.' },
    { at: 3, speaker: 'Dana', text: 'Sam, can you draft the onboarding email' },
    { at: 4, speaker: 'Robbie', text: "Let's go with the green logo for the deck" },
    { at: 5, speaker: 'Dana', text: 'Sam, can you draft the onboarding email' }, // dup → one task
    { at: 6, speaker: 'Sam', text: 'um yeah sounds good' },
  ];
  const n = buildNotes(utt, { name: 'Mia', participants: ['Robbie', 'Dana', 'Sam'], now: FIXED });
  assert.equal(n.transcript.length, 6);
  const titles = n.tasks.map((t) => t.title);
  assert.ok(titles.some((t) => /send the pizza studio quote/i.test(t)), titles.join(' | '));
  assert.ok(titles.some((t) => /draft the onboarding email/i.test(t)));
  assert.equal(n.tasks.filter((t) => /onboarding/i.test(t.title)).length, 1, 'deduped');
  assert.ok(!n.tasks.some((t) => /noted/i.test(t.title)), "Mia's own line is never a task");
  const quote = n.tasks.find((t) => /quote/i.test(t.title));
  assert.equal(quote.owner, 'Robbie', "I'll → the speaker owns it");
  assert.ok(Number.isFinite(quote.due) && quote.due > FIXED, 'by Friday → a due timestamp');
  assert.deepEqual(quote.evidence, [0], 'evidence points at the transcript line');
  const email = n.tasks.find((t) => /onboarding/i.test(t.title));
  assert.equal(email.owner, 'Sam', 'named assignee is captured');
  assert.ok(n.decisions.some((d) => /green logo/i.test(d.text)));
  assert.ok(/action item/i.test(n.synopsis) && /•/.test(n.synopsis));
});

test('wrap-up and address detection require Mia to be named', () => {
  assert.ok(isWrapCommand('Mia, wrap it up', 'Mia'));
  assert.ok(isWrapCommand("okay Mia we're done here", 'Mia'));
  assert.ok(!isWrapCommand("let's wrap up folks", 'Mia'), 'not addressed to Mia');
  assert.ok(!isWrapCommand('Mia, what did we say about pricing', 'Mia'));
  assert.ok(isAddressedTo('hey Mia can you note that', 'Mia'));
  assert.ok(isAddressedTo('Mia, summarize please', 'Mia'));
  assert.ok(!isAddressedTo('the room agreed', 'Mia'));
});

test('shouldTakeNotes honors enabled + min_people', () => {
  assert.ok(shouldTakeNotes({ peopleCount: 2, settings: { enabled: true, min_people: 2 } }));
  assert.ok(!shouldTakeNotes({ peopleCount: 1, settings: { enabled: true, min_people: 2 } }));
  assert.ok(!shouldTakeNotes({ peopleCount: 5, settings: { enabled: false, min_people: 2 } }));
});

test('Roster counts distinct real people per room, excluding AI orbs', () => {
  const r = new Roster({ you: { id: 'ai:solomon.aaa', userId: 'ai:solomon', ai: true, room: 'hall' }, peers: [
    { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' },
    { id: 'u1.b', userId: 'u1', name: 'Robbie', room: 'owner' }, // same person, two tabs
    { id: 'u2.a', userId: 'u2', name: 'Dana', room: 'owner' },
    { id: 'seeker:owner', userId: 'ai:seeker', ai: true, room: 'owner' },
    { id: 'u3.a', userId: 'u3', name: 'Sam', room: 'lounge' },
  ] });
  assert.equal(r.peopleInRoom('owner').length, 2);
  r.onEvent({ t: 'moved', id: 'u3.a', room: 'owner', x: 1, y: 1, dir: 'down' });
  assert.equal(r.peopleInRoom('owner').length, 3);
  r.onEvent({ t: 'left', id: 'u2.a' });
  assert.equal(r.peopleInRoom('owner').length, 2);
});

test('crmMcpClient sends Bearer JSON-RPC and parses an SSE reply; rejects tool errors and a shut door', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const req = JSON.parse(opts.body);
    if (req.params.name === 'boom') return { status: 200, text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { isError: true, content: [{ type: 'text', text: 'nope' }] } })}\n` };
    if (req.params.name === 'closed') return { status: 401, text: async () => 'unauthorized' };
    return { status: 200, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: req.params.arguments }) }] } })}\n\n` };
  };
  const mcp = crmMcpClient({ url: 'https://crm.test/mcp/solomon', token: 'ronin_solomon_x', fetchImpl });
  const r = await mcp.callTool('office_ticket', { name: 'Mia' });
  assert.deepEqual(r, { ok: true, echo: { name: 'Mia' } });
  assert.equal(calls[0].opts.headers.authorization, 'Bearer ronin_solomon_x');
  assert.match(calls[0].opts.headers.accept, /text\/event-stream/);
  await assert.rejects(() => mcp.callTool('boom'), /nope/);
  await assert.rejects(() => mcp.callTool('closed'), /refused the token \(401\)/);
});

// ── a fake floor: the opener yields in-memory sockets; the test drives server→client messages ──
class FakeConn {
  constructor(url) { this.url = url; this.status = 101; this.sent = []; this._msg = []; this._close = []; this.closed = false; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; for (const cb of this._close) cb(); }
  onMessage(cb) { this._msg.push(cb); }
  onClose(cb) { this._close.push(cb); }
  deliver(obj) { const s = JSON.stringify(obj); for (const cb of this._msg) cb(s); }
}
function fakeFloor({ name = 'Mia' } = {}) {
  const conns = [];
  const opener = async (url) => {
    const c = new FakeConn(url);
    conns.push(c);
    setTimeout(() => c.deliver({ t: 'init', you: { id: `ai:solomon.${conns.length}`, userId: 'ai:solomon', ai: true, name, room: 'hall' }, peers: [], locks: {} }), 0);
    return c;
  };
  return { conns, opener };
}
function fakeMcp({ settings }) {
  const calls = [];
  let n = 0;
  const callTool = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'office_ticket') return { enabled: true, ticket: `tkt-${++n}`, settings, spots: { owner: { x: 10, y: 4 } }, ws_path: '/api/office/ws' };
    if (tool === 'meeting_propose') return { meeting_id: 'm-1', tasks: args.tasks.length, lines: args.transcript.length, status: 'proposed' };
    return {};
  };
  return { callTool, calls };
}

test('orchestrator: joins a room at its spot, records chat, and proposes on "Mia, wrap it up"', async () => {
  const floor = fakeFloor();
  const mcp = fakeMcp({ settings: { enabled: true, voice: 'listen', min_people: 2 } });
  const p = new MeetingParticipant({ mcp, name: 'Mia', wsBase: 'wss://crm.test/api/office/ws', openTransport: floor.opener });
  assert.equal(await p.start(), true);
  await sleep(20);
  const home = floor.conns[0];
  // Two people walk into the owner's office.
  home.deliver({ t: 'joined', peer: { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' } });
  home.deliver({ t: 'joined', peer: { id: 'u2.a', userId: 'u2', name: 'Dana', room: 'owner' } });
  await sleep(30);
  assert.ok(p.meetings.get('owner'), 'joined the room');
  const roomConn = floor.conns[1];
  const moved = roomConn.sent.find((m) => m.t === 'move');
  assert.deepEqual([moved.room, moved.x, moved.y], ['owner', 10, 4], 'walked to the orb spot');
  assert.ok(roomConn.sent.some((m) => m.t === 'media' && m.mic === false), 'visibly present, mic off');
  // A scripted exchange with an action item.
  roomConn.deliver({ t: 'chat', room: 'owner', name: 'Robbie', text: "I'll email Pizza Studio the quote by Friday" });
  roomConn.deliver({ t: 'chat', room: 'owner', name: 'Dana', text: 'sounds good' });
  roomConn.deliver({ t: 'chat', room: 'owner', name: 'Robbie', text: 'Mia, wrap it up' });
  await sleep(20);
  const propose = mcp.calls.find((c) => c.tool === 'meeting_propose');
  assert.ok(propose, 'meeting_propose was called');
  assert.equal(propose.args.room, 'owner');
  assert.ok(propose.args.ended_at >= propose.args.started_at);
  assert.ok(propose.args.transcript.length >= 2, 'transcript carries the said lines');
  assert.ok(propose.args.tasks.some((t) => /quote/i.test(t.title)), 'the action item is proposed');
  assert.ok(propose.args.participants.some((pp) => pp.name === 'Robbie'));
  assert.ok(roomConn.closed, 'left the room after wrapping');
  assert.ok(!p.meetings.get('owner'));
});

test('orchestrator: auto-wraps when the room empties below min_people', async () => {
  const floor = fakeFloor();
  const mcp = fakeMcp({ settings: { enabled: true, voice: 'listen', min_people: 2 } });
  const p = new MeetingParticipant({ mcp, name: 'Mia', wsBase: 'wss://crm.test/api/office/ws', openTransport: floor.opener });
  await p.start();
  await sleep(20);
  const home = floor.conns[0];
  home.deliver({ t: 'joined', peer: { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' } });
  home.deliver({ t: 'joined', peer: { id: 'u2.a', userId: 'u2', name: 'Dana', room: 'owner' } });
  await sleep(30);
  assert.ok(p.meetings.get('owner'));
  floor.conns[1].deliver({ t: 'chat', room: 'owner', name: 'Dana', text: 'we should schedule the demo for Monday' });
  home.deliver({ t: 'left', id: 'u2.a' }); // down to one person
  await sleep(20);
  assert.ok(mcp.calls.some((c) => c.tool === 'meeting_propose'), 'filed on empty');
  assert.ok(!p.meetings.get('owner'));
});

test('one-on-one call: joins on mia-called with a single person and proposes on mia-hungup', async () => {
  const floor = fakeFloor();
  const mcp = fakeMcp({ settings: { enabled: true, voice: 'full', min_people: 2 } });
  const p = new MeetingParticipant({ mcp, name: 'Mia', wsBase: 'wss://crm.test/api/office/ws', openTransport: floor.opener });
  await p.start();
  await sleep(20);
  const home = floor.conns[0];
  // One person is in the owner office — below min_people, so no meeting starts on its own.
  home.deliver({ t: 'joined', peer: { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' } });
  await sleep(20);
  assert.ok(!p.meetings.get('owner'), 'one person alone does not start a meeting');
  // They press "Call Mia".
  home.deliver({ t: 'mia-called', room: 'owner', by: 'u1.a', userId: 'u1', name: 'Robbie' });
  await sleep(30);
  assert.ok(p.meetings.get('owner'), 'an explicit call joins even with one person');
  const roomConn = floor.conns[1];
  roomConn.deliver({ t: 'chat', room: 'owner', name: 'Robbie', text: "I'll send the renewal quote on Monday" });
  await sleep(20);
  assert.ok(p.meetings.get('owner'), 'the call stays open with one person (not auto-wrapped)');
  // Hang up → filed like a meeting.
  home.deliver({ t: 'mia-hungup', room: 'owner', by: 'u1.a' });
  await sleep(20);
  const propose = mcp.calls.find((c) => c.tool === 'meeting_propose');
  assert.ok(propose, 'the call files notes like a meeting');
  assert.ok(propose.args.tasks.some((t) => /renewal quote/i.test(t.title)));
  assert.ok(!p.meetings.get('owner') && !p.calledRooms.has('owner'), 'left the call and cleared it');
});

test('voice modes: listen is silent; full answers a line addressed to Mia as chat', async () => {
  for (const voice of ['listen', 'full']) {
    const floor = fakeFloor();
    const mcp = fakeMcp({ settings: { enabled: true, voice, min_people: 2 } });
    const p = new MeetingParticipant({ mcp, name: 'Mia', wsBase: 'wss://crm.test/api/office/ws', openTransport: floor.opener, reply: async () => 'Two action items so far.' });
    await p.start();
    await sleep(20);
    const home = floor.conns[0];
    home.deliver({ t: 'joined', peer: { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' } });
    home.deliver({ t: 'joined', peer: { id: 'u2.a', userId: 'u2', name: 'Dana', room: 'owner' } });
    await sleep(30);
    const roomConn = floor.conns[1];
    const before = roomConn.sent.filter((m) => m.t === 'chat').length;
    roomConn.deliver({ t: 'chat', room: 'owner', name: 'Robbie', text: 'Mia, how many action items do we have?' });
    await sleep(20);
    const after = roomConn.sent.filter((m) => m.t === 'chat').length;
    if (voice === 'full') assert.equal(after, before + 1, 'full voice answers as chat');
    else assert.equal(after, before, 'listen voice stays silent');
  }
});

test('wavToSamples round-trips lib/voice.mjs wavBytes (the audio the STT path transcribes)', () => {
  const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768, 42]);
  const back = wavToSamples(wavBytes(pcm));
  assert.deepEqual([...back], [...pcm]);
  assert.throws(() => wavToSamples(Buffer.from('not a wav')));
});

test('audio path: feedAudio → on-Mac STT → labeled transcript line → proposed in the meeting', async () => {
  // The on-Mac STT (lib/voice.mjs transcribe / whisper) is stubbed here with a fake transcriber so the glue is proven
  // without the whisper runtime; on the launch Mac makeTranscriber wires the real one. Audio stays on the Mac — only the
  // note goes up. This is the labeled spoken-audio fixture path.
  const floor = fakeFloor();
  const mcp = fakeMcp({ settings: { enabled: true, voice: 'listen', min_people: 2 } });
  const SPOKEN = { Robbie: "I'll ship the pricing deck to the Titans by Thursday", Dana: 'we agreed to go with the annual plan' };
  const transcriber = async (samples, { speaker } = {}) => { assert.ok(samples instanceof Int16Array, 'STT gets PCM samples'); return SPOKEN[speaker] || ''; };
  const p = new MeetingParticipant({ mcp, name: 'Mia', wsBase: 'wss://crm.test/api/office/ws', openTransport: floor.opener, transcriber });
  await p.start();
  await sleep(20);
  const home = floor.conns[0];
  home.deliver({ t: 'joined', peer: { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' } });
  home.deliver({ t: 'joined', peer: { id: 'u2.a', userId: 'u2', name: 'Dana', room: 'owner' } });
  await sleep(30);
  assert.ok(p.meetings.get('owner'));
  // Spoken audio for each speaker (a fixture WAV decoded to PCM), fed through the STT seam.
  await p.feedAudio('owner', 'Robbie', wavToSamples(wavBytes(new Int16Array(1600))));
  await p.feedAudio('owner', 'Dana', wavToSamples(wavBytes(new Int16Array(1600))));
  await p.wrapUp('owner', 'asked');
  const propose = mcp.calls.find((c) => c.tool === 'meeting_propose');
  const lines = propose.args.transcript;
  assert.ok(lines.some((l) => l.speaker === 'Robbie' && /pricing deck/i.test(l.text)), 'the spoken line is transcribed and labeled');
  assert.ok(lines.some((l) => l.speaker === 'Dana' && /annual plan/i.test(l.text)));
  assert.ok(propose.args.tasks.some((t) => /ship the pricing deck/i.test(t.title)), 'the spoken action item is proposed');
});

test('buildVocabPrompt merges base + names, dedups case-insensitively, bounds length', () => {
  const p = buildVocabPrompt('Kingmaker, Orosolu', ['Ericka', 'Pizza Studio', 'ericka', 'Taco la Lomita']);
  assert.match(p, /Kingmaker/); assert.match(p, /Pizza Studio/); assert.match(p, /Taco la Lomita/);
  assert.equal((p.match(/ericka/gi) || []).length, 1, 'deduped case-insensitively');
  assert.ok(buildVocabPrompt('x'.repeat(2000), []).length <= 900);
});

test('feedAudio biases whisper with the meeting vocabulary: base + roster names + the CRM\'s own names', async () => {
  const floor = fakeFloor();
  const mcp = fakeMcp({ settings: { enabled: true, voice: 'listen', min_people: 2 } });
  let seenPrompt = null;
  const transcriber = async (_samples, { prompt } = {}) => { seenPrompt = prompt; return 'noted'; };
  const p = new MeetingParticipant({ mcp, name: 'Mia', wsBase: 'wss://crm.test/api/office/ws', openTransport: floor.opener,
    transcriber, vocab: 'Kingmaker', vocabProvider: async () => ['Pizza Studio', 'Taco la Lomita'] });
  await p.start();
  await sleep(20);
  const home = floor.conns[0];
  home.deliver({ t: 'joined', peer: { id: 'u1.a', userId: 'u1', name: 'Robbie', room: 'owner' } });
  home.deliver({ t: 'joined', peer: { id: 'u2.a', userId: 'u2', name: 'Ericka', room: 'owner' } });
  await sleep(30);
  await p.feedAudio('owner', 'Ericka', new Int16Array(1600));
  assert.ok(seenPrompt, 'transcriber received a prompt');
  for (const term of ['Kingmaker', 'Robbie', 'Ericka', 'Pizza Studio', 'Taco la Lomita']) assert.match(seenPrompt, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${term} in the whisper vocab`);
});

test('resolveParticipantConfig + crmOrigin read env', () => {
  const cfg = resolveParticipantConfig({ env: { RONIN_CRM_MCP_URL: 'https://www.ronininc.org/mcp/solomon', RONIN_CRM_MCP_TOKEN: 't', KINGMAKER_FLOOR_NAME: 'Mia' } });
  assert.equal(cfg.mcpUrl, 'https://www.ronininc.org/mcp/solomon');
  assert.equal(cfg.token, 't');
  assert.equal(cfg.name, 'Mia');
  assert.equal(crmOrigin(cfg.mcpUrl), 'https://www.ronininc.org');
});

test('ships neutral: no default CRM, no Mia, no Ronin/Orosolu wiring', () => {
  assert.equal(DEFAULT_NAME, 'Notes', 'the default assistant name is neutral, not Mia');
  const cfg = resolveParticipantConfig({ env: {} });
  assert.equal(cfg.mcpUrl, null, 'no CRM until one is configured');
  assert.equal(cfg.token, null);
  assert.equal(cfg.name, 'Notes');
  // Nothing in the module source hardcodes a Ronin/Orosolu host or the name Mia as a default.
});
