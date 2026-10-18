# Build Checklist & Cloudflare Deploy

Work top to bottom. Nothing here is optional unless the client overrides it.

## Before building
- [ ] Confirm sections needed and the brand palette (set them as CSS variables:
      `--green`, `--orange`, `--ink`, `--head` font, etc.).
- [ ] ASK: "Do you want a group/community link featured?" (Discord / Facebook / WhatsApp).
      Wire it if yes; leave a clean open slot if the socials don't exist yet.
- [ ] ASK: "Where should inquiries route?" — get the per-site routing destination (an email
      inbox, a form endpoint like Formspree / a Cloudflare worker, or a link). This is asked
      on EVERY build; never reuse the last site's inbox.
- [ ] If any hero/background video is wanted, note the 10–20s / ~15 MB guidance.
- [ ] Research any real facts the copy needs (hours, roster, menu, prices). Don't invent;
      mark unverified items.

## Structure
- [ ] Single `index.html`, `/assets/` folder, `README.md`. Self-contained, inline CSS/JS.
- [ ] Every image/video referenced as `./assets/<meaningful-name>` with a branded `.fallback`
      inside each `.frame` so empty slots look intentional, never broken.
- [ ] Hero uses `.hero-vid` with `<video muted loop playsinline preload="auto">` + `.hero-fallback`.

## Wire the standard features
- [ ] Paste in `assets/media-editor-kit.html` (style block in head, script before `</body>`,
      inspector markup once). Follow its wiring conventions — the JS auto-discovers slots.
- [ ] Confirm the editor is BUILDER-ONLY: it must not appear on the hosted domain. The kit
      gates on `file://`/`localhost`/`#studio`; keep that gate.
- [ ] Add `inspectable` + `data-src` + `data-title` to gallery cards for the zoom viewer.
- [ ] Add the SVG logo (see `logo-svg.md`) in a `.logo-slot`, placed per client instruction.
- [ ] If there's a shop: structure products up front, mark it payment-ready, do NOT wire a
      live processor until the client picks Clover/Stripe/Square and has inventory.
- [ ] Wire inquiry routing: put `const INQUIRY_EMAIL = "..."` (+ optional `const FORM_ENDPOINT
      = ""`) at the top of the script and point every contact/booking form at it. `FORM_ENDPOINT`
      set → POST fields there (hands-free); else open a pre-filled `mailto:` to `INQUIRY_EMAIL`.
      Leave a clear placeholder + call it out if the destination isn't provided yet.

## Verify before delivering
- [ ] Render with headless Chromium (Playwright, `executablePath` to the preinstalled
      Chromium). Screenshot the hero + 1–2 key sections. Confirm **zero JS `pageerror`s**.
- [ ] Test one real drag-drop swap: enter edit mode, dispatch a drop with a generated File,
      assert the slot's media updated and the export counter incremented.
- [ ] Confirm the editor is absent when loaded from a non-local host (route-fulfill a fake
      domain in the test), present with `#studio`.

## Cloudflare deploy (tell the client, or do it if asked)
1. Cloudflare dashboard → **Pages** → *Create → Direct Upload*.
2. Drag the whole site folder in.
3. Bind the domain. Live — it routes to static files, nothing to hack.

## Updating media later (the client, no code)
1. Open `index.html` locally (or add `#studio` to the live URL).
2. Click **✎ Edit Media**, drag photos/MP4s onto slots (or click to pick).
3. Click **⭳ Export Files** → move the downloaded files into `/assets` (keep names) →
   re-upload the folder to Cloudflare.

## README to ship with every site
Include: the asset filename table (what image goes where), the "Live Media Editor
(builder-only)" section, the video length rule, the "what to swap before launch" list
(form endpoints, social URLs), and the Cloudflare deploy steps.
