"""Authored hero-material validation scene, not autonomous scene synthesis."""
import bpy,sys,json,hashlib,math,os,time
from pathlib import Path
from mathutils import Vector
args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=2:raise ValueError('verified material receipt, new output directory')
rpath,out=map(lambda x:Path(x).resolve(),args);r=json.loads(rpath.read_text());src=Path(r['materialFile']).resolve()
if src.parent!=rpath.parent or src.stat().st_size>32*1024*1024 or hashlib.sha256(src.read_bytes()).hexdigest()!=r['materialSha256']:raise ValueError('material provenance mismatch')
if out.exists():raise ValueError('new output required')
v=os.statvfs(out.parent)
if v.f_bavail*v.f_frsize<512*1024*1024:raise ValueError('512MiB reserve required')
out.mkdir();started=time.monotonic();bpy.ops.wm.read_factory_settings(use_empty=True)
# Only load the exact locally generated material datablock, never scene/scripts.
with bpy.data.libraries.load(str(src),link=False) as (source,target):
 if 'Verified PBR' not in source.materials:raise ValueError('material absent')
 target.materials=['Verified PBR']
wood=bpy.data.materials['Verified PBR'];wood.name='Verified Weathered Timber'
for n in wood.node_tree.nodes:
 if n.type=='TEX_IMAGE' and (not n.image.packed_file or max(n.image.size)>2048):raise ValueError('unexpected image')
def metal(name,base,metallic,rough):
 m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF');p.inputs['Base Color'].default_value=(*base,1);p.inputs['Metallic'].default_value=metallic;p.inputs['Roughness'].default_value=rough
 noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=180;noise.inputs['Detail'].default_value=3
 bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.18;bump.inputs['Distance'].default_value=.0015;l.new(noise.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs['Normal'],p.inputs['Normal'])
 ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.25;ramp.color_ramp.elements[0].color=(max(.1,rough-.12),)*3+(1,);ramp.color_ramp.elements[1].position=.75;ramp.color_ramp.elements[1].color=(min(.95,rough+.2),)*3+(1,);l.new(noise.outputs['Fac'],ramp.inputs[0]);l.new(ramp.outputs[0],p.inputs['Roughness'])
 return m
iron=metal('Original forged iron',(.035,.041,.045),.85,.37);brass=metal('Original worn brass',(.22,.12,.035),.8,.3);stone=metal('Original dark plaster',(.025,.03,.035),0,.88)
def cube(name,loc,scale,mat,bevel=.005):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 if mat==wood:
  uv=o.data.uv_layers.active
  # Map each physical board inside one seamless source strip; avoid modulo wrapping and source plank boundaries.
  for face in o.data.polygons:
   for li in face.loop_indices:
    p=o.matrix_world@o.data.vertices[o.data.loops[li].vertex_index].co
    # Crop a grain strip per board instead of painting source plank seams across joinery.
    if scale[2]>scale[0]:
     across=(p.x-loc[0])/scale[0] if abs(face.normal.y)>.5 else (p.y-loc[1])/scale[1]
     uv.data[li].uv=(.04+((p.z-loc[2])/scale[2]+.5)*.90,.17+across*.045)
    else:
     across=(p.z-loc[2])/scale[2] if abs(face.normal.y)>.5 else (p.y-loc[1])/scale[1]
     uv.data[li].uv=(.04+((p.x-loc[0])/scale[0]+.5)*.90,.17+across*.045)
 o.data.materials.append(mat)
 if bevel:
  b=o.modifiers.new('Real edge bevel','BEVEL');b.width=bevel;b.segments=3
  o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL')
 return o
cube('recessed plaster wall',(0,.14,.9),(3,.18,3),stone,.01)
for i in range(6):
 x=(i-2.5)*.181
 cube('individual door board %02d'%i,(x,-.015,.85),(.175,.075,1.66),wood,.0025)
