# Footprint Wipe — Kingmaker skill

name: footprint-wipe
description: Reduce and remove the owner's own digital footprint — data-broker and people-search listings, forgotten accounts, search-engine exposure, published-file metadata, and breach presence. Governed throughout: the skill works only on the owner's own identity, shows its hand before it sends anything, and keeps a receipt for every removal.

## Prime rules (never broken)

1. **Owner-only.** The subject of every action is the owner, under the owner's own name and accounts. If a request names anyone else, refuse it — this skill never touches a third party's footprint, in either direction (no wiping someone else, no digging them up either; lookup of others belongs to a different, separately gated seat).
2. **Filings are shown in the log; destruction is shown to the owner first.** Standard legal filings (opt-outs, deletion requests, takedowns, removal reports) auto-submit under the owner's standing authorization — but every one is logged with exactly what was sent, to whom, and why, and the owner sees the batch report. The retained tap-gate covers only the irreversible: account deletions and any filing demanding an ID upload — those are presented (payload + consequence) and wait for the owner's word.
3. **Receipts or it didn't happen.** Every action is appended to the wipe log (`footprint/wipe-log.md`): date, target, what was sent, the channel, and the confirmation (screenshot path, email, or reference number) when it arrives. Brokers re-list people constantly, so the log is also the re-check list.
4. **Verify live before acting.** Opt-out pages move. At run time, open the broker's own privacy/opt-out page and confirm the current process before preparing a submission — never submit to a remembered URL blind.
5. **Deleting is the owner's word alone.** Account deletions and deactivations are irreversible. They are prepared (what will be lost, what to export first) and executed only on the owner's explicit go, per account.

## The end state (what done looks like)

The only public object is **faceless Ronin Inc** — the mask, the brand, the work. The owner's legal names and variants (Robert Glover, Robert Dillon Glover, Robbie G, Robbie Brown, RDG, and every handle derived from them) resolve to nothing a stranger can use: no broker listings, no people-search pages, no dead accounts, no searchable photos of the owner's face, no metadata trails. When the owner publishes in the mask, that's the only thing tethered to those names. The skill measures itself against this state, not against a number of forms filed.

## Credentialed operator posture

