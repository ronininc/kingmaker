// Narrow, deterministic colloquial planning for original built-in skills.
// A plan is not approval. Unsupported language belongs to a governed planner,
// not guessed execution. No model load, network or third-party plugin needed.
export function planNativeAssetRequest({request,methods,filmQualityTarget='procedural-proof'}={}) {
 const text=String(request??'').trim().replace(/^(?:hey|yo)[,!]?[ ]+/i,'');
 if(!/^(?:(?:please|can you|could you|i want you to|i need you to)\s+)*(?:make|create|generate|build)\b/i.test(text))throw new Error('native-asset-language: explicit creation request required');
 if(/\b(?:then|and then)\b|\b(?:texture|material)\s+and\s+(?:a\s+)?vase\b/i.test(text))throw new Error('native-asset-language: multi-part request needs governed composition planner');
 if(/\b(?:cyberpunk|photorealis(?:m|tic)|AAA|cinematic|production[ -]quality|hyperreal(?:istic)?)\b/i.test(text))throw new Error('native-asset-language: requested production fidelity is not supported by procedural native skills');
 const style=/\bbrushed[ -]?metal\b/i.test(text)?'brushed-metal':/\b(?:checker|checkerboard)\b/i.test(text)?'checker':/\bstone\b/i.test(text)?'stone':null;
 const vase=/\bvase\b/i.test(text);
 const sizeMatch=text.match(/\b(\d+)\s*(?:px|pixels?)\b/i),seedMatch=text.match(/\bseed\s+(\d+)\b/i);
 const material={style,size:sizeMatch?Number(sizeMatch[1]):128,seed:seedMatch?Number(seedMatch[1]):1};
 const mesh={profile:[[0.35,0],[0.5,0.2],[0.4,0.8],[0.2,1],[0.22,1.2]],segments:32};
 let methodId,parameters;
 if(/\bsurface[ -]condition\b/i.test(text)){methodId='create-native-surface-condition';parameters={size:32};for(const key of ['wear','dirt','exposure']){const match=text.match(new RegExp('\\b'+key+'\\s+(0(?:\\.\\d+)?|1(?:\\.0+)?)\\b','i'));if(match)parameters[key]=Number(match[1]);}}
 else if(/\b(?:edit )?timeline\b/i.test(text)){const gap=text.match(/\b(\d+)[ -]frames?\s+gap\b/i),fps=text.match(/\b(\d+)\s*fps\b/i);if(!gap||/\b(?:clip|shot|video|render|movie)\b/i.test(text))throw new Error('native-asset-language: timeline clip edits require explicit source IDs and frame ranges; only a declared gap is supported by this language shortcut');methodId='create-native-edit-timeline';parameters={rateNumerator:fps?Number(fps[1]):24,rateDenominator:1,items:[{type:'gap',durationFrames:Number(gap[1])}]};}
 else if(/\bcamera[ -]orbit\b/i.test(text)){if(/\b(?:render|video|movie|animation)\b/i.test(text))throw new Error('native-asset-language: camera orbit outputs calibration JSON, not rendered animation');methodId='create-native-camera-orbit';const count=text.match(/\b(\d+)\s+(?:views|cameras|poses)\b/i);parameters={count:count?Number(count[1]):8};}
 else if(vase&&/\b(?:usd|usda)\b/i.test(text)){if(style)throw new Error('native-asset-language: USD texture synthesis is not implemented');methodId='create-native-usd-lathe';parameters={mesh};}
 else if(vase&&style){methodId='create-native-textured-lathe';parameters={mesh,material};}
 else if(vase){methodId='create-native-lathe-mesh';parameters=mesh;}
 else if(style&&/\b(?:texture|material|maps?)\b/i.test(text)){methodId='create-native-pbr-synthesis';parameters=material;}
 else throw new Error('native-asset-language: request is outside the built-in texture/vase vocabulary');
 if(!methods?.some(m=>m.id===methodId))throw new Error('native-asset-language: required native method is not admitted');
 return {steps:[{id:'create',methodId,inputs:{parameters}}],requestedQualityTarget:filmQualityTarget};
}
