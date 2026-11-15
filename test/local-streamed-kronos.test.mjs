import test from 'node:test';import assert from 'node:assert/strict';import {runLocalStreamedKronos} from '../lib/local-streamed-kronos.mjs';
test('local runner rejects disabled admission before spawning',async()=>{await assert.rejects(runLocalStreamedKronos({request:{admission:{enabled:false}}}),/admission/);});
test('local runner cancellation refuses before filesystem or process',async()=>{const c=new AbortController();c.abort();await assert.rejects(runLocalStreamedKronos({signal:c.signal}),/canceled/);});
