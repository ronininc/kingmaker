import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(fs.readFileSync(new URL('./product.json', import.meta.url), 'utf8'));
if (config.schema !== 'scripture-armor.product/1' || !['standalone', 'kingmaker'].includes(config.product)) throw new Error('Invalid Armor product identity policy');
export const ARMOR_PRODUCT = config.product;
export function productPaths(home = os.homedir()) {
  if (!path.isAbsolute(home)) throw new Error('Owner home must be absolute');
  const bundled = ARMOR_PRODUCT === 'kingmaker';
  return { product: ARMOR_PRODUCT, identityDir: path.join(home, ...(bundled ? ['.kingmaker', 'scripture-armor'] : ['.scripture-armor'])), serviceLabel: bundled ? 'org.ronininc.kingmaker.scripture-vaultd' : 'org.ronininc.scripture-vaultd', serviceName: bundled ? 'kingmaker-scripture-vaultd' : 'scripture-vaultd' };
}
// Resolve existing directory aliases without opening any identity/key file.
export function canonicalPath(input) {
  let cursor = path.resolve(input), tail = [];
  while (!fs.existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) break; tail.unshift(path.basename(cursor)); cursor = parent; }
  return path.resolve(fs.realpathSync(cursor), ...tail);
}
export function assertProductIdentityDir(input, home = os.homedir()) {
  const result = canonicalPath(input);
  const other = canonicalPath(path.join(home, ...(ARMOR_PRODUCT === 'kingmaker' ? ['.scripture-armor'] : ['.kingmaker', 'scripture-armor'])));
  if (result === other || result.startsWith(other + path.sep)) throw new Error(`${ARMOR_PRODUCT} Armor refuses the other product's identity store`);
  return result;
}
if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const paths = productPaths(option('--home') || os.homedir()), field = option('--field');
  if (option('--check')) { console.log(assertProductIdentityDir(option('--check'), option('--home') || os.homedir())); }
  else if (field && ['identityDir', 'serviceLabel', 'serviceName', 'product'].includes(field)) console.log(paths[field]);
  else console.log(JSON.stringify(paths));
}
