// lib/floor-audio-webrtc.mjs — the live room-audio transport for "Mia": she joins the floor call's mesh WebRTC as an AI
// peer, receives each person's microphone track, and hands the decoded speech to the on-Mac STT. This is the piece that
// lets her take notes from what people SAY (not just room chat). Audio never leaves the Mac — only the notes do.
//
// The room-call client is the CRM's public/voice.js (mesh: everyone in a room connects to everyone else). Its contract,
// confirmed with the Orosolu session:
//   • Signalling rides the floor WebSocket: send {t:'signal', to:<peerId>, data:{sdp}|{ice}|{restart:true}}; you receive
//     the same as {t:'signal', from, data}. Messages whose data has `th` are the auditorium (theater.js) — ignored.
//   • The peer with the SMALLER id (plain string compare) makes the offer; the other answers. Mia both offers and answers.
//   • Each connection has three transceivers in fixed m-line order: [0] mic (audio), [1] camera, [2] screen. Mia answers
//     audio recvonly and leaves video inactive, keeping the order so the m-lines line up.
//   • Browsers send Opus (48 kHz). We depacketize per peer, decode to PCM, down-sample to 16 kHz, and segment on pauses
//     into utterances for whisper.
//   • ICE servers come from office_ticket (same as /api/rtc/ice).
//
// The WebRTC + Opus stack is vendored (vendor/webrtc/webrtc-libs.mjs, built by scripts/build-webrtc-vendor.sh), loaded
// lazily so the engine's core pulls in nothing unless a meeting actually needs audio. All timing/IO is injectable.

import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _libs = null;
/** The vendored WebRTC + Opus stack (werift + opusscript). Falls back to bare node_modules in a dev checkout. */
export async function loadWebrtc() {
  if (_libs) return _libs;
  const vendor = new URL('../vendor/webrtc/webrtc-libs.mjs', import.meta.url);
  try { _libs = await import(vendor.href); }
  catch {
    const werift = await import('werift'); const opus = await import('opusscript');
    _libs = { RTCPeerConnection: werift.RTCPeerConnection, MediaStreamTrack: werift.MediaStreamTrack, RtpPacket: werift.RtpPacket, RtpHeader: werift.RtpHeader, OpusScript: opus.default };
  }
  return _libs;
}

/** Down-sample 48 kHz Int16 PCM to 16 kHz by averaging each group of 3 samples (whisper wants 16 kHz mono). Pure. */
export function downsample48to16(int16at48k) {
  const n = Math.floor(int16at48k.length / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = ((int16at48k[i * 3] + int16at48k[i * 3 + 1] + int16at48k[i * 3 + 2]) / 3) | 0;
  return out;
}

/** True when Mia (selfId) is the one who offers to peerId (the smaller id offers; plain string compare, as voice.js does). */
export const weOffer = (selfId, peerId) => String(selfId) < String(peerId);

/** Read a 16-bit mono PCM WAV → { samples: Int16Array, rate }. For TTS output of any sample rate. Throws otherwise. */
export function readWav(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4); const size = b.readUInt32LE(off + 4); const body = off + 8;
    if (id === 'fmt ') fmt = { audioFormat: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = { start: body, size: Math.min(size, b.length - body) };
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data');
  if (fmt.audioFormat !== 1 || fmt.bits !== 16 || fmt.channels !== 1) throw new Error(`need 16-bit mono PCM (got ${fmt.audioFormat}/${fmt.bits}bit/${fmt.channels}ch)`);
  const n = data.size >> 1; const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = b.readInt16LE(data.start + i * 2);
  return { samples: out, rate: fmt.rate };
}

/** Resample Int16 mono to 48 kHz (linear) — the rate the room-call Opus track runs at. Pure. */
export function resampleTo48k(samples, rate) {
  if (rate === 48000 || !samples.length) return samples;
  const ratio = 48000 / rate; const n = Math.max(1, Math.floor(samples.length * ratio)); const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) { const src = i / ratio; const i0 = Math.floor(src); const f = src - i0; const a = samples[i0] ?? 0; const bb = samples[i0 + 1] ?? a; out[i] = (a + (bb - a) * f) | 0; }
  return out;
}

/** A speaker: text → 48 kHz Int16 PCM on the Mac, for Mia's outbound call audio. Prefers Kokoro (the voice runtime),
 *  falls back to Apple `say`; both synthesize to a file (nothing is played on the speakers). Returns null if neither works. */
