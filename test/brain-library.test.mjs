// The Kingmaker Brain Library (lib/brain-library.mjs): every Mac configuration, picks from the profiles, bench results
// folded in per model, weights only where the licence allows, parts under GitHub's 2 GB limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLibrary, DEVICES, LIBRARY_JSON_SCHEMA, LIBRARY_SCHEMA, libraryDevices, modelSlug, PART_BYTES, planParts, redistributable } from '../lib/brain-library.mjs';
import { CLASSES, GRANITE_8GB, QWEN38_9B } from '../lib/mac-profiles.mjs';

test('every Mac configuration Apple sold has a class and a pack', () => {
  const d = libraryDevices();
  assert.equal(d.length, Object.values(DEVICES).flat().length);
  assert.deepEqual(d.find((x) => x.id === 'm3-8gb'), { id: 'm3-8gb', chip: 'M3', ramGb: 8, bandwidthGBs: 100, macs: 'MacBook Air, MacBook Pro 13/14, Mac mini, iMac', class: 8, pack: '8' });
  assert.equal(d.find((x) => x.id === 'm3-pro-18gb').class, 16);
  assert.equal(d.find((x) => x.id === 'm3-ultra-512gb').class, 64);
  for (const x of d) assert.ok(CLASSES.includes(x.class));
});

test('weights are republished only under a licence that allows it; a model with none stays a pointer', () => {
  assert.ok(redistributable('apache-2.0')); assert.ok(redistributable('Apache-2.0'));
  assert.ok(!redistributable(null)); assert.ok(!redistributable('other'));
  const lib = buildLibrary();
  assert.equal(lib.schema, LIBRARY_SCHEMA);
  assert.equal(lib.models.find((m) => m.tag === QWEN38_9B).redistributable, false);
  assert.equal(lib.models.find((m) => m.tag === GRANITE_8GB).redistributable, true);
  assert.deepEqual(lib.models.find((m) => m.tag === GRANITE_8GB).picks.map((p) => p.role).sort(), ['reasoning', 'router', 'writer']);
});

test('bench results fold into each model, and a class with its own results is measured', () => {
  const benches = { 'm3-8gb.json': { host: { chip: 'Apple M3', ramGb: 8 }, maxResidentGb: 3.3, results: [{ model: GRANITE_8GB, context: 4096, loadS: 2, speed: { genTokS: 30 }, resident: { sizeGb: 2.4, gpuGb: 2.4 }, memory: { steadyRssGb: 2.6, swapDeltaMb: 0 }, tools: { twoStep: { pct: 89 }, native: { pct: 78 } }, route: { pct: 92 }, write: { pct: 100 } }] } };
  const lib = buildLibrary({ benches });
  const g = lib.models.find((m) => m.tag === GRANITE_8GB);
  assert.equal(g.bench[0].tokS, 30); assert.equal(g.bench[0].fits, true); assert.equal(g.bench[0].host, 'Apple M3');
  assert.equal(lib.classes.find((c) => c.class === 8).status, 'measured');
  assert.equal(lib.classes.find((c) => c.class === 64).status, 'estimate');
  assert.deepEqual(lib.bench, ['m3-8gb.json']);
});

test('parts stay under GitHub\'s 2 GB release limit and cover the file exactly; slugs are release-safe', () => {
  const size = 5_030_000_000, parts = planParts(size);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.size <= PART_BYTES && PART_BYTES < 2 ** 31));
  assert.equal(parts.reduce((a, p) => a + p.size, 0), size);
  assert.equal(parts[2].start, 2 * PART_BYTES);
  assert.equal(modelSlug('huihui_ai/qwen3-abliterated:8b'), 'huihui-ai-qwen3-abliterated-8b');
  assert.match(modelSlug(GRANITE_8GB), /^[a-z0-9.-]+$/);
  assert.equal(LIBRARY_JSON_SCHEMA.properties.schema.const, LIBRARY_SCHEMA);
});

test('the rotation: role rules decide who may hold a role, and a change needs a clear lead on the class\'s own results', async () => {
  const { eligible, proposePicks, roleScore, proposalReport } = await import('../lib/brain-library.mjs');
  const { quantTag, worthIds } = await import('../lib/bench-cli.mjs');
  const c24 = { class: 24, measuredOn: ['m5.json'] };
  const mk = (tag, kind, bench, capabilities = ['completion', 'tools']) => ({ tag, kind, capabilities, bench: bench.map((b) => ({ file: 'm5.json', fits: true, ...b })) });
  assert.equal(eligible(mk('local/x', 'heretic', []), 'writer', c24), false, 'a local import is never a pick');
  assert.equal(eligible(mk('a:1', 'abliterated', []), 'vision', c24), false, 'vision needs the vision capability');
  assert.equal(eligible(mk('a:1', 'abliterated', [], ['vision']), 'vision', c24), true);
  assert.equal(eligible(mk('qwen3:8b', 'abliterated', []), 'coder', c24), false, 'the coder is a coding model');
  assert.equal(eligible(mk('big:1', 'abliterated', [{ holdsGb: 7 }]), 'router', c24), false, 'a 24 GB router stays small');
  assert.equal(roleScore('writer', { fits: false, tools: 100 }), -1);
  assert.ok(roleScore('writer', { fits: true, tools: 100, route: 100, write: 100 }) > roleScore('writer', { fits: true, tools: 80, route: 100, write: 100 }));
  const lib = { classes: [{ class: 24, measuredOn: ['m5.json'], roles: { writer: 'old:1' } }], models: [mk('old:1', 'abliterated', [{ tools: 83, route: 75, write: 67 }]), mk('new:1', 'heretic', [{ tools: 100, route: 100, write: 100 }]), mk('close:1', 'heretic', [{ tools: 83, route: 80, write: 67 }])] };
  const [row] = proposePicks(lib);
  assert.equal(row.best, 'new:1'); assert.equal(row.change, true);
  assert.equal(proposePicks({ ...lib, models: [lib.models[0], lib.models[2]] })[0].change, false, 'within the margin: no change');
  assert.match(proposalReport([row], '2026-11-14'), /\*\*propose\*\*/);
  assert.equal(quantTag('Qwen3.5-4B-heretic.i1-Q4_K_M.gguf'), 'i1-Q4_K_M'); assert.equal(quantTag('x-Q8_0.gguf'), 'Q8_0'); assert.equal(quantTag('model.bin'), null);
  assert.deepEqual(worthIds('## Worth a look (new): 1\n\n- hf-model-a-gguf — 2 GB\n\n## All added (2)\n\n- hf-model-b-gguf'), ['hf-model-a-gguf']);
});

