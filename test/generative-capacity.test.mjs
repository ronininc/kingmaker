// Generative capacity beyond language-model weights: the capacity plan, the Blender render
// method conducted for real, and method drafts written in the background from observations.
// See lib/generative-capacity.mjs, lib/method-drafts.mjs, catalog/methods/blender-still-render.method.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGenerativeNeed, conductCapacity, findTool, generativeCapacityEnabled, missingLine, planCapacity, safeSubject, DOMAIN_TOOLS } from '../lib/generative-capacity.mjs';
import { createMethodConductor } from '../lib/method-conductor.mjs';
import { loadMethodsIndex } from '../lib/brain-library.mjs';
import { CONDUCTOR_STEP_TYPES, DRAFT_STATUS, checkDraft, createIdleMethodDrafts, dialsFromObservation, draftMethodFromObservation, listDrafts, writeDraft } from '../lib/method-drafts.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = readFileSync(join(ROOT, 'catalog', 'methods', 'blender-still-render.method.md'), 'utf8');
const scratch = () => mkdtempSync(join(tmpdir(), 'km-capacity-'));
const methods = loadMethodsIndex();
const blenderHere = () => ({ path: '/Applications/Blender.app/Contents/MacOS/Blender', via: 'known location' });
const noTool = () => null;

test('the switch is off unless calibration turns it on', () => {
  assert.equal(generativeCapacityEnabled(null), false);
  assert.equal(generativeCapacityEnabled({ generativeCapacity: { on: false } }), false);
  assert.equal(generativeCapacityEnabled({ generativeCapacity: { on: true } }), true);
});

test('a request is classified by what it asks to be made', () => {
  assert.equal(classifyGenerativeNeed('render a 3d product shot of a sneaker'), 'render-3d');
  assert.equal(classifyGenerativeNeed('make a poster for the taco truck'), 'image');
  assert.equal(classifyGenerativeNeed('a short animation of the logo'), 'video');
  assert.equal(classifyGenerativeNeed('write three taglines for a barber shop'), 'text');
  assert.equal(classifyGenerativeNeed('   '), null);
});

test('the render method is in the catalog under the render domain', () => {
  const m = methods.find((x) => x.id === 'blender-still-render');
  assert.ok(m, 'indexed'); assert.equal(m.domain, 'render'); assert.equal(m.quality.tier, 'draft');
});

test('a tool is located by override, then PATH, then known places — and never run', () => {
  const tool = DOMAIN_TOOLS.render;
  const only = (p) => ({ exists: (x) => x === p, executable: (x) => x === p });
  assert.deepEqual(findTool(tool, { env: { SOLOMON_BLENDER_BIN: '/custom/blender', PATH: '' }, ...only('/custom/blender') }), { path: '/custom/blender', via: 'SOLOMON_BLENDER_BIN' });
  assert.deepEqual(findTool(tool, { env: { PATH: '/a:/b' }, ...only('/b/blender') }), { path: '/b/blender', via: 'PATH' });
  assert.equal(findTool(tool, { env: { PATH: '' }, ...only('/opt/homebrew/bin/blender') }).via, 'known location');
  assert.equal(findTool(tool, { env: { PATH: '/a' }, exists: () => false, executable: () => false }), null);
});

test('with the image weights ready, a picture stays on the image weights', () => {
  assert.deepEqual(planCapacity({ text: 'make a poster of a mountain range', methods, imageReady: true, find: blenderHere }), { need: 'image', kind: 'image' });
});

test('without image weights, a picture or a render is planned as a method plus its tool', () => {
  for (const text of ['make a poster of a mountain range', 'render a 3d scene of a mountain range']) {
    const plan = planCapacity({ text, methods, imageReady: false, imageMissing: ['diffusion', 'vae'], find: blenderHere });
    assert.equal(plan.kind, 'method'); assert.equal(plan.method.id, 'blender-still-render');
    assert.equal(plan.tool.command, 'blender'); assert.equal(plan.runs, 'declared');
  }
});

