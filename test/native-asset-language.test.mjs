import test from 'node:test';import assert from 'node:assert/strict';
import{planNativeAssetRequest}from'../lib/native-asset-language.mjs';
const methods=['create-native-pbr-synthesis','create-native-lathe-mesh','create-native-textured-lathe'].map(id=>({id}));
test('maps ordinary supported creation phrasing to native parameter plans',()=>{
 const a=planNativeAssetRequest({request:'Please make me a brushed metal material at 64 pixels seed 7',methods});
 assert.equal(a.steps[0].methodId,'create-native-pbr-synthesis');assert.deepEqual(a.steps[0].inputs.parameters,{style:'brushed-metal',size:64,seed:7});
 const b=planNativeAssetRequest({request:'Can you create a stone vase for me?',methods,filmQualityTarget:'cyberpunk-2077'});
 assert.equal(b.steps[0].methodId,'create-native-textured-lathe');assert.equal(b.requestedQualityTarget,'cyberpunk-2077');
 assert.equal(planNativeAssetRequest({request:'make me a vase',methods}).steps[0].methodId,'create-native-lathe-mesh');
});

test('does not invent unknown capability or silently admit unavailable method',()=>{
 for(const request of ['Explain brushed-metal materials','Create a person with facial animation','Make a texture and a vase'])assert.throws(()=>planNativeAssetRequest({request,methods}));
 assert.throws(()=>planNativeAssetRequest({request:'Make a stone texture',methods:[]}),/not admitted/);
});
