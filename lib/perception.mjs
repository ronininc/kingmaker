// lib/perception.mjs — how a method's views describe the CURRENT STATE in words (2026-11-16). Shared by the
// observe-act daemon and every decision checker, so what is tested is exactly what the pilot sees.
// Views describe state only; they never name an action. Ops (derive[name] = [op, a, b, label, ...]):
//   side  [side, a, orient, label]                 "<label> is N degrees to your LEFT/RIGHT" / dead ahead / behind
//   zone  [zone, a, orient, label, limit, band?]   "<label> is INSIDE the N-degree zone ahead of you (…, on your LEFT)";
//                                                  with band: "outside the zone, in the best band (N–M degrees off
//                                                  the bow)" / "outside the zone and beyond the best band"
//   rel   [rel, a, ref, label, refLabel]           "<label> is N degrees to the LEFT/RIGHT of <refLabel>" (looking
//                                                  along ref) — e.g. the goal relative to the wind direction
//   around[around, a, ref, label, refLabel, limit] "<label> is INSIDE/outside the N-degree zone around <refLabel>"
// previous: the pilot's own previous decision and, for each zone view, the side its field was on then.
export const angleDiff = (a, b) => ((Number(a) - Number(b) + 540) % 360) - 180;
const field = (o, p) => String(p).split('.').reduce((v, k) => v?.[k], o);
const side = (d) => (d > 0 ? 'RIGHT' : 'LEFT');
export const sideWords = (d, what) => (Math.abs(d) <= 5 ? `${what} is dead ahead` : Math.abs(d) >= 175 ? `${what} is directly behind you` : `${what} is ${Math.abs(Math.round(d))} degrees to your ${side(d)}${Math.abs(d) > 100 ? ' (behind your side)' : ''}`);
const where = (d) => (Math.abs(d) <= 5 ? 'dead ahead' : Math.abs(d) >= 175 ? 'directly behind you' : `on your ${side(d)}`);
export const zoneWords = (d, what, limit, band = null) => {
  const off = Math.abs(d);
  if (off < limit) return `${what} is INSIDE the ${limit}-degree zone ahead of you (${Math.round(off)} degrees off the bow, ${where(d)})`;
  if (Number.isFinite(band) && band > limit) return off <= band
    ? `${what} is outside the ${limit}-degree zone and IN THE BEST BAND (${limit}–${band} degrees off the bow; now ${Math.round(off)}, ${where(d)})`
    : `${what} is outside the ${limit}-degree zone and BEYOND THE BEST BAND (more than ${band} degrees off the bow; now ${Math.round(off)}, ${where(d)})`;
  return `${what} is outside the ${limit}-degree zone ahead of you (${Math.round(off)} degrees off the bow, ${where(d)})`;
};
export const relWords = (d, what, ref) => (Math.abs(d) <= 3 ? `${what} is in line with ${ref}` : `${what} is ${Math.abs(Math.round(d))} degrees to the ${side(d)} of ${ref}`);
export const aroundWords = (d, what, ref, limit) => `${what} is ${Math.abs(d) < limit ? 'INSIDE' : 'outside'} the ${limit}-degree zone around ${ref} (${Math.abs(Math.round(d))} degrees from it)`;

//   diff  [diff, a, b, label, refLabel]            "<label> is N ABOVE / BELOW <refLabel>" (numeric difference a − b)
const fmt = (n) => String(Math.round(Math.abs(n) * 100) / 100);
export const diffWords = (d, what, ref) => (Math.abs(d) < 0.05 ? `${what} is equal to ${ref}` : `${what} is ${fmt(d)} ${d > 0 ? 'ABOVE' : 'BELOW'} ${ref}`);
export function perceive(obs, derive = {}, previous = null) {
  const out = {};
  for (const [name, spec] of Object.entries(derive)) {
    const [op, a, b, label, x4, x5] = spec;
    if (op === 'diff') { const v = Number(field(obs, a)) - Number(field(obs, b)); if (Number.isFinite(v)) out[name] = diffWords(v, label ?? a, x4 ?? b); continue; }
    const d = angleDiff(field(obs, a), field(obs, b));
    if (!Number.isFinite(d)) continue;
    out[name] = op === 'side' ? sideWords(d, label ?? name)
      : op === 'zone' ? zoneWords(d, label ?? name, Number(x4), x5 == null ? null : Number(x5))
      : op === 'rel' ? relWords(d, label ?? name, x4 ?? b)
      : op === 'around' ? aroundWords(d, label ?? name, x4 ?? b, Number(x5))
      : Math.round(d);
  }
  if (previous && previous.turn) {
    const zones = Object.values(derive).filter((s) => s[0] === 'zone');
    const then = zones.map(([, a, b, label]) => { const d = angleDiff(field(previous.obs ?? {}, a), field(previous.obs ?? {}, b)); return Number.isFinite(d) ? `${label} was then ${where(d)}` : null; }).filter(Boolean);
    out.previous = `your previous decision: turn ${previous.turn}${then.length ? `; ${then.join('; ')}` : ''}`;
  }
  return out;
}
