#!/usr/bin/env python3
"""Admitted original Kronos CPU forward with local range reads; no oracle/downloads.
Memory is monitored, not an OS hard ceiling. Parent must enforce a kill timeout.
"""
import argparse,hashlib,json,math,os,pathlib,resource,signal,struct,sys,time,types
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
SOURCE={'kronos.py':'0a5f90282e2039c2de0771473419715c845def154896dbd0f5747837e6241032','module.py':'a07edbadc0e96804c8158c021bbc6063bb7cc43b34d7fc470d5c8ff2005a409f'}
KNOWN={'tokenizer':{'checkpoint_sha256':'59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee','config_sha256':'2366e7ccfec76cbc19cf3c4c1b9c5d901be336ca1e83f2d2292c9bff381b77a2'},'forecast':{'checkpoint_sha256':'b082dfcbd8e8c142a725c8bbb99781802f38fec81210e13479effb32b3c3e020','config_sha256':'5e0f6a605d5f81b5c9b559fe5cf716a1acb041c744e6f41bd05b097b7a685396'}}
def sha(b):return hashlib.sha256(b).hexdigest()
def check(value,message):
 if not value:raise ValueError(message)
def peak_rss():
 value=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
 return value if sys.platform=='darwin' else value*1024
def unique(pairs):
 out={}
 for k,v in pairs:check(k not in out,'duplicate JSON key');out[k]=v
 return out

