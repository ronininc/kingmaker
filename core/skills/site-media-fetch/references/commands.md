# yt-dlp command cheat-sheet (site-media-fetch)

Grounded on the current yt-dlp README. Keep yt-dlp updated (`pip install -U --pre "yt-dlp[default]" --break-system-packages`) — extractors break as sites change.

## Install
```bash
pip install -U "yt-dlp[default]" --break-system-packages   # + ffmpeg required
apt-get install -y ffmpeg           # sandbox, if missing
brew install yt-dlp ffmpeg          # operator's Mac
```

## Inspect before downloading (no media pulled)
```bash
yt-dlp --flat-playlist -J "PROFILE_URL" > index.json   # list a channel/profile
yt-dlp -F "VIDEO_URL"                                   # list formats for one video
yt-dlp -j "VIDEO_URL"                                   # full metadata JSON
yt-dlp --write-thumbnail --skip-download "VIDEO_URL"    # just the poster/still
```

## Download best quality
```bash
# Best video+audio → mp4, with thumbnail + metadata:
yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 \
       --write-thumbnail --write-info-json \
       -o "%(uploader)s/%(title).80B [%(id)s].%(ext)s" "VIDEO_URL"

# Prefer web-safe H.264, re-encode to mp4 if needed:
yt-dlp -S "vcodec:h264,res,fps" --recode-video mp4 "VIDEO_URL"

# Repackage container without re-encoding (fast, lossless):
yt-dlp --remux-video mp4 "VIDEO_URL"

# Audio only:
yt-dlp -x --audio-format mp3 --audio-quality 0 "VIDEO_URL"
```

## Format selection notes
- `-f "bestvideo+bestaudio/best"` — best separate streams, fallback to best combined.
- `-S SORT` — sort by preference, e.g. `-S "res:1080,vcodec:h264,fps"`.
- `--merge-output-format mp4` — container for the merged result.
- `--remux-video mp4` (no re-encode) vs `--recode-video mp4` (re-encode).

## Batch: channels / playlists / profiles
```bash
yt-dlp -a urls.txt                       # URLs from a text file
yt-dlp -I 1:12 "PROFILE_URL"             # items 1–12 only  (also 1:3,7,-5::2)
yt-dlp --download-archive archive.txt "PROFILE_URL"   # skip already-downloaded IDs
```

## Auth (login-gated: IG / TikTok / FB / often YouTube)
```bash
yt-dlp --cookies-from-browser chrome "URL"   # run where operator is logged in (Mac)
yt-dlp --cookies cookies.txt "URL"           # portable exported cookie file (sandbox-ok)
```
Avoid `-u/-p` for real accounts — it often fails and can trigger lockouts.

## Politeness / rate limiting
```bash
--sleep-requests 1        # pause between extraction requests
--limit-rate 3M           # cap download speed
-N 2                      # concurrent fragments (keep low to be gentle)
```

## Output template tokens (common)
`%(uploader)s` `%(title)s` `%(id)s` `%(ext)s` `%(upload_date)s` `%(duration)s`
`%(width)s` `%(height)s` — e.g. route by orientation using width/height from `-j`.

## Update
```bash
pip install -U --pre "yt-dlp[default]" --break-system-packages   # nightly (recommended)
yt-dlp --update-to nightly                                       # binary installs
```
