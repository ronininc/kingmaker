---
name: business-profile-recon
description: >-
  Forces a real profile-recon pass before writing anything factual about a
  specific real business — a website, landing page, menu, ad, cold email, lead
  sheet, or "look them up" request. Whenever a task names or implies a real
  business (restaurant, shop, clinic, contractor) and the output will state its
  facts (hours, address, phone, menu, prices, brand, photos, socials), use this
  skill to REACH the business's live profiles first — owner.com, Google Business
  Profile, Yelp, Instagram, TikTok, Facebook, Apple Maps, and delivery/ordering
  platforms (DoorDash, Uber Eats, Toast, Clover, Square) — pull verified facts,
  and cite or mark every one. Trigger on "build a site for them", "look them up",
  "pull their info", "reach their profile", "find their menu/hours", "make them a
  page", or any lead-gen / enrichment request. Do NOT invent or placeholder facts
  when a real business is named — recon is mandatory, especially when building a
  client site so real details replace placeholders.
---

# Business Profile Recon

The point of this skill is simple: **when a task involves a real, named business and
the output asserts facts about it, you must go reach that business's real profiles
before you write — never fabricate, never placeholder.** A beautiful site with an
invented phone number, guessed hours, or a made-up menu is worse than no site: it
damages the client's trust and can send real customers to the wrong place.

This exists because the failure mode is seductive. It's easy to produce plausible copy
("Open daily 11–9, call (000) 000-0000, try our famous fajitas") without checking. That
plausibility is exactly the danger. Reconnaissance replaces guessing with sourced fact.

## The rule

For any real named business whose facts you're about to state or design around:

1. **Reach the profiles first.** Run the recon sweep below *before* writing copy, choosing
   a palette, or building a page. If you catch yourself typing a hours/price/phone/menu
   value you did not read from a source, stop — go find it.
2. **Every asserted fact is either sourced or marked.** A fact you verified gets used and
   its source noted. A fact you could not verify is labeled `UNVERIFIED — confirm` (in a
   builder note, a code comment, or a placeholder the client fills), never presented as true.
3. **Prefer the operator's own surfaces.** The business's own site (often powered by
   **owner.com**, Square, Toast, BentoBox, Clover, Wix), its **Google Business Profile**, and
   its **Instagram** are the highest-signal sources. Aggregators (Yelp mirrors, Zmenu,
   restaurant-guru, "…-restaurants.net") are lower-signal and frequently stale or auto-generated
   — corroborate them, don't trust them alone.

## Recon sweep

Work the sources in roughly this order, stopping when you have confident coverage of the
fields you need. Use `WebSearch` to locate each profile, then `WebFetch` to read it. If a
fetch is blocked or robots-disallowed, do **not** try to bypass it with curl/scripts — fall
back to another source or the search snippet, and mark the field accordingly.

**Start with a locating search:** `"<business name>" <city/area> <category>` — and separately
`"<business name>" owner.com` and `"<business name>" instagram`. The goal of the first pass is
to pin the *exact* entity (right location, current name — businesses rebrand) and collect its
profile URLs.

Then reach, in priority order:

1. **Owner.com / the business's own website** — the operator's source of truth. Owner.com powers
   many restaurant sites with live **menu, prices, hours, online ordering, address, phone**. If
   the business runs on owner.com (or Square/Toast/BentoBox/Clover), this is your best data. Look
   for the real domain first; search `<business> owner.com` and `<business> order online`.
2. **Google Business Profile** (Google Maps / Search knowledge panel) — canonical **hours,
   address, phone, category, price level, rating, photos**, and the "Popular times." Apple Maps
   is a good cross-check.
3. **Instagram / TikTok** — current **vibe, specialties, real photos, brand colors, promotions,
   what they actually sell** (e.g. a place listed as "Mexican" may really be a mariscos house).
   Handles, bio link, pinned posts. Great for palette and hero imagery direction.
4. **Facebook Page** — often has **hours, phone, address, "About", events**, and is where older
   businesses keep info current.
5. **Yelp** — **reviews, photos, attributes** (takeout, outdoor seating, accepts Apple Pay),
   corroborating hours/phone. Treat the top-line category cautiously.
6. **Delivery / ordering platforms** — DoorDash, Uber Eats, Grubhub (and Toast/Clover/Square
   ordering) — a reliable second source for the **live menu and item prices**.
7. **Category-specific & trust sources** as relevant — Apple Maps, BBB, state licensing, TripAdvisor
   (hospitality), Healthgrades/Zocdoc (clinics), Angi (contractors).

See `references/sources.md` for what each platform yields, how to search it, and how to handle
blocks/staleness.

## What to extract — the Profile Card

Capture what you find into a compact **Profile Card** so the downstream work (site build, copy,
lead sheet) consumes verified data instead of guesses. Fill every field you can; explicitly mark
the rest. Note the source next to non-obvious facts.

```
BUSINESS PROFILE CARD
- Legal / display name:            (note if recently rebranded — old name → new name)
- Category / what they REALLY sell: (from IG/menu, not just the aggregator label)
- Address:                          [source]
- Phone:                            [source]
- Hours (per day):                  [source]   or  UNVERIFIED — confirm
- Website / ordering URL:           (owner.com? Square? Toast?)
- Menu / products + prices:         [source]   (list top items; MP/UNVERIFIED where unknown)
- Socials:                          IG @… · TikTok @… · FB … · (open slots if none found)
- Brand colors / logo:              (hex sampled from their photos/site, or "none — propose")
- Real photos available:            (yes/no — URLs or note that client must supply)
- Rating / social proof:            (e.g. 4.8★, 593 reviews) [source]
- Notable specialties / hooks:      (signature dishes, promos, story)
- UNVERIFIED / open items:          (explicit list of what the human must confirm)

SOURCES: <markdown links to every profile you actually read>
```

When the recon feeds a website build, hand these values straight into the build (address, phone,
hours, menu, socials, palette) and wire anything still `UNVERIFIED` as a clearly-labeled
placeholder the client fills — so the site ships accurate, not invented.

## Guardrails

- **Reconnaissance, not surveillance.** Use public business profiles only. Don't compile private
  personal data about individuals, and don't scrape behind logins or defeat access controls.
- **Respect fetch boundaries.** If `WebFetch`/`WebSearch` can't retrieve something, that field is
  UNVERIFIED — say so. Never route around a block with shell/HTTP tools.
- **Corroborate before asserting** anything a customer would act on (hours someone drives to,
  a phone number they call, a price they expect). One stale aggregator is not confirmation.
- **Rebrands and duplicates are common.** Confirm you have the *current* entity at the *right*
  address before trusting anything — same name can be two businesses, and one business can have a
  new name the aggregators haven't caught up to.

## Example

**Input:** "Build a site for Mi Casa — the taco spot on Camelback."

**Wrong:** invent a menu of tacos/enchiladas, set hours to 11–9, drop in `(000) 000-0000`.

**Right (this skill):** search `Mi Casa Camelback Phoenix`, `Restaurante Mi Casa owner.com`,
`Restaurante Mi Casa instagram` → find the Google profile (3633 W Camelback Rd, verify current
name), the Instagram (@restaurantemicasaa — reveals it's a **Sinaloa mariscos** house, not generic
Mexican, plus real palette and photos), delivery menu for prices. Build the Profile Card, then
build the site from *those* facts, marking phone/exact hours `UNVERIFIED — confirm` if the sources
didn't agree. The result is accurate on day one.
