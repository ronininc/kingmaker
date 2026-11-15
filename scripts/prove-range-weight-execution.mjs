// Loopback-only proof: stream one existing F32 projection row at a time, then execute it.
// This is NOT full Kronos/LLM inference, GGUF streaming, or a remote inference service.
import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const [source,reference]=process.argv.slice(2);
const oracle=JSON.parse(await fs.readFile(reference,'utf8'));
const file=await fs.open(source,'r');
const read=async(start,length)=>{assert.ok(Number.isSafeInteger(length)&&length>=0&&length<=8*1024*1024);const b=Buffer.alloc(length);const r=await file.read(b,0,length,start);assert.equal(r.bytesRead,length);return b;};
let server;
try {
 const prefix=await read(0,8);const headerSize=Number(prefix.readBigUInt64LE());
 const header=JSON.parse(await read(8,headerSize));
 const weight=header['head.weight'],bias=header['head.bias'];
 assert.equal(weight.dtype,'F32');assert.equal(bias.dtype,'F32');
 assert.equal(weight.shape.length,2);const [rows,cols]=weight.shape;
 assert.equal(oracle.input.length,cols);assert.deepEqual(bias.shape,[rows]);
 assert.equal(weight.data_offsets[1]-weight.data_offsets[0],rows*cols*4);
 const base=8+headerSize, descriptors=[];
 for(let row=0;row<rows;row++){
  const start=base+weight.data_offsets[0]+row*cols*4,length=cols*4;
  descriptors.push({row,start,length,sha256:hash(await read(start,length))});
 }
 const start=base+bias.data_offsets[0],length=rows*4;
 descriptors.push({bias:true,start,length,sha256:hash(await read(start,length))});
 const allowed=new Map(descriptors.map(d=>[`bytes=${d.start}-${d.start+d.length-1}`,d]));
 let requests=0,served=0;
 server=http.createServer(async(req,res)=>{
  const d=allowed.get(req.headers.range);
  if(req.method!=='GET'||req.url!=='/weights'||!d){res.writeHead(416);res.end();return;}
  try {const bytes=await read(d.start,d.length);requests++;served+=bytes.length;
   res.writeHead(206,{'Content-Length':bytes.length,'Content-Range':`bytes ${d.start}-${d.start+d.length-1}/${(await file.stat()).size}`});res.end(bytes);
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/weights`;
 const output=new Array(rows).fill(0);let retainedPeak=0,checks=0;
 function verified(bytes,d){assert.equal(bytes.length,d.length);assert.equal(hash(bytes),d.sha256);return bytes;}
 for(const d of descriptors){
  const response=await fetch(url,{headers:{Range:`bytes=${d.start}-${d.start+d.length-1}`}});
  assert.equal(response.status,206);assert.equal(Number(response.headers.get('content-length')),d.length);
  assert.equal(response.headers.get('content-range'),`bytes ${d.start}-${d.start+d.length-1}/${(await file.stat()).size}`);
  const bytes=verified(Buffer.from(await response.arrayBuffer()),d);checks++;retainedPeak=Math.max(retainedPeak,bytes.length);
  if(d.bias){for(let r=0;r<rows;r++)output[r]+=bytes.readFloatLE(r*4);}
  else {for(let c=0;c<cols;c++)output[d.row]+=oracle.input[c]*bytes.readFloatLE(c*4);}
  if(d.row===0){const altered=Buffer.from(bytes);altered[0]^=1;assert.throws(()=>verified(altered,d));}
 }
 const bad=await fetch(url,{headers:{Range:'bytes=0-7'}});assert.equal(bad.status,416);
 const maxError=Math.max(...output.map((y,i)=>Math.abs(y-oracle.output[i])));assert.ok(maxError<1e-5);
 console.log(JSON.stringify({scope:'Real existing Kronos tokenizer output head only; not complete model inference',transport:'HTTP byte ranges on 127.0.0.1 only; no external network or model download',checkpointBytes:(await file.stat()).size,weightShape:[rows,cols],requests,weightBytesTransferred:served,largestWeightChunk:retainedPeak,verifiedRangeHashes:checks,corruptedChunkRejected:true,unselectedRangeRejected:true,oracle:'independent NumPy F32 original head projection',maxAbsOutputError:maxError,fullCheckpointMaterializedByClient:false,output},null,2));
}finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await file.close();}
