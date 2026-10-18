/**
 * Online Ordering Worker — house standard bolt-on for a static restaurant site.
 * -------------------------------------------------------------------------
 * A single Cloudflare Worker that turns the "payment-ready shop" structure in a
 * website-build-standard site into a live ordering backend. Default processor is
 * Stripe Checkout (Stripe-hosted page → no card data touches this Worker, minimal
 * PCI scope). Clover / Square adapters live in references/.
 *
 * WHY server-side pricing: the browser is untrusted. Prices and the menu live
 * HERE, keyed by item id. The client only sends {id, qty}; the Worker recomputes
 * every total. Never trust a price that came from the page.
 *
 * Bindings (see wrangler.toml):
 *   ORDERS   (KV)      — order records (pending → paid). Optional but recommended.
 *   MENU     (KV)      — key "menu" holds the JSON menu (assets/menu.example.json).
 * Secrets  (wrangler secret put ...):
 *   STRIPE_SECRET_KEY        — sk_test_… while testing, sk_live_… for real money
 *   STRIPE_WEBHOOK_SECRET    — whsec_… from the Stripe webhook endpoint
 * Vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN           — exact site origin, e.g. https://lacasasushimex.com
 *   SUCCESS_URL / CANCEL_URL — where Stripe returns the customer
 *   NOTIFY_WEBHOOK           — optional: POST paid orders here (Slack/Make/owner endpoint)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (url.pathname === "/menu"   && request.method === "GET")  return handleMenu(env, cors);
      if (url.pathname === "/order"  && request.method === "POST") return handleOrder(request, env, cors);
      if (url.pathname === "/webhook"&& request.method === "POST") return handleWebhook(request, env);
      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      return json({ error: "server error", detail: String(err && err.message || err) }, 500, cors);
    }
  }
};

/* ---------------- menu (server-side source of truth) ---------------- */
async function loadMenu(env) {
  // Menu lives in KV so the owner can update prices without redeploying.
  if (env.MENU) {
    const raw = await env.MENU.get("menu");
    if (raw) return JSON.parse(raw);
  }
  // Fallback so the Worker is never empty on first deploy. Replace via KV.
  return { currency: "usd", items: [
    { id: "shrimp-tacos", name: "Shrimp Tacos", price: 1299 },
    { id: "guero-banado", name: "El Güero Bañado", price: 1899 }
  ]};
}

async function handleMenu(env, cors) {
  const menu = await loadMenu(env);
  return json(menu, 200, cors);
}

/* ---------------- create order → Stripe Checkout ---------------- */
async function handleOrder(request, env, cors) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || body.items.length === 0)
    return json({ error: "cart is empty" }, 400, cors);

  const menu = await loadMenu(env);
  const byId = Object.fromEntries(menu.items.map(i => [i.id, i]));

  // Recompute every line from the server menu. Client prices are ignored.
  const lines = [];
  let subtotal = 0;
  for (const line of body.items) {
    const item = byId[line.id];
    const qty = Math.max(1, Math.min(50, parseInt(line.qty, 10) || 0));
    if (!item) return json({ error: `unknown item: ${line.id}` }, 400, cors);
    subtotal += item.price * qty;
    lines.push({ id: item.id, name: item.name, unit_amount: item.price, qty });
  }

  const fulfillment = body.fulfillment === "delivery" ? "delivery" : "pickup";
  const orderId = crypto.randomUUID();

  // Build Stripe Checkout Session (application/x-www-form-urlencoded).
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", (env.SUCCESS_URL || env.ALLOWED_ORIGIN + "/?order=success") + "&id=" + orderId);
  params.set("cancel_url", env.CANCEL_URL || env.ALLOWED_ORIGIN + "/?order=cancelled");
  params.set("client_reference_id", orderId);
  params.set("metadata[order_id]", orderId);
  params.set("metadata[fulfillment]", fulfillment);
  if (body.customer?.name)  params.set("metadata[customer_name]", String(body.customer.name).slice(0, 120));
  if (body.customer?.phone) params.set("metadata[customer_phone]", String(body.customer.phone).slice(0, 40));
  if (body.notes)           params.set("metadata[notes]", String(body.notes).slice(0, 400));
  if (body.customer?.email) params.set("customer_email", String(body.customer.email).slice(0, 200));
  lines.forEach((l, i) => {
    params.set(`line_items[${i}][price_data][currency]`, menu.currency || "usd");
    params.set(`line_items[${i}][price_data][product_data][name]`, l.name);
    params.set(`line_items[${i}][price_data][unit_amount]`, String(l.unit_amount));
    params.set(`line_items[${i}][quantity]`, String(l.qty));
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const session = await res.json();
  if (!res.ok) return json({ error: "payment init failed", detail: session.error?.message }, 502, cors);

  // Persist a pending record so the webhook can flip it to paid.
  if (env.ORDERS) {
    await env.ORDERS.put("order:" + orderId, JSON.stringify({
      id: orderId, status: "pending", fulfillment, subtotal,
      lines, customer: body.customer || {}, notes: body.notes || "",
      stripe_session: session.id, created: Date.now()
    }), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return json({ id: orderId, url: session.url }, 200, cors);
}

/* ---------------- Stripe webhook → mark paid + notify ---------------- */
async function handleWebhook(request, env) {
  const sig = request.headers.get("stripe-signature") || "";
  const payload = await request.text();
  const ok = await verifyStripeSig(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(payload);
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const orderId = s.metadata?.order_id || s.client_reference_id;
    let record = null;
    if (env.ORDERS && orderId) {
      const raw = await env.ORDERS.get("order:" + orderId);
      if (raw) {
        record = JSON.parse(raw);
        record.status = "paid";
        record.paid_at = Date.now();
        record.amount_total = s.amount_total;
        record.email = s.customer_details?.email || record.customer?.email || "";
        await env.ORDERS.put("order:" + orderId, JSON.stringify(record));
      }
    }
    // Tell the restaurant. NOTIFY_WEBHOOK is the flexible default (Slack/Make/owner
    // endpoint). For direct email, see references/notifications.md (Resend).
    if (env.NOTIFY_WEBHOOK) {
      await fetch(env.NOTIFY_WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🧾 New paid order ${orderId} — ${(s.metadata?.fulfillment || "pickup")}`,
          order: record || { id: orderId, amount_total: s.amount_total }
        })
      }).catch(() => {});
    }
  }
  return new Response("ok", { status: 200 });
}

/* ---------------- helpers ---------------- */
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", ...(extra || {}) }
  });
}
// Verify Stripe's signature header without the SDK (Web Crypto HMAC-SHA256).
async function verifyStripeSig(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map(kv => kv.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
