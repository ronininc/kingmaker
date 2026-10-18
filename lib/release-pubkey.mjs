// The pinned Kingmaker release-signing PUBLIC key, read from the one committed PEM file (lib/kingmaker-release-public.pem).
// The matching PRIVATE key is OFFLINE and never in this repo. Generated with `node scripts/kingmaker-release-sign.mjs keygen`.
// installer/engine.sh ships and pins this same PEM (build-installer.sh copies it into the installer). Rotating the key is
// deliberate: replace the PEM file, re-sign the next release, ship an installer carrying the new PEM, publish the new
// fingerprint (node scripts/kingmaker-release-sign.mjs fingerprint).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PEM_FILE = join(dirname(fileURLToPath(import.meta.url)), 'kingmaker-release-public.pem');
let pem = '';
try { pem = readFileSync(PEM_FILE, 'utf8'); } catch { pem = ''; }
/** The pinned release public key (PEM), or '' if none has been generated yet. */
export const RELEASE_PUBLIC_KEY_PEM = pem;
export const RELEASE_PUBLIC_KEY_FILE = PEM_FILE;
