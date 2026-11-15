"""Controlled original surface-field test. No imported assets, no quality certification."""
import bpy,sys,json,hashlib,time
from pathlib import Path
from mathutils import Vector
root=Path(sys.argv[sys.argv.index('--')+1]).resolve();out=root/'renders'
if out.exists():raise ValueError('new output required')
out.mkdir();bpy.ops.wm.read_factory_settings(use_empty=True);scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=32;scene.render.threads_mode='FIXED';scene.render.threads=4;scene.render.resolution_x=384;scene.render.resolution_y=384;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.view_settings.view_transform='AgX'
scene.world=bpy.data.worlds.new('world');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[1].default_value=.15
bpy.ops.object.camera_add(location=(.65,-1.4,.65));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.4))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=62;scene.camera=cam
light=bpy.data.lights.new('controlled-light','AREA');light.energy=60;light.size=.6;l=bpy.data.objects.new('controlled-light',light);scene.collection.objects.link(l)
receipts=[]
for name in ['neutral','conditioned']:
 p=json.loads((root/name/'record.json').read_text())['parameters'];m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes;links=m.node_tree.links;bsdf=n.get('Principled BSDF')
 for ch,sock in [('base-color','Base Color'),('roughness','Roughness')]:
  t=n.new('ShaderNodeTexImage');t.image=bpy.data.images.load(str(root/name/(ch+'.png')));t.image.colorspace_settings.name='sRGB' if ch=='base-color' else 'Non-Color';links.new(t.outputs['Color'],bsdf.inputs[sock])
 h=bpy.data.images.load(str(root/name/'height.png'));h.colorspace_settings.name='Non-Color';pixels=list(h.pixels);N=64;verts=[];uv=[];faces=[]
 for y in range(N+1):
  for x in range(N+1):
   u=x/N;v=y/N;sample=pixels[(round(v*127)*128+round(u*127))*4];offset=(sample-1)*p['heightLimitMeters'];verts.append(((u-.5)*.4,-offset,v*.8));uv.append((u,v))
 for y in range(N):
  for x in range(N):
   a=y*(N+1)+x;faces.append((a,a+1,a+N+2,a+N+1))
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update();layer=mesh.uv_layers.new()
 for face in mesh.polygons:
  for i in face.loop_indices:layer.data[i].uv=uv[mesh.loops[i].vertex_index]
 obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj);obj.data.materials.append(m)
 for direction,loc in [('left',(-.7,-.8,1.1)),('right',(.7,-.8,1.1))]:
  l.location=loc;l.rotation_euler=(Vector((0,0,.4))-l.location).to_track_quat('-Z','Y').to_euler();path=out/(name+'-'+direction+'.png');scene.render.filepath=str(path);bpy.ops.render.render(write_still=True);receipts.append({'variant':name,'light':direction,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'path':str(path),'maxGeometryOffsetMeters':max(abs(v[1]) for v in verts)})
 bpy.data.objects.remove(obj,do_unlink=True)
(out/'receipt.json').write_text(json.dumps({'schema':'kingmaker.surface-condition-proof/1','artifacts':receipts,'qualityCertified':False,'scope':'controlled rectangular patches under two light directions, not photorealism'},indent=2))