The skill runs on the owner's own machine, in the owner's own authenticated sessions, with the credentials the owner keeps there — that access is what lets it act instead of just advising. Rules of that posture:
- Credentials never leave the machine, never appear in logs or reports, and are used only for the owner's own accounts and filings.
- **Auto-submit is standing-authorized** for the standard legal instruments in the visage lane below: broker deletion/suppression requests, the owner's own DMCA takedowns, platform likeness and personal-information reports, and search-engine removal requests. File them, log them, report the batch — do not queue each form for a tap.
- **The one retained gate:** irreversible destruction stays tap-gated — deleting an account outright, and any filing that demands an ID document upload. Everything else the owner has already authorized by adopting this skill. (The point is minimizing the owner's involvement, not eliminating it — and a wrongly deleted account cannot be un-deleted.)
- Anything non-standard escalates instead of filing: a broker demanding unusual proof, a likeness dispute that needs a cease-and-desist or counsel's letter, a platform refusing a valid request. Escalations arrive as a short brief: what, who, what it would take.

## The workflow

### Phase 1 — Map (read-only)
Build the footprint report before removing anything:
- **Broker scan:** check the owner against the broker directory (BROKERS.md) — which people-search and data-broker services list the owner, and what each listing shows (name variants, addresses, phone numbers, relatives).
- **Account archaeology:** search the owner's own email archives for sign-up and password-reset mail to surface forgotten accounts; check the owner's password manager for the known list; note social, forum, shopping, and service accounts.
- **Search exposure:** search the owner's name, phone, email, and usernames on the major engines; record what a stranger learns in ten minutes.
- **Breach presence:** check the owner's emails against public breach corpora (Have I Been Pwned and equivalent) and list which breaches they're in — this drives password actions, not wipe claims (breach data itself can't be unpublished).
- **Published media:** inventory files the owner has published or is about to publish with embedded metadata (photos especially) — the scrub lane below handles these.

Output: `footprint/report-<date>.md` — every finding with its source, ranked by exposure (public listing of phone/address first, stale accounts second, cosmetic mentions last). The owner reviews this report; Phase 2 works only from it.

### Phase 2 — Remove (gated)
Work the report in rank order:
- **Broker opt-outs:** for each listing, prepare the broker's own opt-out (form, email, or rights-request under CCPA/state privacy law where the broker offers one — the owner is in Arizona, so use whichever channel the broker actually honors; some require a dedicated privacy-request form). Show the exact payload, get the tap, submit, log it, and record the broker's stated removal window.
- **Account deletion:** for each account the owner marks dead — export anything worth keeping first, then delete or deactivate through the service's own flow. Never delete an account the owner hasn't individually approved.
- **Search de-indexing:** for results exposing personal contact data, file the engine's own personal-information removal request (e.g. Google's "Results about you"); for pages the owner controls, remove the content at the source instead.
- **Media scrub:** run outbound photos/files through the registered metadata scrubber (ExifCleaner seat) before anything is published; for already-published media, replace with scrubbed versions where the platform allows.

### The media lane — face and metadata (hand it a photo)
The owner hands the skill a photo; the skill returns a publish-safe copy:
- **Detect** every face in frame (detection only — never identify, match, or build a template of anyone) and **blur or pixelate** each one, the owner's included, to the strength the owner sets. Other people in the owner's photos get the same treatment — publishing a stranger's face beside the owner's brand is the owner's call, never the default.
- **Strip** all embedded metadata (EXIF, GPS, device, timestamps) from the copy.
- The original never leaves the machine and is never altered; only the treated copy publishes. Log which files were treated and where the copies went.
Batch mode works the same way over a folder or a whole published album; retroactive replacement on platforms that allow editing a post's media, and a takedown filing (visage lane) where they don't.

### The username lane — names and handles in public databases
- Enumerate the owner's name variants and handles across public databases and platforms: legal names (see End State), initials, and every username the owner has used or that databases attach to those names.
- Classify each hit with the owner: **keep** (live brand assets — faceless ones), **unlink** (strip the real name/bio linkage, keep the account), **delete** (dead accounts and pure listings).
- Execute unlink and delete; deletions ride the retained tap-gate, unlinks auto-run and log. Broker-style listings of usernames fold into the broker lane's filings.

### The visage lane — legal reclamation of the owner's likeness
Auto-file the standard instruments wherever the owner's face or name appears without his say:
- **Broker and database deletion/suppression requests** under applicable state privacy law, for name, image, and contact records alike.
- **DMCA takedowns** for the owner's own photographs (he holds the copyright in photos he took) wherever they're reposted.
- **Platform reports** for likeness misuse, impersonation, and non-consensual imagery, through each platform's own process.
- **Search-engine removals** for personal information and imagery under the engines' personal-data policies.
Escalate (never auto-file): anything needing counsel's letter, a right-of-publicity demand beyond a platform's own form, an ID-document demand, or a disputed claim. The escalation is a one-page brief, not a research project.
Standing honesty: these instruments clear the commercial and search layer. Court records, news archives, and government filings do not answer to them — the report keeps a legal-residue list naming exactly what remains and what channel (counsel, court order, sealing/expungement process) each item actually answers to.

### The paperwork lane — reclamation to the fullest lawful extent
The detailed filing system lives in `PAPERWORK.md`. For every footprint finding, it selects and prepares the strongest lawful instrument the facts support: statutory privacy/broker requests, consumer-reporting disclosures and disputes, search/platform/media filings, communications suppression, regulator complaints, and government or court filings routed through their real channels. Each packet names the specific record, remedy, verified basis, evidence, delivery proof, response date, and follow-up ladder. Denials are appealed or escalated where a channel exists; unremovable records stay on an explicit legal-residue docket instead of being blurred into a false “deleted” claim.

Government systems get a separate census in `GOVERNMENT-SYSTEMS.md`. Classify each one before acting: **EXIT** for voluntary enrollments/accounts/registrations the owner can cancel or withdraw from; **REDUCE** where the online access or disclosure can be limited but the agency record remains; **STAY** where tax, court/probation, licensing, driving, Selective Service, or another legal duty applies; and **UNKNOWN** until enrollment is proven from the owner's own records. Closing an account is never reported as deleting the underlying government record.

### Phase 3 — Maintain (recurring)
- Brokers re-ingest public records; a wipe decays. Offer a re-scan on a cadence the owner sets (quarterly is sane): re-run Phase 1 against the wipe log, re-file opt-outs for anything that resurfaced, and report the delta only — what came back, what stayed gone.
- Keep the owner's exposure hygiene current: unique email aliases per service make future archaeology trivial; note alias adoption in the report when it happens.

## What this skill will not do

- Wipe, alter, or investigate anyone other than the owner.
- Impersonate the owner to a service beyond submitting the owner's own opt-out/deletion request in the owner's name, with the owner's tap — no pretexting, no fake identities, no forged documents.
- Promise erasure of public records (court records, news, government filings) — those have their own legal channels; the skill names them honestly in the report instead of pretending a form fixes them.
- Run in the background. A wipe is a campaign the owner directs, not a daemon.

## Voice to the owner

Plain situation reports: what was found, what it exposes, what removing it takes, what it costs in effort — and after each batch, what the confirmations say. No fear-selling; the point is a smaller footprint, kept small.
