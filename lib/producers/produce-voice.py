# Voice producer — the ingest-voice-transcribe tool's engine: the stack's
# STT leg, faster-whisper over ONE audio file, fully local. Decodes and
# resamples with PyAV directly because this VM's PyAV build rejects the
# metadata_errors kwarg that faster-whisper's own decode_audio passes
# (TypeError on any file input) — the model path is untouched, only the
# file decode, which PyAV performs either way.
#
# Contract: argv --out <jobDir> --audio <file> [--audio <file> ...]; writes
# output.txt + output.meta.json (outputChars + outputSha256 in meta);
# prints progress lines; exits non-zero on failure. Several files ride ONE
# model load — the load is the expensive part, so batching is the shape
# callers should use (the original ingest lane transcribed two files per
# run for exactly this reason).
#
# Binding: KINGMAKER_WHISPER_MODEL — a faster-whisper model name or local
# CT2 folder (default "base.en", resolved from the local cache only:
# local_files_only, so a missing model is an error, never a download).
import argparse, hashlib, json, sys, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--audio", required=True, action="append")
cli = ap.parse_args()
OUT = Path(cli.out)
OUT.mkdir(parents=True, exist_ok=True)
AUDIOS = [Path(p) for p in cli.audio]
for a in AUDIOS:
    if not a.is_file():
        print(f"audio file not found: {a}", file=sys.stderr)
        sys.exit(2)

import os
import av
import numpy as np
from faster_whisper import WhisperModel

def load_audio_16k(path):
    container = av.open(str(path))
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    frames = []
    for frame in container.decode(audio=0):
        for rf in resampler.resample(frame):
            frames.append(rf.to_ndarray())
    container.close()
    return np.concatenate(frames, axis=1).reshape(-1).astype(np.float32) if frames else np.zeros(0, dtype=np.float32)

def sha256(p):
    h = hashlib.sha256()
    h.update(Path(p).read_bytes())
    return h.hexdigest()

MODEL = os.environ.get("KINGMAKER_WHISPER_MODEL", "base.en")
t0 = time.time()
model = WhisperModel(MODEL, device="cpu", compute_type="int8", local_files_only=True)
print(f"model loaded in {time.time()-t0:.1f}s", flush=True)

HEADER = ("VOICE RUNTIME INGEST — faster-whisper transcription output\n"
          f"tool: faster-whisper\tmodel: {MODEL} (CTranslate2, cpu int8, local files only)\n\n")

def write_artifact(parts, files_meta, complete):
    # Incremental: rewritten after EVERY file, so a killed run (timeout,
    # contention) still leaves each finished file's transcript on disk.
    # meta.complete is False until the last file lands — a partial artifact
    # can never be mistaken for a finished one.
    out = HEADER + "\n\n".join(parts) + "\n"
    (OUT / "output.txt").write_text(out)
    (OUT / "output.meta.json").write_text(json.dumps({
        "tool": f"faster-whisper (model {MODEL}, cpu int8)",
        "files": files_meta, "complete": complete,
        "outputChars": len(out), "outputSha256": hashlib.sha256(out.encode("utf8")).hexdigest(),
    }, indent=2))
    return out

parts = []
files_meta = []
for AUDIO in AUDIOS:
    audio_hash = sha256(AUDIO)
    t = time.time()
    segments, info = model.transcribe(load_audio_16k(AUDIO), beam_size=1, vad_filter=False)
    segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text} for s in segments]
    text = "".join(s["text"] for s in segs).strip()
    elapsed = round(time.time() - t, 1)
    print(f"{AUDIO.name}: {len(segs)} segments, {len(text)} chars, {elapsed}s", flush=True)
    files_meta.append({
        "file": AUDIO.name, "sha256": audio_hash, "duration_s": round(info.duration, 1),
        "language": info.language, "segments": len(segs), "chars": len(text), "elapsed_s": elapsed,
    })
    parts.append(
        f"=== TRANSCRIPT: {AUDIO.name} ===\n"
        f"audio_sha256: {audio_hash}\nduration_s: {info.duration:.1f}\nlanguage: {info.language}\n\n"
        f"{text}\n\n--- segments ---\n" +
        "\n".join(f"[{s['start']:.2f} -> {s['end']:.2f}] {s['text']}" for s in segs))
    out = write_artifact(parts, files_meta, complete=(len(files_meta) == len(AUDIOS)))

print(f"output.txt written: {len(out)} chars total, {time.time()-t0:.1f}s elapsed")
