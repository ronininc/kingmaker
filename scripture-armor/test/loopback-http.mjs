// Test-only transport. No DNS, TLS, redirects or non-loopback destination.
import http from 'node:http';
export function createLoopbackClient(origin) {
  const base=new URL(origin);
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password)throw Error('loopback fixture origin required');
  return (relative,options={})=>new Promise((resolve,reject)=>{
    const url=new URL(relative,base);
    if(url.origin!==base.origin)return reject(Error('fixture destination refused'));
    const request=http.request({hostname:'127.0.0.1',port:base.port,path:url.pathname+url.search,
      method:options.method||'GET',headers:options.headers||{},timeout:3000},response=>{
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){response.destroy();reject(Error('fixture response too large'));}else chunks.push(chunk);});
      response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
      response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(Error('fixture timeout')));request.on('error',reject);
    request.end(options.body);
  });
}
