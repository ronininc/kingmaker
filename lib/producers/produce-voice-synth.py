# Voice-synthesis producer — the voice-synthesize tool's engine: the stack's
# TTS leg, Kokoro-82M through the shipped voice runtime's ONNX sidecar
# (kokoro_onnx_tts.py + solomon_g2p), fully local, weights already on the
# node. The sidecar is driven over its own JSON-lines protocol as a child
# process: the same GPL-clean phonemisation path the shipped product uses
# (misaki + spaCy via solomon_g2p, never kokoro-onnx's espeak tokenizer).
#
# Contract: argv --out <jobDir> (--text <text> | --line <line> [--line ...])
# [--voice <name>] [--speed <float>] [--pause-ms <int>]; writes output.wav
# + output.meta.json (outputSha256 in meta, a per-line timing map measured
# from the synthesized samples), rewrites both INCREMENTALLY after every
# line with meta.complete false until the last, prints progress lines, and
# exits non-zero with a named reason on failure. Lines longer than
# CHUNK_CHARS are split at sentence boundaries under the hood — the timing
# map still reports the caller's lines, so an assembly can sync to them.
#
# Bindings (environment, node-local; a missing binding is a named error,
# never a download and never a fabricated artifact):
#   KINGMAKER_KOKORO_MODEL    — kokoro-v1.0.onnx path
#   KINGMAKER_KOKORO_VOICES   — voices-v1.0.bin path
#   KINGMAKER_KOKORO_SIDECAR  — dir holding kokoro_onnx_tts.py + solomon_g2p.py
import argparse, hashlib, json, os, re, subprocess, sys, time, wave
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--text")
ap.add_argument("--line", action="append", dest="lines")
ap.add_argument("--voice", default="am_adam")
ap.add_argument("--speed", type=float, default=1.0)
ap.add_argument("--pause-ms", type=int, default=350)
cli = ap.parse_args()

OUT = Path(cli.out)
OUT.mkdir(parents=True, exist_ok=True)
LINES = cli.lines if cli.lines else ([cli.text] if cli.text else [])
LINES = [str(x).strip() for x in LINES if str(x).strip()]
if not LINES:
    print("voice-synthesize: no text given", file=sys.stderr)
    sys.exit(2)
PAUSE_MS = max(0, min(3000, cli.pause_ms))
CHUNK_CHARS = 300

MODEL = os.environ.get("KINGMAKER_KOKORO_MODEL", "")
VOICES = os.environ.get("KINGMAKER_KOKORO_VOICES", "")
SIDECAR_DIR = os.environ.get("KINGMAKER_KOKORO_SIDECAR", "")
for label, path in (("KINGMAKER_KOKORO_MODEL", MODEL), ("KINGMAKER_KOKORO_VOICES", VOICES)):
    if not path or not Path(path).is_file():
        print(f"voice-synthesize: kokoro binding missing — {label} does not name a file (got {path!r}); "
              "the weights are node-local and are never downloaded by this producer", file=sys.stderr)
        sys.exit(2)
SIDECAR = Path(SIDECAR_DIR) / "kokoro_onnx_tts.py" if SIDECAR_DIR else None
if SIDECAR is None or not SIDECAR.is_file():
    print(f"voice-synthesize: kokoro binding missing — KINGMAKER_KOKORO_SIDECAR does not name a dir "
          f"holding kokoro_onnx_tts.py (got {SIDECAR_DIR!r})", file=sys.stderr)
    sys.exit(2)

def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()

def split_chunks(text):
    """One caller line -> synthesis chunks of <= CHUNK_CHARS, split at
    sentence boundaries where possible, hard-split only as a last resort."""
    if len(text) <= CHUNK_CHARS:
        return [text]
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    chunks, cur = [], ""
    for s in sentences:
        if len(s) > CHUNK_CHARS:
            if cur:
                chunks.append(cur); cur = ""
            for i in range(0, len(s), CHUNK_CHARS):
                chunks.append(s[i:i + CHUNK_CHARS])
        elif len(cur) + (1 if cur else 0) + len(s) <= CHUNK_CHARS:
            cur = f"{cur} {s}" if cur else s
        else:
            chunks.append(cur); cur = s
    if cur:
        chunks.append(cur)
    return chunks

def read_wav_pcm(path):
    with wave.open(str(path), "rb") as w:
        return w.getframerate(), w.getnchannels(), w.readframes(w.getnframes())

# ── the sidecar session ──────────────────────────────────────────────────
env = dict(os.environ)
env["SOLOMON_KOKORO_ONNX_MODEL"] = MODEL
env["SOLOMON_KOKORO_ONNX_VOICES"] = VOICES
env.setdefault("ORT_INTRA_OP_NUM_THREADS", "3")
t_load = time.time()
proc = subprocess.Popen(
    [sys.executable, str(SIDECAR)],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, env=env, cwd=str(SIDECAR_DIR),
)

