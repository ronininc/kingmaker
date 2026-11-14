// YouTube producer — the ingest-youtube-transcript tool's engine: yt-dlp
// (metadata + English subtitles; transcripts first). Two modes: a known
// video (--video-id, an id or a watch URL), or discovery (--query: yt-dlp's
// own ytsearch, first candidate whose cleaned English transcript is
// substantial — the open Blender movies are nearly dialogue-free, so fitness
// is judged on transcript size, not view counts).
//
// Two field lessons baked in: (1) --sub-langs must be exactly "en" — the
// glob "en.*" also matches auto-translated variants (en-sq) whose timedtext
// fetch can 429 and fail the whole call after the real track already
// downloaded; (2) the subtitle step's exit code is not the verdict — the
// files on disk are.
//
// Contract: argv --out <jobDir> (--video-id <id|url> | --query <words>)
// [--min-transcript-chars n]; writes output.txt + output.meta.json
// (outputChars + outputSha256 in meta); one summary line; non-zero on
// failure.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt("--out");
const VIDEO_ID = opt("--video-id");
const QUERY = opt("--query");
const MIN_CHARS = Number(opt("--min-transcript-chars") ?? 4000);
if (!OUT || (!VIDEO_ID === !QUERY)) { console.error("usage: produce-youtube.mjs --out <dir> (--video-id <id|url> | --query <words>) [--min-transcript-chars n]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const TMP = `${OUT}/tmp`;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function ytdlp(argv, timeout = 120000) {
  const { stdout, stderr } = await run("python3", ["-m", "yt_dlp", ...argv], { timeout, maxBuffer: 32 * 1024 * 1024 });
  return { stdout, stderr };
}
function cleanSub(raw) {
  const lines = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:") ||
        line.includes("-->") || /^\d+$/.test(line) || line.startsWith("NOTE")) continue;
    line = line.replace(/<[^>]+>/g, "").trim();
    if (line && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join("\n");
}
const urlOf = (idOrUrl) => (/^https?:\/\//.test(idOrUrl) ? idOrUrl : `https://www.youtube.com/watch?v=${idOrUrl}`);

async function candidate(url) {
  const metaRes = await ytdlp(["--dump-json", "--no-playlist", url]);
  const m = JSON.parse(metaRes.stdout);
  const subDir = `${TMP}/${m.id}`;
  mkdirSync(subDir, { recursive: true });
  try {
    await ytdlp(["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en",
      "--sub-format", "vtt/srt/best", "-o", `${subDir}/%(id)s.%(ext)s`, url]);
  } catch { /* files on disk decide — a variant error must not kill the run */ }
  const subFile = readdirSync(subDir).find((f) => /\.(vtt|srt)$/.test(f));
  if (!subFile) { console.log(`${m.id}: no subtitle file`); return null; }
  const transcript = cleanSub(readFileSync(`${subDir}/${subFile}`, "utf8"));
  console.log(`${m.id}: transcript ${transcript.length} chars (${subFile})`);
  return { m, subFile, transcript };
}

let chosen = null;
let discovery = "";
if (VIDEO_ID) {
  chosen = await candidate(urlOf(VIDEO_ID));
  if (!chosen) throw new Error(`video ${VIDEO_ID} produced no English subtitle track`);
  discovery = `direct: ${urlOf(VIDEO_ID)}`;
} else {
  const search = await ytdlp(["--flat-playlist", "--dump-json", `ytsearch8:${QUERY}`]);
  const entries = search.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.id && e.title);
  console.log(`discovered ${entries.length} candidates`);
  discovery = `ytsearch8:${QUERY} -> first candidate whose cleaned English transcript reaches ${MIN_CHARS} chars (else the largest)`;
  for (const cand of entries) {
    const c = await candidate(`https://www.youtube.com/watch?v=${cand.id}`);
    if (!c) continue;
    if (!chosen || c.transcript.length > chosen.transcript.length) chosen = c;
    if (c.transcript.length >= MIN_CHARS) break;
  }
  if (!chosen) throw new Error("no candidate produced a subtitle track");
}
const { m, subFile, transcript } = chosen;

const out =
  `YOUTUBE SCRAPER INGEST — video metadata + transcript\n` +
  `tool: yt-dlp (python3 -m yt_dlp)\n` +
  `discovery: ${discovery}\n\n` +
  `=== METADATA ===\n` +
  `id: ${m.id}\ntitle: ${m.title}\nuploader: ${m.uploader ?? ""}\nchannel: ${m.channel ?? ""}\n` +
  `channel_id: ${m.channel_id ?? ""}\nchannel_url: ${m.channel_url ?? ""}\nwebpage_url: ${m.webpage_url}\n` +
  `duration_s: ${m.duration}\nupload_date: ${m.upload_date}\nview_count: ${m.view_count}\n` +
  `like_count: ${m.like_count ?? ""}\ncategory: ${(m.categories ?? []).join(", ")}\n` +
  `description:\n${(m.description ?? "").slice(0, 2000)}\n\n` +
  `=== TRANSCRIPT (${subFile}) ===\n${transcript}\n`;
writeFileSync(`${OUT}/output.txt`, out);
writeFileSync(`${OUT}/output.meta.json`, JSON.stringify({
  tool: "yt-dlp", videoId: m.id, title: m.title, channelId: m.channel_id,
  durationS: m.duration, subtitleFile: subFile, transcriptChars: transcript.length,
  outputChars: out.length, outputSha256: createHash("sha256").update(out, "utf8").digest("hex"),
}, null, 2));
console.log(`chosen: ${m.id} — ${m.title} — transcript=${transcript.length} chars output=${out.length} chars`);
