// Public HTTPS intake broker. Only response bytes cross into the disconnected review worker.
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
const denied=new net.BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(address,prefix,'ipv4');
const v6global=new net.BlockList();v6global.addSubnet('2000::',3,'ipv6');
for(const [address,prefix]of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])denied.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address) {
  const family=net.isIP(address);
  return family===4?!denied.check(address,'ipv4'):family===6&&v6global.check(address,'ipv6')&&!denied.check(address,'ipv6');
}
export function publicReviewURL(input) {
  if(typeof input!=='string'||input.length>4096||/[\0\r\n]/.test(input))throw Error('Drop one public HTTPS link.');
  let url;try{url=new URL(input.trim());}catch{throw Error('Drop a valid HTTPS webpage or repository link.');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||host.includes('%')||!host.includes('.')&&net.isIP(host)!==6||host.endsWith('.localhost')||host.endsWith('.local')||host==='localhost'||net.isIP(host)&&!isPublicAddress(host))throw Error('Only public HTTPS destinations on port 443 are accepted.');
  url.hash='';return url;
}
export async function fetchPublicBytes(input,{resolve=dns.lookup,request=https.request,maxBytes=16*1024*1024,allowPartial=false}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw Error('Review limit must be between 1 byte and 16 MiB.');
  const started=Date.now();let url=publicReviewURL(input);
  for(let hop=0;hop<=3;hop++) {
    if(Date.now()-started>15000)throw Error('Link intake timed out.');
    const host=url.hostname.replace(/^\[|\]$/g,'');
    let dnsTimer;
    const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await Promise.race([resolve(host,{all:true,verbatim:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('DNS lookup timed out.')),3000);dnsTimer.unref?.();})]).finally(()=>clearTimeout(dnsTimer));
    if(!addresses.length||addresses.length>32||addresses.some(entry=>!isPublicAddress(entry.address)))throw Error('The link resolves to a local, private or reserved address.');
    const pinned=addresses[0];
    const response=await new Promise((resolveResponse,reject)=>{
      let total=0,finished=false,deadline;const chunks=[];
      const fail=error=>{if(!finished){finished=true;clearTimeout(deadline);reject(error);}};
      const req=request({protocol:'https:',hostname:host,port:443,path:url.pathname+url.search,method:'GET',agent:false,rejectUnauthorized:true,
        servername:net.isIP(host)?undefined:host,headers:{accept:'text/html,text/plain,application/json,application/octet-stream','accept-encoding':'identity','user-agent':'Scripture-Armor-Review/1'},
        lookup:(_host,options,done)=>options?.all?done(null,[pinned]):done(null,pinned.address,pinned.family)},res=>{
        if([301,302,303,307,308].includes(res.statusCode)){finished=true;clearTimeout(deadline);res.destroy();if(!res.headers.location){reject(Error('Redirect location missing.'));return;}resolveResponse({redirect:res.headers.location});return;}
        if(res.statusCode<200||res.statusCode>=300){res.destroy();return fail(Error('The public link could not be retrieved. Authentication is not forwarded.'));}
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();return fail(Error('Compressed network responses are not accepted by this bounded intake.'));}
        res.on('data',chunk=>{
          if(finished)return;
          const contentType=String(res.headers['content-type']||'');
          if(total+chunk.length>maxBytes){
            if(allowPartial&&/^text\/(?:html|plain)(?:;|$)/i.test(contentType)){
              chunks.push(chunk.subarray(0,maxBytes-total));finished=true;clearTimeout(deadline);
              resolveResponse({bytes:Buffer.concat(chunks,maxBytes),contentType,url:url.href,truncated:true});res.destroy();req.destroy();return;
            }
            fail(Error('This response is larger than '+Math.ceil(maxBytes/1024/1024)+' MiB. No complete review was issued. Use a direct source-file link or submit individual files.'));req.destroy();res.destroy();return;
          }
          total+=chunk.length;chunks.push(chunk);
        });
        res.on('error',()=>fail(Error('Link response interrupted.')));
        res.on('aborted',()=>fail(Error('Link response interrupted.')));
        res.on('end',()=>{if(!finished){finished=true;clearTimeout(deadline);resolveResponse({bytes:Buffer.concat(chunks),contentType:String(res.headers['content-type']||''),url:url.href});}});
      });
      deadline=setTimeout(()=>{req.destroy();fail(Error('Link intake timed out.'));},Math.max(1,15000-(Date.now()-started)));
      req.setTimeout(Math.min(5000,Math.max(1,15000-(Date.now()-started))),()=>{req.destroy();fail(Error('Link intake timed out.'));});
      req.on('error',()=>fail(Error('Public HTTPS intake failed.')));req.end();
    });
    if(response.redirect){if(hop===3)throw Error('Too many link redirects.');url=publicReviewURL(new URL(response.redirect,url).href);continue;}
    if(!response.bytes?.length)throw Error('The linked response was empty.');return response;
  }
  throw Error('Link intake did not complete.');
}
export async function retrieveReviewLink(input,{fetchBytes=fetchPublicBytes}={}) {
  const url=publicReviewURL(input),match=url.hostname==='github.com'&&/^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(url.pathname);
  if(!match){const result=await fetchBytes(url.href,{allowPartial:true});return {...result,name:/html/i.test(result.contentType)?'webpage.html':'linked-content.data',source:{kind:'webpage',host:new URL(result.url).hostname,partial:result.truncated===true,scope:result.truncated?'Partial text review: first 16 MiB only. The remaining response was not inspected; no complete-page safety verdict is issued. No subresources, cookies or scripts were loaded.':'Single public response; no subresources, cookies or scripts were loaded.'}};}
  const owner=match[1],repo=match[2].replace(/\.git$/,''),base=`https://api.github.com/repos/${owner}/${repo}`;
  const readJSON=async endpoint=>{const r=await fetchBytes(endpoint,{maxBytes:1024*1024});return JSON.parse(r.bytes.toString('utf8'));};
  const commit=await readJSON(base+'/commits/HEAD'),sha=commit.sha,tree=commit.commit?.tree?.sha;
  if(!/^[a-f0-9]{40}$/.test(sha||'')||!/^[a-f0-9]{40}$/.test(tree||''))throw Error('Repository revision could not be pinned.');
  // Walk immutable trees separately instead of rejecting a large recursive inventory.
  // Only a display sample stays resident; the traversal stops on elapsed time.
  const files=[],pending=[{sha:tree,prefix:''}];let fileCount=0,readme=null,inventoryIncomplete=false;
  const until=Date.now()+45000;
  while(pending.length){
    if(Date.now()>=until){inventoryIncomplete=true;break;}
    const current=pending.shift();let listing;
    try{listing=await readJSON(base+'/git/trees/'+current.sha);}catch{inventoryIncomplete=true;break;}
    if(!Array.isArray(listing.tree))throw Error('Repository inventory response is invalid.');
    if(listing.truncated===true)inventoryIncomplete=true;
    for(const entry of listing.tree){
      if(typeof entry.path!=='string'||entry.path.length>1024||entry.path.split('/').includes('..')||/[\0\r\n\\]/.test(entry.path))continue;
      const full=current.prefix+entry.path;
      if(entry.type==='tree'&&/^[a-f0-9]{40}$/.test(entry.sha||'')){pending.push({sha:entry.sha,prefix:full+'/'});continue;}
      if(entry.type!=='blob'||entry.mode!=='100644')continue;
      fileCount++;const file={...entry,path:full};if(files.length<100)files.push(file);
      if(!current.prefix&&/^readme\.(md|txt|rst)$/i.test(entry.path))readme=file;
    }
  }
  let bytes=Buffer.from('No supported root README was found. Repository source files were not scanned.');
  if(readme) {
    const r=await fetchBytes(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${readme.path.split('/').map(encodeURIComponent).join('/')}`);bytes=r.bytes;
    const blob=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    if(blob!==readme.sha)throw Error('Repository README does not match the pinned Git blob.');
  }
  return {bytes,name:'repository-README.txt',source:{kind:'repository',repository:`${owner}/${repo}`,commit:sha,tree,
    fileCount,files:files.map(e=>({path:e.path,bytes:Number.isSafeInteger(e.size)?e.size:null})),
    inventoryLimited:inventoryIncomplete||fileCount>100,inventoryIncomplete,
    scope:(inventoryIncomplete?'Repository inventory stopped before completion. ':'')+'Pinned README review and file inventory only. This is not a scan of the whole repository or its dependencies. No checkout, install hooks, submodules or LFS downloads ran.'}};
}
