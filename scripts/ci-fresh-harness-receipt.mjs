// CI build evidence only. No private keys or shipping decisions are handled here.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const digest = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const byteOrder = (a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b));
const readJson = f => JSON.parse(readFileSync(f,'utf8'));
const inside = (base,p) => {
  const rel = relative(base,p);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
};

async function shaFile(p) {
  const h = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(p)) h.update(chunk);
  return h.digest('hex');
}

export async function runtimeTree(app, kind) {
  const base = realpathSync(app), root = join(base,'Contents','Resources',kind);
  if (!inside(base,realpathSync(root))) throw Error(kind + ': runtime escapes the app');
  const h = createHash('sha256');
  let bytes = 0, files = 0, links = 0;
  async function walk(path) {
    const rel = relative(root,path) || '.', s = lstatSync(path), mode = s.mode & 0o777;
    if (s.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target) || !inside(base, resolve(dirname(path),target)) || !inside(base, realpathSync(path))) throw Error(kind + ': nonportable symlink ' + rel);
      links++;
      h.update(JSON.stringify(['symlink',rel,mode,target])+'\n');
    } else if (s.isDirectory()) {
      h.update(JSON.stringify(['dir',rel,mode])+'\n');
      for (const entry of readdirSync(path).sort(byteOrder)) await walk(join(path,entry));
    } else if (s.isFile()) {
      files++; bytes += s.size;
      h.update(JSON.stringify(['file',rel,mode,s.size,await shaFile(path)])+'\n');
    } else throw Error(kind + ': unexpected file type ' + rel);
  }
  await walk(root);
  if (!files) throw Error(kind + ': no runtime files');
  return { kind, files, bytes, links, treeSha256: h.digest('hex') };
}

export async function freshHarnessReceipt({app, sourceCommit, engineCommit, kinds, facts, preSignGuardrails, minimumBuiltAt}) {
  if (!commit.test(sourceCommit) || !commit.test(engineCommit)) throw Error('Two full source commits are required');
  if (!preSignGuardrails || !digest.test(preSignGuardrails.preSignSha256) || !digest.test(preSignGuardrails.wheelSha256) || !Number.isSafeInteger(preSignGuardrails.bytes) || preSignGuardrails.bytes <= 0)
    throw Error('Fresh pre-sign Guardrails input receipt missing or invalid');
  const resources = join(app,'Contents','Resources');
  const stamp = readJson(join(resources,'kingmaker-runtime','solomon-build.json'));
  if (!/^[0-9a-f]{7,40}$/.test(stamp.sourceRef ?? '') || !engineCommit.startsWith(stamp.sourceRef)) throw Error('Packaged engine stamp does not name the approved engine source');
  if (!stamp.buildId || facts.solomonBuild !== stamp.buildId) throw Error('Native plist build ID does not match the packaged engine stamp');
  if (!Number.isFinite(Date.parse(stamp.builtAt)) || !Number.isFinite(Date.parse(minimumBuiltAt)) || Date.parse(stamp.builtAt) < Date.parse(minimumBuiltAt)) throw Error('Packaged engine stamp is not from this build session');
  if (facts.signing !== 'ad-hoc') throw Error('Private assembly must not use a customer signing identity');
  const guard = readJson(join(resources,'guardrails-runtime','runtime-manifest.json'));
  if (guard.executableSha256 !== preSignGuardrails.preSignSha256 || guard.executableSizeBytes !== preSignGuardrails.bytes) throw Error('Packaged Guardrails metadata does not match this session pre-sign proof');
  const knowledge = readJson(join(resources,'knowledge-runtime','northstar-tools-manifest.json'));
  if (knowledge.platform !== 'darwin-arm64' || !Number.isFinite(Date.parse(knowledge.installedAt)) || Date.parse(knowledge.installedAt) < Date.parse(minimumBuiltAt)) throw Error('Fresh arm64 Northstar metadata is required');
  const runtimeClosures = [];
  for (const kind of kinds) runtimeClosures.push(await runtimeTree(app,kind));
  return {
    schema:'kingmaker.fresh-private-assembly/1',
    sourceCommit, engineCommit, engineStamp:stamp,
    gate:'ad-hoc evidence only; do not publish, notarize, or treat as production signatures',
    app:{version:facts.version,bundledNode:facts.bundledNode,engineSha256:await shaFile(join(app,'Contents','MacOS','KingmakerEngine'))},
    guardrails:{ ...preSignGuardrails, packagedSha256:await shaFile(join(resources,'guardrails-runtime','solomon-guardrails')) },
    runtimeClosures,
  };
}

async function main([checkout, engineSource, app, preSignFile, out, minimumBuiltAt]) {
  const git = dir => execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const sourceCommit=git(checkout), engineCommit=git(engineSource);
  if (sourceCommit!==process.env.KINGMAKER_SHA || engineCommit!==process.env.TSS_SHA) throw Error('A checkout is not the preselected release source');
  for (const dir of [checkout,engineSource]) {
    if (execFileSync('git',['-C',dir,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()) throw Error('A source checkout was modified during this build');
  }
  const {inspectApp,REQUIRED_RUNTIMES} = await import(pathToFileURL(join(checkout,'scripts','release-parts.mjs')));
  const facts=inspectApp(app,{allowAdhoc:true});
  const receipt=await freshHarnessReceipt({app,sourceCommit,engineCommit,kinds:REQUIRED_RUNTIMES,facts,preSignGuardrails:readJson(preSignFile),minimumBuiltAt});
  writeFileSync(out,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
}
