---
name: kingmaker-cloudflare-release
description: >-
  Publish a static site to Cloudflare Pages or Workers truthfully: validate the build output, find which
  deployment actually serves the domain, bind the domain, and prove the live site is the new build rather than a
  stale cached one. Use when the owner says "deploy to Cloudflare", "the live site is stale", "my domain doesn't
  resolve", "Pages or Workers?", or "why is production serving the old build". Read-only checks run freely; every
  deploy, DNS change or cache purge waits for the owner's explicit yes.
---

# Cloudflare release, truthfully

A deploy is done when the live domain serves the build you validated, not when the upload command printed "Success".
This skill validates the build, diagnoses what the domain is really serving, and only then publishes, with the
owner's yes.

## When to use it

- Publishing a folder of static files (`index.html` plus assets) to Cloudflare.
- "The live site shows the old version", "the domain doesn't load", "which project serves this domain?".

It doesn't build the site itself; use the project's own build command first.

## Tools

- Cloudflare's own CLI, `wrangler` (not part of Kingmaker): `npx wrangler --version` to check it, `npx wrangler
  whoami` to see which account it is signed into. Signing in is the owner's act in their browser.
- Read-only network tools on every Mac: `dig +short <domain>` and `curl -sI https://<domain>/`.
- A Cloudflare connector, if the owner connected one, for listing Workers and projects. DNS records and custom
  domains may need the Cloudflare dashboard.

## 1. Validate the build before anything is published

In the build output folder:

- `index.html` is at the top level, and every page and asset it links to exists in the folder.
- A build marker you can see from outside: a build ID or version in the HTML (for example a
  `<meta name="build" content="<id>">`) that changes every build. Without one you can't prove the live site is new.
- Nothing that mustn't be public: no `.env`, keys, tokens, source maps you didn't mean to ship, private notes,
  personal data. `grep -rIl -E "sk-[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY" <folder>` must find nothing.
- No installers or large binaries. Cloudflare Pages refuses files over 25 MiB; host downloads elsewhere and link
  them.
- If you use them: `_headers` (for example `Cache-Control: no-cache` on HTML so a new deploy shows at once) and
  `_redirects`, both at the top level.

If a check fails, fix the build. Never publish around it.

## 2. Know what serves the domain

Pages and Workers bind a domain differently, and mixing them up is the usual cause of "nothing loads":

- **Pages:** the project's Custom domains tab adds the domain and creates its DNS record. A deploy makes a new
  version of the project. List them: `npx wrangler pages project list`,
  `npx wrangler pages deployment list --project-name <project>`.
- **Workers (static assets):** the domain is a Worker Custom Domain or a route, with a proxied DNS record for each
  hostname. `npx wrangler deployments list` in the Worker's folder lists its versions.

Decide which one is meant to serve the domain, and bind the domain to that one only, for the bare domain and `www`.

## 3. Diagnose, outside in

1. **Does it resolve?** `dig +short <domain>` and `dig +short www.<domain>`. Nothing back means DNS or binding, not
   stale content: go to step 4.
2. **What is served?** `curl -sI https://<domain>/` shows the status and headers (`cf-cache-status`,
   `cache-control`, `age`). Fetch the page and look for the build marker. An old marker means an old deployment is
   live, or a cache is serving it.
3. **Origin or cache?** Compare the marker on the project's own deployment address (`<project>.pages.dev`, or the
   Worker's `workers.dev` address) with the custom domain. Right there and wrong on the domain: a cache, or the
   domain is bound to a different project.

## 4. Change things (owner's yes each time)

Say exactly what will happen before each one, and wait for a clear yes:

- **Deploy:** `npx wrangler pages deploy <folder> --project-name <project>` (Pages), or `npx wrangler deploy`
  (Workers).
- **Bind the domain** or add DNS records: in the dashboard, or through a connector with DNS scope. Never guess IP
  addresses.
- **Purge the cache** for the zone, when the origin is right and the edge is stale.

## 5. Prove it

After the change, from outside: the domain resolves, `curl -sI` shows 200, the page carries the new build marker,
and the checks from step 1 still hold on what is served. Only then call it deployed.

## Report

Name the layer and the true state, e.g.:
`<domain>: RESOLVES; serving build 2026-10-16.3 (matches validated build); cache headers OK. Deployed with the
owner's yes.` or `<domain>: NOT RESOLVING (no DNS record for the bare domain). Cause: domain bound to the old Pages
project. Fix: bind it to the Worker (waiting for your yes). Build: validated locally.`

## Boundary

Read-only checks are free. Deploys, DNS and custom-domain changes, cache purges and account settings each need the
owner's explicit yes. Kingmaker never signs in, accepts terms, or types a password for the owner.
