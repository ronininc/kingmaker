---
name: site-media-fetch
description: >-
  The house media-harvest engine — finds and downloads a business's REAL videos
  (and audio, thumbnails, posters) from their public social profiles using
  yt-dlp, then preps them as web-ready files for a site build. Use WHENEVER a
  client/prospect site needs real footage: "grab their videos", "pull the reels
  from their Instagram/TikTok/Facebook/YouTube", "download their video for the
  hero", "get real media for the site", "find their videos and bring them in",
  or any time website-build-standard / custom-lead-generator / the agnostic lead
  engine reaches a shop whose hero or gallery slots are empty. Downloads only
  public media; the goal is owned/authorized footage for the business's OWN
  site. Never fabricates media — if a profile has no usable video, mark the slot
  CLIENT-UPLOAD. Pairs with profiler + business-profile-recon (to locate the
  right profiles first) and hands finished files to website-build-standard.
---

# site-media-fetch — pull real video into a site build with yt-dlp

## What this is

The last-mile media piece of a website build pipeline. Our lead engines find a
shop and its socials; the site builder needs **real footage** in the hero and
gallery slots instead of hotlinked or placeholder media. This skill wraps
[yt-dlp](https://github.com/yt-dlp/yt-dlp) — the leading open-source downloader —
to **search a business's public profiles, pull their best video/audio/thumbnails,
and convert them to web-ready files** the builder drops straight into slots.

House rule, unchanged: media on a client site should end up as **owned/authorized
files**. This skill gets you real footage fast so the site renders populated; the
provenance of every file is tracked so it can be confirmed or swapped for a
client upload before launch. Never invent media — an empty profile = a
`CLIENT-UPLOAD` slot, exactly like the recon skills mark unverifiable facts.

## When to use

Trigger on: "grab/pull/download their videos", "get the reel/footage for the
hero", "pull media from their IG/TikTok/Facebook/YouTube", "find their videos and
bring them in", "populate the gallery with their clips", or automatically as the
media step after `custom-lead-generator` / the agnostic lead engine / `profiler`
identifies a prospect and `website-build-standard` needs media.

## Prerequisites (one-time)

yt-dlp needs **ffmpeg** for merging video+audio and any re-encode/remux.

```bash
# Cloud sandbox (this environment):
pip install -U "yt-dlp[default]" --break-system-packages
which ffmpeg || (apt-get update && apt-get install -y ffmpeg)   # if missing

# The operator's own Mac (for logged-in / gated content — see Auth):
brew install yt-dlp ffmpeg          # or: pipx install yt-dlp
```

Keep it fresh. Sites change their internals constantly; a yt-dlp older than ~90
days warns and extractors break. Update before a harvest run:

```bash
pip install -U --pre "yt-dlp[default]" --break-system-packages   # nightly, most reliable
# or, for a binary install:  yt-dlp --update-to nightly
```

## The workflow — search → inspect → pull → prep → hand off

### 1. Find the profiles (don't guess)

Get the business's real, verified social URLs first. If they aren't already in a
Build Brief, run **`profiler`** / **`business-profile-recon`** to confirm which
YouTube channel, Instagram, TikTok, and Facebook page actually belong to this
business (never harvest a same-name lookalike). Collect the profile/channel URLs.

### 2. List what's there BEFORE downloading (cheap, no media pulled)

Enumerate a channel/profile's videos as metadata only, so you can pick the best
ones without downloading everything:

```bash
# Fast index of a channel/profile: IDs, titles, durations, dimensions
yt-dlp --flat-playlist -J "PROFILE_OR_CHANNEL_URL" > index.json

# Inspect one video's formats (resolutions, codecs, fps) before choosing:
yt-dlp -F "VIDEO_URL"

# Full metadata for one video (duration, dimensions, upload date, thumbnail):
yt-dlp -j "VIDEO_URL"
```

Pick for the build: for a **hero**, favor a **horizontal (landscape), longest,
highest-resolution** clip (vertical Reels/TikToks are better for gallery tiles).
Note dimensions from the metadata so you route each clip to the right slot.

### 3. Download best quality (video+audio merged, web-friendly)

```bash
# Best video+audio, merged to mp4, thumbnail + metadata saved alongside:
yt-dlp -f "bestvideo+bestaudio/best" \
       --merge-output-format mp4 \
       --write-thumbnail --write-info-json \
       -o "%(uploader)s/%(title).80B [%(id)s].%(ext)s" \
       "VIDEO_URL"

# Force a clean, universally web-playable file (H.264/AAC in mp4) if the source
# is VP9/AV1/HEVC and won't play everywhere:
yt-dlp -S "vcodec:h264,res,fps" --recode-video mp4 "VIDEO_URL"
#   --remux-video mp4  = repackage without re-encoding (fast, no quality loss)
#   --recode-video mp4 = re-encode (slower, use only when remux can't fix codec)

# A whole profile/channel, newest handful only, skipping anything already pulled:
yt-dlp -I 1:12 --download-archive archive.txt \
       -f "bestvideo+bestaudio/best" --merge-output-format mp4 \
       --write-thumbnail -o "%(uploader)s/%(title).80B [%(id)s].%(ext)s" \
       "PROFILE_OR_CHANNEL_URL"

# Grab just the poster/thumbnail (for a video slot's still, or a photo slot):
yt-dlp --write-thumbnail --skip-download "VIDEO_URL"

# Extract audio only (e.g., a jingle/voiceover — mind music rights, see Guardrails):
yt-dlp -x --audio-format mp3 --audio-quality 0 "VIDEO_URL"
```

Be polite so a profile doesn't rate-limit or block you mid-run:

```bash
--sleep-requests 1 --limit-rate 3M -N 2
```

### 4. Auth for gated platforms (Instagram / TikTok / Facebook / YouTube)

Public posts often download with no login. But in 2025–2026 **Instagram,
TikTok, Facebook, and increasingly YouTube** frequently require a logged-in
session (cookies) — direct `-u/-p` login usually fails and can lock an account.
Use cookies instead:

```bash
# Best: pull cookies from a browser where the operator is already logged in.
# This must run on a machine WITH that browser — i.e. the operator's own Mac,
# NOT the cloud sandbox (no logged-in browser lives there):
yt-dlp --cookies-from-browser chrome  "URL"     # or firefox / safari / edge

# Portable: export a cookies.txt once (browser extension) and pass the file —
# works in the cloud sandbox too:
yt-dlp --cookies cookies.txt  "URL"
```

Practical routing: **public YouTube + most public FB/IG video → runs fine in the
cloud sandbox.** Login-gated IG/TikTok/FB → run yt-dlp **on the operator's own
computer** where he's signed in (`--cookies-from-browser`), or hand over a
`cookies.txt`. If a clip stays blocked, don't fight it — mark that slot
`CLIENT-UPLOAD` and move on.

### 5. Prep + hand off to the site builder

For each kept file: confirm it's `.mp4` H.264/AAC (remux/recode if not), keep the
`.info.json` next to it as provenance (source URL, uploader, date, dimensions),
and route by orientation — landscape → hero / feature; vertical → gallery tiles;
thumbnails → posters or photo slots. Then hand the folder to
**`website-build-standard`** and drop each file into its media slot (the
builder's drag-and-drop media editor / MP4-per-slot). Log each file's source URL
so it can be confirmed as owned or swapped for a client upload before launch.

## Guardrails (quality + rights)

- **Purpose = the business's OWN site.** Harvesting a shop's public footage to
  build that shop's site (which they'll own) is the legitimate use. Getting the
  operator/client to confirm or re-upload owned originals before launch stays the
  house standard.
- **Copyright & music.** Don't lift third-party/copyrighted clips, and be careful
  with videos carrying **licensed background music** — republishing that on a
  commercial site is a rights problem (this is exactly why Oro Talent's build
  banned music on profiles). Prefer the client's own clean footage; when in
  doubt, pull the visuals and mute/replace audio, or flag it.
- **Respect platform ToS + rate limits.** Use the politeness flags; don't hammer
  a profile. yt-dlp only accesses **public** media — do not use it to reach
  private/non-public content.
- **Provenance always.** Keep the `.info.json`; every delivered file carries its
  source URL and date, same discipline as the lead sheet's source column.
- **No fabrication.** No usable video on a profile → `CLIENT-UPLOAD` slot. Never
  substitute stock or another business's footage as if it were theirs.

## Reference

Full command cheat-sheet in `references/commands.md`.
Upstream project + docs: https://github.com/yt-dlp/yt-dlp
