/**
 * lib/harness2-governed.mjs (kingmaker-stack)
 *
 * Harness², reconstructed under Ronin doctrine.
 *
 * Upstream (google-research/harness2, Apache-2.0; paper arXiv
 * 2610.14224) is a recursive agent-harnessing framework: the model
 * stays frozen while a Propose–Probe–Compose loop edits the eight
 * file-mounted harness components around it — system prompt,
 * guardrails, memory, tool guidance, subagents, skills, scripts,
 * plugins — judging candidate edits by behavioral contrast, with no
 * ground-truth verifier, and distilling the wins into an improvement
 * library later tasks inherit.
 *
 * This module is a clean-room reconstruction of that published method
 * on this stack's governance primitives. Upstream code is Python /
 * Vertex-bound research code and is NOT vendored here; the method is
 * re-implemented from the paper. One doctrinal change, deliberate:
 *
 *   Upstream adopts its own edits ungated. Here, propose / probe /
 *   compose only GENERATE a candidate winner. Adoption is a governed
 *   act: it requires a verified founder tap token, it is appended to
 *   the hash-chained audit log either way (adoptions and refusals
 *   alike), and the lesson written to the improvement library records
 *   the tap that authorized it. A harness edit is a behavior change;
 *   behavior changes land through the gate.
 *
 * Everything external is injected: the editor functions (who proposes
 * edits) and the runner (who executes a trial harness against a
 * task). This module ships no model calls, no network code, and no
 * telemetry. Probe cost is the caller's budget problem, surfaced in
 * the audit trail per cycle — the router's lanes govern it upstream.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openAuditLog } from '../../lib/audit-chain.mjs';
import { createTapGate, csamHit, refused } from '../../lib/governance.mjs';

export const HARNESS_COMPONENTS = [
  'systemPrompt',
  'guardrails',
  'memory',
  'toolGuidance',
  'subagents',
  'skills',
  'scripts',
  'plugins',
];

const cloneHarness = (harness) => ({
  components: { ...(harness?.components ?? {}) },
});

function applyEdit(harness, edit) {
  const next = cloneHarness(harness);
  next.components[edit.component] = edit.content;
  return next;
}

function readLibrary(libraryPath) {
  if (!libraryPath || !existsSync(libraryPath)) return [];
  const raw = readFileSync(libraryPath, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('harness2: improvement library is not a JSON array — refused');
  return parsed;
}

function writeLibrary(libraryPath, lessons) {
  mkdirSync(dirname(libraryPath), { recursive: true });
  writeFileSync(libraryPath, JSON.stringify(lessons, null, 2) + '\n', 'utf8');
}

/**
 * createHarnessImprover({ auditLog, auditPath, libraryPath, verifyTap, runner, maxCandidates })
 *
 *   auditLog / auditPath  the stack hash-chained audit log (one is required)
 *   libraryPath           JSON file holding the improvement library (lessons
 *                         carried across tasks — harnessing-level recursion)
 *   verifyTap             (token) => boolean founder-tap verifier; absent
 *                         means adoption always refuses (fail-closed)
 *   runner                async (trialHarness, task) => { score, signal }
 *                         the probe executor; absent means probes refuse
 *   maxCandidates         cap on candidates per cycle (probe-cost guard)
 */
