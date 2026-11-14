// ACCEPTANCE: live spoken audio → notes. A fake BROWSER PEER (the vendored werift, same stack the real CRM floor uses)
// joins Mia's FloorAudioBridge over a direct signalling relay, and streams Opus (encoded from a spoken WAV) exactly as a
// browser mic would. The bridge negotiates, receives the RTP, decodes Opus, down-samples 48→16 kHz, and hands Mia a PCM
// segment — which the installed whisper transcribes back to the spoken words. This is the end-to-end proof that Mia
// hears a room and can take notes from what was said; the audio never leaves this process.
//   node --test test/floor-participant-audio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FloorAudioBridge, loadWebrtc, downsample48to16, weOffer } from '../lib/floor-audio-webrtc.mjs';
import { wavToSamples } from '../lib/floor-participant.mjs';
import { transcribe } from '../../../lib/voice.mjs';

const WHISPER = process.env.SOL_GHOST_WHISPER || '/Applications/Kingmaker.app/Contents/Resources/voice-runtime/stt/whisper-cli';
const MODEL = process.env.SOL_GHOST_WHISPER_MODEL || '/Applications/Kingmaker.app/Contents/Resources/voice-runtime/models/stt/ggml-base.bin';
const VENDOR = fileURLToPath(new URL('../vendor/webrtc/webrtc-libs.mjs', import.meta.url));
const have = (bin) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const ready = process.platform === 'darwin' && existsSync(VENDOR) && existsSync(WHISPER) && existsSync(MODEL) && have('say') && have('afconvert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('talk-back: Mia speaks and the fake browser peer receives her audio', { skip: existsSync(VENDOR) ? false : 'vendored webrtc not available' }, async () => {
  const { RTCPeerConnection, MediaStreamTrack, OpusScript } = await loadWebrtc();
  const browser = new RTCPeerConnection({ iceServers: [] });
  const dec = new OpusScript(48000, 1, OpusScript.Application.AUDIO, { wasm: false });
  const captured = [];
  // Mia's synth: ~1s of a 48 kHz tone (deterministic, so this runs without whisper/TTS).
  const tone = () => { const n = 48000; const s = new Int16Array(n); for (let i = 0; i < n; i += 1) s[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 9000); return s; };
  let bridge;
  const onBrowserSignal = async (data) => { if (data.sdp) await browser.setRemoteDescription(data.sdp); else if (data.ice) await browser.addIceCandidate(data.ice); };
  const toMia = (data) => void bridge.onSignal('aa', data);
  // selfId 'mia' sorts after 'aa', so the browser offers and Mia ANSWERS sendrecv (she attaches her outbound track).
  bridge = new FloorAudioBridge({ selfId: 'mia', iceServers: [], talk: true, synth: async () => tone(), send: (m) => { if (m.to === 'aa') void onBrowserSignal(m.data); }, onSpeech: () => {} });
  browser.onIceCandidate.subscribe((e) => { const c = e?.candidate ?? e; if (c) toMia({ ice: c }); });
  browser.ontrack = (e) => { const t = e.track ?? e; if ((t.kind ?? e.kind) === 'audio') t.onReceiveRtp.subscribe((rtp) => { try { captured.push(dec.decode(Buffer.from(rtp.payload))); } catch { /* */ } }); };
  const mic = new MediaStreamTrack({ kind: 'audio' });
  browser.addTransceiver(mic, { direction: 'sendrecv' }); browser.addTransceiver('video', { direction: 'inactive' }); browser.addTransceiver('video', { direction: 'inactive' });
  const offer = await browser.createOffer(); await browser.setLocalDescription(offer); toMia({ sdp: browser.localDescription });
  for (let i = 0; i < 40 && browser.connectionState !== 'connected'; i += 1) await sleep(100);
  assert.equal(browser.connectionState, 'connected', 'the call connected');
  await bridge.speak('This is Mia speaking.');
  await sleep(300);
  await bridge.stop();
  let peak = 0; for (const p of captured) for (let n = 0; n < p.length; n += 2) { const v = Math.abs(p.readInt16LE(n)); if (v > peak) peak = v; }
  assert.ok(captured.length > 5 && peak > 1000, `Mia's outbound audio did not reach the peer (frames=${captured.length}, peak=${peak})`);
  browser.close();
});

