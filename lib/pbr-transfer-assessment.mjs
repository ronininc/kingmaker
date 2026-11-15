// Synthetic held-out metadata tasks; not training data or a render quality benchmark.
export const PBR_TRANSFER_CASES=Object.freeze([
 {id:'renamed-directx',assets:[{id:'a17',role:'baseColor'},{id:'b92',role:'normal',convention:'DirectX'},{id:'c04',role:'roughness'}],expected:{status:'ready',maps:{baseColor:'a17',normal:'b92',roughness:'c04'},normalConvention:'DirectX',normalGreenFlip:true}},
 {id:'renamed-opengl-metal',assets:[{id:'k40',role:'metallic'},{id:'r39',role:'roughness'},{id:'n18',role:'normal',convention:'OpenGL'},{id:'c77',role:'baseColor'}],expected:{status:'ready',maps:{baseColor:'c77',normal:'n18',roughness:'r39',metallic:'k40'},normalConvention:'OpenGL',normalGreenFlip:false}},
 {id:'unsupported-gloss',assets:[{id:'albedo42',role:'baseColor'},{id:'gloss93',role:'glossiness'}],expected:{status:'unsupported'}}
]);
export const PBR_TECHNIQUE_GUIDE='Use declared semantic roles, never guess by filename. BaseColor uses sRGB; normal, roughness and metallic use Non-Color. OpenGL normal uses positive green Y; DirectX normal requires green inversion and normalConvention DirectX. Preserve exact source IDs. Current importer supports baseColor, normal, roughness, metallic, displacement-as-bump only. Glossiness inversion and packed-channel extraction are not implemented: return status unsupported instead of relabeling gloss as roughness. No code generation or unknown asset IDs.';
export function scorePBRTransfer(task,answer){
 const issues=[];if(answer?.status!==task.expected.status)issues.push('status');
 if(task.expected.status==='ready'){
  if(JSON.stringify(Object.entries(answer?.maps??{}).sort())!==JSON.stringify(Object.entries(task.expected.maps).sort()))issues.push('maps');
  if(answer?.normalConvention!==task.expected.normalConvention)issues.push('normal-convention');
  if(answer?.normalGreenFlip!==task.expected.normalGreenFlip)issues.push('normal-green');
  for(const key of Object.keys(task.expected.maps))if(answer?.colorSpaces?.[key]!== (key==='baseColor'?'sRGB':'Non-Color'))issues.push(`color-space:${key}`);
 }
 return {id:task.id,pass:issues.length===0,issues};
}
