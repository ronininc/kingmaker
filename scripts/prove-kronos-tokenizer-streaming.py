"""Existing-source, CPU-only full Kronos tokenizer streaming proof. No model downloads.
Requires the owner's already installed Kronos source and torch/safetensors environment.
Not an LLM, forecasting accuracy, or production streaming runtime proof.
"""
import os
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
import argparse,hashlib,http.server,json,pathlib,struct,sys,threading,urllib.request,gc,time
import resource,subprocess
import torch
from safetensors.torch import load_file
p=argparse.ArgumentParser();p.add_argument('repo');p.add_argument('checkpoint');p.add_argument('config');p.add_argument('--forecast',action='store_true');a=p.parse_args()
torch.set_num_threads(2);torch.set_num_interop_threads(1)
sys.path.insert(0,a.repo)
from model.kronos import KronosTokenizer, Kronos
Model=Kronos if a.forecast else KronosTokenizer
from model.module import BSQuantizer
config=json.loads(pathlib.Path(a.config).read_text());checkpoint=pathlib.Path(a.checkpoint)
assert checkpoint.stat().st_size<128*1024*1024
with checkpoint.open('rb') as f:
 n=struct.unpack('<Q',f.read(8))[0];assert n<1024*1024;header=json.loads(f.read(n))
header.pop('__metadata__',None);base=8+n
# Trust originates in the existing local source, not hashes supplied by a remote server.
manifest={}
with checkpoint.open('rb') as f:
 for name,v in header.items():
  lo,hi=v['data_offsets'];assert 0<=lo<=hi<=checkpoint.stat().st_size-base
  assert hi-lo<=4*1024*1024;f.seek(base+lo);b=f.read(hi-lo)
  manifest[name]={**v,'start':base+lo,'length':hi-lo,'sha256':hashlib.sha256(b).hexdigest()}
del b
x=torch.linspace(-1,1,48).reshape(1,8,6)
def forward(model):
 if a.forecast:
  ids=torch.arange(8).reshape(1,8)
  return model(ids,ids+1,stamp=torch.zeros(1,8,5,dtype=torch.long),use_teacher_forcing=True,s1_targets=ids+2)
 return model(x)
def flatten(out):return list(out) if a.forecast else list(out[0])+list(out[1:])
with torch.inference_mode():
 oracle_model=Model(**config).eval();oracle_model.load_state_dict(load_file(str(checkpoint)),strict=True)
 reference=[v.clone() for v in flatten(forward(oracle_model))]
del oracle_model;gc.collect()
# Cold construct checkpoint tensors on meta: no full parameter allocation.
with torch.device('meta'):
 model=Model(**config).eval()
# Original quantizer has one tiny derived, nonpersistent buffer. Rebuild using
# its original CPU implementation; no model parameters or downloaded weights.
if not a.forecast:
 small=BSQuantizer(**{k:config[k] for k in ('s1_bits','s2_bits','beta','gamma0','gamma','zeta','group_size')})
 model.tokenizer.bsq.group_codebook=small.bsq.group_codebook
 del small
assert all(p.device.type=='meta' for p in model.parameters())
def rss():return int(subprocess.check_output(['ps','-o','rss=','-p',str(os.getpid())]).strip())*1024
rss_before=rss()
counts={'requests':0,'bytes':0,'live':0,'peak':0,'verified':0};seen=set()
allowed={f"bytes={d['start']}-{d['start']+d['length']-1}":d for d in manifest.values()}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  d=allowed.get(self.headers.get('Range'))
  if self.path!='/weights' or not d:self.send_error(416);return
  with checkpoint.open('rb') as f:f.seek(d['start']);data=f.read(d['length'])
  self.send_response(206);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
url=f'http://127.0.0.1:{server.server_port}/weights';dtype={'F32':torch.float32,'I64':torch.int64}
try:
 for path,module in model.named_modules():
  names=[key for key in manifest if key.rpartition('.')[0]==path]
  if not names:continue
  def evict(mod,names=names):
   for key in names:
    attr=key.rsplit('.',1)[-1];old=getattr(mod,attr);empty=torch.empty(old.shape,dtype=old.dtype,device='meta')
    if attr in mod._parameters:setattr(mod,attr,torch.nn.Parameter(empty,requires_grad=False))
    else:setattr(mod,attr,empty)
  evict(module)
  def before(mod,args,names=names):
   for key in names:
    d=manifest[key];request=urllib.request.Request(url,headers={'Range':f"bytes={d['start']}-{d['start']+d['length']-1}"})
    with urllib.request.urlopen(request,timeout=10) as r:
     assert r.status==206;data=bytearray(r.read(d['length']+1))
    assert len(data)==d['length'] and hashlib.sha256(data).hexdigest()==d['sha256']
    value=torch.frombuffer(data,dtype=dtype[d['dtype']]).reshape(d['shape'])
    attr=key.rsplit('.',1)[-1]
    if attr in mod._parameters:setattr(mod,attr,torch.nn.Parameter(value,requires_grad=False))
    else:setattr(mod,attr,value)
    counts['requests']+=1;counts['bytes']+=len(data);counts['verified']+=1;counts['live']+=len(data);counts['peak']=max(counts['peak'],counts['live']);seen.add(key)
  def after(mod,args,output,names=names,evict=evict):
   evict(mod);counts['live']-=sum(manifest[k]['length'] for k in names)
  module.register_forward_pre_hook(before);module.register_forward_hook(after)
 start=time.monotonic()
 with torch.inference_mode():actual=forward(model)
 elapsed=time.monotonic()-start
 pairs=list(zip(reference,flatten(actual)));errors=[]
 for ref,out in pairs:
  assert torch.isfinite(out).all();error=float((ref-out).abs().max());assert error<=1e-6;errors.append(error)
 assert counts['live']==0 and len(seen)==len(manifest)
 assert all(p.device.type=='meta' for p in model.parameters())
 def sha(path):
  h=hashlib.sha256()
  with open(path,'rb') as f:
   for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
  return h.hexdigest()
 bindings={'checkpoint_sha256':sha(checkpoint),'config_sha256':sha(a.config),'kronos_py_sha256':sha(pathlib.Path(a.repo)/'model/kronos.py'),'module_py_sha256':sha(pathlib.Path(a.repo)/'model/module.py')}
 result={'input_bindings':bindings,'cold_parameter_construction':'meta tensors; only tiny original derived quantizer buffer constructed on CPU','rss_before_stream_bytes':rss_before,'rss_after_stream_bytes':rss(),'process_peak_rss_bytes_including_oracle':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'scope':('Complete original Kronos.forward teacher-forced, 8-step synthetic tokens and timestamps, both logit heads' if a.forecast else 'Complete original KronosTokenizer.forward; 8-step synthetic numerical input, both reconstruction branches, quantization, indices and loss'),'not_proven':['autoregressive market forecast/task quality','LLM inference','Blender','production remote streaming','task quality'], 'device':'CPU, two threads','transport':'ephemeral loopback HTTP byte ranges, no external downloads','checkpoint_bytes':checkpoint.stat().st_size,'unique_checkpoint_tensors_executed':len(seen),'total_checkpoint_tensors':len(manifest),'counts':counts,'seconds':elapsed,'max_abs_output_errors':errors,'oracle':'Original full-checkpoint safetensors PyTorch load and original forward versus same original architecture with per-module fetch/eviction','all_parameters_evicted_after_forward':True,'memory_note':'peak counts checkpoint tensor payload residency only, not activations, framework allocator or process RSS'}
 print(json.dumps(result,indent=2))
finally:server.shutdown();server.server_close();thread.join()
