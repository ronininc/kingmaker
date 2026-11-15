// Original bounded surface-condition field; no learned weights or third-party assets.
import {deflateSync} from 'node:zlib';
const scalar=(v,a,b)=>{if(!Number.isFinite(v)||v<a||v>b)throw Error('surface parameter outside bounds');return v;};
const clamp=v=>Math.max(0,Math.min(1,v));
export function validateSurfaceCondition(p={}){
 const size=scalar(p.size??128,16,512),seed=scalar(p.seed??1,0,4294967295);
 if(!Number.isInteger(size)||!Number.isInteger(seed))throw Error('size/seed integer required');
 const baseColor=p.baseColor??[.28,.16,.07];if(!Array.isArray(baseColor)||baseColor.length!==3)throw Error('RGB required');baseColor.forEach(v=>scalar(v,0,1));
 const keys=['size','seed','baseColor','widthMeters','heightMeters','edgeWidthMeters','contactHeightMeters','wear','dirt','exposure','heightLimitMeters'];
 if(Object.keys(p).some(k=>!keys.includes(k)))throw Error('unknown surface control');
 return {size,seed,baseColor,widthMeters:scalar(p.widthMeters??.3,.02,5),heightMeters:scalar(p.heightMeters??1,.02,5),edgeWidthMeters:scalar(p.edgeWidthMeters??.02,.001,.1),contactHeightMeters:scalar(p.contactHeightMeters??.15,.001,.5),wear:scalar(p.wear??.5,0,1),dirt:scalar(p.dirt??.4,0,1),exposure:scalar(p.exposure??.3,0,1),heightLimitMeters:scalar(p.heightLimitMeters??.001,0,.003)};
}
function noise(x,y,seed){const n=Math.sin(x*127.1+y*311.7+seed*.123)*43758.5453;return n-Math.floor(n);}
export function surfaceConditionAt(p,u,v){
 scalar(u,0,1);scalar(v,0,1);
 const edgeDistance=Math.min(u*p.widthMeters,(1-u)*p.widthMeters,v*p.heightMeters,(1-v)*p.heightMeters);
 const edge=clamp(1-edgeDistance/p.edgeWidthMeters),contact=clamp(1-v*p.heightMeters/p.contactHeightMeters);
 const micro=noise(Math.floor(u*71),Math.floor(v*97),p.seed),macro=noise(Math.floor(u*9),Math.floor(v*13),p.seed);
 const wear=p.wear*edge*(.25+.75*micro),dirt=p.dirt*contact*(.45+.55*macro),exposure=p.exposure*v*(.25+.75*macro);
 const color=p.baseColor.map(c=>clamp(c*(1-.65*dirt-.2*exposure)+.12*wear));
 return {wear,dirt,exposure,color,roughness:clamp(.42+.32*dirt+.16*exposure-.2*wear),heightMeters:-p.heightLimitMeters*wear,edgeDistance};
}
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,b){const t=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(b.length);tail.writeUInt32BE(crc32(Buffer.concat([t,b])));return Buffer.concat([head,t,b,tail]);}
function png(n,pixels){const header=Buffer.alloc(13);header.writeUInt32BE(n);header.writeUInt32BE(n,4);header[8]=8;header[9]=2;const rows=Buffer.alloc(n*(n*3+1));for(let y=0;y<n;y++)pixels.copy(rows,y*(n*3+1)+1,y*n*3,(y+1)*n*3);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
export function synthesizeSurfaceCondition(raw={}){
 const p=validateSurfaceCondition(raw),maps=Object.fromEntries(['base-color','roughness','height','wear-mask'].map(k=>[k,Buffer.alloc(p.size*p.size*3)]));
 let damaged=0,darkened=0;
 for(let y=0;y<p.size;y++)for(let x=0;x<p.size;x++){
  const a=surfaceConditionAt(p,x/(p.size-1),1-y/(p.size-1));if(a.wear>.1)damaged++;if(a.dirt>.1)darkened++;
  const colors={'base-color':a.color,roughness:Array(3).fill(a.roughness),height:Array(3).fill(1-a.wear),'wear-mask':Array(3).fill(a.wear)};
  for(const [k,rgb] of Object.entries(colors))rgb.forEach((v,c)=>maps[k][(y*p.size+x)*3+c]=Math.round(clamp(v)*255));
 }
 return {parameters:p,files:Object.fromEntries(Object.entries(maps).map(([k,v])=>[k+'.png',png(p.size,v)])),metrics:{edgeWearFraction:damaged/(p.size*p.size),contactDirtFraction:darkened/(p.size*p.size)},heightDecode:{zeroValue:1,scaleMeters:p.heightLimitMeters,formula:'(sample - 1) * scaleMeters'},limitations:['Original rectangular UV-patch heuristic, not physically simulated weathering or learned photorealism.','Color is generated from supplied base color, not inferred from external photographs.','Limited geometry wear requires consuming height on subdivided mesh; maps alone do not modify geometry.']};
}
