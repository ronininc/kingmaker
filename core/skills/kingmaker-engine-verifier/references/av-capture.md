# Screen recording with audio, on a Mac

Every verification is one continuous screen recording with an audio track: your narration, and for voice,
Kingmaker's spoken answers. Kingmaker is a Mac agent, so this is macOS only.

Keep recordings outside the repository, e.g. `~/Movies/kingmaker-evidence/<part>/<part>-<timestamp>.mov`. Never
commit them.

## 0. Permissions

The app you record with (Terminal, or QuickTime) needs Screen Recording and Microphone under System Settings ▸
Privacy & Security. Without them the file is black or silent, which is capture state `FAILED` or `UNSUPPORTED`.

## 1. macOS's own `screencapture` (nothing to install)

```bash
mkdir -p ~/Movies/kingmaker-evidence/voice
screencapture -V 600 -g -k ~/Movies/kingmaker-evidence/voice/voice-$(date +%Y%m%dT%H%M%S).mov
```

`-V 600` records the screen for up to 600 seconds (set it longer than the checklist takes), `-g` adds audio from
the default input (your microphone), `-k` shows clicks. `-v` instead of `-V <seconds>` records until stopped;
follow what the terminal prints to stop it. `-G <id>` picks another audio input.

A Mac's microphone hears Kingmaker's spoken answer from the speakers, so narration and answer land on one track. If
you use headphones, its answer won't be on the recording: use the speakers for voice verification.

Without a terminal: Command-Shift-5 ▸ Options ▸ choose a microphone ▸ Record, or QuickTime Player ▸ File ▸ New Screen
Recording with a microphone chosen.

## 2. ffmpeg (when you want control over format)

`ffmpeg` is not part of a stock Mac (`brew install ffmpeg`). List the devices first:

```bash
ffmpeg -f avfoundation -list_devices true -i ""
```

Note the screen's index and the microphone's index, then (here screen 1, microphone 0):

```bash
ffmpeg -f avfoundation -framerate 30 -i "1:0" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -b:a 160k \
  ~/Movies/kingmaker-evidence/voice/voice-$(date +%Y%m%dT%H%M%S).mp4
```

Press q to stop.

## 3. Check the recording has real audio

A silent recording is `FAILED`.

```bash
ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "<file>"   # expect: audio
ffmpeg -i "<file>" -af volumedetect -f null - 2>&1 | grep mean_volume                    # not near silence
```

Without ffmpeg: play it back in QuickTime and listen to the whole take.

## 4. Hash it and write its record

```bash
FILE="<file>"
SHA=$(shasum -a 256 "$FILE" | awk '{print $1}')
cat > "${FILE%.*}.evidence.json" <<JSON
{
  "part": "<part>",
  "file": "$FILE",
  "sha256": "$SHA",
  "durationSec": <seconds>,
  "captureState": "CAPTURED",
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hasAudio": true,
  "checklistStepsShown": ["<step 1>", "<step 2>"]
}
JSON
```

Fill `durationSec` from the file (QuickTime's Movie Inspector, or
`ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE"`).

## 5. Capture states, truthfully

- `CAPTURED`: the file exists, has real audio, and shows every checklist step.
- `FAILED`: tried, but silent, black, cut short or missing a step. Redo it; don't report it as evidence.
- `UNSUPPORTED`: this Mac can't record (no permission, no microphone). The part is DEFERRED for evidence.
- `NOT_CAPTURED`: not tried. The part is UNVERIFIED.

Evidence is never made up. Only `CAPTURED` supports a VERIFIED verdict.
