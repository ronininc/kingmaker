import { produceFilm } from '../lib/film-production.mjs';
const plan={schema:'kingmaker.film-plan/1',title:'Kingmaker procedural render proof',width:128,height:128,fps:2,shots:[{id:'desk',frames:4,camera:{position:[3,-5,3],target:[0,0,0.5]},objects:[{kind:'cube',position:[0,0,0],scale:[2,1,0.2],color:[0.03,0.04,0.05]},{kind:'cube',position:[0,0,0.8],scale:[1.2,0.05,0.7],color:[0.1,0.5,1],emission:2,endRotation:[0,0,15]}]}]};
const result=await produceFilm({plan,workDir:process.argv[2],tools:{blender:'/opt/homebrew/bin/blender',ffmpeg:'/opt/homebrew/bin/ffmpeg',ffprobe:'/opt/homebrew/bin/ffprobe'},maxRunMs:90000,frameBudgetSec:60,onProgress:p=>console.log(JSON.stringify(p))});
console.log(JSON.stringify(result,null,2));
