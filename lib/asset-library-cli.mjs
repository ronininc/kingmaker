import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAssetDelivery,validateDeliveryAsset} from './asset-library-delivery.mjs';
export async function cmdAssetDownload(args,{write=x=>console.log(JSON.stringify(x,null,2)),fetchImpl=fetch}={}) {
 const o={};for(let i=0;i<args.length;i+=2){const k=args[i];if(!['--manifest','--work-dir','--max-bytes','--approve'].includes(k)||!args[i+1]||Object.hasOwn(o,k))throw new Error('asset-download: --manifest FILE --work-dir DIR --max-bytes N [--approve REVIEW_HASH]');o[k]=args[i+1];}
 if(!o['--manifest']||!o['--work-dir'])throw new Error('asset-download: manifest and existing destination required');
 if((await stat(o['--manifest'])).size>8*1024*1024)throw new Error('asset-download: manifest too large');
 const asset=validateDeliveryAsset(JSON.parse(await readFile(o['--manifest'],'utf8'))),workDir=await realpath(o['--work-dir']),maxBytes=Number(o['--max-bytes']);
 if(!Number.isSafeInteger(maxBytes)||maxBytes<asset.bytes)throw new Error('asset-download: explicit sufficient max bytes required');
 const review={asset,workDir,maxBytes,operation:'download',rights:'Approve only if you have reviewed this asset-specific license and have permission to download and store these bytes here. This does not approve redistribution or renderer execution.'};
 const reviewSha256=createHash('sha256').update(JSON.stringify(review)).digest('hex');
 if(!o['--approve']){write({status:'approval-required',reviewSha256,...review});return 0;}
 if(o['--approve']!==reviewSha256)throw new Error('asset-download: review hash mismatch');
 const delivery=createAssetDelivery({asset,approvedOrigins:[new URL(asset.url).origin],fetchImpl,admit:async q=>({approved:true,manifestSha256:q.manifestSha256})});
 write(await delivery.download({outputRoot:workDir,maxBytes}));return 0;
}
