import {DurableObject} from 'cloudflare:workers';
import {validateReusableSkillPacket,METHOD_IDS,materializeReviewedMethod} from '../lib/reusable-skill-catalog.mjs';
// All authorization, replay, limit and deletion state for one installation is
// committed in a single synchronous SQLite transaction. No external writes.
export class FleetCoordinator extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), install TEXT NOT NULL, proof TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, proof TEXT NOT NULL, operation TEXT NOT NULL, requestHash TEXT NOT NULL, certDigest TEXT NOT NULL, targetKey TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS packets (id TEXT PRIMARY KEY, day TEXT NOT NULL, body TEXT NOT NULL)');
 }
 operate(input){return this.ctx.storage.transactionSync(()=>{
  const {operation,install,proofHash,packet}=input||{};
  if(!/^fi_[a-f0-9]{32}$/.test(install||'')||!/^[a-f0-9]{64}$/.test(proofHash||''))return {status:403,error:'bad proof'};
  if(!['contribute','forget','bundle','challenge'].includes(operation))return {status:400,error:'bad operation'};
  if(!['forget','challenge'].includes(operation)&&(!Number.isSafeInteger(input.authorizationExpiresAt)||input.authorizationExpiresAt<=Date.now()||input.authorizationExpiresAt>Date.now()+120000))return {status:403,error:'current authority required'};
  if(operation==='contribute'&&(!validateReusableSkillPacket(packet).ok||packet.installationId!==install))return {status:400,error:'reviewed reusable skill required'};
  let identity=this.sql.exec('SELECT * FROM identity WHERE id=1').toArray()[0];
  if(operation==='challenge'){
   if(identity&&(identity.withdrawn||identity.install!==install||identity.proof!==proofHash))return {status:403,error:'bad proof'};
   const c=input.challenge||{};if(!['contribute','bundle'].includes(c.operation)||![c.nonce,c.requestHash,c.certDigest,c.targetKey].every(v=>/^[a-f0-9]{64}$/.test(v||'')))return {status:400,error:'bad challenge'};
   this.sql.exec('DELETE FROM challenges WHERE expiresAt<=?',Date.now());
   if(this.sql.exec('SELECT COUNT(*) AS n FROM challenges').one().n>=16)return {status:429,error:'challenge limit'};
   const expiresAt=Date.now()+60000;this.sql.exec('INSERT INTO challenges VALUES (?,?,?,?,?,?,?)',c.nonce,proofHash,c.operation,c.requestHash,c.certDigest,c.targetKey,expiresAt);
   return {status:200,nonce:c.nonce,expiresAt};
  }
  if(operation!=='forget'){
   const ch=this.sql.exec('SELECT * FROM challenges WHERE nonce=?',input.nonce||'').toArray()[0];
   if(!ch||ch.expiresAt<=Date.now()||ch.proof!==proofHash||ch.operation!==operation||ch.requestHash!==input.requestHash||ch.certDigest!==input.certDigest||ch.targetKey!==input.targetKey)return {status:403,error:'challenge invalid or consumed'};
   this.sql.exec('DELETE FROM challenges WHERE nonce=?',input.nonce);
  }
  if(!identity){if(operation!=='contribute')return {status:403,error:'bad proof'};this.sql.exec('INSERT INTO identity (id,install,proof) VALUES (1,?,?)',install,proofHash);identity={install,proof:proofHash,withdrawn:0};}
  if(identity.install!==install||identity.proof!==proofHash)return {status:403,error:'bad proof'};
  if(operation==='forget'){
   const count=this.sql.exec('SELECT COUNT(*) AS n FROM packets').one().n;
   this.sql.exec('UPDATE identity SET withdrawn=1 WHERE id=1');this.sql.exec('DELETE FROM packets');this.sql.exec('DELETE FROM challenges');
   return {status:200,forgotten:true,packets:count};
  }
  if(identity.withdrawn)return {status:403,error:'withdrawn'};
  if(operation==='bundle')return {status:200,methods:METHOD_IDS.map(materializeReviewedMethod)};
  const day=new Date().toISOString().slice(0,10);
  if(this.sql.exec('SELECT id FROM packets WHERE id=?',packet.packetId).toArray().length)return {status:409,error:'packet already received'};
  if(this.sql.exec('SELECT COUNT(*) AS n FROM packets WHERE day=?',day).one().n>=4)return {status:429,error:'enough for today'};
  this.sql.exec('INSERT INTO packets(id,day,body) VALUES (?,?,?)',packet.packetId,day,JSON.stringify(packet));
  return {status:200,accepted:true};
 });}
}
