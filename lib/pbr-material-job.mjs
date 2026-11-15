import {admitLocalAssets,validateAssetJob} from './film-assets.mjs';
export async function preparePBRMaterialJob({manifest,assetRoot,maps,normalConvention='OpenGL'}={}){
 const admitted=await admitLocalAssets({manifest,assetRoot,maxBytes:16*1024*1024});
 const job=validateAssetJob({kind:'pbr-material',maps,normalConvention},manifest);
 const files={};
 for(const [channel,ref] of Object.entries(job.maps)){
  const file=admitted.files.find(f=>f.id===ref.assetId);
  if(!/\.(png|jpe?g)$/i.test(file.path))throw Error('only bounded PNG/JPEG texture inputs');
  files[channel]={...file,colorSpace:ref.colorSpace};
 }
 return {schema:'kingmaker.pbr-import/1',assetRoot:admitted.assetRoot,maps:files,normalConvention:job.normalConvention,attribution:admitted.attribution,status:'prepared-not-imported',qualityCertified:false};
}