test('weOffer / downsample48to16 are correct', () => {
  assert.equal(weOffer('ai:solomon.aaa', 'u-olivia.bbb'), true, 'ai: sorts first, so Mia offers');
  assert.equal(weOffer('zz', 'aa'), false);
  const d = downsample48to16(Int16Array.from([300, 300, 300, 900, 900, 900]));
  assert.deepEqual([...d], [300, 900]);
});

test('a fake browser peer streams spoken Opus → the bridge decodes it → whisper reads it back', { skip: ready ? false : 'whisper runtime / say / afconvert / vendored webrtc not available here' }, async () => {
  const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, OpusScript } = await loadWebrtc();
  const dir = mkdtempSync(join(tmpdir(), 'mia-audio-'));
  try {
    // A spoken line, synthesized to 48 kHz mono PCM (say -o writes a file; nothing is played aloud).
    const spoken = "Let's send the Riverside proposal on Monday";
    execFileSync('say', ['-o', join(dir, 'a.aiff'), spoken]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', join(dir, 'a.aiff'), join(dir, 'a.wav')]);
    const pcm48 = wavToSamples(readFileSync(join(dir, 'a.wav'))); // Int16 @ 48 kHz

    // Mia's real audio bridge. selfId 'mia' sorts AFTER the browser 'aa', so the browser offers and Mia answers.
    const captured = [];
    const browser = new RTCPeerConnection({ iceServers: [] });
    // Direct signalling relay between the two peers (stands in for the floor socket's {t:'signal'} relay).
    let bridge;
    const onBrowserSignal = async (data) => { if (data.sdp) await browser.setRemoteDescription(data.sdp); else if (data.ice) await browser.addIceCandidate(data.ice); };
    const toMia = (data) => void bridge.onSignal('aa', data);
    bridge = new FloorAudioBridge({ selfId: 'mia', iceServers: [], gapMs: 600, minSegMs: 400,
      send: (msg) => { if (msg.to === 'aa') void onBrowserSignal(msg.data); },
      onSpeech: (peerId, samples16k) => captured.push({ peerId, samples16k }) });
    browser.onIceCandidate.subscribe((e) => { const c = e?.candidate ?? e; if (c) toMia({ ice: c }); });

    // The browser offers 3 transceivers in the floor's fixed order [mic, camera, screen], mic sendonly.
    const mic = new MediaStreamTrack({ kind: 'audio' });
    const micTx = browser.addTransceiver(mic, { direction: 'sendonly' });
    browser.addTransceiver('video', { direction: 'inactive' });
    browser.addTransceiver('video', { direction: 'inactive' });
    const offer = await browser.createOffer(); await browser.setLocalDescription(offer); toMia({ sdp: browser.localDescription });
    // Wait for connection.
    for (let i = 0; i < 40 && browser.connectionState !== 'connected'; i += 1) await sleep(100);
    assert.equal(browser.connectionState, 'connected', 'the fake browser peer connected to Mia');

    // Stream the spoken audio as Opus, 20 ms frames, like a real mic.
    const enc = new OpusScript(48000, 1, OpusScript.Application.AUDIO, { wasm: false });
    const pt = micTx.sender.codecs?.[0]?.payloadType ?? 96;
    let seq = 1, ts = 0; const ssrc = 1_000_001;
    for (let off = 0; off + 960 <= pcm48.length; off += 960) {
      const frame = Buffer.from(pcm48.buffer, pcm48.byteOffset + off * 2, 960 * 2);
      const opus = enc.encode(frame, 960);
      mic.writeRtp(new RtpPacket(new RtpHeader({ version: 2, payloadType: pt, sequenceNumber: seq++ & 0xffff, timestamp: ts, ssrc, marker: off === 0 }), opus));
      ts += 960; await sleep(20);
    }
    // Let the gap timer flush the segment to onSpeech.
    for (let i = 0; i < 20 && !captured.length; i += 1) await sleep(100);
    await bridge.stop();
    assert.ok(captured.length >= 1, 'the bridge produced a speech segment');
    const seg = captured[0];
    assert.equal(seg.peerId, 'aa');
    assert.ok(seg.samples16k instanceof Int16Array && seg.samples16k.length > 16000, `expected ~1s+ of 16 kHz audio, got ${seg.samples16k?.length}`);

    // The whole point: the installed whisper reads the streamed speech back out.
    const text = await transcribe(seg.samples16k, { whisper: WHISPER, model: MODEL, language: 'en', prompt: 'Riverside proposal Monday' });
    assert.match(text.toLowerCase(), /riverside|proposal|monday/, `whisper did not recover the spoken words: ${JSON.stringify(text)}`);
    browser.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
