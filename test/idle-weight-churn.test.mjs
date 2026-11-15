import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleWeightChurn, createMacIdleObserver, parseHidIdle, WEIGHT_IDLE_MS as TWO } from '../lib/idle-weight-churn.mjs';
const healthy = idleMs => ({ idleMs, acPower: true, pressureNormal: true, diskFreeBytes: 1e9, memoryFreeBytes: 1e9 });
function setup(run = async () => ({})) {
 let time = 0, sample = healthy(0), busy = false, calls = 0;
 const c = createIdleWeightChurn({ observe: async () => sample, now: () => time, pollMs: 60_000, busy: () => busy,
   run: x => { calls++; return run(x); } });
 return { c, calls: () => calls, set: x => { sample = x; }, busy: x => {busy=x;},
   tick: async (t, s = healthy(t)) => { time=t; sample=s; return c.tick(); },
   age: async () => { for (let t=0;t<=TWO;t+=60_000) await (time=t,sample=healthy(t),c.tick()); await Promise.resolve(); } };
}
test('two hours actual OS idle, local only, one attempt per episode', async () => {
 let args; const f=setup(async x=>{args=x;}); await f.age(); await f.c.settled(); assert.equal(f.calls(),1);
 assert.equal(args.localOnly,true); assert.equal(args.allowDownloads,false);
 await f.tick(TWO+60_000); assert.equal(f.calls(),1);
});
test('user activity aborts running work and resets idle episode', async () => {
 let signal; const f=setup(x=>new Promise(resolve=>{signal=x.signal;signal.addEventListener('abort',resolve,{once:true});}));
 await f.age(); assert.equal(f.calls(),1); await f.tick(TWO+60_000,healthy(0)); assert.equal(signal.aborted,true); await f.c.settled();
 await f.tick(TWO+120_000,healthy(60_000)); assert.equal(f.calls(),1);
});
for (const [name, patch] of [['battery',{acPower:false}],['unknown-power',{acPower:null}],['disk',{diskFreeBytes:0}],['memory',{memoryFreeBytes:0}],['pressure',{pressureNormal:false}],['unknown-activity',{idleMs:null}]]) {
 test(`${name} blocks and cancels`, async()=>{
  let signal; const f=setup(x=>new Promise(resolve=>{signal=x.signal;signal.addEventListener('abort',resolve,{once:true});}));
  await f.age(); await f.tick(TWO+60_000,{...healthy(TWO+60_000),...patch}); assert.equal(signal.aborted,true); await f.c.settled();
 });
}
test('sleep/clock jumps fail closed rather than treating missed time as observed idle', async()=>{
 const f=setup(); await f.tick(0); await f.tick(TWO); assert.equal(f.calls(),0); await f.tick(-1,healthy(TWO));assert.equal(f.calls(),0);
});
test('unknown observer cannot trigger; restart never trusts prior idle history', async()=>{
 const f=setup(); await f.tick(0,null); await f.tick(TWO,null); assert.equal(f.calls(),0);
 const g=setup(); await g.tick(0,healthy(TWO*10));assert.equal(g.calls(),0);
});
test('busy foreground blocks even if OS idle',async()=>{const f=setup();f.busy(true);await f.age();assert.equal(f.calls(),0);});
test('stop cancels and prevents future work',async()=>{
 let signal;const f=setup(x=>new Promise(resolve=>{signal=x.signal;signal.addEventListener('abort',resolve,{once:true});}));await f.age();f.c.stop();await f.c.settled();assert.equal(signal.aborted,true);await f.tick(TWO+60_000);assert.equal(f.calls(),1);
});
test('worker failure is not retried repeatedly',async()=>{const f=setup(async()=>{throw Error('failed');});await f.age();await f.c.settled();await f.tick(TWO+60_000);assert.equal(f.calls(),1);});
test('HID parsing and unavailable platform/probe fail closed',async()=>{
 assert.equal(parseHidIdle('"HIDIdleTime" = 123000000'),123);assert.equal(parseHidIdle(''),null);
 assert.equal(await createMacIdleObserver({directory:'.',hostPlatform:()=> 'linux'})(),null);
 assert.equal(await createMacIdleObserver({directory:'.',hostPlatform:()=> 'darwin',read:async()=>{throw Error('denied');}})(),null);
});
test('run deadline cancels a bounded idle attempt',async()=>{
 let signal;const f=setup(x=>new Promise(resolve=>{signal=x.signal;signal.addEventListener('abort',resolve,{once:true});}));await f.age();
 for(let t=TWO+60_000;t<=TWO+15*60_000;t+=60_000)await f.tick(t);
 assert.equal(signal.aborted,true);await f.c.settled();assert.equal(f.c.status().blocked,'run-deadline');
});
test('observer errors do not start jobs',async()=>{
 const c=createIdleWeightChurn({observe:async()=>{throw Error('no sensor');},run:()=>assert.fail('must not run')});
 await c.tick();assert.equal(c.status().blocked,'activity-unknown');
});

test('headroom policy parses strictly, never claims normal pressure',async()=>{
 const {parseMemoryHeadroom,parseSwapPages,idleChurnBlock}=await import('../lib/idle-weight-churn.mjs');
 assert.equal(parseMemoryHeadroom('System-wide memory free percentage: 63%'),63);
 for(const x of ['', 'System-wide memory free percentage: 101%', '63%', 'System-wide memory free percentage: 63%\nSystem-wide memory free percentage: 1%']) assert.equal(parseMemoryHeadroom(x),null);
 assert.deepEqual(parseSwapPages('Swapins: 23.\nSwapouts: 42.'),[23,42]);assert.equal(parseSwapPages('Swapins: 23.'),null);
 const s={...healthy(TWO),pressureNormal:undefined,memoryGuardSource:'headroom-and-swap',memoryHeadroomPercent:63,swapStable:true};
 assert.equal(idleChurnBlock(s),null);
 for(const patch of [{swapStable:false},{memoryHeadroomPercent:null},{memoryHeadroomPercent:24},{memoryHeadroomPercent:101}])assert.equal(idleChurnBlock({...s,...patch}),'memory-headroom-or-paging');
});
test('observer requires two fresh stable swap samples; resets on failed reads and gaps',async()=>{
 let time=0, count=1, fail=false; const seen=[];
 const observe=createMacIdleObserver({directory:'.',hostPlatform:()=> 'darwin',now:()=>time,freeMemory:()=>1e9,disk:async()=>({bavail:1e6,bsize:4096}),
 read:async(file,args)=>{seen.push([file,args]);if(fail)throw Error('denied');return {stdout:file.endsWith('ioreg')?'"HIDIdleTime" = 7200000000000':file.endsWith('pmset')?"Now drawing from 'AC Power'":file.endsWith('memory_pressure')?'System-wide memory free percentage: 63%':`Swapins: ${count}.\nSwapouts: 4.`};}});
 assert.equal((await observe()).swapStable,false);time=5000;let s=await observe();assert.equal(s.swapStable,true);assert.equal(s.pressureNormal,undefined);
 count++;time=10000;assert.equal((await observe()).swapStable,false);time=30000;assert.equal((await observe()).swapStable,false);
 fail=true;time=35000;assert.equal(await observe(),null);fail=false;time=40000;assert.equal((await observe()).swapStable,false);
 assert.deepEqual(seen.filter(([f])=>f.endsWith('memory_pressure')).map(([,args])=>args),Array(6).fill(['-Q']));
});
