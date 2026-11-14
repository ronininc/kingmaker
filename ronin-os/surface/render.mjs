// render.mjs — the Ronin OS surface renderer (DESIGN §1, §2, §7.2). Pure: (posture record, audit entries) -> HTML.
// The surface renders ONLY what the engine's record holds, and only when the record chains to the audit
// entry that established the state. Anything else renders the DEFECT face — a readout that cannot verify
// its own input says so, in words, and shows no state color at all (§7.2: the one unforgivable bug is
// silence presented as liveness; the second is a hue the record doesn't hold).
import { STATES, LANES, AMBER, renderFacts, verifyAgainstChain } from '../ronin-state.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STALE_MS = 120_000;

export function laneAge(lane, now) { return now - Date.parse(lane.at); }

export function renderSurface(record, chainEntries, { now = Date.now(), sun = false } = {}) {
  const v = verifyAgainstChain(record, chainEntries);
  if (!v.ok) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>RONIN — UNVERIFIED</title><link rel="stylesheet" href="/surface.css"></head>
<body class="defect"><main class="defect-face">
<h1>RONIN</h1><p class="defect-word">SURFACE CANNOT VERIFY ITS STATE RECORD</p>
<p class="defect-why">${esc(v.why)}. No state is displayed, because none is held.</p>
</main></body></html>`;
  }
  const f = renderFacts(record);
  const st = STATES[f.state];
  const lanes = LANES.map((name) => {
    const lane = record.lanes?.[name];
    if (!lane) return `<div class="seg seg-empty" data-lane="${name}"><span class="seg-name">${name}</span><span class="seg-sum">—</span></div>`;
    const stale = laneAge(lane, now) > STALE_MS;
    return `<div class="seg${stale ? ' seg-stale' : ''}" data-lane="${name}"><span class="seg-name">${name}</span><span class="seg-sum">${esc(lane.summary)}</span>${stale ? `<span class="seg-age">stale ${Math.round(laneAge(lane, now) / 1000)}s</span>` : ''}</div>`;
  }).join('\n');
  const approvals = (record.approvals ?? []).map((a) => `<article class="card approval"><header>APPROVAL — ${esc(a.kind)}</header><p>${esc(a.summary)}</p><p class="proof" style="--amber:${AMBER}">▸ ${esc(a.evidence ?? '')}</p></article>`).join('\n');
  const wall = f.density === 'WALL' ? `<section class="wall">${LANES.map((n) => `<div class="panel" data-panel="${n}"><h2>${n}</h2><p>${esc(record.lanes?.[n]?.summary ?? 'no live feed')}</p><p class="src">${esc(record.lanes?.[n]?.source ?? '')} · ${esc(record.lanes?.[n]?.at ?? '')}</p></div>`).join('')}</section>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>RONIN — ${f.state}</title><link rel="stylesheet" href="/surface.css"></head>
<body data-state="${f.state}" data-density="${f.density}" style="--state:${f.hex};--amber:${AMBER}">
${sun ? `<div class="initial-sun" role="img" aria-label="Initial Sun — first load of this install"></div>` : ''}
<main class="field">
  <div class="edge edge-${f.trust === 'ATTESTED' ? 'steady' : f.state === 'CONTAINMENT' ? 'strobe' : 'broken'}"></div>
  <section class="core pattern-${f.pattern}">
    <div class="core-name">SEEKER</div>
    <div class="core-state">${esc(f.stateLabel)}</div>
    <div class="core-trust">${esc(f.trust)}</div>
    <div class="core-mode">${esc(record.core?.mode ?? 'idle')}</div>
  </section>
  <section class="ring">${lanes}</section>
  <section class="inner-band">${approvals}</section>
  ${wall}
  <footer class="command-bar"><span class="listen-pill">${record.core?.mode === 'listening' ? "I'm listening…" : 'Seeker'}</span><input id="cmd" type="text" placeholder="Ask Seeker anything…" autocomplete="off"></footer>
</main></body></html>`;
}
