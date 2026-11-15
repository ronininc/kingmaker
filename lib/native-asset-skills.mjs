import {synthesizeSurfaceCondition} from './native-surface-condition.mjs';
import {synthesizeEditTimeline} from './native-timeline-skill.mjs';
// Original procedural algorithms. No provider code, asset, plugin or network dependency.
import {synthesizeCameraOrbit} from './native-camera-skill.mjs';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {realpath,statfs,mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const fail=s=>{throw new Error(`native-asset-skills: ${s}`);};
const integer=(v,a,b)=>Number.isInteger(v)&&v>=a&&v<=b?v:fail('integer outside bounds');
const finite=(v,a,b)=>Number.isFinite(v)&&v>=a&&v<=b?v:fail('number outside bounds');
const hash=b=>createHash('sha256').update(b).digest('hex');
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,crc]);}
function png(w,h,pixels){const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;const rows=Buffer.alloc(h*(w*3+1));for(let y=0;y<h;y++)pixels.copy(rows,y*(w*3+1)+1,y*w*3,(y+1)*w*3);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
function noise(x,y,seed){let n=Math.imul(x+1,374761393)^Math.imul(y+1,668265263)^seed;n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
export function synthesizePBR(raw){
 const style=raw?.style;if(!['stone','brushed-metal','checker'].includes(style))fail('unsupported texture style');
 const size=integer(raw.size??128,16,512),seed=integer(raw.seed??1,0,0xffffffff),tiles=integer(raw.tiles??8,1,32);
 const colors=raw.colors??[[0.12,0.14,0.16],[0.55,0.6,0.65]];
 if(!Array.isArray(colors)||colors.length!==2||colors.some(c=>!Array.isArray(c)||c.length!==3))fail('two RGB colors required');colors.forEach(c=>c.forEach(v=>finite(v,0,1)));
 const height=new Float32Array(size*size),base=Buffer.alloc(size*size*3),rough=Buffer.alloc(base.length),metal=Buffer.alloc(base.length),normal=Buffer.alloc(base.length);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const n=noise(x,y,seed),v=style==='checker'?((Math.floor(x*tiles/size)+Math.floor(y*tiles/size))%2):style==='brushed-metal'?0.3+0.6*noise(0,y,seed)+0.1*n:n;
  height[y*size+x]=v;const k=(y*size+x)*3;
  for(let c=0;c<3;c++){base[k+c]=Math.round(255*(colors[0][c]*(1-v)+colors[1][c]*v));rough[k+c]=Math.round(255*(style==='brushed-metal'?0.22+0.18*n:0.6+0.25*n));metal[k+c]=style==='brushed-metal'?255:0;}
 }
 const at=(x,y)=>height[((y+size)%size)*size+(x+size)%size];
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){let nx=-(at(x+1,y)-at(x-1,y))*0.2,ny=-(at(x,y+1)-at(x,y-1))*0.2,nz=1;const d=Math.hypot(nx,ny,nz),k=(y*size+x)*3;[nx,ny,nz].forEach((v,c)=>normal[k+c]=Math.round((v/d*0.5+0.5)*255));}
 const packed=Buffer.alloc(base.length);for(let i=0;i<packed.length;i+=3){packed[i]=255;packed[i+1]=rough[i];packed[i+2]=metal[i];}
 return {parameters:{style,size,seed,tiles,colors},files:{'base-color.png':png(size,size,base),'roughness.png':png(size,size,rough),'metallic.png':png(size,size,metal),'normal.png':png(size,size,normal),'metallic-roughness.png':png(size,size,packed)},material:{baseColor:{file:'base-color.png',colorSpace:'sRGB'},roughness:{file:'roughness.png',colorSpace:'Non-Color'},metallic:{file:'metallic.png',colorSpace:'Non-Color'},normal:{file:'normal.png',colorSpace:'Non-Color',convention:'OpenGL'}},limitations:['Procedural test material, not scan-derived or photorealism-certified.','No displacement, UV unwrapping, texture baking or rendered appearance validation.']};
}
export function synthesizeLathe(raw){
 const profile=raw?.profile,segments=integer(raw?.segments??32,3,128);
 if(!Array.isArray(profile)||profile.length<2||profile.length>64)fail('profile requires2..64 radius/height pairs');
 profile.forEach((p,i)=>{if(!Array.isArray(p)||p.length!==2)fail('invalid profile');finite(p[0],0.001,100);finite(p[1],-100,100);if(i&&p[1]<=profile[i-1][1])fail('profile heights must increase');});
 const positions=[],normals=[],uv=[],indices=[];
 // glTF Y-up, rotational surface. Separate cap vertices preserve hard edge normals.
 for(let j=0;j<profile.length;j++){const before=profile[Math.max(0,j-1)],after=profile[Math.min(profile.length-1,j+1)],slope=(after[0]-before[0])/(after[1]-before[1]);for(let i=0;i<=segments;i++){const a=i/segments*Math.PI*2,c=Math.cos(a),s=Math.sin(a),d=Math.hypot(1,slope);positions.push(profile[j][0]*c,profile[j][1],profile[j][0]*s);normals.push(c/d,-slope/d,s/d);uv.push(i/segments,j/(profile.length-1));}}
 for(let j=0;j<profile.length-1;j++)for(let i=0;i<segments;i++){const a=j*(segments+1)+i,b=a+segments+1;indices.push(a,b,a+1,a+1,b,b+1);}
 for(const [j,sign] of [[0,-1],[profile.length-1,1]]){const center=positions.length/3;positions.push(0,profile[j][1],0);normals.push(0,sign,0);uv.push(.5,.5);for(let i=0;i<=segments;i++){const a=i/segments*Math.PI*2,c=Math.cos(a),s=Math.sin(a);positions.push(profile[j][0]*c,profile[j][1],profile[j][0]*s);normals.push(0,sign,0);uv.push(.5+c*.5,.5+s*.5);}for(let i=0;i<segments;i++){const a=center+1+i;indices.push(...(sign<0?[center,a,a+1]:[center,a+1,a]));}}
 const arrays=[new Float32Array(positions),new Float32Array(normals),new Float32Array(uv),new Uint32Array(indices)],views=[],parts=[];let offset=0;
 arrays.forEach((a,i)=>{const b=Buffer.from(a.buffer);views.push({buffer:0,byteOffset:offset,byteLength:b.length,target:i===3?34963:34962});parts.push(b);offset+=b.length;});
 const min=[0,1,2].map(i=>Math.min(...positions.filter((_,k)=>k%3===i))),max=[0,1,2].map(i=>Math.max(...positions.filter((_,k)=>k%3===i)));
 const doc={asset:{version:'2.0',generator:'Kingmaker original bounded lathe skill'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,mode:4}]}],buffers:[{byteLength:offset}],bufferViews:views,accessors:[{bufferView:0,componentType:5126,count:positions.length/3,type:'VEC3',min,max},{bufferView:1,componentType:5126,count:normals.length/3,type:'VEC3'},{bufferView:2,componentType:5126,count:uv.length/2,type:'VEC2'},{bufferView:3,componentType:5125,count:indices.length,type:'SCALAR'}]};
 let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);const bin=Buffer.concat(parts),head=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);head.write('glTF');head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+bin.length,8);jh.writeUInt32LE(json.length);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(bin.length);bh.writeUInt32LE(0x004e4942,4);
 return {parameters:{profile,segments},files:{'mesh.glb':Buffer.concat([head,jh,json,bh,bin])},vertices:positions.length/3,triangles:indices.length/3,limitations:['Original rotational mesh, not a sculpted human or kitbash asset.','No rig, character animation, collision certification or visual-quality certification.']};
}
export function synthesizeTexturedLathe(raw){
 const mesh=synthesizeLathe(raw?.mesh),surface=synthesizePBR(raw?.material),old=mesh.files['mesh.glb'];
 const len=old.readUInt32LE(12),doc=JSON.parse(old.subarray(20,20+len).toString()),parts=[old.subarray(28+len)];let offset=parts[0].length;
 doc.images=[];doc.textures=[];doc.samplers=[{magFilter:9729,minFilter:9729,wrapS:10497,wrapT:10497}];
 for(const name of ['base-color.png','metallic-roughness.png','normal.png']){const bytes=surface.files[name],view=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length});doc.images.push({bufferView:view,mimeType:'image/png'});doc.textures.push({source:doc.images.length-1,sampler:0});const pad=Buffer.alloc((4-bytes.length%4)%4);parts.push(bytes,pad);offset+=bytes.length+pad.length;}
 doc.materials=[{name:'Kingmaker original procedural PBR',pbrMetallicRoughness:{baseColorTexture:{index:0},metallicRoughnessTexture:{index:1},metallicFactor:1,roughnessFactor:1},normalTexture:{index:2}}];doc.meshes[0].primitives[0].material=0;doc.buffers[0].byteLength=offset;
 let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);const bin=Buffer.concat(parts),head=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);head.write('glTF');head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+bin.length,8);jh.writeUInt32LE(json.length);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(bin.length);bh.writeUInt32LE(0x004e4942,4);
 return {parameters:{mesh:mesh.parameters,material:surface.parameters},files:{'textured-mesh.glb':Buffer.concat([head,jh,json,bh,bin])},vertices:mesh.vertices,triangles:mesh.triangles,limitations:[...mesh.limitations,...surface.limitations]};
}
export function synthesizeUSDLathe(raw){
 const mesh=synthesizeLathe(raw?.mesh),material=raw?.material??{};
 const color=material.color??[0.18,0.22,0.28];if(!Array.isArray(color)||color.length!==3)fail('linear RGB material color required');color.forEach(v=>finite(v,0,1));
 const roughness=finite(material.roughness??0.4,0,1),metallic=finite(material.metallic??0,0,1),metersPerUnit=finite(raw?.metersPerUnit??1,0.0001,1000);
 const b=mesh.files['mesh.glb'],len=b.readUInt32LE(12),doc=JSON.parse(b.subarray(20,20+len).toString()),bin=b.subarray(28+len);
 const read=(i,width)=>{const v=doc.bufferViews[i],out=[];for(let p=v.byteOffset;p<v.byteOffset+v.byteLength;p+=4)out.push(i===3?bin.readUInt32LE(p):bin.readFloatLE(p));if(width===1)return out.join(', ');const tuples=[];for(let j=0;j<out.length;j+=width)tuples.push('('+out.slice(j,j+width).join(', ')+')');return tuples.join(', ');};
 const text=`#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = ${metersPerUnit}
    upAxis = "Y"
)
def Xform "World"
{
    def Mesh "GeneratedLathe" (prepend apiSchemas = ["MaterialBindingAPI"])
    {
        uniform token subdivisionScheme = "none"
        point3f[] points = [${read(0,3)}]
        normal3f[] normals = [${read(1,3)}] (interpolation = "vertex")
        texCoord2f[] primvars:st = [${read(2,2)}] (interpolation = "vertex")
        int[] faceVertexCounts = [${Array(mesh.triangles).fill(3).join(', ')}]
        int[] faceVertexIndices = [${read(3,1)}]
        rel material:binding = </World/Surface>
    }
    def Material "Surface"
    {
        token outputs:surface.connect = </World/Surface/Shader.outputs:surface>
        def Shader "Shader"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor = (${color.join(', ')})
            float inputs:roughness = ${roughness}
            float inputs:metallic = ${metallic}
            token outputs:surface
        }
    }
}
`;
 return {parameters:{mesh:mesh.parameters,material:{color,roughness,metallic},metersPerUnit},files:{'scene.usda':Buffer.from(text)},vertices:mesh.vertices,triangles:mesh.triangles,limitations:['Original bounded USDA mesh with basic preview material; no MaterialX or MDL implementation.','No physics, collision, mass, semantic labeling or SimReady certification.','No variants, external layers, payload streaming, texture embedding or animation.']};
}
export async function executeNativeAssetSkill({skill,parameters,workDir,qualityTarget='procedural-proof'}={}){
 if(qualityTarget!=='procedural-proof')fail('unsupported fidelity target; no silent downgrade');
 const result=skill==='surface-condition'?synthesizeSurfaceCondition(parameters):skill==='edit-timeline'?synthesizeEditTimeline(parameters):skill==='camera-orbit'?synthesizeCameraOrbit(parameters):skill==='pbr-synthesis'?synthesizePBR(parameters):skill==='lathe-mesh'?synthesizeLathe(parameters):skill==='textured-lathe'?synthesizeTexturedLathe(parameters):skill==='usd-lathe'?synthesizeUSDLathe(parameters):fail('unknown native skill');
 const root=await realpath(workDir),disk=await statfs(root),total=Object.values(result.files).reduce((n,b)=>n+b.length,0);
 if(disk.bavail*disk.bsize<total+256*1024*1024)fail('insufficient disk reserve');
 const outputDir=await mkdtemp(join(root,'native-skill-')),artifacts=[];
 for(const [name,bytes] of Object.entries(result.files)){const path=join(outputDir,name);await writeFile(path,bytes,{flag:'wx'});artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
 const {files,...details}=result;
 const record={schema:'kingmaker.native-asset-skill/1',status:'completed',skill,qualityTarget,qualityCertified:false,provenance:{implementation:'original Kingmaker procedural algorithm',externalAssets:[],rights:'No third-party asset license imposed by this generator; output rights are not reassigned.'},...details,artifacts};
 const recordPath=join(outputDir,'native-skill-record.json');await writeFile(recordPath,JSON.stringify(record,null,2));return {ok:true,record,recordPath,outputDir};
}
