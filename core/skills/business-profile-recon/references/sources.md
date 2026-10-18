# Source Catalog — where to reach a business and what it yields

Read this when you need platform-specific tactics. Each entry: what to search, what you get,
and how reliable it is. Highest-signal sources are the operator's own surfaces; aggregators are
corroboration only.

## Tier 1 — the operator's own surfaces (trust these most)

### Owner.com (and other restaurant site builders)
- **Why it matters:** Owner.com powers a huge number of independent-restaurant sites and their
  direct online ordering. When a business runs on it, you get the operator-maintained **menu with
  live prices, hours, address, phone, and ordering** — the source of truth.
- **How to find:** `"<business>" owner.com`, `"<business>" order online`, or look at the business's
  real domain and check the footer/"Powered by". Sibling builders to check the same way: **Square
  Online, Toast (toasttab.com), BentoBox, Clover, Popmenu, ChowNow, Wix, Squarespace.**
- **Extract:** full menu + prices, hours, address, phone, ordering URL, any brand colors/logo.

### The business's own website
- Real domain (not an aggregator). Footer/contact page = address, phone, hours, email, socials.
- Sample the **brand palette** (hex) and grab the **logo** here if present.

## Tier 2 — canonical listings

### Google Business Profile (Maps / Search knowledge panel)
- **Search:** the name + city; open the Maps listing / right-side knowledge panel.
- **Extract:** hours (incl. special hours), address, phone, category, price level ($–$$$$),
  rating + review count, photos, website link, "Popular times", attributes.
- Most reliable single source for **hours and phone**. Cross-check with Apple Maps.

### Apple Maps
- Good independent cross-check for hours/address/phone and "Good to Know" attributes
  (Apple Pay, contactless, etc.).

## Tier 3 — social (vibe, truth about what they sell, media, palette)

### Instagram
- **Search:** `"<business>" instagram` or guess the handle. Read bio, bio-link, pinned/recent posts.
- **Extract:** what they *actually* serve (often truer than the aggregator category), signature
  items, current promos, **real photography**, and the **brand color palette** (sample from posts).
- Frequently the single best source for design direction and hero imagery.

### TikTok
- Similar to IG; often has walkthroughs, specials, and personality. Handle often matches IG.

### Facebook Page
- **Extract:** hours, phone, address, "About", events, posts. Older/family businesses keep FB
  current even when other profiles lag.

## Tier 4 — corroboration (use, but don't trust alone)

### Yelp
- **Extract:** reviews, photos, attributes, corroborating hours/phone. The category label can be
  wrong or generic. Good for social proof and photos; verify facts against Tier 1–2.

### Delivery / ordering platforms
- **DoorDash, Uber Eats, Grubhub**, plus **Toast / Clover / Square** ordering pages.
- **Extract:** live menu + item prices (a strong second source), hours the kitchen is open.

### Auto-generated aggregators — LOW trust
- Zmenu, restaurant-guru, allmenus, "<name>-restaurants.net/.com", placejoys, wheree, netwaiter.
- Often **stale or machine-generated**. Use only to locate the entity or as a weak corroborator;
  never assert a customer-facing fact (hours/price/phone) from these alone.

## Category-specific

- **Hospitality:** TripAdvisor, OpenTable, Resy.
- **Clinics / providers:** Healthgrades, Zocdoc, state licensing boards.
- **Contractors / home services:** Angi, BBB, state contractor license lookup.
- **Any:** BBB for legitimacy/complaints; the Secretary of State business registry for legal name.

## Handling blocks and staleness

- If `WebFetch` returns robots-disallowed / 403 / a login wall: **do not** use curl, wget, Python
  requests, or any script to fetch it (prohibited). Fall back to another source, or use the
  `WebSearch` result snippet, and mark the field `UNVERIFIED`.
- If two sources disagree (e.g. Yelp says 10pm, Google says 9pm): trust the operator's own surface
  and Google over aggregators; if still unclear, mark `UNVERIFIED — confirm` and surface it to the
  human. A customer will act on this — accuracy beats a confident guess.
- If you genuinely cannot verify a needed field anywhere, say so plainly and wire it as a labeled
  placeholder rather than inventing a value.
