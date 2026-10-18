# General Domain: Search Strategy

Default module for mixed-domain or unclear topics. Use when the query doesn't fit neatly into tech, business, or academic categories.

## Where to Search

Cast a wide net, then narrow:
1. **Established news outlets**: Reuters, AP, BBC, NPR, major national newspapers
2. **Subject-matter publications**: whatever publication covers this niche (e.g., Wired for tech-culture, National Geographic for science/nature, The Athletic for sports)
3. **Official sources**: government websites (.gov), international organizations (UN, WHO, OECD), NGOs
4. **Reference databases**: Britannica, specialized encyclopedias, curated directories
5. **Industry bodies**: professional associations, standards organizations, trade groups

## Search Query Patterns

```
"{topic} {year}"
"{topic} explained"
"{topic} overview {authoritative source}"
"{topic} statistics data {year}"
"{topic} history timeline"
"{topic} pros cons analysis"
"site:.gov {topic}"
"site:.edu {topic}"
```

## Source Evaluation: General

**Strongest signals:**
- Multiple independent news organizations reporting the same facts
- Government and institutional data with documented methodology
- Named experts quoted in reputable publications
- Primary source documents (laws, treaties, official records)

**Acceptable signals:**
- Feature articles in established publications
- Interviews with subject-matter experts
- Documentaries and long-form journalism
- Reputable encyclopedia entries (as starting point, cite their sources)

**Weak signals (flag as Tier 3):**
- Opinion columns (distinguish from news reporting)
- Personal blogs, even from knowledgeable individuals
- Social media posts, even from verified accounts
- Forum discussions (Reddit, HN): useful for leads, not as sources

**Red flags (discard):**
- Content farms (ehow, about.com clones, answer sites)
- Clearly AI-generated articles with generic, unsourced claims
- Hyper-partisan sources presenting opinion as fact
- Anonymous sources without corroboration

## Freshness

Depends on topic type; the main agent provides a freshness parameter. When "none" is specified, prioritize depth over recency. When a date constraint applies, filter aggressively: an outdated source on a fast-moving topic is worse than no source.

## Output Notes

When reporting general findings:
- Note the type of each source (news report, government data, expert opinion, etc.)
- Distinguish between facts, expert opinion, and analysis
- If covering a controversial topic, ensure multiple perspectives are represented
- Note geographic scope of claims (a US statistic may not apply globally)
- Always provide enough context for the claim to be understood without reading the full source
