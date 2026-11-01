// One governed interaction owns speech at a time. The menu-bar app reports the foreground OpenAI surface
// (ChatGPT or Codex) to the CLI; Kingmaker then closes its microphone, suppresses proactive narration and
// records a private, bounded event for its own brain instead of speaking into the other session.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const INTERACTION_EVENT_MAX = 100;

export function normalizeInteractionOwner(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (name === 'chatgpt') return 'chatgpt';
  if (name === 'codex') return 'codex';
  return null;
}

export function frontmostInteractionOwner({ exec = execFileSync } = {}) {
  try {
    const name = exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: 'utf8', timeout: 1_500 });
    return normalizeInteractionOwner(name);
  } catch { return null; }
}

export function interactionEventsPath(paths) { return join(paths.state, 'interaction-events.jsonl'); }

export function createInteractionArbiter({ paths, initialOwner, detect = frontmostInteractionOwner, log = () => {}, now = () => new Date().toISOString() }) {
  let owner = initialOwner === undefined ? detect() : normalizeInteractionOwner(initialOwner);
  const file = interactionEventsPath(paths);

  function setOwner(value, { source = 'app' } = {}) {
    const next = normalizeInteractionOwner(value);
    if (next === owner) return owner;
    const previous = owner;
    owner = next;
    log('interaction_owner', { owner, previous, source });
    return owner;
  }

  function route(type, text, detail = {}) {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    let prior = [];
    try { prior = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-(INTERACTION_EVENT_MAX - 1)); } catch { /* first event */ }
    const event = {
      at: now(), type: String(type || 'suppressed').slice(0, 80), owner,
      text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_000),
      ...detail,
    };
    writeFileSync(file, `${[...prior, JSON.stringify(event)].join('\n')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    log('interaction_routed', { type: event.type, owner, chars: event.text.length });
    return event;
  }

  return {
    setOwner,
    gate: (kind = 'interaction') => ({ allowed: !owner, owner, kind }),
    route,
    get owner() { return owner; },
    file,
  };
}
