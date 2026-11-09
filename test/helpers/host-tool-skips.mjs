import { spawnSync } from 'node:child_process';

/** False when this Node can unseal the shipped Armor bundle; otherwise a skip reason. */
export const ARMOR_KEM_SKIP = typeof crypto.decapsulate === 'function'
  ? false
  : 'skipped: this VM\'s Node.js has no crypto.decapsulate, which the shipped Armor bundle needs to unseal';

const plutil = spawnSync('plutil', ['-help'], { encoding: 'utf8' });
/** False on macOS, where plutil is on PATH; otherwise a skip reason. */
export const PLUTIL_SKIP = plutil.error?.code === 'ENOENT'
  ? 'skipped: this VM has no macOS plutil, which the installer entrypoint calls'
  : false;
