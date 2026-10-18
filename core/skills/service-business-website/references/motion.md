# Motion kit

Drop `assets/animations.css` into the site and add the classes below. It's all CSS transitions
plus one keyframe (the spinner). Everything is guarded by `prefers-reduced-motion`. Keep motion
this restrained — the site should feel crisp, not animated-at.

| # | Animation | Class(es) | Trigger | Feel |
|---|---|---|---|---|
| 1 | Button lift | `.btn` (`.btn--press` variant) | hover / active | rises 1px on hover, settles on press |
| 2 | Card rise | `.card` (`.card-tap` for app) | hover / active | lifts 3px + deeper shadow |
| 3 | Dropdown + caret | `.has-menu` + `.menu`, `[data-open="true"]` | click/state | menu fades & slides 6px, caret flips |
| 4 | Hamburger → X | `.nav-toggle` + `body.nav-open` | click | three bars rotate into a close icon |
| 5 | Progress fill | `.bar > i`, set `style.width` | JS width change | bar slides to the new width (.35s) |
| 6 | Spinner | `.spinner` + `@keyframes spin` | loading | the only keyframe; app loading state |
| 7 | Slide-in drawer | `.sheet` + `.sheet.open` | open detail | slides from right on a soft cubic-bezier |
| 8 | Input focus | `.field-input` | focus | border eases to green + soft focus ring |

## Notes
- The design tokens the kit references (`--green-500`, `--sand`, `--shadow-lg`, etc.) come from
  the site's `:root`. Keep them in `site.css` so the kit inherits them.
- Durations are deliberately short (.12–.35s). Don't lengthen them for "drama"; they read as
  responsiveness, not decoration.
- For a live, interactive catalog with each snippet shown beside its demo, generate a single
  self-contained reference page (the reference build shipped one as `site-motion-reference.html`).
- This kit is intentionally *not* an immersive/3D centerpiece. If a build calls for that,
  it's a separate piece (see the house immersive-workspace standard), layered on top — not a
  substitute for these micro-interactions.
