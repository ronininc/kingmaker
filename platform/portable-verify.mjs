// Portable CLI unit verifier. Integrity is not publisher authenticity: verify the
// release archive against a trusted detached signature before unpacking it.
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,existsSync,mkdirSync,cpSync,renameSync,rmSync,symlinkSync,readlinkSync} from 'node:fs';
import {resolve,join,dirname,basename,parse,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
export function verifyUnit(root,platform){
 root=realpathSync(root);for(const rel of ['UNIT.json','engine','engine/payload.json','engine/package.json'])if(lstatSync(join(root,rel)).isSymbolicLink())throw Error('Unit links refused');const unit=JSON.parse(readFileSync(join(root,'UNIT.json'),'utf8'));
 if(unit.schema!=='kingmaker.unit/1'||unit.unit!=='kingmaker'||unit.platform!==platform||unit.arch!=='x64'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(unit.version))throw Error('Invalid UNIT.json');
 const engine=join(root,'engine'),manifest=JSON.parse(readFileSync(join(engine,'payload.json'),'utf8'));
 if(manifest.schema!=='kingmaker.payload/1'||manifest.version!==unit.version||JSON.parse(readFileSync(join(engine,'package.json'),'utf8')).version!==unit.version||!Array.isArray(manifest.files)||manifest.count!==manifest.files.length)throw Error('UNIT.json/payload.json version or count mismatch');
 const expected=new Set(['payload.json']);
 for(const e of manifest.files){
  if(typeof e.path!=='string'||e.path.includes('\\')||isAbsolute(e.path)||e.path.split('/').some(x=>!x||x==='.'||x==='..')||expected.has(e.path)||!Number.isSafeInteger(e.size)||e.size<0||!/^[a-f0-9]{64}$/.test(e.sha256))throw Error('Unsafe payload entry');
  expected.add(e.path);
 }
 const actual=new Set();const walk=(dir)=>{for(const n of readdirSync(dir)){const f=join(dir,n),s=lstatSync(f);if(s.isSymbolicLink())throw Error('Payload links refused');if(s.isDirectory())walk(f);else if(s.isFile())actual.add(relative(engine,f).split('\\').join('/'));else throw Error('Special payload entry refused');}};walk(engine);
 if(actual.size!==expected.size||[...actual].some(x=>!expected.has(x)))throw Error('Unlisted or missing payload file');
 for(const e of manifest.files){const data=readFileSync(join(engine,e.path));if(data.length!==e.size||createHash('sha256').update(data).digest('hex')!==e.sha256)throw Error('Payload integrity mismatch');}
 return unit;
}
export function safeDestination(dest,source,home=homedir()){
 dest=resolve(dest);const sourceInput=resolve(source);source=realpathSync(source);home=resolve(home);
 if(dest===sourceInput)throw Error('Refusing an unsafe Kingmaker install directory');
 if([parse(dest).root,home,source].includes(dest)||source.startsWith(dest+'/')||dest.startsWith(source+'/')||dest.length<8)throw Error('Refusing an unsafe Kingmaker install directory');
 let p=dest;while(true){if(existsSync(p)&&lstatSync(p).isSymbolicLink()&&!(process.platform==='darwin'&&p==='/var'&&realpathSync(p)==='/private/var'))throw Error('Refusing an unsafe Kingmaker install directory');const up=dirname(p);if(up===p)break;p=up;}
 const canonical=(path)=>{let p=path;const tail=[];while(!existsSync(p)){tail.unshift(basename(p));const up=dirname(p);if(up===p)break;p=up;}return join(realpathSync(p),...tail);};
 dest=canonical(dest);home=canonical(home);if([parse(dest).root,home,source].includes(dest)||source.startsWith(dest+'/')||dest.startsWith(source+'/'))throw Error('Refusing an unsafe Kingmaker install directory');
 if(existsSync(dest)){const m=JSON.parse(readFileSync(join(dest,'UNIT.json'),'utf8'));if(m.schema!=='kingmaker.unit/1'||m.unit!=='kingmaker')throw Error('Refusing an unsafe Kingmaker install directory');}
 return dest;
}
export function installLinux(source,dest,home=homedir()){
 verifyUnit(source,'linux');dest=safeDestination(dest,source,home);mkdirSync(dirname(dest),{recursive:true});
 const lock=dest+'.install-lock';mkdirSync(lock);const stage=dest+'.stage-'+process.pid,backup=dest+'.backup-'+process.pid;
 let moved=false,placed=false,stageOwned=false;const alias=join(home,'.local','bin','kingmaker'),target=join(dest,'kingmaker');
 try{
  if(existsSync(stage)||existsSync(backup))throw Error('Install staging path already exists');
  if(existsSync(alias)||(()=>{try{return lstatSync(alias).isSymbolicLink();}catch{return false;}})()){
   if(!lstatSync(alias).isSymbolicLink()||resolve(dirname(alias),readlinkSync(alias))!==target)throw Error('Refusing to replace an unrelated kingmaker command');
  }
  mkdirSync(stage);stageOwned=true;for(const name of readdirSync(source))cpSync(join(source,name),join(stage,name),{recursive:true,dereference:false,errorOnExist:true,force:false});verifyUnit(stage,'linux');
  if(existsSync(dest)){renameSync(dest,backup);moved=true;}
  renameSync(stage,dest);placed=true;mkdirSync(dirname(alias),{recursive:true});if(!existsSync(alias))symlinkSync(target,alias);
  if(moved)rmSync(backup,{recursive:true});return dest;
 }catch(e){if(placed)rmSync(dest,{recursive:true});if(moved&&existsSync(backup))renameSync(backup,dest);throw e;}
 finally{if(stageOwned&&existsSync(stage))rmSync(stage,{recursive:true});rmSync(lock,{recursive:true});}
}
if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
 try{
  if(Number(process.versions.node.split('.')[0])<24)throw Error('Node 24 or newer is required; no runtime will be downloaded automatically');
  const [mode,source,arg,home]=process.argv.slice(2);
  if(mode==='verify')console.log(JSON.stringify(verifyUnit(source,arg)));
  else if(mode==='safe-destination')console.log(safeDestination(arg,source,home));
  else if(mode==='install-linux')console.log(installLinux(source,arg,home));
  else throw Error('Unknown portable operation');
 }catch(e){console.error(e.message);process.exit(78);}
}