def run(request):
 check(request.get('schema')=='kingmaker.local-streamed-kronos/1','invalid schema')
 admission=request.get('admission',{});check(admission.get('enabled') is True,'runtime disabled; explicit admission required')
 mode=request.get('mode');check(mode in KNOWN,'unsupported mode')
 pins=admission.get('pins',{});expected={**KNOWN[mode],'kronos_py_sha256':SOURCE['kronos.py'],'module_py_sha256':SOURCE['module.py']}
 check(pins==expected,'admission pins do not match reviewed architecture')
 budget=request.get('budget',{});threads=budget.get('threads',1);seconds=budget.get('deadline_seconds',15);rss=budget.get('max_rss_bytes',768*1024*1024)
 check(type(threads)==int and 1<=threads<=2,'threads outside1..2');check(type(seconds)==int and 1<=seconds<=30,'deadline outside1..30');check(type(rss)==int and 128*1024*1024<=rss<=768*1024*1024,'RSS budget outside128..768MiB')
 def alarm(signum,frame):raise TimeoutError('streaming deadline exceeded')
 old=signal.signal(signal.SIGALRM,alarm)
 def cancel(signum,frame):raise InterruptedError('local streaming cancelled')
 oldterm=signal.signal(signal.SIGTERM,cancel);signal.setitimer(signal.ITIMER_REAL,seconds)
 model=None;fd=None;hooks=[];counts={'range_reads':0,'weight_bytes_read':0,'live_weight_bytes':0,'peak_live_weight_bytes':0};loaded={};start=time.monotonic();seen=set()
 try:
  def guard():
   check(peak_rss()<=rss,'process peak RSS budget exceeded')
   if time.monotonic()-start>seconds:raise TimeoutError('streaming deadline exceeded')
  guard();paths=request.get('paths',{});repo=pathlib.Path(paths['repository']);cfg=pathlib.Path(paths['config']);check(cfg.stat().st_size<=65536,'config too large');config_bytes=cfg.read_bytes();check(sha(config_bytes)==expected['config_sha256'],'config hash mismatch');config=json.loads(config_bytes,object_pairs_hook=unique)
  code={}
  for name,pin in SOURCE.items():
   path=repo/'model'/name;check(path.stat().st_size<256*1024,'source too large');code[name]=path.read_bytes();check(sha(code[name])==pin,'source hash mismatch')
  import torch
  torch.set_num_threads(threads);torch.set_num_interop_threads(1);guard()
  # Compile verified bytes; never put an arbitrary repo on the import search path.
  package=types.ModuleType('model');package.__path__=[];sys.modules['model']=package
  for name in ('module.py','kronos.py'):
   fullname='model.'+name[:-3];module=types.ModuleType(fullname);module.__file__=str(repo/'model'/name);module.__package__='model';sys.modules[fullname]=module;exec(compile(code[name],module.__file__,'exec'),module.__dict__)
  module=sys.modules['model.kronos'];Model=module.KronosTokenizer if mode=='tokenizer' else module.Kronos
  data=request.get('input',{})
  def tensor(value,width=None,integer=False):
   check(isinstance(value,list) and len(value)==1 and isinstance(value[0],list) and 1<=len(value[0])<=16,'requires batch1 sequence1..16');flat=[]
   for row in value[0]:
    if width is not None:check(isinstance(row,list) and len(row)==width,'input width mismatch');flat.extend(row)
    else:flat.append(row)
   check(all(type(v)==int if integer else type(v) in (int,float) and math.isfinite(v) and abs(v)<=1e6 for v in flat),'invalid input numbers');return torch.tensor(value,dtype=torch.long if integer else torch.float32)
  if mode=='tokenizer':args=(tensor(data.get('values'),6),);kwargs={}
  else:
   s1=tensor(data.get('s1_ids'),integer=True);s2=tensor(data.get('s2_ids'),integer=True);targets=tensor(data.get('s1_targets'),integer=True);stamp=tensor(data.get('stamp'),5,True)
   check(s1.shape==s2.shape==targets.shape and stamp.shape[:2]==s1.shape,'sequence mismatch');check(all(bool(((v>=0)&(v<1024)).all()) for v in (s1,s2,targets)),'token IDs outside vocabulary');check(all(bool(((stamp[:,:,i]>=0)&(stamp[:,:,i]<lim)).all()) for i,lim in enumerate([60,24,7,32,13])),'timestamp outside embeddings');args=(s1,s2);kwargs={'stamp':stamp,'use_teacher_forcing':True,'s1_targets':targets}
  fd=os.open(paths['checkpoint'],os.O_RDONLY);size=os.fstat(fd).st_size;check(size<=128*1024*1024,'checkpoint exceeds budget');prefix=os.pread(fd,8,0);check(len(prefix)==8,'truncated checkpoint');n=struct.unpack('<Q',prefix)[0];check(n<=1024*1024,'header exceeds budget');raw=os.pread(fd,n,8);header=json.loads(raw,object_pairs_hook=unique);header.pop('__metadata__',None);base=8+n;manifest={};digest=hashlib.sha256(prefix+raw);end=0
  for name,spec in sorted(header.items(),key=lambda item:item[1]['data_offsets'][0]):
   lo,hi=spec['data_offsets'];check(lo==end and lo<=hi and hi-lo<=4*1024*1024 and base+hi<=size,'invalid tensor span');check(spec['dtype'] in ('F32','I64'),'unsupported tensor dtype');check(isinstance(spec['shape'],list) and all(type(v)==int and v>=0 for v in spec['shape']),'invalid shape');check(math.prod(spec['shape'])*(4 if spec['dtype']=='F32' else 8)==hi-lo,'shape span mismatch');block=os.pread(fd,hi-lo,base+lo);check(len(block)==hi-lo,'truncated tensor');digest.update(block);manifest[name]={**spec,'start':base+lo,'length':hi-lo,'sha256':sha(block)};end=hi;guard()
  check(base+end==size and digest.hexdigest()==expected['checkpoint_sha256'],'checkpoint hash mismatch');del block
  with torch.device('meta'):model=Model(**config).eval()
  if mode=='tokenizer':
   small=sys.modules['model.module'].BSQuantizer(**{k:config[k] for k in ('s1_bits','s2_bits','beta','gamma0','gamma','zeta','group_size')});model.tokenizer.bsq.group_codebook=small.bsq.group_codebook;del small
  state=model.state_dict();check(set(state)==set(manifest),'architecture tensor set mismatch')
  for key,value in state.items():check(list(value.shape)==manifest[key]['shape'],'architecture shape mismatch')
  del state
  def evict(mod,names):
   for key in names:
    attr=key.rsplit('.',1)[-1];old_value=getattr(mod,attr);empty=torch.empty(old_value.shape,dtype=old_value.dtype,device='meta')
    if attr in mod._parameters:setattr(mod,attr,torch.nn.Parameter(empty,requires_grad=False))
    else:setattr(mod,attr,empty)
    if key in loaded:counts['live_weight_bytes']-=loaded.pop(key)
  for path,mod in model.named_modules():
   names=[key for key in manifest if key.rpartition('.')[0]==path]
   if not names:continue
   def before(mod,args,names=names):
    guard()
    for key in names:
     d=manifest[key];block=bytearray(os.pread(fd,d['length'],d['start']));check(len(block)==d['length'] and sha(block)==d['sha256'],'tensor range integrity failure');value=torch.frombuffer(block,dtype=torch.float32 if d['dtype']=='F32' else torch.int64).reshape(d['shape']);check(bool(torch.isfinite(value).all()),'nonfinite tensor');attr=key.rsplit('.',1)[-1]
     if attr in mod._parameters:setattr(mod,attr,torch.nn.Parameter(value,requires_grad=False))
     else:setattr(mod,attr,value)
     loaded[key]=len(block);counts['live_weight_bytes']+=len(block);counts['peak_live_weight_bytes']=max(counts['peak_live_weight_bytes'],counts['live_weight_bytes']);counts['range_reads']+=1;counts['weight_bytes_read']+=len(block);seen.add(key)
    guard()
   def after(mod,args,out,names=names):evict(mod,names)
   hooks.append(mod.register_forward_pre_hook(before));hooks.append(mod.register_forward_hook(after,always_call=True))
  guard()
  with torch.inference_mode():output=model(*args,**kwargs)
  guard();flat=list(output) if mode=='forecast' else list(output[0])+list(output[1:]);check(all(bool(torch.isfinite(v).all()) for v in flat),'nonfinite output');check(len(seen)==len(manifest),'not all expected tensors executed');check(counts['live_weight_bytes']==0,'weight eviction incomplete')
  return {'schema':'kingmaker.local-streamed-kronos-result/1','ok':True,'mode':mode,'input_bindings':expected,'input_sha256':sha(json.dumps(data,sort_keys=True,separators=(',',':'),allow_nan=False).encode()),'runtime':{'python':sys.version.split()[0],'torch':torch.__version__,'device':'cpu'},'transport':'local file ranges, no external fetch','counts':{**counts,'startup_integrity_bytes_read':size},'process_peak_rss_bytes':peak_rss(),'elapsed_seconds':time.monotonic()-start,'output_shapes':[list(v.shape) for v in flat],'outputs':[v.tolist() for v in flat],'scope':'bounded original forward only; forecast teacher-forced, not autoregressive quality validation','admission':'local execution only; not publication/library admission'}
 finally:
  failure=sys.exc_info()[1]
  signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old);signal.signal(signal.SIGTERM,oldterm)
  if model is not None:
   for mod in model.modules():
    for name,value in list(mod._parameters.items()):
     if value is not None:mod._parameters[name]=torch.nn.Parameter(torch.empty(value.shape,dtype=value.dtype,device='meta'),requires_grad=False)
    for name,value in list(mod._buffers.items()):
     if value is not None:mod._buffers[name]=torch.empty(value.shape,dtype=value.dtype,device='meta')
  for hook in hooks:hook.remove()
  loaded.clear();counts['live_weight_bytes']=0
  if fd is not None:os.close(fd)
  if failure is not None:
   failure.cleanup_completed=True;failure.remaining_weight_bytes=counts['live_weight_bytes']

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',required=True);a=parser.parse_args()
 try:
  path=pathlib.Path(a.request);check(path.stat().st_size<=65536,'request exceeds64KiB');request=json.loads(path.read_text(),object_pairs_hook=unique);result=run(request);result['cleanup_completed']=True;print(json.dumps(result,allow_nan=False))
 except Exception as e:
  print(json.dumps({'schema':'kingmaker.local-streamed-kronos-result/1','ok':False,'error_type':type(e).__name__,'error':str(e),'cleanup_completed':getattr(e,'cleanup_completed',False),'remaining_weight_bytes':getattr(e,'remaining_weight_bytes',None)}));sys.exit(1)
