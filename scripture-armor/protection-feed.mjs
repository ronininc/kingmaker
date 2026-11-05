import fs from 'node:fs';
const FLAGS=fs.constants.O_NOFOLLOW||0,NONBLOCK=fs.constants.O_NONBLOCK||0;
export function appendProtectionFeed(file,event) {
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|FLAGS|NONBLOCK,0o600);
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||process.getuid&&stat.uid!==process.getuid())throw Error('unsafe protection feed');
    fs.writeSync(fd,JSON.stringify(event)+'\n');
  } finally {fs.closeSync(fd);}
}
export function readProtectionFeed(file) {
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|FLAGS|NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||process.getuid&&stat.uid!==process.getuid())return [];
    const count=Math.min(128*1024,stat.size),start=stat.size-count,buffer=Buffer.alloc(count);
    const read=fs.readSync(fd,buffer,0,count,start);
    let text=buffer.subarray(0,read).toString('utf8');
    if(start>0){const line=text.indexOf('\n');if(line<0)return [];text=text.slice(line+1);}
    return text.split('\n').filter(Boolean).slice(-100).reverse().flatMap(line=>{try{const event=JSON.parse(line);return event&&typeof event==='object'&&!Array.isArray(event)&&typeof event.message==='string'?[event]:[];}catch{return [];}});
  }catch{return [];}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
