# Academic Domain: Search Strategy

## Where to Search

Priority order:
1. **Google Scholar**: broadest academic search, citation counts visible
2. **arXiv**: preprints in CS, physics, math, quantitative biology, statistics
3. **PubMed / PMC**: biomedical and life sciences, peer-reviewed
4. **Semantic Scholar**: AI-powered academic search with citation context
5. **SSRN**: social sciences, economics, law preprints
6. **Institutional repositories**: university publication databases
7. **Conference proceedings**: ACM DL, IEEE Xplore, NeurIPS, ICML, ACL

## Search Query Patterns

```
"site:scholar.google.com {topic} {year range}"
"site:arxiv.org {topic}"
"site:pubmed.ncbi.nlm.nih.gov {topic}"
"{topic} systematic review {year}"
"{topic} meta-analysis"
"{author name} {topic} {year}"
"{topic} survey paper {field}"
```

## Source Evaluation: Academic Specific

**Strongest signals:**
- Peer-reviewed journal articles (check for journal impact factor if known)
- Systematic reviews and meta-analyses (synthesize multiple studies)
- Papers with high citation counts relative to their age
- Replication studies that confirm original findings

**Acceptable signals:**
- arXiv preprints from established research groups (note preprint status)
- Conference papers from top-tier venues (NeurIPS, ICML, ACL, CVPR, etc.)
- Technical reports from major research labs (Google, DeepMind, Meta AI, etc.)
- Theses and dissertations from recognized universities

**Weak signals (flag as Tier 3):**
- arXiv preprints without institutional affiliation
- Papers with zero citations after 2+ years
- Workshop papers and extended abstracts
- Predatory journal publications

**Red flags (discard):**
- Papers from known predatory journals (check Beall's list patterns)
- Studies with undisclosed funding from interested parties
- Results that have been retracted (check Retraction Watch)
- Papers that cite only their own prior work

## Freshness

Academic research has longer cycles. Last 2-3 years is the default window. For rapidly evolving fields (ML, AI, genomics), prefer last 12-18 months. For established science, seminal papers from any era are valid if still cited. Always note whether a paper is preprint vs peer-reviewed.

## Output Notes

When reporting academic findings:
- Always note: peer-reviewed vs preprint
- Include citation count when available (contextualizes impact)
- Note sample size, methodology type (RCT, observational, computational)
- Distinguish between statistical significance and practical significance
- Flag if findings are from a single study vs replicated
- Note funding sources when disclosed (potential conflict of interest)