export function makeSpeaker({ synthesizeKokoroWav = null, allowSay = true } = {}) {
  return async (text) => {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!line) return null;
    if (synthesizeKokoroWav) {
      const r = await synthesizeKokoroWav(line).catch(() => null);
      if (r?.out && existsSync(r.out)) { try { const { samples, rate } = readWav(readFileSync(r.out)); return resampleTo48k(samples, rate); } catch { /* fall through */ } finally { try { rmSync(r.dir, { recursive: true, force: true }); } catch { /* */ } } }
    }
    if (allowSay && process.platform === 'darwin') {
      const dir = mkdtempSync(join(tmpdir(), 'km-tts-'));
      try { const aiff = join(dir, 's.aiff'); const wav = join(dir, 's.wav'); execFileSync('say', ['-o', aiff, line]); execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav]); return readWav(readFileSync(wav)).samples; }
      catch { return null; } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
    }
    return null;
  };
}

const AT = () => Date.now();
const noop = () => {};

/**
 * One Mia-side mesh of audio-only PeerConnections over a floor room socket. Give it selfId (Mia's room-socket tab id),
 * send (posts a {t:'signal',…} object on that socket), iceServers (from office_ticket), and onSpeech(peerId, samples16k)
 * — called with a segment of one speaker's 16 kHz PCM whenever they pause. Drive membership with peerEntered/peerLeft and
 * feed inbound {t:'signal'} to onSignal. All audio decoding stays in this process.
 */
export class FloorAudioBridge {
  constructor({ selfId, send, iceServers = [], onSpeech, now = AT, log = noop, gapMs = 800, maxSegMs = 12_000, minSegMs = 600, talk = false, synth = null } = {}) {
    if (!selfId) throw new Error('FloorAudioBridge needs selfId (Mia\'s room-socket tab id).');
    if (typeof send !== 'function') throw new Error('FloorAudioBridge needs send().');
    this.selfId = selfId; this.send = send; this.iceServers = iceServers; this.onSpeech = onSpeech || noop;
    this.now = now; this.log = log; this.gapMs = gapMs; this.maxSegMs = maxSegMs; this.minSegMs = minSegMs;
    // talk = Mia may SPEAK back in this room (voice "full"): her audio transceiver is sendrecv and she streams TTS out.
    this.talk = talk && typeof synth === 'function'; this.synth = synth;
    this.peers = new Map(); // peerId → { pc, decoder, buf:[Int16Array@48k], ms, gapTimer, outTrack?, outSeq, outTs, outSsrc, outPt }
    this.closed = false; this.speaking = false;
    this.lib = null;
  }

  async #libs() { this.lib ??= await loadWebrtc(); return this.lib; }

