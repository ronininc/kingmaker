---
name: website-build-standard
description: >-
  The house standard for building client/team websites. Use this WHENEVER building, redesigning, or drafting a website, landing page, microsite, one-pager, or marketing site — even if the user doesn't name the standard or these features. Trigger on "build a site", "make a website / landing page", "spin up a page for [client]", "client one-pager", "make them a web page", or any request whose deliverable is a hosted web page. Encodes the defaults every site ships with: an immersive, physically-explorable centerpiece (with a 2D standard-mode fallback), static Cloudflare-ready deploy, a builder-only drag-and-drop media editor (photo or MP4 per slot), a cinematic hero slideshow of the client's best photos as the default hero (until drone footage exists), click-to-zoom inspector, scalable SVG logos, a payment-ready shop, a per-site inquiry-routing destination, and a group/community link. Do NOT use for editing a non-web document, a slide deck, a spreadsheet, or backend/API work with no web page.
---

# Website Build Standard

This skill encodes how we build every website by default. The goal: a client can run
their own site — swap photos and clips, keep it fast, never touch code — while the hosted
result stays locked, secure, and instantly deployable. Follow these defaults unless the
client or Robbie explicitly overrides one; if you override, say which and why.

Every site is judged against one question: **can the client operate it without us, and can
a visitor never break it?**

## Workflow

1. **Clarify scope, then ask the three standing questions.** Confirm the sections needed and
   the brand palette. Always ask: (a) *Do you want a group/community link featured?*
   (Discord / Facebook group / WhatsApp) — wire it if yes, leave an open slot if not yet;
   (b) if any hero/background video is wanted, remind them clips run best at **10–20s**;
   (c) *Where should inquiries route?* — prompt the builder for the routing destination for
   this site (an email inbox, a form endpoint like Formspree/a Cloudflare worker, or a link).
   Wire every contact/booking form to it; if not given yet, leave a clearly-marked
   `INQUIRY_EMAIL` / `FORM_ENDPOINT` config slot at the top of the script so it's a one-line
   change later. This custom routing is per-site — never hard-code one shop's inbox into the
   next build; always re-ask.
2. **Research first** (if the site needs real facts — team info, hours, menu, copy). Gather
   before building. Don't invent facts; mark anything unverified.
3. **Scaffold `index.html` + `/assets/` + `README.md`** as a single self-contained static
   site. Inline all CSS/JS. No build step, no framework, no server, no database.
4. **Wire every visual slot for swappable media** using the paste-in kit — see
   `assets/media-editor-kit.html`. This is non-negotiable and is the core of the standard.
5. **Add the brand logo as a scalable SVG** (see `references/logo-svg.md`), placed where the
   client asked (default top-left).
6. **Verify by rendering** with headless Chromium (screenshot the hero + key sections,
   confirm zero JS errors, test one real drag-drop swap) before delivering.
7. **Deliver** the `index.html` (renders inline) + a zipped folder that's Cloudflare-ready,
   and tell the client exactly how to add their media and deploy.

Read `references/build-checklist.md` for the full itemized standard and the exact
Cloudflare deploy steps. Read `references/logo-svg.md` when building a crest/logo.

## The defaults (what every site ships with)

**Immersive by default (with a 2D standard mode).** Every site ships a premium, physically
explorable centerpiece tuned to the business — a walkable **floor plan** for a home, a
**menu-item showroom** for a restaurant, a **showroom purchasing surface** for a grocery/retail
store, the **AR workspace table** for a portfolio, a **node map** for a system/service. Build it
with the `immersive-evidence-workspace` skill — read it whenever you build a site — where the
per-business surface catalog lives. The "enter" state must be a real explorable surface, not a
photo swap. Always ship a clean **2D "standard" mode** from the same content as a one-switch
fallback (reduced-motion, low-power, screen-reader, or preference): immersive is the default, 2D
is a toggle away. Keep it manifest-driven so **4D** (live state, temporal, WebXR) bolts on later.

