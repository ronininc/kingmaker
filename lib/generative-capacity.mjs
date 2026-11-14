// lib/generative-capacity.mjs — the weight hunt, widened from "which LLM weights" to "which
// generative capacity" (owner, 2026-11-11: weights are "pure 'generative' capacity"; a renderer
// like Blender "should be a tool call from its second brain").
//
// A capacity is anything on this machine that can produce the thing asked for:
//   weights  a Brain Library model (text, code, reasoning, vision) — chosen by lib/weight-hunter.mjs
//   image    the local image weights behind lib/image-lane.mjs
//   method   a Brain Library METHOD FILE whose procedure produces it, plus the tool that file names
//            (a render method + Blender). The capability lives in the file, not in this code.
//
// This module only PLANS and, for a method, hands the plan to the method conductor. It runs no
// tool itself. The conductor's vocabulary has no step that executes a program, so a render
// method writes the real scene script and job record and DECLARES the render run with the
// exact command — recorded as declared, never faked. Letting a method file actually start a
// tool is a new conductor step and stays the owner's decision.
//
// Off unless calibration.generativeCapacity.on === true, like the weight hunter.

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { huntWeights } from './weight-hunter.mjs';

const RENDER_3D = /\b(3d|three[- ]dimensional|blender|render(?:ed|ing)?|scene|model of|turntable|product shot|isometric|low[- ]poly)\b/i;
const VIDEO = /\b(video|animation|animate|clip|footage|motion graphic)\b/i;
// Plurals and the router's own picture words (lib/fast-route.mjs IMAGE), so a request the router sent to the image lane is a picture here too.
const PICTURE = /\b(images?|pictures?|photos?|posters?|flyers?|logos?|illustrations?|drawings?|draw|paintings?|wallpapers?|icons?|banners?|art|artwork|crests?)\b/i;

/** The method-file domains that can satisfy each need. A method declares its domain; nothing here names a file. */
// A still-render method cannot make a moving picture, so video is met only by a method that declares the video domain.
export const NEED_DOMAINS = Object.freeze({ 'render-3d': ['render'], video: ['video'], image: ['image', 'render'] });

/** The tool each method domain leans on, and where it is usually found. `env` names an override variable. */
export const DOMAIN_TOOLS = Object.freeze({
  render: { command: 'blender', env: 'SOLOMON_BLENDER_BIN', candidates: ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender', '/opt/homebrew/bin/blender'] },
});

export function generativeCapacityEnabled(calibration) {
  return Boolean(calibration && typeof calibration === 'object' && calibration.generativeCapacity?.on === true);
}

/** What kind of thing is being asked for: 'render-3d', 'video', 'image', or 'text' (everything else). */
export function classifyGenerativeNeed(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if (RENDER_3D.test(t)) return 'render-3d';
  if (VIDEO.test(t)) return 'video';
  if (PICTURE.test(t)) return 'image';
  return 'text';
}

function isExecutable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** Locate a tool: the override variable first, then PATH, then the usual places. It is never run. */
export function findTool(tool, { env = process.env, exists = existsSync, executable = isExecutable } = {}) {
  if (!tool) return null;
  const override = tool.env ? env[tool.env] : null;
  if (override && exists(override) && executable(override)) return { path: override, via: tool.env };
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, tool.command);
    if (exists(p) && executable(p)) return { path: p, via: 'PATH' };
  }
  for (const p of tool.candidates ?? []) if (exists(p) && executable(p)) return { path: p, via: 'known location' };
  return null;
}

/**
 * The plan for this request. Never throws for a missing capacity: it says what is missing.
 *   { need, kind: 'weights', weights }                      a library model was hunted
 *   { need, kind: 'image' }                                 the local image weights are ready
 *   { need, kind: 'method', method, tool, runs: 'declared' } a method file + its tool are here
 *   { need, kind: 'none', missing: [...] }                  nothing on this machine can make it
 * `methods` is the methods index (brain-library loadMethodsIndex); `imageReady` is image-lane's setup.ready.
 * `lane` is the router's lane for the request, when the caller has it.
 */
