/**
 * order-client.js — drop into the static site to talk to the ordering Worker.
 * Inline this in index.html (or load as a file). It keeps a tiny cart in memory
 * (no browser storage — house standard) and hands off to Stripe Checkout.
 *
 * 1) Set ORDER_API to your deployed Worker URL.
 * 2) Give each menu "Add" button:  data-add="<item-id>"  (ids must match the KV menu).
 * 3) Add a checkout button with id="checkoutBtn" and a cart count el id="cartCount".
 */
const ORDER_API = "https://CLIENT_SLUG-ordering.YOUR-SUBDOMAIN.workers.dev"; // ← set me

(function () {
  const cart = {}; // { itemId: qty }

  function count() { return Object.values(cart).reduce((a, b) => a + b, 0); }
  function render() {
    const c = document.getElementById("cartCount");
    if (c) c.textContent = count() ? String(count()) : "";
  }

  document.querySelectorAll("[data-add]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const id = btn.getAttribute("data-add");
      cart[id] = (cart[id] || 0) + 1;
      render();
    });
  });

  const checkout = document.getElementById("checkoutBtn");
  if (checkout) checkout.addEventListener("click", async function () {
    if (!count()) { alert("Your cart is empty."); return; }
    checkout.disabled = true;
    try {
      const items = Object.entries(cart).map(([id, qty]) => ({ id, qty }));
      const res = await fetch(ORDER_API + "/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          fulfillment: (document.querySelector(".order-strip .toggle button.on")?.dataset.ot) || "pickup"
          // optionally add: customer:{name,phone,email}, notes
        })
      });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; }   // → Stripe Checkout
      else { alert(data.error || "Could not start checkout."); checkout.disabled = false; }
    } catch (e) {
      alert("Network error starting checkout."); checkout.disabled = false;
    }
  });

  render();
})();
