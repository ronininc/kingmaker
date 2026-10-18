# Business Domain: Search Strategy

## Where to Search

Priority order:
1. **Financial news**: Reuters, Bloomberg, Financial Times, Wall Street Journal
2. **Industry reports**: Gartner, McKinsey, Forrester, Statista, IBISWorld
3. **Regulatory filings**: SEC EDGAR (10-K, 10-Q, 8-K), company investor relations pages
4. **Press releases**: official company newsrooms, PR Newswire, Business Wire
5. **Market research**: CB Insights, Crunchbase, PitchBook (for startup/VC data)
6. **Government data**: Bureau of Labor Statistics, Census, OECD, World Bank

## Search Query Patterns

```
"{company} annual report {year}"
"{industry} market size {year}"
"site:sec.gov {company} 10-K"
"{industry} trends {year} report"
"{company} revenue growth {quarter} {year}"
"{market} forecast {year} {research firm}"
"{industry} competitive landscape analysis"
```

## Source Evaluation: Business Specific

**Strongest signals:**
- SEC filings and audited financial statements
- Named research firms with disclosed methodology
- Official company earnings calls and investor presentations
- Government statistical agencies

**Acceptable signals:**
- Business news articles citing named sources or documents
- Industry association reports
- Company press releases (note: inherently biased toward positive framing)
- Analyst reports from recognized firms

**Weak signals (flag as Tier 3):**
- Business advice blogs without data
- LinkedIn posts and thought leadership articles
- Unnamed "industry experts" in articles
- Market size estimates without methodology

**Red flags (discard):**
- Unverifiable market statistics with no original source
- SEO content farms rewriting press releases
- Articles primarily promoting a product or service
- "Reports" from unknown firms with no methodology section

## Freshness

Business data ages quickly. Default to last 12 months. For market sizing and forecasts, prefer the most recent available report. For historical trends, older data is acceptable but must be clearly dated. Always note the reporting period for financial data.

## Output Notes

When reporting business findings:
- Always note the source's potential bias (vendor report vs independent research)
- Distinguish between revenue, GMV, ARR, and other financial metrics
- Note whether market size figures are TAM, SAM, or SOM
- Include the methodology or sample size when citing survey results
- Currency and reporting period must be explicit
