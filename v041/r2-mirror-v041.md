# R2 mirror for v0.4.1 — prepared, awaiting Robbie's word

Grounded 2026-10-20 from update-host/worker.js (public repo): the worker serves
R2 keys by request path — GET /v0.4.1/<file> reads key v0.4.1/<file> from the
RELEASES bucket (gated by the Mac's update key), and GET /download/<name>
reads public/<name> with no key (that is what ronininc.org links for the DMG).

Bucket: kingmaker-releases (the NEW bucket, wrangler profile ronin-personal —
same way the v0.4.0 parts were uploaded). Local source folder:
~/Projects/sol-ghost/dist/release/v0.4.1/ plus the DMG in ~/Projects/sol-ghost/dist/.

Objects to put (13 under v0.4.1/, 1 under public/):
- v0.4.1/Kingmaker-0.4.1.tar.gz.part01 … part08
- v0.4.1/kingmaker-manifest.json
- v0.4.1/kingmaker-manifest.json.sig
- v0.4.1/SHA256SUMS
- v0.4.1/Ronin-Launcher-0.3.1-arm64.zip
- public/Kingmaker-Installer-v0.4.1.dmg

Command shape (per object, run from his Mac with the ronin-personal profile,
exactly as the 4.0 uploads were run):
  wrangler r2 object put kingmaker-releases/v0.4.1/<file> --file <local path>

Total ~2.33 GB on his uplink — hours, resumable per object (each put is
independent; a failed part is re-put alone).

OPEN sub-step: /latest.json at the bucket root is what enrolled Macs poll for
"is there an update". Its current content/schema must be read from the bucket
before writing a v0.4.1 one — do not guess its fields. (4.0's latest.json
existed in the old bucket; the new bucket's state was never confirmed.)
