// Content inspection only. No uploaded script, macro, command or entity runs.
import zlib from 'node:zlib';
import {classifyBuffer} from './scan.mjs';
import {agnosticAugment} from './format-inspect.mjs'; // ITEM 9 port (UNAPPLIED work copy): named coverage for formats this reader did not inspect
const MAX=16*1024*1024,EXPANDED=4*1024*1024;
const utf8=b=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(b).replace(/^\uFEFF/,'');}catch{return null;}};
const privateMaterial=text=>/"(?:seal_priv|sign_priv|kem_priv|mldsa_priv)"\s*:|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text);
function xmlText(text){return text.replace(/<[^>]{0,8192}>/g,' ').replace(/&(?:lt|gt|amp|quot|apos);/g,s=>({'&lt;':'<','&gt;':'>','&amp;':'&','&quot;':'"','&apos;':"'"}[s]));}
// Nested-archive recursion bounds (Item 3, wall (c)): entries of the
// uploaded archive are level 1; an archive entry at levels 1..3 is
// expanded in memory, an archive entry at level 4 is named as a
// shortfall instead of being silently inventoried. The 4 MiB expanded
// budget is shared across ALL levels. Extraction is in-memory only,
// inside this disposable review scope; nothing is written to disk and
// every entry name at every level passes the same traversal checks
// the top level has always applied.
export const ARCHIVE_MAX_DEPTH=3;
function safeEntryName(name){return typeof name==='string'&&name.length>0&&name.length<=1024&&!name.includes('\0')&&!name.startsWith('/')&&!name.includes('\\')&&!name.split('/').includes('..');}
function archiveKindOf(b){
  if(b.length>3&&b[0]===0x50&&b[1]===0x4b&&(b[2]===3||b[2]===5||b[2]===7))return 'zip';
  if(b.length>1&&b[0]===0x1f&&b[1]===0x8b)return 'gzip';
  if(b.length>=265&&b.subarray(257,262).toString('ascii')==='ustar')return 'tar';
  return null;
}
function zipEntries(bytes,budget={used:0,limit:EXPANDED}) {
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('archive directory missing');
  const count=bytes.readUInt16LE(end+10),start=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
  if(count>128||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||start+size>end)throw Error('archive limits or unsupported multi-volume format');
  let cursor=start;const entries=[];
  for(let i=0;i<count;i++) {
    if(cursor+46>start+size||bytes.readUInt32LE(cursor)!==0x02014b50)throw Error('invalid archive directory');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24);
    const nameLen=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nameLen+extra+comment>start+size)throw Error('truncated archive name');
    const name=utf8(bytes.subarray(cursor+46,cursor+46+nameLen));cursor+=46+nameLen+extra+comment;
    if(!safeEntryName(name))throw Error('unsafe archive entry');
    if(flags&1)throw Error('encrypted archive');
    if(![0,8].includes(method)||length>EXPANDED||length>Math.max(4096,compressed*200)||(budget.used+=length)>budget.limit)throw Error('archive expansion limit or unsupported compression');
    if(offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('invalid archive entry header');
    const dataAt=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
    if(dataAt+compressed>start)throw Error('archive entry overlaps directory');
    const packed=bytes.subarray(dataAt,dataAt+compressed),data=method===0?Buffer.from(packed):zlib.inflateRawSync(packed,{maxOutputLength:EXPANDED});
    if(data.length!==length)throw Error('archive length mismatch');
    entries.push({name,data});
  }
  return entries;
}
function tarEntries(bytes,budget) {
  const entries=[];let off=0;
  while(off+512<=bytes.length) {
    const block=bytes.subarray(off,off+512);
    if(block.every((x)=>x===0))break;
    const rawName=block.subarray(0,100).toString('utf8').replace(/\0.*$/s,'');
    const prefix=block.subarray(345,500).toString('utf8').replace(/\0.*$/s,'');
    const name=prefix?prefix+'/'+rawName:rawName;
    const size=parseInt(block.subarray(124,136).toString('ascii').replace(/[^0-7]/g,''),8)||0;
    if(!rawName)break;
    if(!safeEntryName(name))throw Error('unsafe archive entry');
    if(off+512+size>bytes.length)throw Error('truncated archive entry');
    if((budget.used+=size)>budget.limit)throw Error('archive expansion limit');
    entries.push({name,data:Buffer.from(bytes.subarray(off+512,off+512+size))});
    off+=512+Math.ceil(size/512)*512;
  }
  if(!entries.length)throw Error('archive directory missing');
  return entries;
}
function expandArchive(bytes,kind,ctx) {
  if(kind==='zip')return zipEntries(bytes,ctx.budget);
  if(kind==='tar')return tarEntries(bytes,ctx.budget);
  // gzip wraps a single inner stream; decompress within the budget left.
  const remaining=Math.max(0,ctx.budget.limit-ctx.budget.used);
  let inner;
  try{inner=zlib.gunzipSync(bytes,{maxOutputLength:remaining});}
  catch(error){throw Error(error&&error.code==='ERR_BUFFER_TOO_LARGE'?'archive expansion limit':'gzip stream unreadable');}
  ctx.budget.used+=inner.length;
  return [{name:'(gzip content)',data:inner}];
}
// One archive entry at any depth: nested archives recurse (bounded),
// everything else follows the same text/private-material/XXE handling
// the top level has always applied. Display names carry the nesting
// path (outer.zip!inner.zip!file) so findings locate their layer.
function collectEntry(entry,displayName,depth,ctx) {
  const {result}=ctx;
  if(/vbaProject\.bin$|\.exe$|\.dll$|\.app\//i.test(entry.name))result.activeContent=true;
  const kind=archiveKindOf(entry.data);
  if(kind) {
    if(depth>ARCHIVE_MAX_DEPTH) {
      ctx.shortfalls.push({kind:'archive-depth',path:displayName,depth,limit:ARCHIVE_MAX_DEPTH,disposition:'not-expanded',detail:`nested ${kind} archive at level ${depth}; the depth bound (${ARCHIVE_MAX_DEPTH}) is reached — its contents were not extracted or scanned`});
      result.limitations.push(`Nested archive not expanded (depth bound ${ARCHIVE_MAX_DEPTH}): ${displayName}`);
      return;
    }
    let inner;
    try{inner=expandArchive(entry.data,kind,ctx);}
    catch(error){
      ctx.shortfalls.push({kind:'archive-unreadable',path:displayName,disposition:'not-expanded',detail:`nested ${kind} archive could not be expanded: ${error.message}`});
      result.limitations.push(`Nested archive could not be expanded: ${displayName} (${error.message})`);
      return;
    }
    for(const sub of inner)collectEntry(sub,`${displayName}!${sub.name}`,depth+1,ctx);
    return;
  }
  const text=utf8(entry.data);
  if(text===null||text.includes('\0'))return;
  if(privateMaterial(text)){result.format='Sensitive key material';result.limitations.push('Private key material inside the archive was withheld from preview.');return;}
  if(/<!DOCTYPE|<!ENTITY/i.test(text)){result.activeContent=true;result.limitations.push('XML external entities are not resolved.');return;}
  result.texts.push({name:displayName,text:/\.xml$/i.test(entry.name)?xmlText(text):text});
}
export function inspectAgnostic(bytes,name='uploaded-file') {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX)throw Error('empty or oversized file');
  const header=bytes.subarray(0,16).toString('latin1'),kind=classifyBuffer(bytes.subarray(0,16384),name);
  const result={format:'unknown',kind:'data',texts:[],limitations:[],shortfalls:[],activeContent:false,commandAuthority:false};
  if(header.startsWith('%PDF-')) {
    result.format='PDF';result.limitations.push('PDF structure recognized; full document and embedded-object analysis is not available in this reader.');
    const text=bytes.toString('latin1');result.activeContent=/\/JavaScript\b|\/JS\b|\/OpenAction\b|\/Launch\b/.test(text);
    if(/\/Encrypt\b/.test(text)){result.limitations.push('Encrypted PDF content cannot be inspected.');return result;}
    // ITEM 9 port: structure/text-layer detail (page objects, action
    // flags, inflated-stream coverage) from the format lane.
    const aug=agnosticAugment(bytes,name);
    if(aug){result.limitations.push(...aug.limitations);if(aug.activeContent)result.activeContent=true;}
    return result;
  }
  if(header.startsWith('PK\x03\x04')||header.startsWith('PK\x05\x06')) {
    result.format='ZIP archive';
    try {
      const ctx={result,budget:{used:0,limit:EXPANDED},shortfalls:result.shortfalls};
      const entries=zipEntries(bytes,ctx.budget);result.entries=entries.length;
      if(entries.some(e=>e.name==='word/document.xml'))result.format='DOCX';
      else if(entries.some(e=>e.name==='xl/workbook.xml'))result.format='XLSX';
      else if(entries.some(e=>e.name.startsWith('ppt/slides/')))result.format='PPTX';
      else if(entries.some(e=>e.name==='content.xml'))result.format='OpenDocument';
      for(const entry of entries)collectEntry(entry,entry.name,1,ctx);
      result.limitations.push(`Archive and document extraction is bounded (nested archives expanded to depth ${ARCHIVE_MAX_DEPTH}, ${EXPANDED} bytes expanded in total); opaque objects and image content require additional review.`);
    }catch(error){result.limitations.push(error.message);}
    return result;
  }
  const topKind=archiveKindOf(bytes);
  if(topKind==='tar'||topKind==='gzip') {
    result.format=topKind==='tar'?'TAR archive':'GZIP archive';
    try {
      const ctx={result,budget:{used:0,limit:EXPANDED},shortfalls:result.shortfalls};
      const entries=expandArchive(bytes,topKind,ctx);result.entries=entries.length;
      for(const entry of entries)collectEntry(entry,entry.name,1,ctx);
      result.limitations.push(`Archive extraction is bounded (nested archives expanded to depth ${ARCHIVE_MAX_DEPTH}, ${EXPANDED} bytes expanded in total); opaque objects and image content require additional review.`);
    }catch(error){result.limitations.push(error.message);}
    return result;
  }
  if(kind==='binary'){result.kind='binary';result.format=header.startsWith('\x7fELF')?'ELF executable':header.startsWith('MZ')?'PE executable':'Native binary';return result;}
  if(header.startsWith('\x89PNG')||header.startsWith('\xff\xd8\xff')||header.startsWith('GIF8')||header.startsWith('RIFF')){
    // ITEM 9 port: named format + metadata-level inspection (chunks/
    // markers/boxes, trailing-data check) instead of signature-only.
    const aug=agnosticAugment(bytes,name);
    if(aug){result.format=aug.format;result.limitations.push(...aug.limitations);return result;}
    result.format='Image/media';result.limitations.push('Media signature recognized; image/media payload review requires an additional parser.');return result;
  }
  const text=utf8(bytes);
  if(text===null||text.includes('\0')){
    // ITEM 9 port: name the format and the reason before falling back
    // to the generic opaque line (TAR/GZIP listings, RAR/7z/OLE named
    // unsupported, WASM/unknown-binary header indicators).
    const aug=agnosticAugment(bytes,name);
    if(aug){result.format=aug.format;result.limitations.push(...aug.limitations);if(aug.activeContent)result.activeContent=true;return result;}
    result.limitations.push('Opaque or unsupported binary data; not classified as clean.');return result;}
  if(privateMaterial(text)){
    result.format='Sensitive key material';result.limitations.push('Private key material is not accepted for ordinary file review.');return result;
  }
  result.format=kind==='source'?'Source text':'Text';result.kind=kind;
  const trim=text.trim();
  if(/<(?:!doctype\s+html|html|body)\b/i.test(text)){
    result.format='HTML';result.activeContent=/<(?:script|iframe|object|embed)\b|\bon[a-z]+\s*=/i.test(text);
    result.limitations.push('HTML is inspected and displayed as inert text only. Scripts, subresources and embedded objects are not loaded.');
  }else if(trim.startsWith('{')||trim.startsWith('[')){try{JSON.parse(trim);result.format='JSON';}catch{result.limitations.push('Invalid JSON-like text.');}}
  else if(kind!=='source'&&/^[^\r\n]*\t/.test(text))result.format='TSV';
  else if(kind!=='source'&&/^[^\r\n]*[,;]/.test(text))result.format='Delimited text';
  result.texts.push({name,text});return result;
}
