import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign,createHash} from 'node:crypto';import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';import {addFleetSkill,CATALOG_DOMAIN,FLEET_SKILLS_SCHEMA,loadFleetSkillCatalog,PACKAGE_DOMAIN,SKILL_PACKAGE_SCHEMA} from '../lib/fleet-skills.mjs';import {connectorTurn,listConnectors,savedConnectors} from '../lib/connectors.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const {privateKey,publicKey}=generateKeyPairSync('ed25519');const publicKeyPem=publicKey.export({format:'pem',type:'spki'});
function signed(domain,value){return sign(null,Buffer.from(`${domain}:${canonicalJson(value)}`),privateKey).toString('base64');}
function packageBytes(overrides={}){const pkg={schema:SKILL_PACKAGE_SCHEMA,id:'produce-summary',version:'1.0.0',publisher:'Ronin test collective',description:'Aggregate a synthetic produce list and write a sorted summary.',permissions:['read:provided-inputs','write:artifacts','network:none'],dependencies:[],workflow:[{type:'instruction',text:'Read the provided produce rows only.'},{type:'tool',tool:'write-file',text:'Write a sorted Markdown summary.'},{type:'verify',text:'Compare totals with the input rows.'}],fixtures:[{name:'two-row-safe-fixture',input:'apple,2\npear,1',expected:'apple 2 before pear 1'}],...overrides};return Buffer.from(JSON.stringify({package:pkg,signature:signed(PACKAGE_DOMAIN,pkg)}));}
let revision = Date.parse('2026-11-24T00:00:00Z');
function publish(states,bytes=packageBytes()){const entry={id:'produce-summary',version:'1.0.0',publisher:'Ronin test collective',description:'Aggregate produce into a sorted Markdown report.',permissions:['read:provided-inputs','write:artifacts','network:none'],dependencies:[],state:'reviewed',packageUrl:'https://fleet.example.test/produce-summary-1.0.0.json',packageSha256:hash(bytes),...states},catalog={schema:FLEET_SKILLS_SCHEMA,publishedAt:new Date(revision++).toISOString(),skills:[entry]};return {document:{...catalog,signature:signed(CATALOG_DOMAIN,catalog)},bytes,entry};}
function installFixture(pub){const state=mkdtempSync(join(tmpdir(),'kingmaker-fleet-skill-'));mkdirSync(join(state,'fleet'),{recursive:true});writeFileSync(join(state,'fleet','skills-public-key.pem'),publicKeyPem);writeFileSync(join(state,'fleet','skills-catalog.json'),JSON.stringify(pub.document));return state;}
test('one reviewed fixture appears in both state directories and Add is isolated to one',async()=>{const pub=publish(),a=installFixture(pub),b=installFixture(pub);for(const state of [a,b])assert.equal(loadFleetSkillCatalog(state).skills[0].status,'available');const added=await addFleetSkill({state:a,id:'produce-summary',fetchPackage:async()=>pub.bytes});assert.equal(added.ok,true);assert.equal(added.ran,false);assert.equal(loadFleetSkillCatalog(a).skills[0].status,'added');assert.equal(loadFleetSkillCatalog(b).skills[0].status,'available');const tool=listConnectors(a).find(c=>c.name==='produce-summary');assert.equal(tool.kind,'skill');assert.match(readFileSync(tool.target,'utf8'),/Aggregate a synthetic produce list/);assert.equal(listConnectors(b).some(c=>c.name==='produce-summary'),false);});
test('tampered package is refused before files or connectors are added',async()=>{const pub=publish(),state=installFixture(pub),tampered=Buffer.concat([pub.bytes,Buffer.from(' ')]);const result=await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>tampered});assert.equal(result.ok,false);assert.match(result.error,/digest/);assert.equal(listConnectors(state).some(c=>c.name==='produce-summary'),false);});
test('revoked catalog version is visible but cannot be added',async()=>{const pub=publish({state:'revoked',reason:'Fixture revoked.'}),state=installFixture(pub);assert.equal(loadFleetSkillCatalog(state).skills[0].status,'revoked');const result=await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>pub.bytes});assert.equal(result.ok,false);assert.match(result.error,/revoked/i);});
test('permission escalation requires fresh approval and unsupported access stays blocked',async()=>{const pub=publish(),state=installFixture(pub);assert.equal((await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>pub.bytes})).ok,true);const elevatedBytes=packageBytes({version:'1.1.0',permissions:['read:provided-inputs','write:artifacts','network:none','calendar:write']}),next=publish({version:'1.1.0',permissions:['read:provided-inputs','write:artifacts','network:none','calendar:write'],packageSha256:hash(elevatedBytes)},elevatedBytes);writeFileSync(join(state,'fleet','skills-catalog.json'),JSON.stringify(next.document));const view=loadFleetSkillCatalog(state).skills[0];assert.equal(view.status,'blocked');assert.match(view.reason,/Unsupported permission/);const result=await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>elevatedBytes,approvalPin:next.entry.packageSha256});assert.equal(result.ok,false);assert.match(result.error,/Unsupported permission/);});
test('a supported update that expands access needs a fresh owner approval',async()=>{const firstBytes=packageBytes({permissions:['read:provided-inputs','network:none']}),first=publish({permissions:['read:provided-inputs','network:none'],packageSha256:hash(firstBytes)},firstBytes),state=installFixture(first);assert.equal((await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>firstBytes})).ok,true);const nextBytes=packageBytes({version:'1.1.0'}),next=publish({version:'1.1.0',packageSha256:hash(nextBytes)},nextBytes);writeFileSync(join(state,'fleet','skills-catalog.json'),JSON.stringify(next.document));assert.equal(loadFleetSkillCatalog(state).skills[0].status,'blocked');const denied=await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>nextBytes});assert.equal(denied.needsApproval,true);const approved=await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>nextBytes,approvalPin:next.entry.packageSha256});assert.equal(approved.ok,true);assert.equal(approved.ran,false);});
test('an update replaces its prior My Tools connector and a catalog downgrade is blocked',async()=>{const first=publish(),state=installFixture(first);assert.equal((await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>first.bytes})).ok,true);const nextBytes=packageBytes({version:'1.1.0'}),next=publish({version:'1.1.0',packageSha256:hash(nextBytes)},nextBytes);writeFileSync(join(state,'fleet','skills-catalog.json'),JSON.stringify(next.document));assert.equal((await addFleetSkill({state,id:'produce-summary',fetchPackage:async()=>nextBytes})).ok,true);assert.equal(listConnectors(state).filter(c=>c.name.startsWith('produce-summary')).length,1);writeFileSync(join(state,'fleet','skills-catalog.json'),JSON.stringify(first.document));const view=loadFleetSkillCatalog(state);assert.equal(view.ok,false);assert.match(view.error,/older/i);});
test('unconfigured install reports the missing publication/sync path honestly',()=>{const state=mkdtempSync(join(tmpdir(),'kingmaker-fleet-none-')),result=loadFleetSkillCatalog(state);assert.equal(result.ok,false);assert.match(result.error,/not configured/);});

