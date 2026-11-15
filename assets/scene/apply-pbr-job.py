"""Trusted local PBR material import, no source blend files, scripts or network."""
import bpy,json,sys,hashlib,os,struct
from pathlib import Path
args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=2: raise ValueError('job and new output directory required')
jobpath,out=map(lambda x:Path(x).resolve(),args)
if jobpath.stat().st_size>100000: raise ValueError('job budget')
j=json.loads(jobpath.read_text());root=Path(j['assetRoot']).resolve()
if j.get('schema')!='kingmaker.pbr-import/1' or j.get('normalConvention') not in ('OpenGL','DirectX'): raise ValueError('schema/convention')
if out.exists(): raise ValueError('new output directory required')
if os.statvfs(out.parent).f_bavail*os.statvfs(out.parent).f_frsize<256*1024*1024: raise ValueError('disk reserve')
channels={'baseColor','roughness','normal','metallic','displacement'}
if not j.get('maps',{}).get('baseColor') or not set(j['maps'])<=channels: raise ValueError('channels')
# Validate dimensions before passing bytes to the image decoder.
def dimensions(data):
 if data[:8]==b'\x89PNG\r\n\x1a\n': return struct.unpack('>II',data[16:24])
 if data[:2]!=b'\xff\xd8': raise ValueError('PNG/JPEG only')
 i=2
 while i<len(data):
  if data[i]!=255: raise ValueError('invalid JPEG marker')
  while i<len(data) and data[i]==255:i+=1
  marker=data[i];i+=1
  if marker in (0xd8,0xd9):continue
  if marker==0xda:break
  n=int.from_bytes(data[i:i+2],'big')
  if n<2 or i+n>len(data):raise ValueError('JPEG segment bounds')
  if marker in (0xc0,0xc1,0xc2):return (int.from_bytes(data[i+5:i+7],'big'),int.from_bytes(data[i+3:i+5],'big'))
  i+=n
 raise ValueError('JPEG dimensions absent')
verified={};total=0
for channel,a in j['maps'].items():
 p=(root/a['path']).resolve()
 if root not in p.parents or a['license'] not in ('CC0-1.0','CC-BY-4.0'): raise ValueError('containment/license')
 if p.stat().st_size!=a['bytes'] or a['bytes']>8*1024*1024:raise ValueError('byte bound')
 data=p.read_bytes();total+=len(data)
 if total>16*1024*1024 or hashlib.sha256(data).hexdigest()!=a['sha256']:raise ValueError('digest/budget')
 w,h=dimensions(data)
 if not 1<=w<=2048 or not 1<=h<=2048:raise ValueError('dimension budget')
 verified[channel]={'path':p,'data':data,'width':w,'height':h,'sha256':a['sha256']}
out.mkdir()
# Snapshot verified bytes; decoder never reopens mutable source paths.
for channel,a in verified.items():
 p=out/(channel+a['path'].suffix.lower());p.write_bytes(a.pop('data'));a['snapshot']=p
bpy.ops.wm.read_factory_settings(use_empty=True)
mat=bpy.data.materials.new('Verified PBR');mat.use_nodes=True;nodes=mat.node_tree.nodes;links=mat.node_tree.links;bsdf=nodes.get('Principled BSDF')
texcoord=nodes.new('ShaderNodeTexCoord')
for channel in sorted(verified,key=lambda c:c=='displacement'):
 a=verified[channel]
 image=bpy.data.images.load(str(a['snapshot']),check_existing=False)
 if tuple(image.size)!=(a['width'],a['height']):raise ValueError('decoded dimensions mismatch')
 image.colorspace_settings.name='sRGB' if channel=='baseColor' else 'Non-Color';image.pack()
 tex=nodes.new('ShaderNodeTexImage');tex.name='Verified-'+channel;tex.image=image;links.new(texcoord.outputs['UV'],tex.inputs['Vector'])
 if channel=='normal':
  normal=nodes.new('ShaderNodeNormalMap');normal.space='TANGENT'
  if j['normalConvention']=='DirectX':
   separate=nodes.new('ShaderNodeSeparateColor');combine=nodes.new('ShaderNodeCombineColor');invert=nodes.new('ShaderNodeMath');invert.operation='SUBTRACT';invert.inputs[0].default_value=1
   links.new(tex.outputs['Color'],separate.inputs[0]);links.new(separate.outputs['Green'],invert.inputs[1]);links.new(separate.outputs['Red'],combine.inputs['Red']);links.new(invert.outputs[0],combine.inputs['Green']);links.new(separate.outputs['Blue'],combine.inputs['Blue']);links.new(combine.outputs[0],normal.inputs['Color'])
  else:links.new(tex.outputs['Color'],normal.inputs['Color'])
  links.new(normal.outputs['Normal'],bsdf.inputs['Normal'])
 elif channel=='displacement':
  # Bump only, explicitly not arbitrary geometric displacement.
  bump=nodes.new('ShaderNodeBump');bump.inputs['Distance'].default_value=.01;links.new(tex.outputs['Color'],bump.inputs['Height'])
  existing=list(bsdf.inputs['Normal'].links)
  if existing:links.new(existing[0].from_socket,bump.inputs['Normal'])
  links.new(bump.outputs['Normal'],bsdf.inputs['Normal'])
 else:links.new(tex.outputs['Color'],bsdf.inputs[{'baseColor':'Base Color','roughness':'Roughness','metallic':'Metallic'}[channel]])
# Material datablock retained without manufacturing a misleading showcase scene.
mat.use_fake_user=True
bpy.ops.wm.save_as_mainfile(filepath=str(out/'material.blend'))
receipt={'schema':'kingmaker.pbr-import-receipt/1','status':'material-imported','renderer':bpy.app.version_string,'maps':[{ 'channel':k,'sha256':v['sha256'],'dimensions':[v['width'],v['height']],'colorSpace':'sRGB' if k=='baseColor' else 'Non-Color'} for k,v in verified.items()],'nodes':len(nodes),'links':len(links),'materialFile':str(out/'material.blend'),'materialSha256':hashlib.sha256((out/'material.blend').read_bytes()).hexdigest(),'attribution':j['attribution'],'qualityCertified':False,'limitations':['Material import only; no aesthetic validation or complete scene generated.','No mesh importer, arbitrary shader code, HDRI, UDIM or geometric displacement.']}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2));print('KINGMAKER_PBR_IMPORT_COMPLETE')
