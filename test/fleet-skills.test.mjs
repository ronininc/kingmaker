import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign,createHash} from 'node:crypto';import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';import {addFleetSkill,CATALOG_DOMAIN,FLEET_SKILLS_SCHEMA,loadFleetSkillCatalog,startFleetSkillRefresh,PACKAGE_DOMAIN,SKILL_PACKAGE_SCHEMA} from '../lib/fleet-skills.mjs';import {connectorTurn,listConnectors,savedConnectors} from '../lib/connectors.mjs';
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

test('two isolated clients fetch and refresh a signed Fleet feed automatically', { timeout: 15_000 }, async t => {
  let feed = null, requestedCatalogs = 0, requestedPackages = 0;
  const server = createServer((request, response) => {
    if (request.url === '/package.json') {
      requestedPackages += 1;
      response.end(bytes);
    } else if (request.url === '/catalog.json') {
      requestedCatalogs += 1;
      response.statusCode = feed ? 200 : 503;
      response.end(JSON.stringify(feed));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bytes = packageBytes();
  const reviewed = publish({ packageUrl: `${origin}/package.json` }, bytes);
  const revoked = publish({ ...reviewed.entry, state: 'revoked', reason: 'Fixture publisher revoked this skill.' }, bytes);
  feed = reviewed.document;
  const clients = Array.from({ length: 2 }, () => {
    const state = mkdtempSync(join(tmpdir(), 'kingmaker-fleet-feed-'));
    const fleet = join(state, 'fleet');
    mkdirSync(fleet);
    writeFileSync(join(fleet, 'skills-feed.json'), JSON.stringify({ catalogUrl: `${origin}/catalog.json`, fixtureLoopback: true }));
    writeFileSync(join(fleet, 'skills-public-key.pem'), publicKeyPem);
    const client = { state, view: null, modelCalls: 0 };
    const poll = startFleetSkillRefresh(state, view => { client.view = view; }, { intervalMs: 25 });
    t.after(poll.stop);
    return client;
  });
  async function awaitViews(predicate) {
    for (let tries = 0; tries < 250; tries += 1) {
      if (clients.every(client => client.view && predicate(client.view))) return;
      await delay(20);
    }
    assert.fail(JSON.stringify(clients.map(client => client.view)));
  }
  const invoke = client => connectorTurn(client.connector, 'pear,1\napple,2', {
    state: client.state,
    fetchImpl: async (_url, options) => {
      client.modelCalls += 1;
      assert.match(JSON.parse(options.body).messages[0].content, /Aggregate a synthetic produce list/);
      return Response.json({ message: { content: 'apple 2 before pear 1' } });
    },
  });

  await awaitViews(view => view.ok && view.skills[0]?.status === 'available');
  assert.ok(requestedCatalogs >= 2);
  assert.equal(requestedPackages, 0);
  for (const client of clients) {
    assert.equal(existsSync(join(client.state, 'fleet', 'skills-catalog.json')), false);
    const added = await addFleetSkill({ state: client.state, id: reviewed.entry.id });
    assert.equal(added.ok, true);
    assert.equal(added.ran, false);
    assert.equal(client.modelCalls, 0);
    assert.ok(savedConnectors(client.state).some(connector => connector.id === added.connector.id));
    client.connector = added.connector;
    assert.equal((await invoke(client)).text, 'apple 2 before pear 1');
  }
  assert.equal(requestedPackages, 2);

  feed = null;
  await awaitViews(view => !view.ok && /HTTP 503/.test(view.error));
  for (const client of clients) assert.match((await invoke(client)).text, /HTTP 503/);

  feed = revoked.document;
  await awaitViews(view => view.ok && view.skills[0]?.status === 'revoked');
  for (const client of clients) assert.match((await invoke(client)).text, /publisher revoked/i);

  feed = { ...revoked.document, skills: reviewed.document.skills };
  await awaitViews(view => !view.ok && /signature/i.test(view.error) && view.skills[0]?.status === 'revoked');
  for (const client of clients) assert.match((await invoke(client)).text, /signature/i);

  feed = reviewed.document;
  await awaitViews(view => !view.ok && /older/i.test(view.error) && view.skills[0]?.status === 'revoked');
  for (const client of clients) {
    assert.match((await invoke(client)).text, /older/i);
    assert.equal(client.modelCalls, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(client.state, 'fleet-skills', 'accepted-catalog.json'), 'utf8')), revoked.document);
  }
});