**Cinematic hero slideshow — the default hero (until drone footage).** The hero is the
first impression, and it is never an empty drop-zone. Until real drone/video footage exists
for a business, the hero is a **cinematic slideshow compiled from the client's best photos** —
the strongest 3–6 shots pulled during the owner.com / `custom-lead-generator` media dive (the
Build Brief's best-media set). It ships **preloaded** with those photos (embedded so it runs on
first paint), auto-advancing with a slow **Ken Burns** push and soft **crossfades**, a readable
scrim, overlaid headline / subtext / CTA, progress dots, prev-next arrows, keyboard + hover-pause,
and a `prefers-reduced-motion` fallback. This is mandatory on **every site built from the lead-gen
engine** — never ship an empty hero as the first thing a client or visitor sees. The hero stays a
builder-swappable slot: when a **10–20s drone/hero clip** is introduced later, it replaces the
slideshow through Edit Media with no rebuild (video then follows the latency rule below). Choose
the photos automatically from the Build Brief; if fewer than 3 usable photos exist, fall back to
the single best photo over the branded gradient. Match the slideshow's accent to the site palette.

**Static & self-contained.** One `index.html`, an `/assets/` folder, a `README.md`.
Deployed via Cloudflare Pages / direct upload — it routes to static files, so there's
nothing live to hack and nothing for a visitor to alter. Prefer file tools over a build
pipeline; the whole point is that the client can drag the folder into Cloudflare and be live.

**Drag-and-drop swappable media (the heart of the standard).** Every section that shows a
visual — hero, gallery cards, roster/feature images, product shots — is a drop zone. In a
built-in **Edit Media** mode the client drags a photo *or* an MP4 onto any slot (or clicks to
pick a file); it previews live. An **Export Files** button then downloads each dropped file
named correctly for `/assets`, so updating media needs zero code. Each visual slot must
accept **both an image and a video**. The kit in `assets/media-editor-kit.html` implements
all of this — paste it in and follow its wiring conventions rather than rebuilding it.

**Editor is BUILDER-ONLY — never on the hosted site.** The Edit Media tool must initialize
*only* during local editing (`file://` or `localhost`/`127.0.0.1`) or when a private unlock
token (`#studio`) is in the URL. On the public hosted domain it must not exist at all — no
toolbar, no drop zones — so visitors can never alter anything. The kit already gates this;
keep the gate. (The zoom/rotate *viewer* below is a viewer, not an edit tool, so it stays on
for visitors.)

**Video length / latency rule.** The hero is a photo slideshow by default (see above); this
rule governs the moment a hero/background clip is introduced to replace it. No latency
anywhere. Hero/background MP4 loops run **10–20 seconds** and compressed (~under 15 MB) so first load is instant, including on
mobile. Bigger clips *work* but load slower — the editor measures a dropped clip and warns
if it runs long/heavy (advisory, never blocks). Hero video is always
`muted` + `loop` + `playsinline` + `preload="auto"` with a poster/branded fallback, and
below-the-fold video must not block the above-the-fold render.

**Image inspector (viewer).** Gallery images are click-to-open inspectors — drag to pan,
scroll/buttons to zoom, rotate 90°, reset. This only *views*, so it stays enabled for
visitors on the hosted site.

**Scalable SVG logos.** Build the brand crest as an SVG (crisp at any size, tiny file,
animatable) rather than a raster, unless the client supplies a raster. Place per instruction.
See `references/logo-svg.md`.

**Payment-ready shop.** Any store/shop section is structured for products up front and is
payment-ready — a Cloudflare webhook worker (Clover / Stripe / Square) bolts on when
inventory is live, with no redesign. Don't wire a live processor until the client picks one
and has inventory; build the structure so it's a bolt-on, not a rebuild.

**Custom inquiry routing — prompt every time.** Every site with a contact, booking, or
lead form routes its inquiries somewhere, and that destination is chosen *per site* — so
always prompt the builder for it and never carry one site's inbox into the next. Put a
labelled config at the top of the page script — `const INQUIRY_EMAIL = "..."` and an
optional `const FORM_ENDPOINT = ""` — and wire every form to it: if `FORM_ENDPOINT` is set,
POST the fields there for hands-free routing (Formspree / a Cloudflare worker that emails the
inbox); otherwise open a pre-filled `mailto:` to `INQUIRY_EMAIL`. If the builder hasn't given
a destination yet, ship the slot filled with a clear placeholder and call it out as the one
line to change before launch. The routing target is data, not a default — re-ask on every build.

**Group link — ask every time.** When starting a site, ask whether the client wants a
group/community link featured. Wire it if yes; leave a clean open slot if the socials don't
exist yet.

## Deliver-well notes

- Send the finished file(s) as you go, one line of context each — the client can preview.
- Keep the accompanying message operational: what it is, the one thing they need to do
  (drop media via Edit Media → Export → deploy), and any open items.
- If real image/video files can't reach you, that's fine — the whole reason the editor
  exists is so the client drops them in themselves. Say so plainly.
