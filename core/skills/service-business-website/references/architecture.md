# Architecture

Static front end (no build step) + Supabase backend. Three role-gated apps share one config
and one tiny data client.

## Pages
- **Marketing:** `index.html`, `services/*.html`, `gallery.html`, `about.html`, `contact.html`.
  Shared `assets/css/site.css` + `assets/js/site.js` (mobile nav, services dropdown, mailto
  contact form, footer year). Images are labeled CSS placeholders until real photos exist.
- **Client portal:** `portal.html`. One "Access" button. With no `?c=CODE` it opens a sample
  project so nothing real leaks. A client's link is `…/portal.html?c=CODE`.
- **Crew tracker:** `crew/index.html`. Login required. New job → pick/enter client, title,
  address, start date, contract total. Tabs: Active / New / In progress / Completed / By date.
  Per job: status, progress step (0/25/50/75/100), notes (client-visible or internal),
  payments, "copy portal link".
- **Scheduler:** `admin/index.html`. Same login. A **crew×day timeline**, not a calendar: a job
  is a bar as wide as its working-day duration. Drag to move/reassign; tap for a detail sheet;
  drag to an Unscheduled tray to unplace. Green/amber drop targets show free vs conflict.
  Sunday is skipped everywhere.

## Data model (Supabase)
Tables: `clients`, `jobs`, `job_notes`, `payments`, `crew_members`, `crews`.
Scheduling lives on `jobs`: `crew_id`, `scheduled_date` (first working day), `duration_days`
(working days). Occupancy is derived from those three — no separate bookings table to drift.

## Roles & gating
- RLS on every table; the anonymous role has **no policy** on any of them.
- Crew access is gated on the `crew_members` roster via `is_crew()`, not merely on being
  signed in — a self-registered account still gets nothing.
- The portal reads through one `security definer` function, `portal_lookup(code)`, returning
  exactly one job's progress, client-visible notes, and payment totals. Internal notes never
  leave the DB.
- Only `admin`-role members can change the `crews` roster; `crew` members can schedule.

## Access codes
Per-job `PREFIX-` + 6 chars from an alphabet with no `0/O/1/I/S/5` (survives being read over
the phone). They're bearer tokens — treat like a shared-doc link.

## Payments
Manual collection: the portal shows contract total, paid-to-date, balance, and how to pay.
The crew records each payment; the balance updates immediately. `contract_total` is separate
from individual `payments` rows, so a future Stripe webhook just inserts a payment row.
