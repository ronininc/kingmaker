// Original-game requirements intake. No game execution, copied assets or implied capability.
const enums={platform:['browser','windows','macos','linux','mobile'],perspective:['first-person','third-person'],scope:['vertical-slice','small-game','open-world'],playerMode:['single-player','multiplayer'],qualityTarget:['primitive-prototype','stylized','high-fidelity'],parkour:['yes','no'],firearms:['yes','no'],abilities:['yes','no'],karma:['yes','no']};
const required=[...Object.keys(enums),'premise','coreLoop','artDirection','completionCriteria','budget','deadline'];
export function reviewGameBrief(raw={}){
 const values={};for(const [k,v]of Object.entries(raw)){if(!required.includes(k))throw Error(`game-brief: unknown field ${k}`);if(typeof v!=='string'||!v.trim()||v.length>2000||/[\x00-\x08]/.test(v))throw Error(`game-brief: invalid ${k}`);if(enums[k]&&!enums[k].includes(v))throw Error(`game-brief: ${k} must be ${enums[k].join(', ')}`);values[k]=v.trim();}
 const missing=required.filter(k=>!values[k]);
 return {schema:'kingmaker.original-game-brief/1',status:missing.length?'requirements-incomplete':'ready-for-implementation-review',values,missing,originality:{policy:'Create original worlds, characters, code and assets. Reference games inform separately chosen concepts and quality, not copying protected expression.',referenceGames:['Mirror’s Edge','Infamous','GTA 6','Watch Dogs'],sourceRights:'Each external asset or code source requires its own provenance and rights review.'},implementation:{started:false,backgroundJob:null,notificationScheduled:false},acceptanceGates:['Owner reviews complete requirements and scope/budget.','Playable prototype tests: input, camera, movement and chosen mechanics.','Asset and source rights review; actual Armor scan plus functional tests.','Performance and visual review on target hardware.','Package is launched and completion criteria verified before notifying done.'],limitations:['This is a requirements document, not a generated game.','High-fidelity/open-world/multiplayer requests require feasibility and resources review.','Background execution and completion notification are not scheduled by this module.']};
}
export function createGameBriefSession(){
 let values={};
 return {handle(text){
  const s=String(text).trim();if(!/^game plan\b/i.test(s))return null;
  const rest=s.replace(/^game plan\s*/i,'');
  if(/^reset$/i.test(rest)){values={};return {handled:true,message:'Game requirements draft cleared. No implementation was running.'};}
  const match=rest.match(/^set (player mode|quality target|core loop|art direction|completion criteria|[a-zA-Z]+) (.+)$/is);
  if(match){const key=({'player mode':'playerMode','quality target':'qualityTarget','core loop':'coreLoop','art direction':'artDirection','completion criteria':'completionCriteria'})[match[1].toLowerCase()]??required.find(k=>k.toLowerCase()===match[1].toLowerCase())??match[1];const value=enums[key]?match[2].trim().toLowerCase().replace(/ /g,'-'):match[2].trim();const proposed={...values,[key]:value};reviewGameBrief(proposed);values=proposed;}
  else if(!['','start','show'].includes(rest.toLowerCase()))return {handled:true,message:'Use game plan set FIELD VALUE, or game plan show. Fields: '+required.join(', ')};
  const review=reviewGameBrief(values);
  return {handled:true,review,message:`Original game requirements: ${JSON.stringify(values)}. ${review.missing.length?'Still needed: '+review.missing.join(', ')+'. Use game plan set FIELD VALUE.':'Requirements captured, awaiting implementation review; no game build has started.'} This draft lasts for this session. No background build or notification is scheduled.`};
 }};
}
