import { spawnSync } from 'node:child_process';

import nodeCrypto from 'node:crypto';
import { connectArmor } from '../../lib/armor-connection.mjs';

/** False when this Node has ML-KEM (node:crypto decapsulate), which the PQ command gate and Armor need; otherwise a skip reason.
 *  (2026-11-17: this used to test the WebCrypto global `crypto`, which never has decapsulate, so every test using it was
 *  silently skipped on every machine. ML-KEM lives on node:crypto — which is what lib/armor-bundle.mjs uses.) */
export const ARMOR_KEM_SKIP = typeof nodeCrypto.decapsulate === 'function'
  ? false
  : 'skipped: this VM\'s Node.js has no crypto.decapsulate (ML-KEM), which post-quantum Armor identities need';

const plutil = spawnSync('plutil', ['-help'], { encoding: 'utf8' });
/** False on macOS, where plutil is on PATH; otherwise a skip reason. */
export const PLUTIL_SKIP = plutil.error?.code === 'ENOENT'
  ? 'skipped: this VM has no macOS plutil, which the installer entrypoint calls'
  : false;

/** False when this process is connected to an INSTALLED, authenticated, compatible Scripture Armor (lib/armor-connection.mjs);
 *  otherwise a visible skip reason with the precise refusal code. These tests exercise the real integration — the installed
 *  Armor's own code — so where no Armor is installed they are SKIPPED (reported as skips, never counted as passes).
 *  2026-11-17: replaces ARMOR_PQ_TODO; the classical-only vendored copy is gone. */
export const ARMOR_SKIP = (() => {
  try { const c = connectArmor(); return c.ok ? false : 'skipped: Armor connection not ok'; }
  catch (e) { return `skipped: no usable installed Scripture Armor (${e.code}): ${String(e.detail ?? e.message).slice(0, 160)}`; }
})();