  async #pc(peerId) {
    let p = this.peers.get(peerId);
    if (p) return p;
    const { RTCPeerConnection, OpusScript, MediaStreamTrack } = await this.#libs();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    p = { pc, codec: new OpusScript(48000, 1, OpusScript.Application.AUDIO, { wasm: false }), buf: [], ms: 0, gapTimer: null };
    p.decoder = p.codec; // one OpusScript instance both decodes inbound and encodes Mia's outbound audio
    if (this.talk) { p.outTrack = new MediaStreamTrack({ kind: 'audio' }); p.outSeq = 1; p.outTs = 0; p.outSsrc = (Math.random() * 0x7fffffff) | 0; p.outPt = null; }
    this.peers.set(peerId, p);
    pc.onIceCandidate.subscribe((e) => { const c = e?.candidate ?? e; if (c && !this.closed) this.send({ t: 'signal', to: peerId, data: { ice: c } }); });
    pc.ontrack = (e) => { const track = e.track ?? e; if ((track.kind ?? e.kind) === 'audio') track.onReceiveRtp.subscribe((rtp) => this.#onRtp(peerId, rtp)); };
    return p;
  }

  /** A person walked into the room. If Mia's id sorts lower she offers; otherwise she waits for their offer. */
  async peerEntered(peerId) {
    if (this.closed || peerId === this.selfId || this.peers.has(peerId)) return;
    if (!weOffer(this.selfId, peerId)) return; // they offer; onSignal will build the PC
    try {
      const p = await this.#pc(peerId); const pc = p.pc;
      if (this.talk && p.outTrack) pc.addTransceiver(p.outTrack, { direction: 'sendrecv' }); // [0] mic: send Mia + receive them
      else pc.addTransceiver('audio', { direction: 'recvonly' }); // [0] mic: listen only
      pc.addTransceiver('video', { direction: 'recvonly' }); // [1] camera
      pc.addTransceiver('video', { direction: 'recvonly' }); // [2] screen
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      this.send({ t: 'signal', to: peerId, data: { sdp: pc.localDescription } });
    } catch (e) { this.log('audio_offer_error', { peerId, error: String(e?.message || e) }); }
  }

  /** An inbound {t:'signal'} for Mia from peerId (ignore the auditorium's th-tagged messages). */
  async onSignal(peerId, data) {
    if (this.closed || !data || data.th) return;
    try {
      if (data.sdp) {
        const p = await this.#pc(peerId); const pc = p.pc;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          if (this.talk && p.outTrack) { const tx = pc.getTransceivers()[0]; if (tx) { try { tx.direction = 'sendrecv'; } catch { /* */ } try { tx.sender.replaceTrack(p.outTrack); } catch { /* */ } } } // answer sendrecv so Mia can talk
          const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); this.send({ t: 'signal', to: peerId, data: { sdp: pc.localDescription } });
        }
      } else if (data.ice) {
        const p = this.peers.get(peerId); if (p) await p.pc.addIceCandidate(data.ice);
      } else if (data.restart && weOffer(this.selfId, peerId)) {
        const p = this.peers.get(peerId); if (p) { const offer = await p.pc.createOffer({ iceRestart: true }); await p.pc.setLocalDescription(offer); this.send({ t: 'signal', to: peerId, data: { sdp: p.pc.localDescription } }); }
      }
    } catch (e) { this.log('audio_signal_error', { peerId, error: String(e?.message || e) }); }
  }

  #onRtp(peerId, rtp) {
    const p = this.peers.get(peerId); if (!p || this.closed) return;
    let pcm; try { pcm = p.decoder.decode(Buffer.from(rtp.payload)); } catch { return; } // a lost/garbled frame: skip it
    if (!pcm?.length) return;
    p.buf.push(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2));
    p.ms += (pcm.length / 2) / 48; // 48 samples per ms at 48 kHz
    if (p.gapTimer) { clearTimeout(p.gapTimer); p.gapTimer = null; }
    if (p.ms >= this.maxSegMs) { this.#flush(peerId); return; }
    p.gapTimer = setTimeout(() => this.#flush(peerId), this.gapMs); p.gapTimer?.unref?.();
  }

  #flush(peerId) {
    const p = this.peers.get(peerId); if (!p) return;
    if (p.gapTimer) { clearTimeout(p.gapTimer); p.gapTimer = null; }
    const ms = p.ms; const frames = p.buf; p.buf = []; p.ms = 0;
    if (!frames.length || ms < this.minSegMs) return; // too short to be speech
    let total = 0; for (const f of frames) total += f.length;
    const at48 = new Int16Array(total); let o = 0; for (const f of frames) { at48.set(f, o); o += f.length; }
    try { this.onSpeech(peerId, downsample48to16(at48)); } catch (e) { this.log('audio_onspeech_error', { peerId, error: String(e?.message || e) }); }
  }

  /** Mia talks: synthesize `text` on the Mac and stream it as Opus out to every connected caller, in real time. Only
   *  when talk is on (voice "full"); one utterance at a time. Audio is generated and sent here — nothing is played on
   *  the Mac's own speakers. Resolves when the line has been streamed. */
  async speak(text) {
    if (this.closed || !this.talk || this.speaking) return false;
    const peers = [...this.peers.values()].filter((p) => p.outTrack && p.pc.connectionState === 'connected');
    if (!peers.length) return false;
    let samples; try { samples = await this.synth(text); } catch { samples = null; }
    if (!samples?.length) return false;
    this.speaking = true;
    try {
      const { RtpPacket, RtpHeader } = await this.#libs();
      for (const p of peers) p.outPt ??= p.pc.getTransceivers()[0]?.sender?.codecs?.[0]?.payloadType ?? 96;
      for (let off = 0; off + 960 <= samples.length; off += 960) {
        if (this.closed) break;
        const frame = Buffer.from(samples.buffer, samples.byteOffset + off * 2, 960 * 2);
        for (const p of peers) {
          let opus; try { opus = p.codec.encode(frame, 960); } catch { continue; }
          try { p.outTrack.writeRtp(new RtpPacket(new RtpHeader({ version: 2, payloadType: p.outPt, sequenceNumber: p.outSeq++ & 0xffff, timestamp: p.outTs, ssrc: p.outSsrc, marker: off === 0 }), opus)); } catch { /* peer gone */ }
          p.outTs += 960;
        }
        await new Promise((r) => setTimeout(r, 20)); // pace at real time (20 ms frames)
      }
      return true;
    } finally { this.speaking = false; }
  }

  peerLeft(peerId) {
    const p = this.peers.get(peerId); if (!p) return;
    this.#flush(peerId);
    try { p.pc.close(); } catch { /* closed */ }
    this.peers.delete(peerId);
  }

  async stop() {
    this.closed = true;
    for (const peerId of [...this.peers.keys()]) { try { this.#flush(peerId); } catch { /* */ } try { this.peers.get(peerId)?.pc.close(); } catch { /* */ } }
    this.peers.clear();
  }
}
