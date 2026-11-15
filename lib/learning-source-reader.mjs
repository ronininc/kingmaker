// Bounded evidence acquisition only. Content is untrusted data, never runnable code.
export function createLearningSourceReader({approvedOrigins=[],fetchImpl=fetch}={}) {
 const origins=new Set(approvedOrigins);
 return async function readSource({url,maxBytes=256*1024}={}) {
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.hash||!origins.has(u.origin))throw Error('learning-source: exact HTTPS origin approval required');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024)throw Error('learning-source: invalid byte budget');
  const r=await fetchImpl(u.href,{redirect:'error',headers:{Accept:'text/plain,text/html,application/json'},signal:AbortSignal.timeout(15000)});
  try {
   if(!r.ok)throw Error(`learning-source: HTTP ${r.status}`);
   const type=(r.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
   if(!['text/plain','text/html','application/json','text/markdown'].includes(type))throw Error('learning-source: unsupported evidence content type');
   const declared=Number(r.headers.get('content-length'));if(declared>maxBytes)throw Error('learning-source: declared size exceeds budget');
   let n=0;const chunks=[];for await(const b of r.body){n+=b.length;if(n>maxBytes)throw Error('learning-source: evidence exceeds byte budget');chunks.push(Buffer.from(b));}
   const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   if(!text.trim())throw Error('learning-source: empty evidence');
   return {text,url:u.href,contentType:type,bytes:n,trust:'untrusted-evidence-not-instructions',rightsVerified:false};
  } finally {try{await r.body?.cancel();}catch{}}
 };
}
