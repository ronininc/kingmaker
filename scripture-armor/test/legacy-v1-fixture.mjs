// Genuine historical source fixture; no generated compatibility shim or production identity access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const LEGACY_V1_COMMIT = 'd3879de164fb26f969905ee887b01eaf7f9965d2';
export const LEGACY_V1_SHA256 = '712dc3ca3c0e4154cecf753f5118a5b893d1a6bf0ea011a05b9007a995b2d70e';
export function legacyFixtureHome(fallback, env = process.env) {
 if (!env.ARMOR_LEGACY_V1_HOME) return fallback;
 const home=env.ARMOR_LEGACY_V1_HOME;
 if(!path.isAbsolute(home)) throw Error('Legacy fixture home must be absolute');
 const file=path.join(home,'armor.mjs'),provenance=JSON.parse(fs.readFileSync(path.join(home,'provenance.json'),'utf8'));
 if(provenance.repo!=='https://github.com/ronininc/scripture-armor'||provenance.commit!==LEGACY_V1_COMMIT||provenance.sha256!==LEGACY_V1_SHA256||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==LEGACY_V1_SHA256) throw Error('Legacy fixture provenance/content mismatch');
 const scan=JSON.parse(fs.readFileSync(path.join(home,'source-scan.json'),'utf8'));
 if(scan.target_sha256!==LEGACY_V1_SHA256||scan.verdict!=='pass') throw Error('Legacy source fixture requires recorded incoming source scan');
 return home;
}
