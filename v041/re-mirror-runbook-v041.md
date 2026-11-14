# v0.4.1 re-mirror runbook — worker-read account (CORRECT profile)

Written 2026-10-20 ~22:05 UTC, grounded by public URL checks run at that time
(redirect chain + HEADs against kingmaker-updates.robbiebrown2026.workers.dev).

## What the public checks established (22:05 UTC)

1. ronininc.org/download/kingmaker -> 302 -> workers.dev/download/Kingmaker-Installer.dmg
   -> 200 OK, 2,929,688 bytes, ETag "f6b04d80fa7106fead5c1b7412c0c3a2".
   This IS the download path every site visitor takes — and it is NOT the 4.1 DMG
   (4.1 = 2,943,609 B per the local build log). Robbie's screenshot showed it
   serving the 0.3.0-era installer.
2. workers.dev/download/Kingmaker-Installer-v0.4.1.dmg -> 404.
   The versioned DMG key exists only in the WRONG account's bucket.
3. workers.dev/v0.4.1/<file> -> 401 (update-key gated — cannot distinguish
   missing-object from missing-auth publicly). Consistent with the installer's
   part01 404s: the worker-read bucket has no v0.4.1/ tree.

## Diagnosis (UPDATED 22:37 UTC — whoami path is dead, KV probe is live)

Two Cloudflare accounts each own a bucket named kingmaker-releases. The
`--profile ronin-personal` mirror ("ALL-UPLOADED v0.4.1") went to the wrong one.
The worker reads the other one.

What happened since this was written (all in live chat):
- `wrangler whoami --profile X` is REJECTED by wrangler ("--profile cannot be
  used with the whoami command") — that identification route is closed. Do NOT
  hand Robbie a whoami-based block again.
- `r2 object get kingmaker-releases/latest.json` probed under all three of his
  wrangler profiles (default, orosolu24, ronin-personal) at 22:11 UTC: ALL came
  back "key does not exist". None of his wrangler logins touches the worker's
  bucket. The old dashboard-inspected bucket (v0.2.1-v0.3.0 + public/ folder
  that served him the 0.3.0 installer today) had a latest.json — so the worker
  likely lives on the DASHBOARD account, a fourth account with no wrangler
  login on this Mac.
- Solid fingerprint meanwhile: every failed installer transfer is exactly 9
  bytes — the worker's "Not found" body. An auth failure would be 12
  ("Unauthorized"). So his key is good and enrollment is good; the bucket
  simply has no v0.4.1/ tree.
- LIVE identification step (asked in chat 22:37 UTC, awaiting his output): the
  worker's config names its KV namespace DEVICES, id
  `e08bbab74ec941059f6b6570d8795232`. KV ids are unique per account, so run:
      wrangler --profile default kv namespace list
      wrangler --profile orosolu24 kv namespace list
      wrangler --profile ronin-personal kv namespace list
  Whichever profile lists that id IS the worker's account — mirror under that
  <PROFILE> below and we're done.
- FALLBACK (if the id shows under NONE of them): the worker's account has no
  wrangler login on this Mac at all. Fix is one `wrangler login` in the browser
  on the dashboard (robbiebrown2026) account, then mirror under the new
  profile name that login creates.

## THE KEY CORRECTION the mirror prep got wrong

The mirror prep file (r2-mirror-v041.md) plans `public/Kingmaker-Installer-v0.4.1.dmg`
— but the site serves `public/Kingmaker-Installer.dmg` (no version). Upload the
4.1 DMG content under BOTH keys:

- public/Kingmaker-Installer.dmg            <-- the key the site + redirect serve
- public/Kingmaker-Installer-v0.4.1.dmg     <-- the GitHub-release name (belt and braces)

Once both keys hold the 4.1 DMG in the worker-read bucket, the from-site
BINARY path is fixed with zero site-repo changes. (Page TEXT — "Version 0.4.0",
25 GB / 17 GB copy — still needs the GitHub App grant owed since Oct 18.)

## Re-mirror command block (his Mac, correct profile = <PROFILE> from the KV probe, or the new login's profile)

```bash
cd ~/Projects/sol-ghost/dist/release/v0.4.1
B=kingmaker-releases
for f in Kingmaker-0.4.1.tar.gz.part01 Kingmaker-0.4.1.tar.gz.part02 \
         Kingmaker-0.4.1.tar.gz.part03 Kingmaker-0.4.1.tar.gz.part04 \
         Kingmaker-0.4.1.tar.gz.part05 Kingmaker-0.4.1.tar.gz.part06 \
         Kingmaker-0.4.1.tar.gz.part07 Kingmaker-0.4.1.tar.gz.part08 \
         kingmaker-manifest.json kingmaker-manifest.json.sig \
         SHA256SUMS Ronin-Launcher-0.3.1-arm64.zip; do
  wrangler r2 object put "$B/v0.4.1/$f" --file "$f" --profile <PROFILE> --remote
done
cd ~/Projects/sol-ghost/dist
wrangler r2 object put "$B/public/Kingmaker-Installer.dmg" \
  --file Kingmaker-Installer-v0.4.1.dmg --profile <PROFILE> --remote
wrangler r2 object put "$B/public/Kingmaker-Installer-v0.4.1.dmg" \
  --file Kingmaker-Installer-v0.4.1.dmg --profile <PROFILE> --remote
```

Same command shape as the validated 4.0 uploads; ~2.34 GB uplink; each put is
independent (re-put failures alone). All must use --remote (the tell: wrangler
prints 'Resource location: remote').

## Verification (no Cloudflare access needed — anyone can run these)

```bash
curl -sI https://kingmaker-updates.robbiebrown2026.workers.dev/download/Kingmaker-Installer.dmg | grep -i content-length
# expect 2943609 (the 4.1 DMG), not 2929688 (the stale file)
curl -s -o /dev/null -w "%{http_code}\n" https://kingmaker-updates.robbiebrown2026.workers.dev/download/Kingmaker-Installer-v0.4.1.dmg
# expect 200, not 404
```

## OPEN sub-step (carried from r2-mirror-v041.md)

The bucket-root /latest.json is what enrolled Macs poll for "is there an update".
Its current content/schema must be READ from the worker-read bucket before a
v0.4.1 one is written — never guess its fields. (4.0's latest.json existed in
the old bucket; the worker-read bucket's state was never confirmed.)

## After this lands

- Robbie downloads from ronininc.org again (the REAL customer path, from dot):
  binary is now 4.1; the page still says 0.4.0 until the App grant lands.
- Then the acceptance loop (8 GB LEAN + Stream the library) proves the
  read->replicate->ask->improve gate per his V4 acceptance order.
- Discord announcement goes out with a page whose binary already matches.
