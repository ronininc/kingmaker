---
name: service-business-website
description: Build a complete client website for a local service business (landscaping, contracting, cleaning, pool care, HVAC and similar) structured like the reference build — public marketing pages plus three role-gated apps (a crew job tracker, an office drag-and-drop scheduler, and a client project portal) over a Supabase backend, with a reusable CSS motion kit and sign-in security tailored for Cloudflare Pages. Use this whenever the user wants to create, scaffold, or redesign a service-business site, pair a marketing site with a field/ops tool, add a client portal, crew tracker, or scheduling board, "build a site like the reference build", or deploy any of these to Cloudflare. Also use when tailoring an existing static site's auth, headers, or credential-stripping for a Cloudflare Pages deployment.
---

# Service-business website (reference pattern)

Builds a static, no-build-step site (plain HTML/CSS/JS) with a Supabase backend and a
Cloudflare-first deploy. Any static host serves the front end; the security model is written
for Cloudflare Pages. There is no framework and no npm install — this keeps client sites cheap
to host and trivial to hand off.

## What you're building

| Surface | Path | Audience |
|---|---|---|
| Marketing site | `index.html`, `services/*.html`, `gallery/about/contact` | Public |
| Client portal | `portal.html?c=CODE` | Clients (bearer code) |
| Crew job tracker | `crew/index.html` | Crew (login) |
| Office scheduler | `admin/index.html` | Admin (login) |

The marketing pages are self-contained (shared `assets/css/site.css` + `assets/js/site.js`).
The three apps share `assets/js/db.js` (a tiny Supabase client over `fetch`) and
`assets/js/config.js` (backend URL, public key, demo access, business details).

## Workflow

1. **Gather the business facts first.** If a real business is named, run the house
   recon/profile step before writing any factual copy (hours, address, phone, services,
   brand). Never invent facts or photos — unknown image slots stay as CSS placeholders.
2. **Scaffold the marketing pages** from the client's real content. Every image is a styled
   CSS placeholder (`.ph` variants with a `data-label`) until real photography is supplied —
   the site looks intentional, not broken. Wire nav, services dropdown, and the mailto contact
   form (no server needed).
3. **Apply the motion kit.** Drop in `assets/animations.css` (see `references/motion.md`) —
   button lift, card rise, dropdown fade+caret, hamburger→X, progress-fill, spinner, slide-in
   drawer, input focus. All respect `prefers-reduced-motion`.
4. **Stand up the backend** per `references/architecture.md`: tables, roles, the
   `is_crew()` roster gate, and the `portal_lookup()` security-definer function. Copy
   `assets/config.template.js` and fill in the project URL + publishable key.
5. **Wire the three apps** (portal / crew / scheduler) to the backend. The scheduler is a
   crew×day timeline, not a calendar — a job is a bar as wide as its working-day duration.
6. **Tailor sign-in security for Cloudflare** — this is mandatory before any public deploy.
   Read `references/security-cloudflare.md` and ship `assets/_headers` +
   `assets/deploy-cloudflare.sh`. The deploy script strips the demo credential and ABORTS if
   it survives; `_headers` sets CSP + noindex; put `/admin/*` and `/crew/*` behind Cloudflare
   Access for edge SSO.
7. **Deploy:** `./deploy-cloudflare.sh --deploy` (wrangler) or drag `dist/` into Cloudflare
   Pages → Upload assets.

## Non-negotiables

- **The publishable Supabase key is public by design; the `service_role` key never touches
  the client bundle.** Security lives in RLS + the roster gate + `portal_lookup`, not in
  hiding the key. Verify anon reads return `[]` and anon writes 401.
- **The local demo password never reaches a public URL.** `demoAccess` self-disables off
  localhost, and the build step strips the password and fails closed if it remains.
- **No fabricated content or imagery.** Placeholders are labeled and intentional; real photos
  replace them later. Copy states only verified facts.

## Reference files

- `references/architecture.md` — pages, roles, Supabase data model, access codes, scheduler
  occupancy logic. Read before building the apps or backend.
- `references/security-cloudflare.md` — the full Cloudflare-tailored sign-in security model:
  `_headers`, the build-time credential strip, and Cloudflare Access edge auth. Read before
  deploying.
- `references/motion.md` — the animation catalog and how to apply each one. Read when styling.

## Assets

- `assets/animations.css` — the reusable motion kit (values verbatim from the reference build).
- `assets/_headers` — Cloudflare Pages security headers template (replaces `netlify.toml`).
- `assets/config.template.js` — backend + demo-access + business-details config pattern.
- `assets/deploy-cloudflare.sh` — build clean `dist/`, strip the credential (abort if present),
  deploy to Cloudflare Pages.
