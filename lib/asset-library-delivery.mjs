// Delivery is not execution: partial bytes must never be passed to a renderer.
import { createHash } from 'node:crypto';
import { realpath, statfs, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const hash = b => createHash('sha256').update(b).digest('hex');
const bad = s => { throw new Error(`asset-library: ${s}`); };
const positive = n => Number.isSafeInteger(n) && n > 0;
export function validateDeliveryAsset(a) {
  if (!a || !/^[a-zA-Z0-9_-]{1,80}$/.test(a.id) || !positive(a.bytes) || !/^[a-f0-9]{64}$/.test(a.sha256)) bad('invalid identity, size or digest');
  let url; try { url = new URL(a.url); } catch { bad('invalid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) bad('HTTPS without credentials required');
  for (const k of ['title','author','license','licenseUrl','source','changes']) if(typeof a[k] !== 'string' || !a[k].trim() || a[k].length > 2048) bad(`missing ${k}`);
  for(const k of ['licenseUrl','source']) { let u; try {u=new URL(a[k]);}catch{bad(`invalid ${k}`);} if(u.protocol!=='https:' || u.username || u.password) bad(`invalid ${k}`); }
  if(!positive(a.chunkBytes) || a.chunkBytes>1024*1024 || !Array.isArray(a.chunkSha256) || a.chunkSha256.length!==Math.ceil(a.bytes/a.chunkBytes) || a.chunkSha256.some(x=>!/^[a-f0-9]{64}$/.test(x))) bad('exact chunk hashes required');
  return Object.freeze(Object.fromEntries(['id','bytes','sha256','url','title','author','license','licenseUrl','source','changes','chunkBytes','chunkSha256'].map(k=>[k,k==='chunkSha256'?Object.freeze([...a[k]]):a[k]])));
}
export function createAssetDelivery({asset,approvedOrigins=[],admit,fetchImpl=fetch}={}) {
  const a=validateDeliveryAsset(asset), origin=new URL(a.url).origin;
  if(!approvedOrigins.includes(origin) || typeof admit!=='function') bad('explicit origin and rights admission required');
  const digest=hash(JSON.stringify(a));
  async function admission(operation) {
    const approval=await admit({asset:a,manifestSha256:digest,operation});
    if(approval?.approved!==true || approval.manifestSha256!==digest) bad('asset not admitted');
  }
  async function chunk(index,signal) {
    if(!Number.isInteger(index)||index<0||index>=a.chunkSha256.length)bad('invalid chunk index');
    await admission('read-range');
    const start=index*a.chunkBytes,end=Math.min(a.bytes-1,start+a.chunkBytes-1);
    const r=await fetchImpl(a.url,{headers:{Range:`bytes=${start}-${end}`,'Accept-Encoding':'identity'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    try {
      if(r.status!==206 || r.headers.get('content-range')!==`bytes ${start}-${end}/${a.bytes}` || (r.headers.get('content-encoding') && r.headers.get('content-encoding')!=='identity')) bad('invalid range response');
      const chunks=[];let n=0;
      for await(const b of r.body) {n+=b.length;if(n>end-start+1)bad('oversized range');chunks.push(Buffer.from(b));}
      const bytes=Buffer.concat(chunks);
      if(n!==end-start+1 || hash(bytes)!==a.chunkSha256[index])bad('range integrity mismatch');
      return {status:'verified-partial-bytes',index,bytes,renderable:false,manifestSha256:digest};
    } finally { try{await r.body?.cancel();}catch{} }
  }
  async function download({outputRoot,maxBytes,signal}={}) {
    if(!positive(maxBytes)||a.bytes>maxBytes)bad('explicit download budget exceeded');
    await admission('download');
    const root=await realpath(outputRoot),disk=await statfs(root);
    if(disk.bavail*disk.bsize<a.bytes+256*1024*1024)bad('insufficient space plus reserve');
    const dir=await mkdtemp(join(root,'library-asset-'));let f;
    try {
      f=await open(join(dir,'payload.partial'),'wx');const full=createHash('sha256');
      for(let i=0;i<a.chunkSha256.length;i++){const {bytes}=await chunk(i,signal);full.update(bytes);let off=0;while(off<bytes.length){const {bytesWritten}=await f.write(bytes,off,bytes.length-off);if(!bytesWritten)bad('short write');off+=bytesWritten;}}
      await f.sync();await f.close();f=null;
      if(full.digest('hex')!==a.sha256)bad('full asset digest mismatch');
      await rename(join(dir,'payload.partial'),join(dir,'payload'));
      await writeFile(join(dir,'manifest.json'),JSON.stringify(a,null,2));
      return {status:'full-bytes-verified',path:join(dir,'payload'),manifest:a,renderable:false,limitations:['Format validation and renderer admission still required.','Recorded license metadata is not proof of rights.']};
    } catch(e) {await f?.close();await rm(dir,{recursive:true,force:true});throw e;}
  }
  return Object.freeze({asset:a,readChunk:chunk,download});
}
