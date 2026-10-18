# Payment provider adapters

The template ships wired for **Stripe Checkout** because it's the least work and
lowest PCI scope: the customer pays on a Stripe-hosted page, so no card data ever
touches the Worker. Only swap providers if the client already runs Clover or Square
and wants payouts in that account.

The contract to preserve when swapping: `/order` must (1) recompute totals from the
server menu, (2) create a hosted checkout session with the provider, (3) persist a
pending order keyed by `order_id`, and (4) return `{ url }` for the browser to redirect
to. The provider's webhook then flips the order to `paid` and fires `NOTIFY_WEBHOOK`.

## Stripe (default — already implemented in worker.js)
- Secrets: `STRIPE_SECRET_KEY` (`sk_test_…` then `sk_live_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
- Dashboard → Developers → Webhooks → add endpoint `https://<worker>/webhook`, event
  `checkout.session.completed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- Test cards: `4242 4242 4242 4242`, any future date/CVC. Nothing is charged in test mode.

## Clover (hosted checkout)
- Clover Hosted Checkout API: `POST https://api.clover.com/invoicingcheckoutservice/v1/checkouts`
  (sandbox host `https://apisandbox.dev.clover.com`) with `Authorization: Bearer <API_TOKEN>`.
- Body includes `customer` + `shoppingCart.lineItems[]` (amounts in cents). Response returns
  a `href` — return that as `{ url }`.
- Webhook: configure in the Clover dashboard; verify the `X-Clover-Auth`/signature per their
  docs, then mark paid. This project also has a Clover MCP connector (`clover-operations-command`)
  useful for reconciling orders against the merchant's inventory.

## Square (hosted checkout / Payment Links)
- `POST https://connect.squareup.com/v2/online-checkout/payment-links` (sandbox
  `https://connect.squareupsandbox.com`) with `Authorization: Bearer <ACCESS_TOKEN>` and
  `Square-Version` header. Body: `quick_pay` or `order` with `line_items[]` (amounts in cents,
  `location_id` required). Response `payment_link.url` → return as `{ url }`.
- Webhook: Square dashboard → Webhooks, subscribe to `payment.updated`; verify the
  `x-square-hmacsha256-signature` with your signature key, then mark paid.

Keep the same `menu` KV, `ORDERS` KV, CORS, and server-side pricing regardless of provider.
