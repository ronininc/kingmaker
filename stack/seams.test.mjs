/**
 * seams.test.mjs (kingmaker-stack)
 *
 * Cross-component seam checks for the folded stack. The per-component
 * suites test each build against its own fakes; these checks test the
 * JOINTS — with the real modules from both sides of each seam:
 *
 *   (a) lane-policy (edge0 augmentation) ↔ governed router tiers
 *       (router-phase2). The two vocabularies do NOT share names:
 *       lanes are reflex/standard/deep, tiers are cheap/standard/
 *       frontier. LANE_TO_TIER below is the explicit adapter.
 *   (b) cell-governor's 'littlebrother-full' workload kind (space-cell)
 *       ↔ littlebrother's actual full-method exports. The governor
 *       names no methods; resolution runs through littlebrother's own
 *       factory, and the solomon build must NOT expose them.
 *   (c) exhaust harvester (training-data-pipeline) ↔ the REAL audit
 *       writers of the stack: a chain written by the actual governed
 *       router (JSON-array shape) and chains written by littlebrother's
 *       audit log (JSONL shape), including the real on-disk artifact
 *       at littlebrother/audit/littlebrother-audit.jsonl (read-only).
 *       The pipeline's own suite covers both shapes with synthetic
 *       chains; this check proves the cross-implementation hash math
 *       agrees (router/LB writers → pipeline reader/verifier).
 *
 *   (d) the eleven absorbed components (folded in 2026-10-20 from the
 *       @githubprojects five and the "helps us now" six): registry ↔
 *       descriptor license agreement, the lazy-frames triage binding
 *       through its real tripwire module, the externals staying
 *       external (ExifCleaner guard, Unsloth Studio posture), XERJ's
 *       lexical-only embedder pin, Anatomy's renders-never-diagnoses
 *       seat, the content-skill pins, the shared audit chain's math,
 *       and a zero-bare-import scan over the new components.
 *
 * No network, $0. All writes go to a temp scratch dir; component
 * homes are never written to.
 *
 * Run: node seams.test.mjs   (exit 1 on any failure)
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STACK_DIR = dirname(fileURLToPath(import.meta.url));
const WS = dirname(STACK_DIR); // ~/workspace
const P = {
  router: join(WS, 'router-phase2'),
  littlebrother: join(WS, 'littlebrother'),
  spaceCell: join(WS, 'kingmaker-v041', 'space-cell'),
  training: join(WS, 'training-data-pipeline'),
  edge0: join(WS, 'edge0-minicpm-augmentation'),
};

const tmp = mkdtempSync(join(tmpdir(), 'kingmaker-stack-seams-'));
const results = [];
function check(name, cond, extra = '') {
  results.push([cond ? 'PASS' : 'FAIL', name]);
  if (!cond) console.log(`  detail: ${extra}`);
}

// ---------------------------------------------------------------- (a) lanes ↔ tiers
{
  const { LANES, KIND_TO_LANE, classifyLane } = await import(join(P.edge0, 'lib/lane-policy.mjs'));
  const { TIERS, TIER_RANK } = await import(join(P.router, 'lib/routing-bandit.mjs'));
  const { DEFAULT_MODELS } = await import(join(P.router, 'lib/governed-router.mjs'));

  // THE ADAPTER. lane-policy decides posture (think?, budget); the router
  // decides which model tier serves. Only 'standard' shares a name across
  // the two vocabularies — everything else resolves through this table.
  const LANE_TO_TIER = Object.freeze({ reflex: 'cheap', standard: 'standard', deep: 'frontier' });
  const TIER_TO_LANE = Object.freeze({ cheap: 'reflex', standard: 'standard', frontier: 'deep' });

  const laneIds = Object.keys(LANES);
  check('(a) every lane maps to exactly one router tier',
    laneIds.every((l) => TIERS.includes(LANE_TO_TIER[l])), JSON.stringify(LANE_TO_TIER));
  check('(a) mapping is a bijection onto the tier set (every tier reachable from a lane)',
    TIERS.every((t) => TIER_TO_LANE[t] && LANE_TO_TIER[TIER_TO_LANE[t]] === t));
  check('(a) the one shared name resolves identically: lane standard ↔ tier standard',
    LANE_TO_TIER.standard === 'standard' && TIER_TO_LANE.standard === 'standard');
  check('(a) router DEFAULT_MODELS use only bandit tiers the mapping covers',
    DEFAULT_MODELS.every((m) => TIERS.includes(m.tier) && TIER_TO_LANE[m.tier] !== undefined),
    JSON.stringify(DEFAULT_MODELS.map((m) => m.tier)));
  check('(a) lane order respects tier rank: reflex < standard < deep as cheap < standard < frontier',
    laneIds.every((l, i, arr) => i === 0 || TIER_RANK[LANE_TO_TIER[arr[i - 1]]] < TIER_RANK[LANE_TO_TIER[l]]),
    `lane order ${laneIds.join(',')}`);
  check('(a) budgets grow with tier rank, and only the top lane thinks',
    TIER_RANK[LANE_TO_TIER.reflex] === 0 && LANES.reflex.think === false && LANES.standard.think === false
      && LANES.deep.think === true
      && LANES.reflex.maxTokens < LANES.standard.maxTokens && LANES.standard.maxTokens < LANES.deep.maxTokens);
  check('(a) every KIND_TO_LANE target is a real lane with a tier',
    Object.values(KIND_TO_LANE).every((l) => LANES[l] && LANE_TO_TIER[l]));
  check('(a) classifier output always lands on a mapped lane',
    ['route', 'chat', 'code', undefined].every((kind) => {
      const d = classifyLane(kind ? { kind } : {});
      return LANE_TO_TIER[d.lane] !== undefined;
    }));
}

// ---------------------------------------------------------------- (b) governor kind ↔ LB full methods
{
  const { WORKLOAD_KINDS } = await import(join(P.spaceCell, 'lib/cell-governor.mjs'));
  const { FULL_METHOD_IDS, createFullMethods } = await import(join(P.littlebrother, 'lib/methods-full.mjs'));
  const { createLittleBrother } = await import(join(P.littlebrother, 'lib/littlebrother.mjs'));

  const kind = WORKLOAD_KINDS['littlebrother-full'];
  check("(b) 'littlebrother-full' workload kind exists in the governor registry", !!kind);
  check("(b) the kind is gated on the heretic spine — the same side of the wall as the full methods",
    kind?.spine === 'kingmaker-x-heretic', `spine=${kind?.spine}`);

  const created = createFullMethods({});
  check('(b) FULL_METHOD_IDS and createFullMethods() agree exactly',
    JSON.stringify(Object.keys(created).sort()) === JSON.stringify([...FULL_METHOD_IDS].sort()),
    `ids=${FULL_METHOD_IDS} created=${Object.keys(created)}`);
  check('(b) every exported full method is a function',
    FULL_METHOD_IDS.every((id) => typeof created[id] === 'function'));

  const lbK = await createLittleBrother({ mode: 'kingmaker', auditPath: join(tmp, 'lb-kingmaker.jsonl') });
  check('(b) kingmaker build exposes every full method on its api.methods',
    FULL_METHOD_IDS.every((id) => lbK.methods.includes(id) && typeof lbK[id] === 'function'),
    `kingmaker methods=${lbK.methods}`);
  const lbS = await createLittleBrother({ mode: 'solomon', auditPath: join(tmp, 'lb-solomon.jsonl') });
  check('(b) solomon build exposes NONE of the full methods (structural cut holds at runtime)',
    FULL_METHOD_IDS.every((id) => !lbS.methods.includes(id) && lbS[id] === undefined),
    `solomon methods=${lbS.methods}`);
}

// ---------------------------------------------------------------- (c) harvester ↔ real audit writers
{
  const { createGovernedRouter } = await import(join(P.router, 'lib/governed-router.mjs'));
  const { openAuditLog: openLbLog } = await import(join(P.littlebrother, 'lib/audit-log.mjs'));
  // NOTE: harvestFile's documented return includes `format`, but the
  // component never surfaces it (doc/impl mismatch — see lib/harvest.mjs).
  // The stack adapter restores the documented field using the pipeline's
  // own detectFormat; records/chainOk come from harvestFile unchanged.
  const { harvestFileWithFormat: harvestFile } = await import(join(STACK_DIR, 'lib/harvest.mjs'));

  // Router side: the REAL governed router writes the chain (JSON-array
  // shape); the REAL harvester reads it. Fake runner only — the seam
  // under test is writer→reader, not any model.
  const routerAudit = join(tmp, 'router-chain.json');
  const router = createGovernedRouter({
    auditPath: routerAudit,
    runner: async ({ model }) => ({
      output: `Summary complete. Produced by ${model.id}.`,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  });
  const routed = await router.route({ id: 'seam-task-1', text: 'Summarize the quarterly dispatch notes for the guild board' });
  check('(c) governed router completes a route against the fake runner', routed.status === 'ok', JSON.stringify(routed));

  const hRouter = harvestFile(routerAudit, { chainLabel: 'seam-router' });
  check('(c) harvester detects the router chain format as json-array', hRouter.format === 'json-array', `format=${hRouter.format}`);
  check('(c) router-written chain VERIFIES under the pipeline reader (hash math agrees across implementations)',
    hRouter.chainOk === true);
  const goldRoute = hRouter.records.find((r) => r.kind === 'routing-decision' && r.label === 'gold');
  check('(c) the completed route harvests to a GOLD routing-decision with full provenance',
    !!goldRoute && goldRoute.provenance.teacher === 'governed-router' && goldRoute.decision?.model === routed.model,
    JSON.stringify(hRouter.records.map((r) => [r.kind, r.label])));

  // LittleBrother side: LB's own audit-log writer (JSONL shape).
  const lbPath = join(tmp, 'lb-chain.jsonl');
  const lbLog = openLbLog(lbPath);
  lbLog.append({ actor: 'littlebrother', action: 'lookup', detail: 'method=ipLookup target=203.0.113.7', meta: { mode: 'kingmaker', verified: true } });
  lbLog.append({ actor: 'littlebrother', action: 'lookup', detail: 'method=webRecon target=example.com', meta: { mode: 'kingmaker', verified: null } });
  const hLb = harvestFile(lbPath, { chainLabel: 'seam-lb' });
  check('(c) harvester detects the littlebrother chain format as jsonl', hLb.format === 'jsonl', `format=${hLb.format}`);
  check('(c) littlebrother-written chain VERIFIES under the pipeline reader', hLb.chainOk === true);
  check('(c) verified lookup → gold task-outcome; unverified → unlabeled',
    hLb.records.some((r) => r.kind === 'task-outcome' && r.label === 'gold' && r.provenance.teacher === 'littlebrother')
      && hLb.records.some((r) => r.kind === 'task-outcome' && r.label === 'unlabeled'),
    JSON.stringify(hLb.records.map((r) => [r.kind, r.label])));

  // The real on-disk artifact in the littlebrother home (READ-ONLY).
  const hReal = harvestFile(join(P.littlebrother, 'audit', 'littlebrother-audit.jsonl'), { chainLabel: 'seam-real-lb' });
  check('(c) the real littlebrother audit artifact harvests clean (jsonl, chain ok, ≥1 gold record)',
    hReal.format === 'jsonl' && hReal.chainOk === true
      && hReal.records.some((r) => r.kind === 'task-outcome' && r.label === 'gold'),
    JSON.stringify({ format: hReal.format, chainOk: hReal.chainOk, n: hReal.records.length }));
}

// ---------------------------------------------------------------- (d) the absorbed eleven
{
  const NEW_IDS = ['wordcraft', 'artemis', 'anatomy', 'solidcraft', 'xerj', 'unsloth', 'check-if-email-exists', 'stop-slop', 'humanizer', 'exifcleaner', 'lazy-frames'];
  const manifest = JSON.parse(readFileSync(join(STACK_DIR, 'stack-manifest.json'), 'utf8'));
  const byId = Object.fromEntries(manifest.components.map((c) => [c.id, c]));
  const desc = (id) => JSON.parse(readFileSync(join(STACK_DIR, id, 'descriptor.json'), 'utf8'));

  check('(d) manifest registers all seventeen components (five builds + integration layer + absorbed eleven)',
    ['router-phase2', 'littlebrother', 'space-cell', 'training-data-pipeline', 'edge0-minicpm-augmentation', 'kingmaker-stack', ...NEW_IDS].every((id) => byId[id]));

  for (const id of NEW_IDS) {
    check(`(d) ${id}: manifest license posture == descriptor`,
      byId[id].licensePosture.class === desc(id).licensePosture.class
      && byId[id].licensePosture.license === desc(id).licensePosture.license,
      `manifest=${byId[id].licensePosture.class}/${byId[id].licensePosture.license} descriptor=${desc(id).licensePosture.class}/${desc(id).licensePosture.license}`);
  }
  check('(d) lazy-frames is the only unverified absorbed component',
    NEW_IDS.filter((id) => byId[id].licensePosture.class === 'unverified').join() === 'lazy-frames');
  check('(d) exifcleaner is the only external-class absorbed component',
    NEW_IDS.filter((id) => byId[id].licensePosture.class === 'external').join() === 'exifcleaner');

  // Lazy-frames triage binds through its real tripwire module.
  const lf = await import(join(STACK_DIR, 'lazy-frames', 'lib/lazy-frames-triage.mjs'));
  check('(d) lazy-frames triage record is DO NOT USE and validates as triage',
    lf.LAZY_FRAMES_TRIAGE.status === 'DO NOT USE' && lf.validateTriageRecord(lf.LAZY_FRAMES_TRIAGE).ok === true);
  check('(d) lazy-frames tripwires refuse render + capture + remote skill fetch',
    lf.buildRenderJob({}).ok === false && lf.buildCaptureJob('https://example.com').ok === false
      && lf.guardSkillSource('https://lazy-frames.cosmicstack.ai/skill.md').ok === false);

  // Externals stay external.
  const ex = await import(join(STACK_DIR, 'exifcleaner', 'lib/exifcleaner-external.mjs'));
  let guardThrew = false;
  try { ex.guardSpecifier('exifcleaner'); } catch { guardThrew = true; }
  check('(d) exifcleaner descriptor validates as an external registration, tripwire armed',
    ex.validateExternalDescriptor(desc('exifcleaner')).ok === true && guardThrew && ex.guardSpecifier('./lib/other.mjs') === true);
  const un = await import(join(STACK_DIR, 'unsloth', 'lib/unsloth-contract.mjs'));
  check('(d) unsloth Studio stays external: descriptor says so, launch config refuses tunnel + wide bind',
    /external-only/.test(desc('unsloth').posture.studio)
      && un.buildStudioLaunchConfig({ tunnel: true }).ok === false
      && un.buildStudioLaunchConfig({ host: '0.0.0.0' }).ok === false
      && un.UNSLOTH_PIN.studioPosture === 'external-only');

  // XERJ: lexical-only embedder, enforced by the real contract.
  const xj = await import(join(STACK_DIR, 'xerj', 'lib/xerj-contract.mjs'));
  check('(d) xerj governed server config pins the lexical embedder; neural-from-hub refuses',
    xj.buildServerConfig({ adminKeyRef: 'vault:xerj-admin' }).config.embedder.kind === 'lexical'
      && xj.validateEmbedder({ kind: 'neural' }).ok === false
      && /lexical/.test(desc('xerj').embedderPinned));

  // Anatomy: the seat is stated in the descriptor and the gate's law matches it.
  const an = await import(join(STACK_DIR, 'anatomy', 'lib/anatomy-gate.mjs'));
  check('(d) anatomy descriptor states renders-never-diagnoses; publish is a forbidden action at its gate',
    /never/i.test(desc('anatomy').seat.diagnosis) && typeof desc('anatomy').seat.renders === 'string'
      && an.FORBIDDEN_ACTIONS.includes('publish'));

  // Content skills: manifest-side pins in the descriptors equal the modules' pins.
  const ss = await import(join(STACK_DIR, 'stop-slop', 'lib/stop-slop-skill.mjs'));
  const hu = await import(join(STACK_DIR, 'humanizer', 'lib/humanizer-skill.mjs'));
  check('(d) stop-slop descriptor pins == module pins',
    JSON.stringify(desc('stop-slop').pin.skillFiles) === JSON.stringify(ss.STOP_SLOP_PIN.skillFiles));
  check('(d) humanizer descriptor pin == module pin',
    JSON.stringify(desc('humanizer').pin.skillFiles) === JSON.stringify(hu.HUMANIZER_PIN.skillFiles));

  // The shared audit chain the new contracts log through verifies
  // under independently recomputed house math.
  const { openAuditLog } = await import(join(STACK_DIR, 'lib/audit-chain.mjs'));
  const chainPath = join(tmp, 'absorbed-chain.jsonl');
  const log = openAuditLog(chainPath, { genesisLabel: 'seam-d' });
  log.append({ actor: 'seam', action: 'one', detail: 'first' });
  log.append({ actor: 'seam', action: 'two', detail: 'second' });
  const lines = readFileSync(chainPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let chainOk = lines.length === 3;
  for (let i = 0; i < lines.length && chainOk; i++) {
    const e = lines[i];
    const recomputed = createHash('sha256').update(JSON.stringify({ ...e, hash: undefined }), 'utf8').digest('hex');
    chainOk = recomputed === e.hash && e.seq === i && (i === 0 ? e.prevHash === '0'.repeat(64) : e.prevHash === lines[i - 1].hash);
  }
  check('(d) shared stack audit chain verifies under independent recomputation', chainOk && log.verify().ok === true);

  // Zero bare imports across the absorbed components (zero-dependency,
  // no upstream code — the externals least of all).
  const bare = [];
  let scanned = 0;
  const scanDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) scanDir(p);
      else if (entry.name.endsWith('.mjs')) {
        scanned++;
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
          if (!m[1].startsWith('.') && !m[1].startsWith('node:')) bare.push(`${p.replace(STACK_DIR, '')}: ${m[1]}`);
        }
      }
    }
  };
  for (const id of NEW_IDS) scanDir(join(STACK_DIR, id));
  check(`(d) no bare imports in any of ${scanned} absorbed-component .mjs files`, bare.length === 0, bare.join('; '));

  // The combined verifier covers every absorbed suite.
  const verifier = readFileSync(join(STACK_DIR, 'verify-all.mjs'), 'utf8');
  check('(d) verify-all covers every absorbed suite',
    NEW_IDS.every((id) => verifier.includes(`join(STACK_DIR, '${id}')`)));
}

// ---------------------------------------------------------------- report
let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed += 1;
  console.log(`${status}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} seam checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