test('the rotation\'s guards (review 2026-10-15): tools floor, unmeasured pick, speed, one run, simulated speed, vision, censored', async () => {
  const { proposePicks, effectiveTokS, eligible } = await import('../lib/brain-library.mjs');
  const mk = (tag, kind, runs, capabilities = ['completion', 'tools']) => ({ tag, kind, capabilities, bench: runs.map((b, i) => ({ file: i ? 'b.json' : 'a.json', fits: true, tokS: 50, ...b })) });
  const cls = (roles, files = ['a.json', 'b.json']) => ({ class: 24, measuredOn: files, roles });
  const pick = mk('pick:1', 'abliterated', [{ tools: 100, route: 75, write: 67 }, { tools: 100, route: 75, write: 67 }]);
  const better = { tools: 89, route: 100, write: 100 };
  // 1. a better blend that calls tools worse is not proposed for a tool role
  let [r] = proposePicks({ classes: [cls({ writer: 'pick:1' })], models: [pick, mk('blend:1', 'heretic', [better, better])] });
  assert.equal(r.change, false); assert.match(r.why, /calls tools worse/);
  // 2. an unmeasured pick is reported, never swapped
  [r] = proposePicks({ classes: [cls({ writer: 'gone:1' })], models: [mk('x:1', 'heretic', [{ tools: 100, route: 100, write: 100 }])] });
  assert.equal(r.change, false); assert.match(r.why, /not measured/);
  // 3. too slow for the role: not even scored
  [r] = proposePicks({ classes: [cls({ writer: 'pick:1' })], models: [pick, mk('slow:1', 'heretic', [{ tools: 100, route: 100, write: 100, tokS: 12 }, { tools: 100, route: 100, write: 100, tokS: 12 }])] });
  assert.equal(r.best, 'pick:1');
  // 4. one run needs twice the margin
  const weak = mk('weak:1', 'abliterated', [{ tools: 95, route: 80, write: 80 }, { tools: 95, route: 80, write: 80 }]);
  [r] = proposePicks({ classes: [cls({ writer: 'weak:1' })], models: [weak, mk('once:1', 'heretic', [{ tools: 100, route: 85, write: 90 }])] });
  assert.equal(r.change, false); assert.match(r.why, /one run/);
  // 5. a simulated 8 GB result's speed is scaled to an 8 GB chip
  assert.equal(Math.round(effectiveTokS({ tokS: 97, simulatedAsGb: 8, host: 'Apple M5 Pro' })), 32);
  assert.equal(effectiveTokS({ tokS: 97, host: 'Apple M5 Pro' }), 97);
  // 6. vision is reported, never proposed
  const vpick = mk('v:1', 'abliterated', [{ tools: 80, route: 70, write: 60 }, { tools: 80, route: 70, write: 60 }], ['vision']);
  [r] = proposePicks({ classes: [cls({ vision: 'v:1' })], models: [vpick, mk('v:2', 'abliterated', [{ tools: 100, route: 100, write: 100 }, { tools: 100, route: 100, write: 100 }], ['vision'])] });
  assert.equal(r.change, false); assert.match(r.why, /image suite/);
  // 7. a better censored model is shown, not proposed
  [r] = proposePicks({ classes: [cls({ writer: 'weak:1' })], models: [weak, mk('stock:1', 'stock', [{ tools: 100, route: 100, write: 100 }, { tools: 100, route: 100, write: 100 }])] });
  assert.equal(r.change, false); assert.match(r.why, /censored \(stock:1\)/);
  // 8. the coder match is anchored
  const c = { class: 24, measuredOn: [] };
  assert.equal(eligible({ tag: 'some-decoder:1', bench: [] }, 'coder', c), false);
  assert.equal(eligible({ tag: 'codestral-embed:1', bench: [] }, 'coder', c), false);
  assert.equal(eligible({ tag: 'huihui_ai/qwen2.5-coder-abliterate:7b', bench: [] }, 'coder', c), true);
});

test('big-Mac options are listed, never picked, never republished, with their runtime and sizes', async () => {
  const { BIG_OPTIONS } = await import('../lib/brain-library.mjs');
  const lib = buildLibrary();
  assert.equal(lib.bigOptions.length, BIG_OPTIONS.length);
  for (const o of lib.bigOptions) {
    assert.equal(o.status, 'option'); assert.equal(o.basis, 'estimate'); assert.equal(o.redistributable, false); assert.equal(o.weights, null);
    assert.match(o.runtime, /Not Ollama/); assert.ok(o.files.every((f) => f.gb > 0)); assert.ok(o.links[0].startsWith('https://huggingface.co/'));
    assert.ok(!lib.models.some((m) => m.tag === o.tag), 'never in the measured models or the picks');
  }
  assert.deepEqual(lib.bigOptions.find((o) => /V4\.1/.test(o.tag)).forRamGb, [512]);
});
