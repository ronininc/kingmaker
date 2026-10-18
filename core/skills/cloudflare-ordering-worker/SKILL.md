---
name: cloudflare-ordering-worker
description: >-
  Add real online ordering to a static client website by deploying a Cloudflare
  Worker as the ordering + payment backend. Use this WHENEVER a site needs to take
  orders or payments — "add online ordering", "let them order/pay on the site", "wire
  up checkout", "add a cart", "deploy the ordering worker", "make the shop live",
  "connect Stripe/Clover/Square", or any time you finish a website-build-standard site
  whose payment-ready shop now needs a working backend. This is the house bolt-on that
  turns the static "payment-ready" structure into a live, hosted ordering system without
  a rebuild. Trigger even if the user only says "they need to take orders" and doesn't
  name Cloudflare or Workers. Do NOT hand-roll a server, a Node/Express backend, or paste
  secret keys into the front-end — the ordering path is always this Worker.
---

# Cloudflare Ordering Worker

This skill deploys one small Cloudflare Worker that sits behind a house-standard static
site and does the three things a static page cannot: **hold the real menu/prices, create
a hosted checkout, and record paid orders + notify the restaurant.** The site stays static
and unhackable; the Worker is the only moving part, and it's a bolt-on — no redesign.

The design rule that matters most: **the browser is untrusted, so prices live in the
Worker, not the page.** The site sends only `{id, qty}`; the Worker recomputes every total
from a server-side menu in KV. This is why we never let the front-end pass prices, and why
"just use a Stripe payment link per item" isn't enough once there's a cart.

Default processor is **Stripe Checkout** (Stripe-hosted page → card data never touches the
Worker, minimal PCI scope). Clover and Square are drop-in alternates in
`references/providers.md` — use them only when the client already runs that POS.

## What's in this skill

```
assets/
  worker.js            — the Worker (Stripe Checkout, server-side pricing, webhook, notify)
  wrangler.toml        — deploy config; rename the slug, paste KV ids, per-site vars
  menu.example.json    — the server-side menu (prices in CENTS) → upload to KV
  order-client.js      — front-end glue: cart + "Start Order" → redirect to checkout
references/
  providers.md         — Stripe (default) / Clover / Square adapters
  notifications.md     — how the kitchen gets told (webhook / Resend email / SMS)
```

Start from these files — copy them into a working folder and fill the placeholders. Don't
rewrite the Worker from scratch; it already handles CORS, signature verification, and the
untrusted-price problem correctly.

## Deploy workflow

Do these in order. Steps 1–3 are per-site setup; 4–6 wire and verify.

**1. Scaffold.** Copy `assets/worker.js` and `assets/wrangler.toml` into a new folder
(e.g. `<client>-ordering/`). In `wrangler.toml` set `name` to `<client>-ordering`, and set
`ALLOWED_ORIGIN`, `SUCCESS_URL`, `CANCEL_URL` to the site's real origin. Leave secrets out
of this file.

**2. Create KV + upload the menu.** The menu is the price source of truth, editable without
redeploying:
```
npx wrangler kv namespace create ORDERS      # paste the id into wrangler.toml
npx wrangler kv namespace create MENU         # paste the id into wrangler.toml
npx wrangler kv key put --binding=MENU menu --path=menu.example.json
```
Edit `menu.example.json` first so `id`s match the site's `data-add` buttons and prices are
in **cents** (1299 = $12.99).

**3. Set secrets (never in git).**
```
npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_… while testing
npx wrangler secret put STRIPE_WEBHOOK_SECRET     # whsec_… (from step 5)
```

**4. Deploy.** `npx wrangler deploy` → note the `https://<client>-ordering.<sub>.workers.dev`
URL. Sanity check: `GET /health` returns `{ok:true}` and `GET /menu` returns the menu.

**5. Register the Stripe webhook.** Stripe Dashboard → Developers → Webhooks → add
`https://<worker>/webhook`, event `checkout.session.completed`. Copy the signing secret into
`STRIPE_WEBHOOK_SECRET` (rerun the secret put, then redeploy). This is what flips an order to
`paid` and notifies the kitchen — skipping it means orders pay but nobody hears about them.

**6. Wire the site.** Inline `assets/order-client.js` into the site's `index.html`, set
`ORDER_API` to the Worker URL, add `data-add="<item-id>"` to each menu "Add" button, and give
the checkout button `id="checkoutBtn"` (optional cart counter `id="cartCount"`). The client
recomputes nothing — it just collects `{id, qty}` and redirects to the returned checkout URL.

### Deploying via the Cloudflare MCP instead of the CLI
If `wrangler` isn't available but the Cloudflare Developer Platform MCP is connected, you can
provision without the terminal: use `kv_namespace_create` for ORDERS and MENU, `workers_*`
tools to inspect/manage the Worker, and the docs search tool for current API shapes. Secrets
and the code upload still go through `wrangler` or the dashboard — MCP covers KV + inspection,
not secret-setting. Prefer the CLI when both are available; it's the fewest moving parts.

## Verify before calling it done
- `GET /health` → `{ok:true}`; `GET /menu` → the KV menu (not the fallback stub).
- Place a **test-mode** order end to end with card `4242 4242 4242 4242`. Confirm the browser
  redirects to Stripe, payment completes, and the webhook marks the order `paid` (check the
  ORDERS KV) and fires `NOTIFY_WEBHOOK` / email.
- Confirm CORS: a request from the real `ALLOWED_ORIGIN` succeeds; the Worker doesn't echo `*`
  for a site that takes money.
- Only after a clean test-mode run, swap `sk_test_…`/`whsec_…` for live keys and redeploy.

## Guardrails
- **Never** put a secret key in `wrangler.toml`, the front-end, or git. Secrets go through
  `wrangler secret put` (or the dashboard) only.
- **Never** trust a price or total from the browser. If you find yourself reading a price out
  of the page, stop — the menu in KV is the only source.
- **Always** verify the webhook signature (the template does) — an unsigned `/webhook` lets
  anyone mark orders paid.
- Test mode first, every time. Real money only after a green end-to-end test run.
- Inquiry/notification destination and payment account are **per client** — re-set them on
  every deploy; never carry one restaurant's inbox, keys, or menu into the next.
