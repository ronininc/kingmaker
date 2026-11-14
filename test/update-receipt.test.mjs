import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {generateReleaseKeypair,signManifestBytes} from '../lib/release-signing.mjs';import {installedRelease} from '../lib/update.mjs';import {manifest,receipt} from './fixtures/update-provenance.mjs';
const source=readFileSync(new URL('../installer/engine.sh',import.meta.url),'utf8');
const block=name=>source.split('# BEGIN installed-release receipt '+name+'\n')[1].split('# END installed-release receipt '+name)[0];
const json=source.slice(source.indexOf('json_str() {'),source.indexOf('\nsay()'));
const journal=source.slice(source.indexOf('jot() {'),source.indexOf('\ncleanup()'));
const keys=generateReleaseKeypair();
for(const interrupted of [true,false])test('actual installer receipt blocks: '+(interrupted?'interrupted commit restores prior receipt':'successful commit authenticates new receipt'),{skip:process.platform!=='darwin'},()=>{
 const root=mkdtempSync(join(tmpdir(),'km-receipt-')),dataDir=join(root,'data'),appRoot=join(root,'app');receipt(dataDir,appRoot,manifest(),keys.privateKeyPem);
 const old=readFileSync(join(dataDir,'installed-release.json'),'utf8');const next=manifest('0.3.0','2026-10-18T02:00:00Z','new');
 const bytes=JSON.stringify(next);writeFileSync(join(root,'manifest.json'),bytes);writeFileSync(join(root,'manifest.json.sig'),signManifestBytes(Buffer.from(bytes),keys.privateKeyPem));
 mkdirSync(join(root,'stage/old'),{recursive:true});mkdirSync(join(dataDir,'.install-staging/config'),{recursive:true});
 const script=`set -e\n${json}\nsay(){ :; }\n${journal}\nfail(){ rollback; exit 7; }\nfail_at(){ if [ "$INTERRUPT" = 1 ]; then fail interrupted; fi; }\n${block('staging')}\n${block('commit')}\n`;
 const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',env:{...process.env,DATA:dataDir,DSTAGE:join(dataDir,'.install-staging'),STAGE:join(root,'stage'),JOURNAL:join(root,'stage/journal'),STAGED_APP:appRoot,MANIFEST:join(root,'manifest.json'),RELEASE_VERIFIED:'1',INTERRUPT:interrupted?'1':'0'}});
 assert.equal(result.status,interrupted?7:0,result.stderr);
 if(interrupted)assert.equal(readFileSync(join(dataDir,'installed-release.json'),'utf8'),old);
 assert.equal(installedRelease({verifyInstalledImpl:()=>true,dataDir,appRoot,publicKeyPem:keys.publicKeyPem}).createdAt,interrupted?manifest().createdAt:next.createdAt);
});
