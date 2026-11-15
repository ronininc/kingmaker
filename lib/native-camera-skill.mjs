// Independently authored pinhole/orbit mathematics; no third-party implementation.
const number=(v,min,max)=>{if(!Number.isFinite(v)||v<min||v>max)throw Error('camera parameter outside bounds');return v;};
const integer=(v,min,max)=>{number(v,min,max);if(!Number.isInteger(v))throw Error('integer required');return v;};
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const l=Math.hypot(...a);return a.map(v=>v/l);};
export function synthesizeCameraOrbit(raw={}){
 const count=integer(raw.count??8,1,360),width=integer(raw.width??640,16,8192),height=integer(raw.height??480,16,8192);
 const radius=number(raw.radius??3,.01,10000),elevation=number(raw.elevation??20,-85,85),fov=number(raw.fov??50,5,150),phase=number(raw.phase??0,-360,360);
 const target=raw.target??[0,0,0];if(!Array.isArray(target)||target.length!==3)throw Error('target must be XYZ');target.forEach(v=>number(v,-10000,10000));
 const f=width/(2*Math.tan(fov*Math.PI/360)),K=[[f,0,width/2],[0,f,height/2],[0,0,1]];
 const cameras=Array.from({length:count},(_,index)=>{
  const a=(phase+index*360/count)*Math.PI/180,e=elevation*Math.PI/180;
  const position=[radius*Math.cos(e)*Math.cos(a),radius*Math.sin(e),radius*Math.cos(e)*Math.sin(a)].map((v,i)=>v+target[i]);
  const forward=unit(target.map((v,i)=>v-position[i])),right=unit(cross(forward,[0,1,0])),down=cross(forward,right);
  const worldToCamera=[right,down,forward].map(axis=>[...axis,-dot(axis,position)]);
  return {index,position,worldToCamera};
 });
 const parameters={count,width,height,radius,elevation,fov,phase,target};
 const record={schema:'kingmaker.camera-orbit/1',coordinates:'world Y-up; camera X-right Y-down Z-forward; row-major 3x4 world-to-camera; pixel origin top-left',parameters,K,cameras};
 return {parameters,files:{'cameras.json':Buffer.from(JSON.stringify(record,null,2))},limitations:['Calibration and pose records only: no images rendered, no depth, occlusion, segmentation or collision truth.','No lens distortion; horizontal field of view and square pixels.']};
}
export function projectCameraPoint(record,index,point){
 if(!Array.isArray(point)||point.length!==3||point.some(v=>!Number.isFinite(v)))throw Error('finite XYZ required');
 const camera=record.cameras[index];if(!camera)throw Error('camera absent');
 const [x,y,z]=camera.worldToCamera.map(r=>dot(r.slice(0,3),point)+r[3]);
 if(z<=0)return null;
 return [record.K[0][0]*x/z+record.K[0][2],record.K[1][1]*y/z+record.K[1][2],z];
}
