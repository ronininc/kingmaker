"""Trusted fixed renderer. No evaluated source, dynamic imports, URLs or assets."""
import bpy, json, sys, math, hashlib, os
from pathlib import Path
from mathutils import Matrix, Vector
args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=3: raise ValueError('camera JSON, building JSON, new output directory required')
camera_path,building_path,out=map(lambda x:Path(x).resolve(),args)
if camera_path.stat().st_size>1000000 or building_path.stat().st_size>100000: raise ValueError('input budget')
if out.exists(): raise ValueError('output must be new')
if os.statvfs(out.parent).f_bavail*os.statvfs(out.parent).f_frsize<256*1024*1024: raise ValueError('disk reserve')
cameras=json.loads(camera_path.read_text());building=json.loads(building_path.read_text())
if cameras.get('schema')!='kingmaker.camera-orbit/1' or building.get('schema')!='kingmaker.original-building/1': raise ValueError('wrong schema')
if not 1<=len(cameras['cameras'])<=4 or not 1<=len(building['parts'])<=64: raise ValueError('count budget')
def finite(v):
 if not isinstance(v,(int,float)) or not math.isfinite(v) or abs(v)>10000: raise ValueError('invalid scalar')
 return v
for p in building['parts']:
 if p.get('type','box') not in ('box','text','wheel'): raise ValueError('unsupported primitive')
 if len(p['name'])>64: raise ValueError('name too long')
 for k in ('center','size','color'):
  if len(p[k])!=3: raise ValueError('vector')
  for v in p[k]: finite(v)
 if any(v<=0 or v>3 for v in p['size']) or any(v<0 or v>1 for v in p['color']): raise ValueError('geometry bounds')
K=cameras['K'];width=cameras['parameters']['width'];height=cameras['parameters']['height']
if width!=640 or height!=480 or abs(K[0][0]-K[1][1])>1e-6 or K[0][2]!=width/2 or K[1][2]!=height/2: raise ValueError('only centered square-pixel640x480 calibration supported in this proof')
for c in cameras['cameras']:
 if len(c['worldToCamera'])!=3 or any(len(r)!=4 for r in c['worldToCamera']): raise ValueError('camera dimensions')
 for r in c['worldToCamera']:
  for v in r: finite(v)
 R=Matrix([r[:3] for r in c['worldToCamera']]);check=R@R.transposed()
 if abs(R.determinant()-1)>1e-5 or any(abs(check[i][j]-(1 if i==j else 0))>1e-5 for i in range(3) for j in range(3)): raise ValueError('camera rotation invalid')
out.mkdir()
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=8
scene.render.threads_mode='FIXED';scene.render.threads=1
scene.render.resolution_x=256;scene.render.resolution_y=192;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.world=bpy.data.worlds.new('World');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.09,.12,.17,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.45
for p in building['parts']:
 if p.get('type')=='text':
  bpy.ops.object.text_add(location=p['center']);obj=bpy.context.object;obj.data.body=p['name'];obj.data.extrude=.001;obj.scale=p['size']
 elif p.get('type')=='wheel':
  bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=p['size'][0],depth=p['size'][2],location=p['center']);obj=bpy.context.object
 else:
  bpy.ops.mesh.primitive_cube_add(size=1,location=p['center']);obj=bpy.context.object;obj.scale=p['size']
 obj.name=p['name']
 mat=bpy.data.materials.new(p['name']);mat.diffuse_color=(*p['color'],1);mat.use_nodes=True
 bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(*p['color'],1);bsdf.inputs['Roughness'].default_value=.35;obj.data.materials.append(mat)
 if 'neon' in p['name'] or 'data-line' in p['name'] or p.get('type')=='text':
  bsdf.inputs['Emission Color'].default_value=(*p['color'],1);bsdf.inputs['Emission Strength'].default_value=2
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,-.73,0));bpy.context.object.scale=(200,.05,200)
for loc,energy,size in [((3,5,4),700,4),((-3,2,-4),400,3)]:
 data=bpy.data.lights.new('key','AREA');data.energy=energy;data.shape='DISK';data.size=size
 obj=bpy.data.objects.new('light',data);scene.collection.objects.link(obj);obj.location=loc;obj.rotation_euler=(Vector((0,0,0))-obj.location).to_track_quat('-Z','Y').to_euler()
data=bpy.data.cameras.new('learned-camera');data.type='PERSP';data.sensor_fit='HORIZONTAL';data.sensor_width=36;data.lens=K[0][0]*36/width
obj=bpy.data.objects.new('camera',data);scene.collection.objects.link(obj);scene.camera=obj
# Input uses CV +Y down,+Z forward. Blender camera +Y up,-Z forward.
cv_to_blender=Matrix.Diagonal((1,-1,-1,1));receipts=[]
for c in cameras['cameras']:
 world_to_cv=Matrix(c['worldToCamera']+[[0,0,0,1]])
 obj.matrix_world=world_to_cv.inverted()@cv_to_blender
 path=out/f"frame-{c['index']:03d}.png";scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)
 receipts.append({'cameraIndex':c['index'],'worldToCamera':c['worldToCamera'],'blenderCameraWorld':[[v for v in row] for row in obj.matrix_world],'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
receipt={'schema':'kingmaker.scene-composition-proof/1','status':'rendered','cameraSource':{'path':str(camera_path),'sha256':hashlib.sha256(camera_path.read_bytes()).hexdigest()},'buildingSource':{'path':str(building_path),'sha256':hashlib.sha256(building_path.read_bytes()).hexdigest()},'renderer':bpy.app.version_string,'size':[256,192],'artifacts':receipts,'qualityCertified':False,'limitations':['Original primitive building only; no photorealism or cinematic production claim.','Fixed trusted composition harness, not general autonomous scene generation.']}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2))
print('KINGMAKER_SCENE_PROOF_COMPLETE')
