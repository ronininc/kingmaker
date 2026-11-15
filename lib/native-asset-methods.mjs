// Staged capability inventory. Does not register or activate methods in the main library.
import { readFile } from 'node:fs/promises';
import { prepareAssetJob } from './film-assets.mjs';
const indexURL=new URL('../catalog/native-asset-methods/index.json',import.meta.url);
export async function listNativeAssetMethods(){return JSON.parse(await readFile(indexURL,'utf8'));}
export async function prepareNativeAssetMethod({id,request,manifest,assetRoot,maxBytes}={}){
  const index=await listNativeAssetMethods();
  const method=index.methods.find(m=>m.id===id);
  if(!method)throw new Error('native-asset-methods: unknown staged method');
  if(!method.preparationSupported)return {status:'adapter-required',methodId:id,requiredAdapter:method.requiredAdapter,nativeExecution:false,qualityCertified:false};
  if(request?.kind!==method.requiredAdapter)throw new Error('native-asset-methods: request does not match method adapter');
  const prepared=await prepareAssetJob({request,manifest,assetRoot,maxBytes});
  return {...prepared,methodId:id,nativeExecution:false,qualityCertified:false};
}