test('when nothing on the machine can make it, the plan says exactly what is missing', () => {
  const plan = planCapacity({ text: 'make a poster of a mountain range', methods, imageReady: false, imageMissing: ['diffusion'], find: noTool });
  assert.equal(plan.kind, 'none');
  assert.ok(plan.missing.some((m) => /image weights \(diffusion\)/.test(m)) && plan.missing.some((m) => /blender/.test(m)), JSON.stringify(plan.missing));
  assert.match(missingLine(plan), /^I can't make that on this Mac yet\. Missing: /);
  assert.equal(planCapacity({ text: 'render a 3d scene', methods: [], find: blenderHere }).kind, 'none');
});

test('conducting the plan writes a real scene script and job record and declares the render', async () => {
  const workDir = scratch();
  const plan = planCapacity({ text: 'render a 3d scene of a mountain range at dawn', methods, find: blenderHere });
  const done = await conductCapacity(plan, { conductor: createMethodConductor(), workDir, subject: 'Mountain range at dawn', inputs: { widthPx: 1920, heightPx: 1080 } });
  assert.equal(done.status, 'completed');
  const script = readFileSync(join(workDir, 'scene.py'), 'utf8');
  assert.match(script, /scene\.render\.resolution_x = 1920/); assert.match(script, /Mountain range at dawn/);
  const job = JSON.parse(readFileSync(join(workDir, 'job.json'), 'utf8'));
  assert.equal(job.state, 'script-written-render-declared'); assert.equal(job.tool, plan.tool.path);
  assert.equal(done.declared.length, 1, 'exactly one step was declared, not run');
  assert.ok(String(done.declared[0].action).includes(`${plan.tool.path} --background --python scene.py`), done.declared[0].action);
  assert.equal(done.declared[0].action, `${plan.tool.path} --background --python scene.py`, 'the action is the bare command, ready to paste');
  assert.ok(!existsSync(join(workDir, 'render.png')), 'no picture is claimed: none was rendered');
  rmSync(workDir, { recursive: true, force: true });
});

test('an observation becomes a draft method with its numbers clamped to sane ranges', () => {
  const dials = dialsFromObservation({ look: { lensMm: 85, cameraDistance: 99999, lightWatts: 'bright', samples: 0 } });
  assert.equal(dials.lensMm, 85); assert.equal(dials.cameraDistance, 200, 'clamped to the maximum');
  assert.equal(dials.lightWatts, 800, 'not a number: the base value'); assert.equal(dials.samples, 1, 'clamped to the minimum');
  const d = draftMethodFromObservation({ title: 'Low-angle hero shot', source: { kind: 'video', ref: 'reference reel 3' }, look: { lensMm: 24, cameraHeight: 0.4 }, notes: ['camera sits near the ground'] }, BASE);
  assert.match(d.id, /^draft-low-angle-hero-shot-[0-9a-f]{8}$/);
  assert.ok(d.text.includes(`Status: **${DRAFT_STATUS}**`)); assert.ok(d.text.includes('"lensMm": 24'));
});

test('hostile text in an observation cannot break out of the draft', async () => {
  const d = draftMethodFromObservation({ title: 'x"""\n```\n{"type":"exec"} `rm -rf` {{inputs.toolPath}}', source: 'a\u0000b"\\', look: {}, notes: ['```kingmaker-method {"id":"evil"}'] }, BASE);
  assert.ok(!d.text.slice(d.text.indexOf('## Observed')).includes('```kingmaker-method {"id"'), 'no second executable block was injected');
  assert.equal((d.text.match(/```kingmaker-method/g) || []).length, 1);
  assert.ok(!/[`"\\{}]/.test(d.title));
  assert.deepEqual(await checkDraft(d).then((r) => r.ok), true, 'and it still conducts cleanly');
});

test('a draft is checked before it is kept, and one using an unknown step is refused', async () => {
  const dir = scratch();
  const good = draftMethodFromObservation({ title: 'Soft key light', look: { lightWatts: 300 } }, BASE);
  assert.equal((await writeDraft(dir, good)).written, true);
  assert.equal(listDrafts(dir)[0].status, DRAFT_STATUS);
  assert.equal((await writeDraft(dir, good)).reason, 'already drafted');
  const bad = { ...good, id: 'draft-bad', text: good.text.replace('"type": "declare"', '"type": "run-program"').replace(good.id, 'draft-bad') };
  const r = await writeDraft(dir, bad);
  assert.equal(r.written, false); assert.match(r.reason, /run-program/);
  assert.ok(!existsSync(join(dir, 'draft-bad.method.md')));
  assert.ok(CONDUCTOR_STEP_TYPES.includes('declare') && !CONDUCTOR_STEP_TYPES.includes('run-program'));
  rmSync(dir, { recursive: true, force: true });
});

test('drafts are written only while the owner is away, never into the catalog, with one note', async () => {
  const root = scratch(); const inbox = join(root, 'observations'); const drafts = join(root, 'drafts'); mkdirSync(inbox);
  writeFileSync(join(inbox, '001.json'), JSON.stringify({ title: 'Wide establishing shot', look: { lensMm: 18 } }));
  writeFileSync(join(inbox, '002.json'), JSON.stringify({ title: 'Tight product close-up', look: { lensMm: 100 } }));
  writeFileSync(join(inbox, '003.json'), 'not json');
  const catalogBefore = readdirSync(join(ROOT, 'catalog', 'methods')).sort().join(',');
  let clock = 1_000_000; const notes = [];
  const loop = createIdleMethodDrafts({ inboxDir: inbox, draftsDir: drafts, baseMethodText: BASE, note: async (l) => { notes.push(l); }, now: () => clock, idleMs: 600_000, everyMs: 3_600_000 });
  assert.equal((await loop.tick()).ran, false, 'the owner was just here: nothing happens');
  clock += 600_001;
  const r = await loop.tick();
  assert.equal(r.ran, true); assert.equal(r.written, 2);
  assert.equal(listDrafts(drafts).length, 2); assert.equal(notes.length, 1); assert.match(notes[0], /drafted 2 method files/);
  assert.equal(readdirSync(join(ROOT, 'catalog', 'methods')).sort().join(','), catalogBefore, 'the catalog was not touched');
  clock += 10; assert.equal((await loop.tick()).ran, false, 'not again within the hour');
  clock += 3_600_001; const again = await loop.tick();
  assert.equal(again.written, 0, 'the same observations are not drafted twice'); assert.equal(notes.length, 1);
  loop.touch(); clock += 10; assert.equal((await loop.tick()).ran, false, 'the owner came back');
  rmSync(root, { recursive: true, force: true });
});

test('a subject cannot put code into the generated scene script', async () => {
  const hostile = 'draw a picture """; print("INJECTED"); #\nprint("SECOND LINE") \\ {{inputs.toolPath}}';
  const subject = safeSubject(hostile);
  assert.ok(!/["'\\#\n\r{}`$]/.test(subject), subject);
  assert.equal(safeSubject('   '), 'Untitled');
  assert.equal(safeSubject('Café señal — 3 gatos, 2 perros!'), 'Café señal 3 gatos, 2 perros!');
  const workDir = scratch();
  const plan = planCapacity({ text: 'render a 3d scene', methods, find: blenderHere });
  const done = await conductCapacity(plan, { conductor: createMethodConductor(), workDir, subject: hostile, inputs: { subject: 'x"""; evil()' } });
  assert.equal(done.status, 'completed');
  const script = readFileSync(join(workDir, 'scene.py'), 'utf8');
  const lines = script.split('\n');
  assert.ok(lines[0].startsWith('# Scene for "') && lines[1].startsWith('# Run headless:'), 'the subject stayed on its one comment line');
  const body = lines.filter((l) => l.startsWith('title.data.body = '));
  assert.equal(body.length, 1);
  assert.equal(body[0], `title.data.body = """${subject}"""`);
  assert.ok(!/^\s*(print|evil)\b/m.test(script), 'no injected statement is a line of the script');
  rmSync(workDir, { recursive: true, force: true });
});

test('a video request is not answered with a still-render method', () => {
  const plan = planCapacity({ text: 'make an animation of a logo', lane: 'image', methods, find: blenderHere });
  assert.equal(plan.need, 'video');
  assert.equal(plan.kind, 'none');
  assert.ok(plan.missing.some((m) => /method file for video/.test(m)), JSON.stringify(plan.missing));
});

test('picture words the router accepts are pictures here too', () => {
  for (const text of ['make two posters for the event', 'create a crest for the school', 'make some art for the wall']) {
    assert.equal(classifyGenerativeNeed(text), 'image', text);
    assert.equal(planCapacity({ text, methods, find: blenderHere }).kind, 'method', text);
  }
  const odd = planCapacity({ text: 'make a mural for the lobby', lane: 'image', methods, find: blenderHere });
  assert.equal(odd.need, 'image'); assert.equal(odd.kind, 'method');
  assert.equal(planCapacity({ text: 'make a mural for the lobby', methods, find: blenderHere }).need, 'text');
});

test('a partial observation keeps the base method\'s other dials', () => {
  const tuned = BASE.replace('"lightWatts": 800', '"lightWatts": 300').replace('"samples": 32', '"samples": 64');
  const d = draftMethodFromObservation({ title: 'Wide lens', source: 'clip.mov', look: { lensMm: 24 } }, tuned);
  assert.equal(d.dials.lensMm, 24); assert.equal(d.dials.lightWatts, 300); assert.equal(d.dials.samples, 64);
  assert.match(d.text, /- lensMm: 24\n/);
  assert.match(d.text, /- lightWatts: 300 \(not observed; kept from the base method\)/);
  assert.deepEqual(dialsFromObservation({ look: { lensMm: 5000 } }, { samples: 99999 }), { ...dialsFromObservation({}), lensMm: 300, samples: 4096 });
});