for x in [-.62,.62]:cube('heavy timber jamb',(x,-.02,.87),(.13,.15,1.70),wood,.006)
cube('upper lintel',(0,-.02,1.79),(1.38,.15,.14),wood,.007)
cube('threshold',(0,-.08,.015),(1.4,.27,.07),iron,.006)
# Detailed hand-authored hinges, visible knuckles and fasteners.
def cyl(name,loc,radius,depth,mat,rotation=(math.pi/2,0,0)):
 bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=radius,depth=depth,location=loc,rotation=rotation);o=bpy.context.object;o.name=name;o.data.materials.append(mat);b=o.modifiers.new('Machined edge','BEVEL');b.width=.001;b.segments=3
 for p in o.data.polygons:p.use_smooth=True
 return o
for z in [.36,1.35]:
 cube('forged hinge strap',(-.32,-.068,z),(.47,.018,.07),iron,.008)
 for x in [-.51,-.34,-.13]:
  cyl('brass rivet',(x,-.083,z),.012,.009,brass)
  cube('rivet slot',(x,-.089,z),(.014,.002,.002),iron,.0004)
 for dz in [-.026,0,.026]:cyl('hinge knuckle',(-.575,-.065,z+dz),.018,.023,iron,(0,0,0))
# Handle escutcheon, stem, cast ring.
cube('latch escutcheon',(.34,-.068,.86),(.085,.025,.2),iron,.01)
for z in [.79,.93]:cyl('latch screw',(.34,-.087,z),.009,.008,brass)
cyl('handle boss',(.34,-.105,.87),.025,.055,brass)
bpy.ops.mesh.primitive_torus_add(major_radius=.055,minor_radius=.008,major_segments=64,minor_segments=12,location=(.34,-.14,.81),rotation=(math.pi/2,0,0));bpy.context.object.name='cast latch ring';bpy.context.object.data.materials.append(brass)
# Cyber modification: physically modeled light channel, not flat colored wall.
cube('neon housing',(.70,-.05,.93),(.048,.07,1.48),iron,.009)
em=bpy.data.materials.new('cyan neon');em.use_nodes=True;p=em.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(.03,.35,.4,1);p.inputs['Emission Color'].default_value=(.015,.7,1,1);p.inputs['Emission Strength'].default_value=8
cyl('neon glass tube',(.70,-.095,.93),.008,1.4,em,(0,0,0))
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=96;scene.cycles.use_denoising=True;scene.cycles.adaptive_threshold=.015
scene.render.threads_mode='FIXED';scene.render.threads=4;scene.render.resolution_x=768;scene.render.resolution_y=768;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.view_settings.view_transform='AgX'
scene.world=bpy.data.worlds.new('dim studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.05,.065,.08,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.2
for name,loc,power,color,size in [('warm soft key',(-1.4,-1.2,2.4),110,(1,.7,.45),1.4),('cool grazing',(.9,-.35,1.1),32,(.05,.65,1),.7),('subtle fill',(-.4,-2,.8),15,(.65,.75,1),2)]:
 d=bpy.data.lights.new(name,'AREA');d.energy=power;d.color=color;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,.9))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(.68,-2.8,1.17));cam=bpy.context.object;cam.rotation_euler=(Vector((.04,0,.9))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=49;scene.camera=cam
scene.render.filepath=str(out/'hero-door.png');bpy.ops.wm.save_as_mainfile(filepath=str(out/'scene.blend'));bpy.ops.render.render(write_still=True)
receipt={'schema':'kingmaker.authored-hero-proof/1','status':'rendered','authorship':'Assistant-authored detailed scene and lighting, not autonomous Kingmaker synthesis','sourceMaterialReceipt':str(rpath),'sourceMaterialSha256':r['materialSha256'],'sourceAttribution':r['attribution'],'image':str(out/'hero-door.png'),'sha256':hashlib.sha256((out/'hero-door.png').read_bytes()).hexdigest(),'elapsedSec':time.monotonic()-started,'size':[768,768],'samples':96,'qualityCertified':False,'limitations':['One authored material/geometry study; not full environment, game-ready asset or cinematic video.','No generalized learning proof; evaluate aesthetic quality separately.']}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2));print('HERO_DETAIL_COMPLETE')
