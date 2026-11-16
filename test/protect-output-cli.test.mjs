import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {cmdProtectOutput} from '../lib/protect-output-cli.mjs';
test('explicit output command has help, rejects unsafe config and never activates implicit output routing',async t=>{
 assert.equal(await cmdProtectOutput(['--help']),0);
 await assert.rejects(cmdProtectOutput([]),/ARGUMENTS/);await assert.rejects(cmdProtectOutput(['--host','https://bad.test']),/ARGUMENTS/);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'protection-cli-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const enrollment=path.join(dir,'update.json'),config=path.join(dir,'config.json');
 await fs.writeFile(enrollment,JSON.stringify({url:'https://evil.test',key:'fixture'}),{mode:0o600});await fs.writeFile(config,'{}',{mode:0o600});
 const args=['--input',path.join(dir,'in'),'--output',path.join(dir,'out'),'--language','js','--config',config,'--enrollment',enrollment];
 await assert.rejects(cmdProtectOutput(args),/ENROLLMENT_INVALID/);
 await fs.chmod(enrollment,0o644);await assert.rejects(cmdProtectOutput(args),/FILE_UNSAFE/);
 await fs.chmod(enrollment,0o600);await fs.rename(enrollment,enrollment+'.real');await fs.symlink(enrollment+'.real',enrollment);await assert.rejects(cmdProtectOutput(args));
 assert.deepEqual((await fs.readdir(dir)).sort(),['config.json','update.json','update.json.real']);
});