export function planCapacity({ text, lane = null, library = null, memoryClass = 8, installed = [], cached = [], methods = [], imageReady = false, imageMissing = [], find = findTool } = {}) {
  let need = classifyGenerativeNeed(text);
  if (!need) return null;
  // The router already decided this is a picture request; its words may be ones this module's patterns do not list.
  if (need === 'text' && lane === 'image') need = 'image';
  if (need === 'text') {
    const weights = library ? huntWeights({ text, library, memoryClass, installed, cached }) : null;
    return weights ? { need, kind: 'weights', weights } : { need, kind: 'none', missing: ['no eligible library model for this task'] };
  }
  if (need === 'image' && imageReady) return { need, kind: 'image' };
  const missing = [];
  if (need === 'image') missing.push(`local image weights (${imageMissing.length ? imageMissing.join(', ') : 'not set up'})`);
  const domains = NEED_DOMAINS[need] ?? [];
  // Best-rated method first; a method is usable only when its domain's tool is on this machine.
  const candidates = methods.filter((m) => domains.includes(m.domain)).sort((a, b) => (b.quality?.score ?? 0) - (a.quality?.score ?? 0));
  if (!candidates.length) missing.push(`a method file for ${domains.join(' or ')}`);
  for (const method of candidates) {
    const spec = DOMAIN_TOOLS[method.domain] ?? null;
    const tool = spec ? find(spec) : null;
    if (spec && !tool) { missing.push(`${spec.command} (the tool the "${method.id}" method uses)`); continue; }
    return {
      need, kind: 'method', method: { id: method.id, title: method.title, domain: method.domain }, tool: tool ? { command: spec.command, ...tool } : null,
      runs: 'declared',
      why: 'the method conductor writes the real scene script and job record and declares the render run; it has no step that starts a program',
    };
  }
  return { need, kind: 'none', missing };
}

/**
 * The request text as it may be placed in a generated file. The conductor substitutes inputs into
 * templates without escaping, and a render method puts the subject inside program source (a comment
 * and a string literal). So only letters, digits, spaces and plain punctuation are kept: no quotes,
 * backslashes, hash signs, braces or line breaks, none of which a subject line needs.
 */
export function safeSubject(text) {
  return String(text ?? '').replace(/[^\p{L}\p{N} .,:;!?()&+\/-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled';
}

/**
 * Conduct a 'method' plan: the conductor runs the method file's steps in `workDir` and returns
 * its trace. `subject` is passed to the method as its `subject` input, and the located tool's
 * path as `toolPath`, so the declared command in the trace is the exact one for this machine.
 */
export async function conductCapacity(plan, { conductor, workDir, subject, inputs = {}, now = undefined } = {}) {
  if (!plan || plan.kind !== 'method') throw new Error('generative-capacity: only a method plan is conducted here');
  if (!conductor || !workDir) throw new Error('generative-capacity: a conductor and a workDir are required');
  const result = await conductor.conduct(plan.method.id, { workDir, now, inputs: { ...inputs, ...(subject ? { subject: safeSubject(subject) } : {}), ...(plan.tool?.path ? { toolPath: plan.tool.path } : {}) } });
  return {
    status: result.status,
    method: result.method,
    // The conductor's own list of declared steps: `action` is the exact command, with no prose around it.
    declared: (result.declared ?? []).map((d) => ({ id: d.step ?? null, action: d.action ?? null, reason: d.reason ?? null })),
    result,
  };
}

/** One plain sentence for the bar about a plan that cannot be met. */
export function missingLine(plan) {
  if (!plan || plan.kind !== 'none') return null;
  return `I can't make that on this Mac yet. Missing: ${plan.missing.join('; ')}.`;
}
