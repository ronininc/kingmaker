# Tech Domain: Search Strategy

## Where to Search

Priority order:
1. **Official documentation**: product docs, API references, release notes, changelogs
2. **GitHub**: repositories, issues, discussions, READMEs, benchmarks
3. **RFCs and standards**: IETF, W3C, ECMA, IEEE specifications
4. **Conference talks and papers**: recorded presentations, published proceedings
5. **Tech publications**: Ars Technica, The Verge, InfoQ, The New Stack, Hacker News (as signal, not source)

## Search Query Patterns

```
"{technology} documentation"
"{technology} changelog {version}"
"{technology} vs {alternative} benchmark {year}"
"site:github.com {technology} {specific feature}"
"{technology} RFC" or "{technology} specification"
"{technology} performance {workload type} {year}"
"{technology} migration guide"
```

## Source Evaluation: Tech Specific

**Strongest signals:**
- Official release announcements from the project maintainers
- Benchmark results with methodology disclosed (hardware, config, dataset)
- Code examples that can be independently verified
- CVE databases for security claims

**Weak signals (flag as Tier 3):**
- Blog posts comparing technologies without running benchmarks
- "Top 10 tools" listicles without technical depth
- Stack Overflow answers (useful for discovery, cite the linked docs instead)
- Tutorials that don't cite versions or dates

**Red flags (discard):**
- AI-generated tech comparisons with generic pros/cons
- Articles that don't mention specific versions
- Benchmarks without disclosed methodology
- Marketing whitepapers disguised as technical analysis

## Freshness

Tech moves fast. Default to sources from the last 6 months. For established technologies (Linux kernel, PostgreSQL, TCP/IP), older sources are acceptable if they cover stable, unchanging behavior. For new tools, frameworks, or APIs, insist on current-year sources.

## Output Notes

When reporting tech findings:
- Always note the version being discussed
- Distinguish between stable release features and preview/beta
- Note if a benchmark was run by the vendor (potential bias) vs independent party
- Link to source code or commits when making claims about implementation
