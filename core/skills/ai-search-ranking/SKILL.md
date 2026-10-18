---
name: ai-search-ranking
description: "Build a website engineered to rank in AI search engines (ChatGPT, Google Gemini, AI Overviews). Keyword-map → one page per keyword → FAQ templates → AI-readable schema method. Trigger on any new site or site rebuild where Robbie wants AI-search visibility."
metadata: { "includeInPrompt": true }
---

# AI Search Ranking

## Purpose

Turn real search demand into a site where every page answers one query well enough for Google and AI engines to cite it. Method distilled from @kenvanvorhis's reel (https://instagram.com/p/Dd8jsuhtBmp/, posted 2026-10-01): an exotic/luxury car-rental site in California built from a Keyword Planner export. His results (100,000 keywords tested, appearing in ChatGPT and Gemini, outranking established competitors in 2 weeks) are HIS claims, unverified. The skill promises the method, never his timeline.

Tooling is Ronin's stack, not his: the CRM site builder replaces Webflow, and local Kingmaker drives cloud Claude through the CRM.

## Workflow

1. **Search demand source.** Robbie supplies or authorizes the keyword source: a Google Ads Keyword Planner export from his own account, Search Console data, or another source he names. Creating or logging into an ads account is his tap, never Claude's.
2. **Keyword research.** Pull what real customers type for this business, service area and audience ("lamborghini rental palm springs" pattern: service + model/product + place). Use `searchfit-seo:keyword-clustering` for grouping when it is installed.
3. **Keyword map.** Export to a sheet: query, monthly volume, intent, cluster, target page, source of the number. Every volume cites its source; nothing estimated is shown as measured. **Stop here and show Robbie the keyword map. No copy is written until he approves it.**
4. **Site plan: one page per keyword.** Each approved query or tight cluster gets exactly one page. No two pages compete for the same query. Location pages follow `local-seo-location-pages` when it applies.
5. **Collections.** Model the repeatable content as CMS collections in the site builder (his example: vehicles, locations, models; for a restaurant: dishes, locations, catering; for a service business: services, areas, jobs).
6. **Page templates.** Each template carries a clear title and H1 matching the query, a direct answer in the first paragraph, specifics (prices only where the site's rules allow them, hours, area, proof), and an FAQ block of real questions customers ask.
7. **AI-readable structure.** JSON-LD schema per page type (LocalBusiness / Product / Service / FAQPage / BreadcrumbList), clean headings, fast static pages, and a crawlable sitemap. Use `searchfit-seo:schema-markup` and `searchfit-seo:ai-visibility` when installed rather than re-deriving them.
8. **Copy.** Claude writes the site-wide copy against the approved map: one page, one query, answer first, facts sourced from the business's verified profile (run `business-profile-recon` first for a real business).

## Output Contract

- `keyword-map` sheet (step 3), approved by Robbie before step 8.
- Site plan: page list with target query per page.
- Templates with FAQ blocks and schema per page type.
- Copy per page, each factual claim traceable to a source.
- A short note of what was measured vs. what is expected; AI-search appearance is checked after launch, never promised.

## Operating Rules

1. **Audience targeting.** Copy is written for the business's actual customers and region (language, dialect, local terms); regional Spanish follows `spanish-regional-localization`.
2. **Sourced claims only.** Every fact about the business and every number in the keyword map cites its source. No invented reviews, awards, rankings or results.
3. **Robbie's tap on credentials.** Ads, Search Console, analytics, registrar or CMS logins and keys are his to enter; never request a secret in chat or put one in a file.
4. **Never touch publish toggles.** Building and previewing is fine; going live, DNS, and publish switches stay with Robbie.
5. **No outreach changes.** This skill builds pages. It does not alter outreach sequences, email, SMS, or social posting.
6. **His claims stay his.** The reel's 2-week, 100k-keyword and ChatGPT/Gemini results are labeled as the creator's claims everywhere, never presented as Ronin results or guarantees.

Reconstructed 2026-10-05 from the "install AI search ranking skill" build order, because Muse's original `~/workspace/skills/ai-search-ranking/SKILL.md` was not on the host. If Muse's file surfaces, replace this one with it verbatim.
