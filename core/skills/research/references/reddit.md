# Reddit Research

Read this reference when Reddit posts, comments, or community sentiment are a
material part of the research question.

## Access

Claude SDK `WebFetch` may refuse `reddit.com`. Do not retry it repeatedly.

For a known subreddit listing, use Reddit's public JSON endpoint through Bash:

```bash
curl -sS --max-time 30 \
  -H 'User-Agent: Research/1.0' \
  'https://www.reddit.com/r/SUBREDDIT/top.json?t=year&limit=100'
```

For a known post, append `.json` to its canonical URL. Use bounded timeouts and
page sizes. If Reddit rejects or rate-limits the request, report the gap and use
other forums/review platforms; do not bypass access controls.

Use WebSearch to discover relevant threads when the subreddit or post is not
known. Open cached/search snippets only as discovery evidence, then fetch the
original thread when possible.

## Sampling

- Define the market, product, and time window before collecting threads.
- Use multiple query phrasings and more than one relevant subreddit.
- Prefer threads with substantive comments over isolated high-vote posts.
- Record thread date, subreddit, score/comment count when available, and URL.
- Search for counterexamples and negative experiences, not only confirming
  opinions.
- Treat deleted users, removed comments, bots, promotions, and affiliate posts
  as contamination signals.

## Interpretation

Reddit is community evidence, not population-representative market research.
Use it to identify language, objections, use cases, and hypotheses. Do not turn
comment frequency into market share, prevalence, or purchase intent without a
representative source.

Quote sparingly and preserve the meaning. Attribute claims as community-sourced
and triangulate important conclusions with primary data, reputable surveys,
retailer reviews, or official product information.
