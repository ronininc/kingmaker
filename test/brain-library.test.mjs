// The Kingmaker Brain Library (lib/brain-library.mjs): every Mac configuration, the starter floor,
// bench results folded in per model, weights only where the licence allows, parts under GitHub's 2 GB
// limit. Since the metered-doctrine rework (2026-11-14) the catalog carries the FLOOR (the smallest
// sufficient model per role, the same for every Mac) instead of per-class packs: devices are facts,
// picks are per role, and nothing in the catalog is gated by a device's RAM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLibrary, DEVICES, LIBRARY_JSON_SCHEMA, LIBRARY_SCHEMA, libraryDevices, modelSlug, PART_BYTES, planParts, redistributable } from '../lib/brain-library.mjs';
import { FLOOR_ROLES, GRANITE_8GB, QWEN38_9B } from '../lib/mac-profiles.mjs';

test('every Mac configuration Apple sold is a device fact — no class, no pack', () => {
  const d = libraryDevices();
  assert.equal(d.length, Object.values(DEVICES).flat().length);
  assert.deepEqual(d.find((x) => x.id === 'm3-8gb'), { id: 'm3-8gb', chip: 'M3', ramGb: 8, bandwidthGBs: 100, macs: 'MacBook Air, MacBook Pro 13/14, Mac mini, iMac' });
  for (const x of d) { assert.ok(!('class' in x) && !('pack' in x), `${x.id} carries no class or pack`); }
});

test('the catalog carries the floor: the smallest sufficient model per role', () => {
  const lib = buildLibrary();
  assert.deepEqual(lib.floor.roles, FLOOR_ROLES);
  assert.ok(!('classes' in lib), 'no classes in the catalog');
  assert.equal(LIBRARY_JSON_SCHEMA.properties.floor.type, 'object');
  assert.ok(!('classes' in LIBRARY_JSON_SCHEMA.properties), 'and none in its schema');
});

test('weights are republished only under a licence that allows it; a model with none stays a pointer', () => {
  assert.ok(redistributable('apache-2.0')); assert.ok(redistributable('Apache-2.0'));
  assert.ok(!redistributable(null)); assert.ok(!redistributable('other'));
  const lib = buildLibrary();
  assert.equal(lib.schema, LIBRARY_SCHEMA);
  assert.equal(lib.models.find((m) => m.tag === QWEN38_9B).redistributable, false);
  assert.equal(lib.models.find((m) => m.tag === GRANITE_8GB).redistributable, true);
  assert.deepEqual(lib.models.find((m) => m.tag === GRANITE_8GB).picks.map((p) => p.role).sort(), ['reasoning', 'writer'], 'the granite is the floor writer and reasoning pick (the router floor is the smaller 1.7b)');
  const g = lib.models.find((m) => m.tag === GRANITE_8GB);
  assert.equal(g.downloadGb, 2.1, 'a model carries its download size');
  assert.deepEqual([...g.roles].sort(), ['reasoning', 'writer'], 'and the roles evidence tables for it');
});

