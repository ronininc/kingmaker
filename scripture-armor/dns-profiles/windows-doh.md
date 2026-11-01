# Windows — encrypted DNS (DNS over HTTPS) to your loop resolver

Windows 11 speaks DNS over HTTPS natively. Point it at the resolver
running inside your own closed loop and this machine's lookups travel
encrypted to *your* resolver instead of the network's default.

> **Operator placeholders:**
> - DoH template: `https://dns.example-loop.invalid/dns-query`
> - Resolver address: `192.0.2.53`
>
> `.invalid` can never resolve and `192.0.2.53` is TEST-NET-1 (RFC 5737
> documentation range). Both are fake on purpose. Replace them with your
> loop resolver's real DoH template and address before use.

## Steps (Settings UI — the supported path)

1. Open **Settings → Network & internet**, choose your adapter
   (**Wi-Fi** or **Ethernet**), open its **hardware properties**.
2. Next to **DNS server assignment**, click **Edit**.
3. Switch to **Manual**, turn on **IPv4** (and IPv6 if your resolver
   serves it).
4. In **Preferred DNS**, enter your resolver's address:

   ```
   192.0.2.53
   ```

5. Set **Preferred DNS encryption** to **Encrypted only (DNS over
   HTTPS)**. In the **DNS over HTTPS template** field, enter:

   ```
   https://dns.example-loop.invalid/dns-query
   ```

6. Save. Repeat for the Alternate DNS field if you run a second loop
   resolver; otherwise leave Alternate empty — a foreign fallback would
   quietly route lookups back outside the loop.

## Registry snippet (administrators; same placeholders apply)

Force the DNS client to prefer/require DoH for manually configured
servers, then confirm the adapter's server list. Apply only after the
Settings steps above, and back up the key first.

```reg
Windows Registry Editor Version 5.00

; Require auto-DoH upgrade for configured DNS servers (2 = allow, and
; Windows will use DoH where a template is known/entered).
[HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters]
"EnableAutoDoh"=dword:00000002
```

Per-adapter server + template configuration is most reliably done from
the Settings UI above (or `Set-DnsClientServerAddress` /
`Set-DnsClientDohConnectionSettings` in PowerShell on current builds);
this document does not invent per-interface registry paths, because
they vary by build — use the UI or the cmdlets, with the same
placeholder replacements.

## Notes

- This wraps the **DNS layer** — the queries. It does not wrap all
  traffic; full-traffic wrap is the VPN posture, separate by design
  (see the DNS section of the main README).
- "Encrypted only" matters: the permissive mode falls back to plaintext
  DNS when DoH fails, which silently leaves the loop. Encrypted-only
  fails closed.
