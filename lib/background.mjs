// The supported macOS background path: register Kingmaker.app itself as a Login Item through SMAppService.
// This is explicit and reversible (`kingmaker background enable|disable`) and does not install a privileged helper.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownBundle } from './paths.mjs';

export const BACKGROUND_ACTIONS = Object.freeze(['status', 'enable', 'disable']);

export function findKingmakerExecutable({ env = process.env, home = env.HOME || homedir(), exists = existsSync, modulePath = fileURLToPath(import.meta.url) } = {}) {
  const bundle = ownBundle(modulePath);
  const explicit = String(env.KINGMAKER_APP || '').trim();
  const apps = [bundle, explicit && resolve(explicit), join(home, 'Applications', 'Kingmaker.app'), '/Applications/Kingmaker.app'].filter(Boolean);
  for (const app of apps) {
    const binary = join(app, 'Contents', 'MacOS', 'Kingmaker');
    if (exists(binary)) return { app, binary };
  }
  return null;
}

export function runBackgroundCommand(action = 'status', { run = execFile, ...findOptions } = {}) {
  const command = BACKGROUND_ACTIONS.includes(action) ? action : null;
  if (!command) return Promise.resolve({ ok: false, status: 'invalid', message: `Use: kingmaker background ${BACKGROUND_ACTIONS.join(' | ')}` });
  const installed = findKingmakerExecutable(findOptions);
  if (!installed) return Promise.resolve({ ok: false, status: 'not-installed', message: 'Install Kingmaker.app first; a source checkout cannot register itself as a Login Item.' });
  // Launch the bundle, not its inner Mach-O: SMAppService resolves the calling application from bundle context.
  // `open` does not relay stdout, so the short-lived command instance returns one JSON result through a private temp file.
  const resultDir = mkdtempSync(join(tmpdir(), 'kingmaker-background-'));
  const resultFile = join(resultDir, 'result.json');
  return new Promise((resolveResult) => {
    run('/usr/bin/open', ['-W', '-n', installed.app, '--args', `--background-${command}`, '--background-result-file', resultFile], { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      let payload = {};
      try { payload = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* app did not return a result */ }
      rmSync(resultDir, { recursive: true, force: true });
      const status = String(payload.status || 'unknown');
      const message = String(payload.message || (error ? stderr || error.message : '')).trim();
      if (!error && !message && command === 'enable' && status === 'enabled') {
        // Registration covers future sign-ins; launch the host now as well.
        run('/usr/bin/open', [installed.app], { timeout: 15_000, maxBuffer: 64 * 1024 }, () => {});
      }
      resolveResult({ ok: !error && !message && ['enabled', 'not-registered', 'not-found', 'requires-approval'].includes(status), status, app: installed.app, message });
    });
  });
}

export function describeBackground(result) {
  if (!result.ok) return `Background: unavailable — ${result.message || result.status}.`;
  if (result.status === 'enabled') return 'Headless Host Mode: enabled. Keep the Mac plugged in with its lid open; the built-in display may sleep while Kingmaker keeps the system awake. Disable it with: kingmaker background disable';
  if (result.status === 'requires-approval') return 'Headless Host Mode: waiting for approval in System Settings → General → Login Items. After approval, keep the Mac plugged in with its lid open; display sleep remains allowed.';
  return 'Headless Host Mode: disabled. Enable it with: kingmaker background enable';
}