test('bench results fold into each model; fit is judged against the bench device\'s own memory', () => {
  const benches = { 'm3-8gb.json': { host: { chip: 'Apple M3', ramGb: 8 }, maxResidentGb: 3.3, results: [{ model: GRANITE_8GB, context: 4096, loadS: 2, speed: { genTokS: 30 }, resident: { sizeGb: 2.4, gpuGb: 2.4 }, memory: { steadyRssGb: 2.6, swapDeltaMb: 0 }, tools: { twoStep: { pct: 89 }, native: { pct: 78 } }, route: { pct: 92 }, write: { pct: 100 } }] } };
  const lib = buildLibrary({ benches });
  const g = lib.models.find((m) => m.tag === GRANITE_8GB);
  assert.equal(g.bench[0].tokS, 30); assert.equal(g.bench[0].fits, true); assert.equal(g.bench[0].host, 'Apple M3');
  assert.equal(g.bench[0].ramGb, 8, 'the run records the device it was measured on');
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

test('the rotation: role rules decide who may hold a role, and a change needs a clear lead', async () => {
  const { eligible, proposePicks, roleScore, proposalReport } = await import('../lib/brain-library.mjs');
  const { quantTag, worthIds } = await import('../lib/bench-cli.mjs');
  const mk = (tag, kind, bench, capabilities = ['completion', 'tools']) => ({ tag, kind, capabilities, bench: bench.map((b) => ({ file: 'm5.json', fits: true, ...b })) });
  assert.equal(eligible(mk('local/x', 'heretic', []), 'writer'), false, 'a local import is never a pick');
  assert.equal(eligible(mk('a:1', 'abliterated', []), 'vision'), false, 'vision needs the vision capability');
  assert.equal(eligible(mk('a:1', 'abliterated', [], ['vision']), 'vision'), true);
  assert.equal(eligible(mk('qwen3:8b', 'abliterated', []), 'coder'), false, 'the coder is a coding model');
  assert.equal(eligible(mk('big:1', 'abliterated', [{ holdsGb: 7 }]), 'router'), true, 'size never gates eligibility anymore: smallness is the floor pick\'s job, not a rule');
  assert.equal(roleScore('writer', { fits: false, tools: 100 }), -1);
  assert.ok(roleScore('writer', { fits: true, tools: 100, route: 100, write: 100 }) > roleScore('writer', { fits: true, tools: 80, route: 100, write: 100 }));
  const lib = { floor: { roles: { writer: 'old:1' } }, models: [mk('old:1', 'abliterated', [{ tools: 83, route: 75, write: 67 }]), mk('new:1', 'heretic', [{ tools: 100, route: 100, write: 100 }]), mk('close:1', 'heretic', [{ tools: 83, route: 80, write: 67 }])] };
  const row = proposePicks(lib).find((r) => r.role === 'writer');
  assert.equal(row.best, 'new:1'); assert.equal(row.change, true);
  assert.equal(proposePicks({ ...lib, models: [lib.models[0], lib.models[2]] }).find((r) => r.role === 'writer').change, false, 'within the margin: no change');
  assert.match(proposalReport([row], '2026-11-14'), /\*\*propose\*\*/);
  assert.equal(quantTag('Qwen3.5-4B-heretic.i1-Q4_K_M.gguf'), 'i1-Q4_K_M'); assert.equal(quantTag('x-Q8_0.gguf'), 'Q8_0'); assert.equal(quantTag('model.bin'), null);
  assert.deepEqual(worthIds('## Worth a look (new): 1\n\n- hf-model-a-gguf — 2 GB\n\n## All added (2)\n\n- hf-model-b-gguf'), ['hf-model-a-gguf']);
});

test('the rotation\'s guards (review 2026-10-15): tools floor, unmeasured pick, speed, one run, simulated speed, vision, censored', async () => {
  const { proposePicks, effectiveTokS, eligible } = await import('../lib/brain-library.mjs');
  const mk = (tag, kind, runs, capabilities = ['completion', 'tools']) => ({ tag, kind, capabilities, bench: runs.map((b, i) => ({ file: i ? 'b.json' : 'a.json', fits: true, tokS: 50, ...b })) });
  const floor = (roles) => ({ roles });
  const pick = mk('pick:1', 'abliterated', [{ tools: 100, route: 75, write: 67 }, { tools: 100, route: 75, write: 67 }]);
  const better = { tools: 89, route: 100, write: 100 };
  // 1. a better blend that calls tools worse is not proposed for a tool role
  let r = proposePicks({ floor: floor({ writer: 'pick:1' }), models: [pick, mk('blend:1', 'heretic', [better, better])] }).find((x) => x.role === 'writer');
  assert.equal(r.change, false); assert.match(r.why, /calls tools worse/);
  // 2. an unmeasured pick is reported, never swapped
  r = proposePicks({ floor: floor({ writer: 'gone:1' }), models: [mk('x:1', 'heretic', [{ tools: 100, route: 100, write: 100 }])] }).find((x) => x.role === 'writer');
  assert.equal(r.change, false); assert.match(r.why, /not measured/);
  // 3. too slow for the role: not even scored
  r = proposePicks({ floor: floor({ writer: 'pick:1' }), models: [pick, mk('slow:1', 'heretic', [{ tools: 100, route: 100, write: 100, tokS: 12 }, { tools: 100, route: 100, write: 100, tokS: 12 }])] }).find((x) => x.role === 'writer');
  assert.equal(r.best, 'pick:1');
  // 4. one run needs twice the margin
  const weak = mk('weak:1', 'abliterated', [{ tools: 95, route: 80, write: 80 }, { tools: 95, route: 80, write: 80 }]);
  r = proposePicks({ floor: floor({ writer: 'weak:1' }), models: [weak, mk('once:1', 'heretic', [{ tools: 100, route: 85, write: 90 }])] }).find((x) => x.role === 'writer');
  assert.equal(r.change, false); assert.match(r.why, /one run/);
  // 5. a simulated 8 GB result's speed is scaled to an 8 GB chip
  assert.equal(Math.round(effectiveTokS({ tokS: 97, simulatedAsGb: 8, host: 'Apple M5 Pro' })), 32);
  assert.equal(effectiveTokS({ tokS: 97, host: 'Apple M5 Pro' }), 97);
  // 6. vision is reported, never proposed
  const vpick = mk('v:1', 'abliterated', [{ tools: 80, route: 70, write: 60 }, { tools: 80, route: 70, write: 60 }], ['vision']);
  r = proposePicks({ floor: floor({ vision: 'v:1' }), models: [vpick, mk('v:2', 'abliterated', [{ tools: 100, route: 100, write: 100 }, { tools: 100, route: 100, write: 100 }], ['vision'])] }).find((x) => x.role === 'vision');
  assert.equal(r.change, false); assert.match(r.why, /image suite/);
  // 7. a better censored model is shown, not proposed
  r = proposePicks({ floor: floor({ writer: 'weak:1' }), models: [weak, mk('stock:1', 'stock', [{ tools: 100, route: 100, write: 100 }, { tools: 100, route: 100, write: 100 }])] }).find((x) => x.role === 'writer');
  assert.equal(r.change, false); assert.match(r.why, /censored \(stock:1\)/);
  // 8. the coder match is anchored
  assert.equal(eligible({ tag: 'some-decoder:1', bench: [] }, 'coder'), false);
  assert.equal(eligible({ tag: 'codestral-embed:1', bench: [] }, 'coder'), false);
  assert.equal(eligible({ tag: 'huihui_ai/qwen2.5-coder-abliterate:7b', bench: [] }, 'coder'), true);
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