export function createHarnessImprover(opts = {}) {
  const audit = opts.auditLog ?? openAuditLog(opts.auditPath);
  const libraryPath = opts.libraryPath ?? null;
  const gate = createTapGate(opts.verifyTap);
  const runner = typeof opts.runner === 'function' ? opts.runner : null;
  const maxCandidates = opts.maxCandidates ?? 8;

  const log = (action, detail, meta = {}) =>
    audit.append({ actor: 'harness2', action, detail, meta });

  /**
   * PROPOSE — editors offer candidate edits. An edit replaces the whole
   * content of ONE of the eight components. Edits naming an unknown
   * component are dropped; content that trips the CSAM screen aborts
   * that candidate (logged WITHOUT content, no override).
   */
  async function propose({ task, harness, editors } = {}) {
    if (!harness || typeof harness !== 'object') return refused('propose: a harness object is required');
    if (!Array.isArray(editors) || editors.length === 0) return refused('propose: at least one editor is required');
    const candidates = [];
    let dropped = 0;
    let screened = 0;
    for (const editor of editors) {
      const produced = await editor(cloneHarness(harness), task);
      const edits = Array.isArray(produced) ? produced : produced ? [produced] : [];
      for (const edit of edits) {
        if (!edit || !HARNESS_COMPONENTS.includes(edit.component) || typeof edit.content !== 'string') {
          dropped += 1;
          continue;
        }
        if (csamHit(edit.content)) {
          screened += 1;
          log('csam-abort', `stage=propose component=${edit.component} — content withheld by policy`);
          continue;
        }
        candidates.push({
          id: `cand-${candidates.length + 1}`,
          component: edit.component,
          content: edit.content,
          rationale: String(edit.rationale ?? '').slice(0, 500),
        });
        if (candidates.length >= maxCandidates) break;
      }
      if (candidates.length >= maxCandidates) break;
    }
    log('harness-propose', `task=${task?.id ?? 'untitled'} candidates=${candidates.length} dropped=${dropped} screened=${screened}`, {
      candidates: candidates.length, dropped, screened,
    });
    return { ok: true, candidates };
  }

  /**
   * PROBE — run each candidate's trial harness against the task via the
   * injected runner; the runner's score is the behavioral contrast
   * signal. No ground truth is consulted — that is the method, and its
   * known limit: a winning probe is evidence, not proof.
   */
  async function probe({ task, harness, candidates } = {}) {
    if (!runner) return refused('probe: no runner configured — probes cannot run');
    if (!Array.isArray(candidates) || candidates.length === 0) return refused('probe: no candidates to probe');
    const probes = [];
    for (const cand of candidates) {
      const trial = applyEdit(harness, cand);
      let signal;
      try {
        signal = await runner(trial, task);
      } catch (err) {
        signal = { score: null, signal: `runner error: ${err.message}` };
      }
      probes.push({
        candidateId: cand.id,
        component: cand.component,
        score: typeof signal?.score === 'number' ? signal.score : null,
        signal: String(signal?.signal ?? '').slice(0, 500),
      });
    }
    log('harness-probe', `task=${task?.id ?? 'untitled'} probed=${probes.length}`, { probed: probes.length });
    return { ok: true, probes };
  }

  /**
   * COMPOSE — pick the winning edit from the contrasts. Highest score
   * wins; a null score ranks below any number; ties break by candidate
   * order (deterministic — same probes, same winner).
   */
  function compose({ candidates, probes } = {}) {
    if (!Array.isArray(probes) || probes.length === 0) return refused('compose: no probes to compose from');
    const byId = new Map((candidates ?? []).map((c) => [c.id, c]));
    let winner = null;
    for (const p of probes) {
      const cand = byId.get(p.candidateId);
      if (!cand) continue;
      const score = p.score ?? Number.NEGATIVE_INFINITY;
      if (!winner || score > winner.score) winner = { ...cand, score, signal: p.signal };
    }
    if (!winner) return refused('compose: no probed candidate could be resolved');
    log('harness-compose', `winner=${winner.id} component=${winner.component} score=${winner.score}`, {
      winner: winner.id, component: winner.component,
    });
    return { ok: true, winner, contrasts: probes };
  }

  /** One full PPC cycle — generates a winner. NEVER adopts. */
  async function runCycle({ task, harness, editors } = {}) {
    const proposed = await propose({ task, harness, editors });
    if (!proposed.ok) return proposed;
    if (proposed.candidates.length === 0) return refused('cycle: editors produced no usable candidates');
    const probed = await probe({ task, harness, candidates: proposed.candidates });
    if (!probed.ok) return probed;
    const composed = compose({ candidates: proposed.candidates, probes: probed.probes });
    if (!composed.ok) return composed;
    return { ok: true, winner: composed.winner, contrasts: composed.contrasts, adopted: false };
  }

  /**
   * ADOPT — the governed act. Requires a verified founder tap token.
   * On success: the winning edit is applied, a lesson is appended to
   * the improvement library (harnessing-level recursion: later tasks
   * inherit it), and the adoption is audit-logged with the lesson.
   * On refusal: nothing changes, nothing is written to the library,
   * and the refusal is audit-logged.
   */
  async function adopt({ task, harness, winner, tapToken } = {}) {
    if (!winner || !HARNESS_COMPONENTS.includes(winner.component)) {
      return refused('adopt: a composed winner is required');
    }
    const gateResult = await gate(tapToken);
    if (gateResult) {
      log('harness-adopt-refused', `task=${task?.id ?? 'untitled'} component=${winner.component} reason=${gateResult.reason}`, {
        component: winner.component,
      });
      return gateResult;
    }
    const next = applyEdit(harness, winner);
    const lesson = {
      at: new Date().toISOString(),
      task: task?.id ?? 'untitled',
      component: winner.component,
      rationale: winner.rationale ?? '',
      score: winner.score ?? null,
      authorizedBy: 'founder-tap',
    };
    if (libraryPath) {
      const lessons = readLibrary(libraryPath);
      lessons.push(lesson);
      writeLibrary(libraryPath, lessons);
    }
    log('harness-adopt', `task=${lesson.task} component=${winner.component} score=${lesson.score}`, { lesson });
    return { ok: true, harness: next, lesson };
  }

  /** The improvement library as it stands — what later tasks inherit. */
  function lessons() {
    return readLibrary(libraryPath);
  }

  return {
    propose,
    probe,
    compose,
    runCycle,
    adopt,
    lessons,
    verifyAudit: () => audit.verify(),
    auditPath: audit.path,
  };
}
