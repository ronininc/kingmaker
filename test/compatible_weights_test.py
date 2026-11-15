import importlib.util,json,pathlib,struct,tempfile,unittest
s=importlib.util.spec_from_file_location('converter',pathlib.Path(__file__).resolve().parents[1]/'scripts/convert-compatible-weights.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class ConversionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.src=self.root/'input';self.out=self.root/'output'
 def tearDown(self):self.tmp.cleanup()
 def source(self,values=[1.125,-2.25],header=None):
  h=header or {'weight':{'dtype':'F32','shape':[len(values)],'data_offsets':[0,len(values)*4]}}
  b=json.dumps(h).encode();self.src.write_bytes(struct.pack('<Q',len(b))+b+struct.pack('<'+'f'*len(values),*values));return m.digest(self.src)
 def test_roundtrip(self):
  h=self.source();r=m.convert(self.src,self.out,h);self.assertEqual(r['tensor_count'],1);self.assertFalse(r['new_training']);self.assertEqual(r['max_abs_tensor_error'],0)
 def test_hash_pin(self):
  self.source()
  with self.assertRaisesRegex(ValueError,'SHA256'):m.convert(self.src,self.out,'0'*64)
 def test_budget(self):
  h=self.source()
  with self.assertRaisesRegex(ValueError,'budget'):m.convert(self.src,self.out,h,max_bytes=1)
 def test_no_overwrite(self):
  h=self.source();self.out.write_text('preserve')
  with self.assertRaises(ValueError):m.convert(self.src,self.out,h)
  self.assertEqual(self.out.read_text(),'preserve')
 def test_overflow(self):
  h=self.source([1e30])
  with self.assertRaisesRegex(ValueError,'overflow'):m.convert(self.src,self.out,h)
  self.assertFalse(self.out.exists())
 def test_nonfinite(self):
  h=self.source([float('nan')])
  with self.assertRaisesRegex(ValueError,'nonfinite'):m.convert(self.src,self.out,h)
 def test_error_tolerance(self):
  h=self.source([1.12345])
  with self.assertRaisesRegex(ValueError,'tolerance'):m.convert(self.src,self.out,h,max_abs_error=0)
 def test_bad_span(self):
  h=self.source(header={'w':{'dtype':'F32','shape':[1],'data_offsets':[0,100]}})
  with self.assertRaisesRegex(ValueError,'span'):m.convert(self.src,self.out,h)
 def test_overlap(self):
  spec={'dtype':'F32','shape':[2],'data_offsets':[0,8]};h=self.source(header={'a':spec,'b':spec})
  with self.assertRaisesRegex(ValueError,'overlapping'):m.convert(self.src,self.out,h)
 def test_unknown_architecture_dtype_not_guessed(self):
  h=self.source(header={'w':{'dtype':'NF4','shape':[2],'data_offsets':[0,8]}})
  with self.assertRaisesRegex(ValueError,'unsupported'):m.convert(self.src,self.out,h)
if __name__=='__main__':unittest.main()
