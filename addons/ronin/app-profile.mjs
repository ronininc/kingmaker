// The macOS login item starts Kingmaker.app without a shell, so profile environment
// variables are not available after login. Keep one owner-controlled pointer to the
// profile the app should launch. The pointer contains paths and a port, never secrets.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const ACTIVE_PROFILE_SCHEMA = 1;

export function activeAppProfilePath(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Kingmaker', 'active-profile.json');
}

function allowedProfilePath(value, home) {
  const support = resolve(home, 'Library', 'Application Support');
  const path = resolve(String(value || ''));
  return path.startsWith(`${support}${sep}`) ? path : null;
}

export function readActiveAppProfile(home = homedir()) {
  try {
    const value = JSON.parse(readFileSync(activeAppProfilePath(home), 'utf8'));
    const state = allowedProfilePath(value?.state, home);
    const runtimeHome = allowedProfilePath(value?.runtime_home, home);
    const port = Number(value?.port);
    if (value?.schema !== ACTIVE_PROFILE_SCHEMA || value?.profile !== 'ronininc' || !state || !runtimeHome || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return { schema: ACTIVE_PROFILE_SCHEMA, profile: 'ronininc', state, runtimeHome, port };
  } catch { return null; }
}

export function setActiveRoninAppProfile(paths, { home = homedir(), port = Number(process.env.SOL_GHOST_PORT) || 3001 } = {}) {
  const state = allowedProfilePath(paths?.state, home);
  const runtimeHome = allowedProfilePath(paths?.runtimeHome, home);
  const selectedPort = Number(port);
  if (!state || !runtimeHome) throw new Error('The installed Kingmaker profile must stay inside ~/Library/Application Support.');
  if (!Number.isInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) throw new Error('The installed Kingmaker profile needs a valid local port.');
  const path = activeAppProfilePath(home);
  const directory = join(home, 'Library', 'Application Support', 'Kingmaker');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schema: ACTIVE_PROFILE_SCHEMA, profile: 'ronininc', state, runtime_home: runtimeHome, port: selectedPort }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return readActiveAppProfile(home);
}

/** One Kingmaker to the owner: a terminal command uses the same profile the menu bar app launches (the pointer above),
 *  exactly as app/Kingmaker.swift sets it, unless SOL_GHOST_HOME names one. Without this, `kingmaker start` in a
 *  terminal ran the old default profile (~/Library/Application Support/sol-ghost) while the app ran kingmaker-ronin,
 *  so a key typed at that console went into a vault the app never reads. Returns the profile applied, or null. */
export function applyActiveAppProfile(env = process.env, home = homedir()) {
  if (String(env.SOL_GHOST_HOME || '').trim()) return null;
  const profile = readActiveAppProfile(home);
  if (!profile) return null;
  env.SOL_GHOST_HOME = profile.state;
  if (!String(env.SOL_GHOST_RUNTIME_HOME || '').trim()) env.SOL_GHOST_RUNTIME_HOME = profile.runtimeHome;
  if (!String(env.SOL_GHOST_PORT || '').trim()) env.SOL_GHOST_PORT = String(profile.port);
  return profile;
}
