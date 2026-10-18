# Notifying the restaurant when an order is paid

The Worker fires on `checkout.session.completed`. Pick how the kitchen hears about it.

## Default: NOTIFY_WEBHOOK (most flexible, no extra secret)
Set `NOTIFY_WEBHOOK` in `wrangler.toml [vars]` to any endpoint that accepts a JSON POST:
- A **Slack** incoming webhook (`https://hooks.slack.com/services/…`) — order lands in a channel.
- A **Make.com / Zapier** webhook that texts the owner, prints a ticket, or appends a sheet.
- The site owner's own endpoint.
The Worker already POSTs `{ text, order }` there. Nothing else to do.

## Direct email: Resend
> Note: MailChannels ended its free Workers email service in 2024 — do not rely on it.
Use [Resend](https://resend.com): verify the restaurant's domain, create an API key, then
`npx wrangler secret put RESEND_API_KEY`. In `handleWebhook`, after marking paid:

```js
if (env.RESEND_API_KEY) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "orders@theclientdomain.com",
      to: env.RESTAURANT_EMAIL,
      subject: `New order ${orderId} — ${record?.fulfillment || "pickup"}`,
      text: JSON.stringify(record, null, 2)
    })
  }).catch(() => {});
}
```
Add `RESTAURANT_EMAIL` to `[vars]`. Keep the mailbox per-site — never hard-code one
restaurant's inbox into the next deploy.

## SMS
Point `NOTIFY_WEBHOOK` at a Twilio Function, or add a Twilio `fetch` call the same way as
Resend using a `TWILIO_*` secret. SMS is the most reliable way to reach a busy kitchen.
