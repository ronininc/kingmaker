import assert from 'node:assert/strict';
import test from 'node:test';
import { codesignProbe, decideSignature } from '../scripts/release-gate.mjs';
import { appRequirement, readPin } from '../lib/release-identity.mjs';
const pin = readPin().sha1;
function probe(status = 0) {
  const calls = [];
  const result = codesignProbe('/fixture.app', { pin, platform:'darwin', run: (_cmd,args) => {
    calls.push(args);
    if(args.some(a=>a.startsWith('-R=')))return {status,stdout:''};
    return {status:0,stdout:args.includes('-r-') ? `certificate leaf = H"${pin}"` : 'Identifier=com.ronininc.solghost\nflags=0x10000(runtime)'};
  }});
  return {result,calls};
}
test('staged gate evaluates exact pin and refuses forged text without successful evaluation', () => {
  const good=probe(); assert.equal(decideSignature(good.result,pin).ok,true);
  assert.ok(good.calls.some(a=>a.includes(`-R=${appRequirement(pin)}`)));
  assert.equal(decideSignature(probe(1).result,pin).ok,false);
  assert.equal(decideSignature({...good.result, pinVerified:undefined},pin).ok,false);
  assert.equal(decideSignature(good.result,'A'.repeat(40)).ok,false);
  assert.equal(decideSignature(good.result,null).ok,false);
  for(const detailsText of ['Identifier=wrong\nflags=0x10000(runtime)','Identifier=com.ronininc.solghost',good.result.detailsText+'\nSignature=adhoc']) {
    assert.equal(decideSignature({...good.result,detailsText},pin).ok,false);
  }
});
