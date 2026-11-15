"""Local integration tests; existing admitted checkpoint/runtime only, no downloads."""
import importlib.util,json,pathlib,subprocess,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1];RUNNER=ROOT/'scripts/run-local-streamed-kronos.py';EVIDENCE=ROOT.parent/'weight-adaptation-evidence'
class RunnerTests(unittest.TestCase):
 def request(self):return json.loads((EVIDENCE/'tokenizer-request.json').read_text())
 def call(self,request):
  with tempfile.TemporaryDirectory() as d:
   path=pathlib.Path(d)/'request.json';path.write_text(json.dumps(request));r=subprocess.run([sys.executable,str(RUNNER),'--request',str(path)],capture_output=True,text=True,timeout=35)
   return r.returncode,json.loads(r.stdout)
 def test_disabled(self):
  q=self.request();q['admission']['enabled']=False;code,r=self.call(q);self.assertNotEqual(code,0);self.assertIn('disabled',r['error'])
 def test_pin_mismatch(self):
  q=self.request();q['admission']['pins']['checkpoint_sha256']='0'*64;code,r=self.call(q);self.assertNotEqual(code,0);self.assertIn('pins',r['error'])
 def test_budget_rejected(self):
  q=self.request();q['budget']['threads']=999;code,r=self.call(q);self.assertNotEqual(code,0);self.assertIn('threads',r['error'])
 def test_rss_enforced(self):
  q=self.request();q['budget']['max_rss_bytes']=128*1024*1024;code,r=self.call(q);self.assertNotEqual(code,0);self.assertIn('RSS',r['error']);self.assertTrue(r['cleanup_completed'])
 def test_typed_shape(self):
  q=self.request();q['input']['values']=[[[0,1]]];code,r=self.call(q);self.assertNotEqual(code,0);self.assertIn('width',r['error']);self.assertTrue(r['cleanup_completed'])
 def test_corrupted_runtime_range_evicted(self):
  # Separate subprocess monkeypatches the local read transport after manifest verification.
  script='''import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
q=json.load(open(sys.argv[2]));original=m.os.pread;count=0
def bad(fd,n,offset):
 global count
 count+=1;b=original(fd,n,offset)
 if count==100 and b:b=bytes([b[0]^1])+b[1:]
 return b
m.os.pread=bad
try:m.run(q);raise AssertionError('corruption not rejected')
except ValueError as e:
 assert 'integrity' in str(e),str(e)
 assert e.cleanup_completed and e.remaining_weight_bytes==0
 print('rejected and evicted')
'''
  r=subprocess.run([sys.executable,'-c',script,str(RUNNER),str(EVIDENCE/'tokenizer-request.json')],capture_output=True,text=True,timeout=35);self.assertEqual(r.returncode,0,r.stderr);self.assertIn('evicted',r.stdout)
 def test_cancel_eviction(self):
  script="""import importlib.util,json,os,signal,sys
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
q=json.load(open(sys.argv[2]));original=m.os.pread;count=0
def cancel(fd,n,offset):
 global count
 count+=1
 if count==100:os.kill(os.getpid(),signal.SIGTERM)
 return original(fd,n,offset)
m.os.pread=cancel
try:m.run(q);raise AssertionError('cancellation missed')
except InterruptedError as e:
 assert e.cleanup_completed and e.remaining_weight_bytes==0
 print('cancelled and evicted')
"""
  r=subprocess.run([sys.executable,'-c',script,str(RUNNER),str(EVIDENCE/'tokenizer-request.json')],capture_output=True,text=True,timeout=35);self.assertEqual(r.returncode,0,r.stderr);self.assertIn('cancelled and evicted',r.stdout)
 def test_operational_matches_original(self):
  # Oracle uses the original implementation and standard safetensors loader,
  # separate from operational streaming subprocess. Never part of runtime.
  import torch
  from safetensors.torch import load_file
  q=self.request();sys.path.insert(0,q['paths']['repository']);from model.kronos import KronosTokenizer,Kronos
  torch.set_num_threads(2)
  for mode,Model in [('tokenizer',KronosTokenizer),('forecast',Kronos)]:
   q=json.loads((EVIDENCE/(mode+'-request.json')).read_text());code,r=self.call(q);self.assertEqual(code,0,r);self.assertTrue(r['cleanup_completed']);self.assertEqual(r['counts']['live_weight_bytes'],0)
   model=Model(**json.loads(pathlib.Path(q['paths']['config']).read_text())).eval();model.load_state_dict(load_file(q['paths']['checkpoint']),strict=True);d=q['input']
   with torch.inference_mode():
    if mode=='tokenizer':
     out=model(torch.tensor(d['values'],dtype=torch.float32));outputs=list(out[0])+list(out[1:])
    else:outputs=model(torch.tensor(d['s1_ids']),torch.tensor(d['s2_ids']),stamp=torch.tensor(d['stamp']),use_teacher_forcing=True,s1_targets=torch.tensor(d['s1_targets']))
   for actual,expected in zip(r['outputs'],outputs):torch.testing.assert_close(torch.tensor(actual,dtype=expected.dtype),expected,rtol=0,atol=0)
if __name__=='__main__':unittest.main()
