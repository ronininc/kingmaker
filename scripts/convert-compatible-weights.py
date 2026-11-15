#!/usr/bin/env python3
"""Bounded, offline safetensors precision conversion, NOT architecture translation.
Preserves tensor names/shapes and non-floating types. Never loads executable pickle.
Output remains an unapproved candidate; no library admission or execution occurs.
"""
import argparse, hashlib, json, os, struct, tempfile
from pathlib import Path
import numpy as np
DTYPES={'F32':'<f4','F16':'<f2','F64':'<f8','I64':'<i8','I32':'<i4','I16':'<i2','I8':'i1','U8':'u1','BOOL':'?'}

def digest(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''): h.update(block)
 return h.hexdigest()

def convert(source, target, expected_sha256, *, dtype='F16', max_bytes=64*1024*1024, max_abs_error=0.02):
 source,target=Path(source),Path(target)
 if dtype not in ('F16','F32'): raise ValueError('target must be F16 or F32')
 if not 0 < max_bytes <= 256*1024*1024: raise ValueError('budget must be 1..256 MiB')
 if not np.isfinite(max_abs_error) or max_abs_error < 0: raise ValueError('invalid tolerance')
 if target.exists() or source.resolve()==target.resolve(): raise ValueError('output must be new')
 if source.stat().st_size > max_bytes: raise ValueError('input exceeds bounded conversion budget')
 if len(expected_sha256)!=64 or digest(source)!=expected_sha256: raise ValueError('source SHA256 mismatch')
 with source.open('rb') as f:
  prefix=f.read(8)
  if len(prefix)!=8: raise ValueError('truncated header')
  n=struct.unpack('<Q',prefix)[0]
  if not 2 <= n <= min(8*1024*1024,source.stat().st_size-8): raise ValueError('invalid header size')
  def unique(pairs):
   out={}
   for k,v in pairs:
    if k in out: raise ValueError('duplicate header key')
    out[k]=v
   return out
  header_bytes=f.read(n)
  header=json.loads(header_bytes,object_pairs_hook=unique)
  payload=f.read(max_bytes+1)
  if len(payload)>max_bytes or hashlib.sha256(prefix+header_bytes+payload).hexdigest()!=expected_sha256: raise ValueError("source changed during conversion")
 metadata=header.pop('__metadata__',{})
 if not isinstance(metadata,dict) or any(not isinstance(v,str) for v in metadata.values()): raise ValueError('invalid metadata')
 entries=[]
 for name,spec in header.items():
  if not isinstance(spec,dict) or spec.get('dtype') not in DTYPES: raise ValueError('unsupported tensor dtype')
  shape=spec.get('shape'); offsets=spec.get('data_offsets')
  if not isinstance(shape,list) or any(type(x)!=int or x<0 for x in shape): raise ValueError('invalid shape')
  count=1
  for x in shape: count*=x
  if not isinstance(offsets,list) or len(offsets)!=2 or any(type(x)!=int for x in offsets): raise ValueError('invalid offsets')
  a,b=offsets
  if a<0 or b<a or b>len(payload) or b-a!=count*np.dtype(DTYPES[spec['dtype']]).itemsize: raise ValueError('invalid tensor span')
  entries.append((a,b,name,spec))
 entries.sort()
 end=0
 for a,b,_,_ in entries:
  if a!=end: raise ValueError('gapped or overlapping tensor spans')
  end=b
 if end!=len(payload): raise ValueError('unclaimed tensor bytes')
 result={}; blocks=[]; offset=0; worst=0.0
 for a,b,name,spec in entries:
  values=np.frombuffer(payload[a:b],dtype=DTYPES[spec['dtype']])
  newtype=dtype if spec['dtype'].startswith('F') else spec['dtype']
  if spec['dtype'].startswith('F') and not np.isfinite(values).all(): raise ValueError('nonfinite source weights')
  with np.errstate(over='ignore'): converted=values.astype(DTYPES[newtype])
  if spec['dtype'].startswith('F'):
   if not np.isfinite(converted).all(): raise ValueError('precision overflow')
   error=float(np.max(np.abs(values.astype('float64')-converted.astype('float64')),initial=0))
   worst=max(worst,error)
   if error>max_abs_error: raise ValueError('precision error exceeds tolerance')
  block=converted.tobytes(); blocks.append(block)
  result[name]={'dtype':newtype,'shape':spec['shape'],'data_offsets':[offset,offset+len(block)]};offset+=len(block)
 result['__metadata__']={**metadata,'kingmaker.source_sha256':expected_sha256,'kingmaker.state':'unapproved-precision-candidate'}
 raw=json.dumps(result,separators=(',',':')).encode();raw+=b' '*((-len(raw))%8)
 total=8+len(raw)+offset
 if total>max_bytes: raise ValueError('output exceeds budget')
 free=os.statvfs(target.parent); available=free.f_bavail*free.f_frsize
 if available<total+64*1024*1024: raise ValueError('insufficient disk reserve')
 # Exclusive creation prevents replacing a source or another worker's output.
 try:
  with target.open('xb') as f:
   f.write(struct.pack('<Q',len(raw)));f.write(raw)
   for block in blocks:f.write(block)
   f.flush();os.fsync(f.fileno())
 except FileExistsError: raise
 except BaseException:
  target.unlink(missing_ok=True);raise
 return {'schema':'kingmaker.compatible-weight-conversion/1','source_sha256':expected_sha256,'output_sha256':digest(target),'tensor_count':len(entries),'output_bytes':total,'max_abs_tensor_error':worst,'target_float_dtype':dtype,'state':'awaiting-independent-evaluation','architecture_changed':False,'tokenizer_changed':False,'new_training':False,'runtime_compatibility':'not implied; operators, architecture and tokenizer require separate validation'}

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('source');p.add_argument('target');p.add_argument('--sha256',required=True);p.add_argument('--dtype',choices=['F16','F32'],default='F16');p.add_argument('--max-bytes',type=int,default=64*1024*1024);p.add_argument('--max-abs-error',type=float,default=.02)
 a=p.parse_args();print(json.dumps(convert(a.source,a.target,a.sha256,dtype=a.dtype,max_bytes=a.max_bytes,max_abs_error=a.max_abs_error),indent=2))
