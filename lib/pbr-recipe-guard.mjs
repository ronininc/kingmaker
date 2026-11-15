import {preparePBRMaterialJob} from './pbr-material-job.mjs';
const fail=s=>{throw Error(`pbr-recipe: ${s}`);};
// Source semantic labels must be separately reviewed; this guard binds them to bytes,
// not guesses from filenames or the model's confidence.
export function validatePBRRecipe({manifest,semantics,recipe}={}){
 if(recipe?.status!=='ready'||!Array.isArray(semantics)||!semantics.length||semantics.length>32)fail('ready recipe and reviewed semantic metadata required');
 const files=new Map((manifest?.assets??[]).map(a=>[a.id,a]));const byRole=new Map();
 for(const s of semantics){if(!s||!files.has(s.id)||files.get(s.id).sha256!==s.sha256)fail('semantic metadata digest mismatch');if(!['baseColor','normal','roughness','metallic','displacement'].includes(s.role))fail('unsupported channel semantics');if(byRole.has(s.role))fail('ambiguous duplicate role');byRole.set(s.role,s);}
 if(!byRole.has('baseColor'))fail('base color missing');
 const expected=Object.fromEntries([...byRole].map(([k,v])=>[k,v.id]));
 if(JSON.stringify(Object.entries(recipe.maps??{}).sort())!==JSON.stringify(Object.entries(expected).sort()))fail('model map assignment mismatches reviewed semantics');
 for(const role of byRole.keys())if(recipe.colorSpaces?.[role]!== (role==='baseColor'?'sRGB':'Non-Color'))fail('wrong channel color space');
 const normal=byRole.get('normal');const convention=normal?.convention??'OpenGL';
 if(normal&&!['OpenGL','DirectX'].includes(normal.convention))fail('normal convention unknown');
 if(recipe.normalConvention!==convention||recipe.normalGreenFlip!==(convention==='DirectX'))fail('wrong normal convention or green inversion');
 return {maps:expected,normalConvention:convention};
}
export async function prepareLearnedPBRMaterialJob({manifest,assetRoot,semantics,recipe}={}){
 const checked=validatePBRRecipe({manifest,semantics,recipe});
 return preparePBRMaterialJob({manifest,assetRoot,...checked});
}
