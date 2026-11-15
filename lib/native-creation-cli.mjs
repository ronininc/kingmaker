import {presentCreation} from './creation-presentation.mjs';
import {realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createMethodConductor} from './method-conductor.mjs';
import {createNativeCreationRuntime} from './native-creation-runtime.mjs';
import {planNativeAssetRequest} from './native-asset-language.mjs';
export async function cmdNativeCreate(args,{write=x=>console.log(JSON.stringify(x,null,2))}={}) {
 const opts={};
 for(let i=0;i<args.length;i+=2){const k=args[i];if(!['--request','--quality','--work-dir','--approve'].includes(k)||!args[i+1]||Object.hasOwn(opts,k))throw new Error('native-create: use --request TEXT --work-dir DIR [--quality procedural-proof] [--approve REVIEW_HASH]');opts[k]=args[i+1];}
 if(!opts['--request']||!opts['--work-dir'])throw new Error('native-create: --request and existing --work-dir required');
 const workDir=await realpath(opts['--work-dir']);let reviewSha256;
 const conductor=createMethodConductor({indexUrl:new URL('../catalog/native-creation-skills/index.json',import.meta.url),toolProvider:null});
 const runtime=createNativeCreationRuntime({conductor,admittedMethodIds:['create-native-pbr-synthesis','create-native-lathe-mesh','create-native-textured-lathe','create-native-usd-lathe','create-native-camera-orbit','create-native-edit-timeline','create-native-surface-condition'],planner:planNativeAssetRequest,filmQualityTarget:opts['--quality']??'procedural-proof',approve:async p=>({approved:opts['--approve']===reviewSha256,proposalSha256:p.proposalSha256})});
 const proposal=await runtime.propose(opts['--request']);
 reviewSha256=createHash('sha256').update(JSON.stringify({proposal,workDir})).digest('hex');
 if(!opts['--approve']){write({status:'approval-required',reviewSha256,workDir,proposal,limitations:['Original procedural skills only; no production-quality certification.','Re-run the same command with --approve REVIEW_HASH after reviewing this exact request, destination and methods.']});return 0;}
 if(opts['--approve']!==reviewSha256)throw new Error('native-create: review hash mismatch; review the current proposal again');
 const result=await runtime.execute(proposal,{workDir});result.presentation=await presentCreation(result);write(result);return result.status==='completed'?0:1;
}