function refreshFixture(state, document) {
  writeFileSync(join(state, 'fleet', 'skills-catalog.json'), JSON.stringify(document));
}

test('a signed package cannot increase permissions beyond its signed catalog entry', async () => {
  const permissions = ['read:provided-inputs', 'network:none'];
  const initial = publish({ permissions }, packageBytes({ permissions }));
  const next = publish({ version: '1.1.0', permissions }, packageBytes({ version: '1.1.0' }));
  for (const state of [installFixture(initial), installFixture(initial)]) {
    const prior = await addFleetSkill({ state, id: initial.entry.id, fetchPackage: async () => initial.bytes });
    assert.equal(prior.ok, true);
    refreshFixture(state, next.document);
    const refused = await addFleetSkill({
      state, id: next.entry.id, approvalPin: next.entry.packageSha256, fetchPackage: async () => next.bytes,
    });
    assert.match(refused.error, /permissions do not match/i);
    assert.deepEqual(savedConnectors(state).map(connector => connector.id), [prior.connector.id]);
    assert.throws(() => readFileSync(join(state, 'fleet-skills', next.entry.id, '1.1.0', 'SKILL.md')), { code: 'ENOENT' });
  }
});

test('two fixture states invoke the reviewed skill explicitly and then refuse it after revocation', async () => {
  const reviewed = publish();
  const revoked = publish({ state: 'revoked', reason: 'Revoked in the fixture.' });
  for (const state of [installFixture(reviewed), installFixture(reviewed)]) {
    let calls = 0;
    const invoke = connector => connectorTurn(connector, 'pear,1\napple,2', {
      state,
      fetchImpl: async (_url, options) => {
        calls += 1;
        const messages = JSON.parse(options.body).messages;
        assert.match(messages[0].content, /Aggregate a synthetic produce list/);
        assert.equal(messages[1].content, 'pear,1\napple,2');
        return Response.json({ message: { content: 'apple 2 before pear 1' } });
      },
    });
    assert.equal(loadFleetSkillCatalog(state).skills[0].status, 'available');
    const added = await addFleetSkill({ state, id: reviewed.entry.id, fetchPackage: async () => reviewed.bytes });
    assert.equal(added.ok, true);
    assert.equal(added.ran, false);
    assert.equal(calls, 0);
    assert.equal((await invoke(added.connector)).text, 'apple 2 before pear 1');
    assert.equal(calls, 1);

    refreshFixture(state, { ...revoked.document, skills: reviewed.document.skills });
    assert.match(loadFleetSkillCatalog(state).error, /signature/i);
    assert.match((await invoke(added.connector)).text, /signature/i);
    refreshFixture(state, revoked.document);
    assert.equal(loadFleetSkillCatalog(state).skills[0].status, 'revoked');
    assert.match((await invoke(added.connector)).text, /revoked/i);
    refreshFixture(state, reviewed.document);
    assert.match(loadFleetSkillCatalog(state).error, /older/i);
    assert.match((await invoke(added.connector)).text, /older/i);
    assert.equal(calls, 1);
  }
});

test('revocation received during Add prevents registration', async () => {
  const reviewed = publish();
  const revoked = publish({ state: 'revoked' });
  const state = installFixture(reviewed);
  const result = await addFleetSkill({
    state,
    id: reviewed.entry.id,
    fetchPackage: async () => {
      refreshFixture(state, revoked.document);
      return reviewed.bytes;
    },
  });
  assert.match(result.error, /catalog changed/i);
  assert.deepEqual(savedConnectors(state), []);
});
