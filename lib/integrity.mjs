// lib/integrity.mjs — is this the official Kingmaker? (the owner, 2026-10-15: "make sure the only alterations that can be
// made to kingmaker are features they add … i dont want them fucking with the source code").
//
// People extend Kingmaker through skills (the data folder's skills/) and catalog extensions, never by editing the app.
// The app's code signature already seals every file in Kingmaker.app (Contents/Resources/sol-ghost included); an
// official build is signed with Ronin's own certificate (a local signing certificate, its private key only on the owner's Mac). So
// at each launch, in the background (~6 s), the engine checks the bundle against that seal AND that signer:
//   official  the seal holds and Ronin signed it
//   modified  a file was changed, added or removed, or someone else re-signed it
//   dev       not running from an app bundle (the owner's own source checkout)
// A modified copy keeps working on its own Mac, but it is cut off from the collective: no sharing of what it learns,
// no Brain Library submissions, no updates (an update would only replace it); and it says so, plainly, once.
// Limits, honestly: a person who controls their own Mac can always change what runs on it; this keeps a changed copy
// out of the collective and the library, which is what matters to Ronin.
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPin } from './release-identity.mjs';

export const BUNDLE_ID = 'com.ronininc.solghost';
/** Ronin's signers (SHA-1 of the leaf): the pinned Kingmaker Release certificate every release is signed with
 *  (lib/release-identity.json, the same pin the build signs with), and the owner's own local signing certificate. A Developer ID
 *  team joins here when there is one. */
export const signersFor = (pin = readPin()) => Object.freeze([...new Set([pin?.sha1, '4B14A5E4B8B51526A3668C5A97AE82BE8BA0F6D7'].filter(Boolean))]);
export const RONIN_SIGNERS = signersFor();
export const requirement = (signers = RONIN_SIGNERS) => `identifier "${BUNDLE_ID}" and (${signers.map((h) => `certificate leaf = H"${h.toLowerCase()}"`).join(' or ')})`;

/** The Kingmaker.app this module runs from, or null (a source checkout). Pure. */
export function appBundleOf(file = fileURLToPath(import.meta.url)) {
  const m = /^(.*?\/[^/]+\.app)\/Contents\/Resources\//.exec(resolve(file));
  return m ? m[1] : null;
}

/** Check the bundle. → { state: 'official' | 'modified' | 'dev', reason, at } */
export function checkIntegrity({ app = appBundleOf(), run = execFile, signers = RONIN_SIGNERS, now = () => new Date().toISOString() } = {}) {
  if (!app) return Promise.resolve({ state: 'dev', reason: 'running from source', at: now() });
  return new Promise((done) => {
    run('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement(signers)}`, app], { timeout: 120_000 }, (err, _out, stderr) => {
      if (!err) return done({ state: 'official', reason: 'sealed and signed by Ronin', at: now() });
      const why = String(stderr || err.message || '');
      const reason = /does not satisfy its designated Requirement|test-requirement/i.test(why) ? 'signed by someone other than Ronin'
        : /modified|added|deleted|missing|invalid/i.test(why) ? 'files changed since Ronin signed it' : 'the signature check failed';
      done({ state: 'modified', reason, detail: why.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300), at: now() });
    });
  });
}

/**
 * The engine's view, checked once at launch. official() is optimistic until the check finishes (nothing leaves before
 * the first daily share anyway); modified() is true only once the check has said so.
 */
export function createIntegrity({ state, check = checkIntegrity, log = () => {}, onModified = () => {} } = {}) {
  let result = null, pending = null;
  const record = (r) => { try { mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'integrity.json'), JSON.stringify(r, null, 1), { mode: 0o600 }); } catch { /* the check still holds */ } };
  return {
    start() { pending ??= check().then((r) => { result = r; record(r); log('integrity', { state: r.state, reason: r.reason }); if (r.state === 'modified') onModified(r); return r; }); return pending; },
    result: () => result,
    /** May this copy reach the collective (share, submit, update)? */
    official: () => !result || result.state !== 'modified',
    modified: () => result?.state === 'modified',
    ready: () => pending ?? Promise.resolve(result),
  };
}

/** What the bar says, once, about a modified copy. */
export const MODIFIED_NOTE = (reason) => `This copy of Kingmaker isn't the official build (${reason}), so it's cut off from the collective: nothing it learns is shared, it can't submit to the Brain Library, and it won't update. It keeps working here. To restore it, install Kingmaker again from Kingmaker Installer. To extend Kingmaker, add skills or extensions instead of changing its files.`;

