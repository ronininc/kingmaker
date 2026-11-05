# Android — Private DNS (DNS over TLS) to your loop resolver

Android speaks encrypted DNS natively as **Private DNS** (DNS over TLS,
port 853). Point it at the resolver running inside your own closed loop
and the phone's lookups travel encrypted to *your* machine instead of to
whatever resolver the local network hands out.

> **Operator placeholder:** `dns.example-loop.invalid`
> The `.invalid` top-level domain can never resolve — it is in this
> document on purpose, so the template can never accidentally point a
> real phone at a real stranger's server. Replace it everywhere with the
> hostname of **your** loop resolver (which must present a valid TLS
> certificate for that hostname on port 853).

## Steps (stock Android; vendor skins move these menus slightly)

1. Open **Settings → Network & internet → Private DNS**.
   (On some skins: Settings → Connections → More connection settings →
   Private DNS.)
2. Select **Private DNS provider hostname**.
3. Enter your loop resolver's hostname:

   ```
   dns.example-loop.invalid
   ```

4. Tap **Save**. Android validates the resolver immediately; if the
   hostname cannot be resolved or the TLS handshake fails, it falls back
   and tells you it couldn't connect — that failure is the check working.
5. Confirm: with Private DNS active, lookups from every app go to that
   hostname over TLS (port 853), bypassing the DHCP-provided resolver.

## Notes

- Private DNS wraps the **DNS layer** — the queries. It does not wrap
  the phone's traffic itself; that is the VPN posture, separate by
  design (see the DNS section of the main README).
- The hostname must be a name, not a bare IP — Android's Private DNS is
  hostname-based so the TLS certificate can be verified against it.
- If your loop resolver is only reachable inside your tailnet/mesh,
  the phone must be on that mesh for the hostname to resolve; outside
  it, Android reports the resolver unreachable rather than silently
  downgrading to plaintext on some builds — know your build's behavior
  before you rely on it.
