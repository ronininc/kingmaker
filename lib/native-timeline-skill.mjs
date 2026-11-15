// Original, frame-exact single-track edit decision construction. No media IO.
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw Error('timeline integer outside bounds');return v;};
const label=v=>{if(typeof v!=='string'||!v.length||v.length>128||/[\x00-\x1f]/.test(v))throw Error('invalid timeline label');return v;};
export function synthesizeEditTimeline(raw={}){
 const rateNumerator=integer(raw.rateNumerator??24,1,120000),rateDenominator=integer(raw.rateDenominator??1,1,1001);
 if(rateNumerator/rateDenominator<1||rateNumerator/rateDenominator>120)throw Error('frame rate outside bounds');
 if(!Array.isArray(raw.items)||!raw.items.length||raw.items.length>256)throw Error('requires 1..256 items');
 let cursor=0;
 const items=raw.items.map((item,index)=>{
  if(!item||!['clip','gap'].includes(item.type))throw Error('unsupported edit type');
  const durationFrames=integer(item.durationFrames,1,1000000),timelineStartFrame=cursor;
  cursor+=durationFrames;if(cursor>1000000)throw Error('timeline too long');
  const out={index,type:item.type,timelineStartFrame,durationFrames};
  if(item.type==='clip'){
   out.assetId=label(item.assetId);out.sourceStartFrame=integer(item.sourceStartFrame??0,0,1000000);
   out.sourceTotalFrames=integer(item.sourceTotalFrames,1,2000000);
   if(out.sourceStartFrame+durationFrames>out.sourceTotalFrames)throw Error('clip exceeds declared source duration');
  }
  return out;
 });
 const record={schema:'kingmaker.edit-timeline/1',rate:{numerator:rateNumerator,denominator:rateDenominator},durationFrames:cursor,durationSeconds:cursor*rateDenominator/rateNumerator,track:{kind:'video',items},mediaValidated:false};
 return {parameters:{rateNumerator,rateDenominator,items:raw.items},files:{'edit-timeline.json':Buffer.from(JSON.stringify(record,null,2))},limitations:['Edit decisions only: referenced asset IDs and declared source durations are not resolved or verified.','No media render, audio mixing, transitions, variable frame rate, retiming, OTIO interchange or editor compatibility claim.','All input clips must already share the declared frame rate; no implicit conversion.']};
}
