# Sign-in security, tailored for Cloudflare Pages

This is the mandatory pre-deploy checklist. It replaces the Netlify `netlify.toml` approach
with Cloudflare-native mechanisms and adds an edge-auth layer.

## 1. The publishable key is public — security is server-side
The Supabase publishable/anon key ships in `config.js` by design. It grants nothing on its
own because RLS is on for every table and the anon role has no policy. Verify before shipping:
anon `SELECT` returns `[]`, anon `INSERT/UPDATE` returns 401. **Never** put the `service_role`
(secret) key in any client file. If you add real card payments later, hold secrets in a
Cloudflare Worker's environment variables, not in the static bundle.

## 2. Strip the demo credential at build (fail closed)
The one-button local login stores a real password in `config.js`. Two guards keep it off the
public internet:
- `demoAccess.enabled` evaluates to **false** on anything that isn't `localhost` / `127.0.0.1`
  / `::1` / `file:` — so a `*.pages.dev` URL or a custom domain shows the normal login screen.
- `deploy-cloudflare.sh` blanks the password, hard-sets `enabled: false`, and **ABORTS the
  deploy** if the credential string is still present in `dist/`.

Wire the strip into deployment so it can never be skipped:
- **CLI:** run `./deploy-cloudflare.sh --deploy`.
- **Git-connected Pages project:** set the **Build command** to the strip step and the
  **Build output directory** to `dist/`, so every push rebuilds a stripped bundle.

Confirm after building: `grep -r "<your demo password>" dist/` returns nothing.

## 3. `_headers` — CSP, clickjacking, indexing, cache
Ship `assets/_headers` at the site root (Cloudflare Pages reads it automatically; it replaces
`netlify.toml`). It sets:
- A CSP whose `connect-src` is pinned to your one Supabase origin, so a stray script can't
  phone elsewhere; `script-src 'self'` (no inline/CDN); `object-src 'none'`.
- `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, a strict `Referrer-Policy`,
  and a locked-down `Permissions-Policy`.
- `X-Robots-Tag: noindex, nofollow` on `/admin/*`, `/crew/*`, `/portal.html`.
- A modest cache on `/assets/*`.
Replace the `SUPABASE_URL` placeholder with your project origin.

## 4. Cloudflare Access — edge SSO in front of the staff tools
The app-level Supabase roster gate is the data lock. Add an **edge** lock so the office/crew
tools require sign-in before the page even loads:

Zero Trust → **Access → Applications → Add → Self-hosted**:
- App 1 path: `admin.yourdomain.com/admin` (or `yourdomain.com/admin/*`).
- App 2 path: `yourdomain.com/crew/*`.
- Policy: **Allow** a named list of emails or an identity-provider group (Google, Okta, etc.).
Now only authorized people reach those routes at all — defense in depth over `is_crew()`.
Leave the public marketing pages and `/portal.html` open (the portal uses bearer codes).

## 5. Optional hardening
- **Turnstile** on the portal's code-entry field to slow brute-forcing of access codes.
- **Rate limiting** rule on `/portal.html` and the Supabase auth endpoints.
- Keep public sign-ups **disabled** in Supabase → Authentication → Providers (belt-and-braces;
  the roster gate already covers it).

## Quick pre-deploy gate
1. `service_role` key absent from the repo. ✔
2. `deploy-cloudflare.sh` runs, strips the password, and the credential is gone from `dist/`. ✔
3. `_headers` present with `connect-src` pinned to your Supabase origin. ✔
4. Cloudflare Access policies cover `/admin/*` and `/crew/*`. ✔
5. Supabase public sign-ups disabled; anon read `[]` / write 401 verified. ✔