def rpc(cmd, timeout_s=1200):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("kokoro sidecar closed its output stream")
        ev = json.loads(line)
        # The shipped sidecar announces tts.ready twice (once at load, once for
        # the ready op). Any ready event that is not the answer to a ready op is
        # an announcement, not a result: skip it rather than misreading it as
        # the next command's response (which reports as a reasonless failure).
        if ev.get("event") == "tts.ready" and cmd.get("op") != "ready":
            continue
        return ev

try:
    ready = rpc({"op": "ready"}, timeout_s=600)
    if ready.get("event") != "tts.ready":
        print(f"voice-synthesize: kokoro sidecar failed to load: {ready}", file=sys.stderr)
        sys.exit(1)
    voices = ready.get("voices", [])
    if cli.voice not in voices:
        print(f"voice-synthesize: unknown voice {cli.voice!r} — the weights carry {len(voices)} voices", file=sys.stderr)
        sys.exit(2)
    load_s = time.time() - t_load
    print(f"kokoro sidecar ready in {load_s:.1f}s: {len(voices)} voices, phonemizer {ready.get('phonemizer')}, "
          f"copyleft linked: {ready.get('copyleft')}", flush=True)

    SR = None
    assembled = bytearray()
    lines_meta = []
    cursor = 0.0  # seconds into the assembled output
    t_synth = time.time()

    def write_artifact(complete):
        out_path = OUT / "output.wav"
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(bytes(assembled))
        data = out_path.read_bytes()
        meta = {
            "tool": "kokoro-onnx (kokoro-v1.0.onnx via kokoro_onnx_tts sidecar; misaki G2P via solomon_g2p)",
            "voice": cli.voice, "speed": cli.speed, "pauseMs": PAUSE_MS,
            "sampleRate": SR, "channels": 1,
            "durationSec": round(len(assembled) / 2 / SR, 3),
            "inputChars": sum(len(x) for x in LINES),
            "lines": lines_meta, "complete": complete,
            "modelLoadSec": round(load_s, 1),
            "outputBytes": len(data), "outputSha256": sha256_bytes(data),
        }
        (OUT / "output.meta.json").write_text(json.dumps(meta, indent=2))
        return meta

    for li, line in enumerate(LINES):
        line_start = cursor
        rms_acc, n_chunks = [], 0
        for ci, chunk in enumerate(split_chunks(line)):
            tmp = OUT / f".chunk-{li}-{ci}.wav"
            ev = rpc({"op": "synthesize", "text": chunk, "out": str(tmp),
                      "voice": cli.voice, "speed": cli.speed})
            if ev.get("event") != "tts.synthesized":
                print(f"voice-synthesize: synthesis failed on line {li + 1}: "
                      f"{ev.get('reason') or ev.get('event') or 'unknown'} {ev.get('detail', '')}".strip(), file=sys.stderr)
                sys.exit(1)
            sr, ch, pcm = read_wav_pcm(tmp)
            if SR is None:
                SR = sr
            elif sr != SR:
                print(f"voice-synthesize: sample rate changed mid-run ({SR} -> {sr})", file=sys.stderr)
                sys.exit(1)
            if ch != 1:
                print(f"voice-synthesize: expected mono audio, got {ch} channels", file=sys.stderr)
                sys.exit(1)
            assembled += pcm
            cursor += (len(pcm) / 2) / sr
            rms_acc.append(ev.get("rms", 0))
            n_chunks += 1
            tmp.unlink(missing_ok=True)
        lines_meta.append({
            "index": li, "text": line, "chars": len(line), "chunks": n_chunks,
            "startSec": round(line_start, 3), "endSec": round(cursor, 3),
            "durationSec": round(cursor - line_start, 3),
            "rms": round(sum(rms_acc) / len(rms_acc), 4) if rms_acc else 0,
        })
        print(f"line {li + 1}/{len(LINES)}: {len(line)} chars -> {cursor - line_start:.2f}s "
              f"({n_chunks} chunk{'s' if n_chunks != 1 else ''})", flush=True)
        if li < len(LINES) - 1 and PAUSE_MS:
            silence = b"\x00" * int(SR * PAUSE_MS / 1000) * 2
            assembled += silence
            cursor += PAUSE_MS / 1000
        write_artifact(complete=(li == len(LINES) - 1))

    meta = write_artifact(complete=True)
    wall = time.time() - t_synth
    print(f"output.wav written: {meta['durationSec']}s of audio, {meta['outputBytes']} bytes, "
          f"{wall:.1f}s synthesis wall (model load {load_s:.1f}s separate)", flush=True)
finally:
    try:
        if proc.poll() is None:
            proc.stdin.write(json.dumps({"op": "shutdown"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=10)
    except Exception:
        proc.kill()
