import { Worker } from 'node:worker_threads';

const WORKER=new URL('./static-inventory-worker.mjs',import.meta.url),TIMEOUT_MS=10_000;
export async function runBuiltinStaticInventory({sourceRoot,sourceTreeSha256,trackedFiles,signal}){
  if(signal?.aborted)throw new Error('STATIC_INVENTORY_ABORTED');
  return new Promise((resolve,reject)=>{const worker=new Worker(WORKER,{workerData:{sourceRoot,sourceTreeSha256,trackedFiles},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4}}),timer=setTimeout(()=>{worker.terminate();reject(new Error('STATIC_INVENTORY_TIMEOUT'));},TIMEOUT_MS);timer.unref?.();let settled=false;
    const done=(fn,v)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);worker.terminate();fn(v)};
    const aborted=()=>done(reject,new Error('STATIC_INVENTORY_ABORTED'));signal?.addEventListener('abort',aborted,{once:true});
    worker.once('message',(m)=>{if(m?.error)return done(reject,new Error(m.error));const encoded=JSON.stringify(m);if(encoded.length>65_536)return done(reject,new Error('STATIC_INVENTORY_OUTPUT_LIMIT'));if(m?.schema!=='ronin.builtin-static-inventory/v1'||m?.analyzerId!=='kingmaker-static-inventory'||m?.analyzerVersion!=='2'||m?.sourceTreeSha256!==sourceTreeSha256||m?.controls?.targetCodeExecuted!==false||m?.controls?.shellInvoked!==false||m?.controls?.pluginsLoaded!==false||m?.controls?.contentReadForHashing!==true||m?.controls?.contentExported!==false)return done(reject,new Error('STATIC_INVENTORY_ATTESTATION'));done(resolve,{attestation:m,findings:[],evidence:m});});worker.once('error',(e)=>done(reject,e));worker.once('exit',(code)=>{if(!settled&&code!==0)done(reject,new Error(`STATIC_INVENTORY_EXIT_${code}`));});
  });
}
