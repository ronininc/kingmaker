// REA access for the shield layer, in the product's own pattern (the
// same one review-worker.mjs uses): REA is a repo-level component staged
// beside the product in the standalone bundle (rea/rea.mjs) and a sibling
// lib/ in the source tree — it is located on disk and imported by URL,
// never statically imported across directories. A missing REA component
// is a hard failure: the shield layer does not run without the shipped
// rule engine it extends.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const reaFile = [path.join(HERE, 'rea', 'rea.mjs'), path.join(HERE, '..', 'lib', 'rea.mjs')]
  .find((p) => fs.existsSync(p));
if (!reaFile) throw Error('shield layer: REA component (rea.mjs) not found beside the product or in the sibling lib/');
const rea = await import(pathToFileURL(reaFile).href);

export const RULES = rea.RULES;
export const scanText = rea.scanText;
export const verdictFor = rea.verdictFor;
export const sandboxProfile = rea.sandboxProfile;
