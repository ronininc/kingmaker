---
name: spanish-regional-localization
description: Produce Spanish website/marketing copy that sounds like a native speaker from the SPECIFIC country/region tied to the business, not generic textbook or "neutral" Spanish. Use this WHENEVER writing, translating, or reviewing Spanish (ES) copy for a client site, menu, ad, or social post — always, even if the user just says "translate this to Spanish" or "make it bilingual." Trigger hard on restaurant/food-business sites, since cuisine almost always signals the culture (Cuban, Colombian, Venezolano, Puerto Rican, Dominican, Argentine, and Mexican-regional — Sinaloa/Sonora vs. Chihuahua vs. CDMX vs. Yucatán all differ). Also trigger for non-restaurant clients once national/regional origin is known. Do NOT skip this for "simple" translations — the whole point of this skill is that grammatically-correct Spanish that ignores regional colloquialisms reads as foreign/stilted to the target audience, which is exactly the failure mode this skill exists to prevent.
---

# Spanish Regional Localization

## The problem this solves

Dictionary-correct Spanish and a real regional Spanish are not the same thing. A menu, tagline, or CTA translated with generically "correct" vocabulary can be grammatically flawless and still read as tone-deaf to a Cuban, a Sinaloense, or a Chilango — because each region has its own everyday words for ordinary things (food, money, friends, "cool," "come order now"), and using the wrong region's words is as noticeable to a native speaker as an obvious mistranslation.

The fix is not "add slang." It's: **identify the specific culture behind this business, then write in the everyday register that culture actually uses** — verified against real regional sources, not assumed from general Spanish knowledge.

## Step 1 — Identify the culture, don't assume it

Before writing a word of Spanish copy, pin down:

- **What cuisine/culture is this business?** Check your notes on the client, the business's own "About" copy, dish names on their menu, and their social media captions (owners usually write their own captions in their own natural register — this is a goldmine, not just a photo source).
- **If Mexican, which region?** "Mexican" is not one dialect. Sonoran/Sinaloan coastal-norteño Spanish, Chihuahua border Spanish, CDMX/central Spanish, and Yucatecan Spanish each have distinct everyday vocabulary. Look at the food style as a signal: mariscos/aguachile-heavy + coastal → Sinaloa/Sonora register; birria/tacos de canasta → central; cochinita/Mayan-inflected dish names → Yucatán.
- **Never guess when it's ambiguous.** If the cuisine or the owner's origin isn't clear from the intake material, ask the operator/client directly ("¿de qué región son ustedes / de dónde es la receta?") rather than defaulting to generic Mexican Spanish as a catch-all. A wrong regional guess is worse than asking.
- **Log the answer** once known — this determines every translation decision for that client's site, so it belongs in that client's file in [[client-sites]] so it doesn't get re-guessed next session.

## Step 2 — Load the region's profile

Read `references/regional-glossary.md` for the region that matches. It's a starter set of high-frequency restaurant/marketing terms per region (greetings, CTAs, money/ordering language, common false-friend words) plus known traps (a word that's fine in one country and off-color or means something completely different in another — e.g. "torta" = sandwich in Mexico but cake almost everywhere else; "popote" vs. "pitillo" vs. "sorbete" vs. "cañita" for drinking straw depending on country; "guagua" = bus in the Caribbean but baby in parts of South America).

The glossary is a **starting point, not a source of truth** — always verify a specific term before shipping it (Step 3), especially for anything that will appear in permanent site copy.

## Step 3 — Verify terms with live sources, don't rely on memory

For any term you're not highly confident is correct for that specific region, web_search it rather than pattern-matching from general Spanish knowledge. This is the actual fix for the bug this skill exists to prevent — Claude's default Spanish output skews toward whichever dialect dominates its training data, which is often not the client's.

Good sources, roughly in order of trust for this use case:

1. **The business's own real copy** (menu, Instagram/Facebook captions, Google reviews written by their customers in Spanish) — this is the single best source because it's that exact community's actual language, not a reference book's approximation.
2. **Diccionario de la lengua española (RAE)** and **Diccionario de americanismos (ASALE)** — search `"[term]" site:rae.es` or `"[term]" diccionario americanismos` — these mark regional usage explicitly (e.g. "Cuba, Ven." tags).
3. **Regional-specific dictionaries** where they exist — e.g. Academia Mexicana de la Lengua's *Diccionario de mexicanismos*, similar Cuban/Colombian/Venezuelan academy resources.
4. **WordReference country-tagged forum threads** (`wordreference.com` forum search for the term + country) — native speakers arguing about exactly this kind of nuance is often the most useful signal.
5. **Urban Dictionary and similar open slang resources** — useful for catching contemporary colloquial usage, but treat every result with caution: entries are user-submitted, inconsistently regional, frequently vulgar, and sometimes just wrong. Never lift a term from Urban Dictionary straight into client-facing copy without cross-checking it against at least one of the sources above, and never use an entry whose vulgar/sexual sense is the dominant one — see Step 4 on register.
6. **Local food blogs, regional news outlets, or YouTube food-review/vlog content from that specific country/region** — good for how the dish or the ordering experience is actually described casually.

Cross-check any term against at least **two independent sources** before it goes into permanent site copy. One hit on Urban Dictionary alone is not enough.

Follow the standing copyright rules while researching: paraphrase what you learn, don't quote dictionary entries or forum posts verbatim into your notes or into the copy.

## Step 4 — Match register to the surface, not just the region

Getting the region right and then writing like a street-slang generator is a second, different failure mode. Website copy is customer-facing marketing — warm and authentic, not a linguistics demo.

- **Use regionally-correct everyday words** for ordinary things (food terms, "order now," "welcome," "family-owned") — this is where most of the authenticity signal lives.
- **Skip anything vulgar, crude, or that reads as try-hard slang** — a restaurant site should sound like a warm local, not a meme account. If a term's primary Urban Dictionary sense is vulgar, don't use it even if a secondary sense is food-related.
- **Dish names stay as the region actually calls them** (don't "standardize" a Cuban's "ropa vieja" or a Sinaloense's "aguachile" into something more generic).
- **CTAs and structural copy** (buttons, nav, hours) can lean slightly more neutral/pan-regional than flavor copy (hero taglines, about-section storytelling, dish descriptions) — that's where the region should come through strongest.

## Step 5 — Apply consistently across the whole site

Once a region is set for a client, every piece of Spanish copy on that site (nav, hero, about, menu descriptions, CTAs, footer) should use that same region's register — not mixed. If the site is bilingual EN/ES, this only affects the `data-es`/Spanish strings; keep English copy as already handled by [[client-sites]] conventions.

Before finalizing, do a quick self-check: would a native speaker from that specific country/region read this and recognize it as their own everyday Spanish — not "correct Spanish," not another region's Spanish?
