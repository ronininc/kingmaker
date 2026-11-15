import unittest, importlib.util, copy
from pathlib import Path
spec=importlib.util.spec_from_file_location('lighting_plan',Path(__file__).resolve().parents[1]/'assets/scene/lighting_plan.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def valid():
 return {'schema':m.SCHEMA,'units':'meters','camera':{'position':[0,-3,1], 'target':[0,0,1],'lensMm':50,'fStop':5.6},'lights':[{'name':'key','position':[-1,-1,2],'target':[0,0,1],'watts':150,'sizeMeters':1,'colorLinear':[1,.8,.6]}],'world':{'colorLinear':[.1,.1,.1],'strength':.2},'render':{'width':384,'height':384,'samples':32,'exposure':0}}
class TestPlan(unittest.TestCase):
 def test_valid(self): self.assertEqual(m.validate_plan(valid())['units'],'meters')
 def test_unsupported_code(self):
  p=valid();p['script']='print(1)'
  with self.assertRaises(ValueError):m.validate_plan(p)
 def test_nan(self):
  p=valid();p['lights'][0]['watts']=float('nan')
  with self.assertRaises(ValueError):m.validate_plan(p)
 def test_camera_degenerate(self):
  p=valid();p['camera']['target']=p['camera']['position']
  with self.assertRaises(ValueError):m.validate_plan(p)
 def test_resource_bounds(self):
  for key,value in [('samples',10000),('width',4096),('height',True)]:
   p=valid();p['render'][key]=value
   with self.assertRaises(ValueError):m.validate_plan(p)
 def test_units(self):
  p=valid();p['units']='centimeters'
  with self.assertRaises(ValueError):m.validate_plan(p)
 def test_light_duplicates(self):
  p=valid();p['lights'].append(copy.deepcopy(p['lights'][0]))
  with self.assertRaises(ValueError):m.validate_plan(p)
if __name__=='__main__':unittest.main()
