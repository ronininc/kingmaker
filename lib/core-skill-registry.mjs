// Inventory is discovery, not authority. This module never executes or admits skills.
import { readdirSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
const hash = b => createHash('sha256').update(b).digest('hex');
function file(root, path) {
  const p = resolve(root, path), rel = relative(root, p);
  if (!rel || rel.startsWith('..'+sep) || rel === '..') throw Error('Outside registry root');
  if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isFile()) throw Error('Expected regular file');
  const real = relative(root, realpathSync(p));
  if (real.startsWith('..'+sep) || real === '..') throw Error('Symlink escape');
  const b = readFileSync(p);
  if (b.length > 4 * 1024 * 1024) throw Error('Registry file exceeds bound');
  return { path: rel.split(sep).join('/'), sha256: hash(b), bytes: b.length };
}
export function buildCoreSkillRegistry(root) {
  root = realpathSync(root);
  const entries = [];
  const core = resolve(root, 'core/skills');
  if (existsSync(core)) for (const d of readdirSync(core, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (!d.isDirectory()) continue;
    const base = `core/skills/${d.name}`;
    if (!existsSync(resolve(root, base, 'SKILL.md'))) continue;
    const provenance = ['SOURCE.md','VENDORED.md','LICENSE','LICENSE.md','LICENSE.txt'].filter(n=>existsSync(resolve(root,base,n))).map(n=>file(root,`${base}/${n}`));
    entries.push({ id:`prose:${d.name}`, kind:'prose-core', descriptor:file(root,`${base}/SKILL.md`), provenance, status:'existing-core-rea-gated', nativeExecution:false, admission:'unchanged', rights:'see-preserved-provenance-not-recertified' });
  }
  function nested(dir, depth=0) {
    if(depth > 12) throw Error('Nested skill depth exceeds bound');
    for(const d of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const p = resolve(dir,d.name);
      if(d.isDirectory()) nested(p,depth+1);
      else if(d.name === 'SKILL.md' && depth > 1) {
        const descriptor = file(root,relative(root,p));
        entries.push({id:`nested:${descriptor.path}`,kind:'nested-prose',descriptor,nativeExecution:false,admission:'not-registered-individually',status:'bundled-reference-only'});
      }
    }
  }
  if(existsSync(core)) nested(core);
  for (const [lane, kind] of [['native-creation-skills','native-candidate'],['native-asset-methods','reference-only']]) {
    const indexPath = `catalog/${lane}/index.json`;
    const index = JSON.parse(readFileSync(resolve(root,indexPath),'utf8'));
    const sourceIndex = file(root,indexPath);
    for (const m of index.methods || []) entries.push({id:`${kind}:${m.id}`,kind,descriptor:file(root,`catalog/${lane}/${m.file}`),sourceIndex, requiredBuiltin:kind==='native-candidate'?m.requiredBuiltin:null, nativeExecution:kind==='native-candidate'&&m.nativeExecution===true, admission:'not-granted-by-registry',status:kind==='native-candidate'?'implementation-present-requires-existing-admission':'reference-not-executable', quality:m.quality||null});
  }
  const ids = entries.map(e=>e.id);
  if(new Set(ids).size !== ids.length) throw Error('Duplicate skill ID');
  const implementationFiles = ['lib/native-asset-skills.mjs','lib/native-camera-skill.mjs','lib/native-timeline-skill.mjs','lib/native-surface-condition.mjs','lib/core-pack.mjs','lib/rea.mjs'].filter(p=>existsSync(resolve(root,p))).map(p=>file(root,p));
  return {schema:'kingmaker.core-skill-registry/1',scope:'this-checkout-only',authority:'inventory-only-no-admission-no-license-grant',entries,implementationFiles,counts:Object.fromEntries(['prose-core','nested-prose','native-candidate','reference-only'].map(k=>[k,entries.filter(e=>e.kind===k).length]))};
}
export function verifyCoreSkillRegistry(root, manifest) {
  const current = buildCoreSkillRegistry(root);
  return {ok:JSON.stringify(current) === JSON.stringify(manifest), counts:current.counts};
}
