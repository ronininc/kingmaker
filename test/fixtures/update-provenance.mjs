import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {signManifestBytes} from '../../lib/release-signing.mjs';
export const sha = b => createHash('sha256').update(b).digest('hex');
export function manifest(version='0.3.0', createdAt='2026-10-18T01:00:00.000Z', artifact='old', engine='#!/bin/bash\necho ok\n') {
 return {schema:'kingmaker.release/1',product:'Kingmaker',version,tag:'v'+version,createdAt,app:{bundleId:'com.ronininc.solghost',version,sha256:sha(artifact)},engine:{sha256:sha(engine)}};
}
export function receipt(dataDir, appRoot, m, privateKeyPem) {
 mkdirSync(dataDir,{recursive:true}); const files={};
 for(const f of ['Contents/MacOS/Kingmaker','Contents/MacOS/KingmakerEngine','Contents/Resources/sol-ghost/payload.json','Contents/Info.plist','Contents/_CodeSignature/CodeResources']) {
  const path=join(appRoot,f);mkdirSync(join(path,'..'),{recursive:true});const body=f.endsWith('payload.json')?JSON.stringify({schema:'kingmaker.payload/1',version:m.version,files:[{path:'sample.mjs',size:4,sha256:sha('code')}] }):f;
  writeFileSync(path,body);if(f.endsWith('payload.json'))writeFileSync(join(path,'../sample.mjs'),'code');files[f]=sha(body);
 }
 const bytes=Buffer.from(JSON.stringify(m));
 writeFileSync(join(dataDir,'installed-release.json'),JSON.stringify({schema:'kingmaker.installed-release/1',manifest:bytes.toString('base64'),signature:signManifestBytes(bytes,privateKeyPem),files}));
}
