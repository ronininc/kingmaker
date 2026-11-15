# Trusted bounded executor. Never evaluate strings from plans; never enable blend auto-execution.
import bpy, json, sys, os, math, time, resource
from mathutils import Vector
p, out = sys.argv[sys.argv.index('--')+1:]
plan=json.load(open(p)); start=time.monotonic(); usage0=resource.getrusage(resource.RUSAGE_SELF)
if plan['input']:
    bpy.ops.wm.open_mainfile(filepath=plan['input'], load_ui=False, use_scripts=False)
else:
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
if len(scene.objects)>256: raise ValueError('Project exceeds object budget')
for op in plan['operations']:
    action=op['op']; name=op.get('id')
    if action in ['create','light','import-glb'] and bpy.data.objects.get(name): raise ValueError('Duplicate object id: '+name)
    if action=='import-glb':
        before=set(bpy.data.objects); bpy.ops.import_scene.gltf(filepath=plan['assets'][op['assetId']])
        imported=set(bpy.data.objects)-before
        holder=bpy.data.objects.new(name,None); scene.collection.objects.link(holder)
        for obj in imported:
            if obj.parent is None: obj.parent=holder
        holder.location=op['position']; holder.scale=op['scale']
    elif action=='create':
        {'cube':bpy.ops.mesh.primitive_cube_add,'sphere':bpy.ops.mesh.primitive_uv_sphere_add,'cylinder':bpy.ops.mesh.primitive_cylinder_add}[op['kind']]()
        obj=bpy.context.object; obj.name=name; obj.location=op['position']; obj.scale=op['scale']
    elif action in ['transform','material','bevel']:
        obj=bpy.data.objects.get(name)
        if obj is None or obj.type!='MESH': raise ValueError('Expected existing mesh: '+name)
        if action=='transform':
            obj.location=op['position']; obj.rotation_euler=[math.radians(x) for x in op['rotation']]; obj.scale=op['scale']
        elif action=='material':
            material=bpy.data.materials.new(name+'-surface'); material.use_nodes=True
            bsdf=material.node_tree.nodes.get('Principled BSDF'); bsdf.inputs['Base Color'].default_value=(*op['color'],1)
            bsdf.inputs['Roughness'].default_value=op['roughness']; bsdf.inputs['Metallic'].default_value=op['metallic']
            obj.data.materials.clear(); obj.data.materials.append(material)
        else:
            mod=obj.modifiers.new('Workflow bevel','BEVEL'); mod.width=op['width']; mod.segments=op['segments']
    elif action=='camera':
        obj=scene.camera
        if obj is None:
            obj=bpy.data.objects.new('WorkflowCamera',bpy.data.cameras.new('WorkflowCamera')); scene.collection.objects.link(obj); scene.camera=obj
        obj.location=op['position']; direction=Vector(op['target'])-obj.location
        if direction.length<.001: raise ValueError('Camera equals target')
        obj.rotation_euler=direction.to_track_quat('-Z','Y').to_euler(); obj.data.lens=op['lens']
    elif action=='light':
        data=bpy.data.lights.new(name,'AREA'); data.energy=op['energy']; data.shape='DISK'; data.size=op['size']
        obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); obj.location=op['position']; obj.rotation_euler=(-obj.location).to_track_quat('-Z','Y').to_euler()
if len(scene.objects)>256: raise ValueError('Project exceeds object budget')
scene.render.engine='CYCLES'; scene.cycles.samples=16; scene.render.resolution_x=256; scene.render.resolution_y=256; scene.render.resolution_percentage=100
scene.render.threads_mode='FIXED'; scene.render.threads=2
chosen='CPU'; available=[]
if plan['device']=='AUTO':
    try:
        prefs=bpy.context.preferences.addons['cycles'].preferences
        for backend in ['METAL','CUDA','HIP','ONEAPI']:
            try:
                prefs.compute_device_type=backend; prefs.get_devices()
                devices=[d for d in prefs.devices if d.type!='CPU']
                if devices:
                    for d in prefs.devices:d.use=d.type!='CPU'
                    available=[d.name for d in devices]; chosen=backend; break
            except Exception: pass
    except Exception: pass
scene.cycles.device='CPU' if chosen=='CPU' else 'GPU'
scene.render.filepath=os.path.join(out,'render.png')
if plan['render']:
    if scene.camera is None: raise ValueError('Render needs camera')
    try:bpy.ops.render.render(write_still=True)
    except Exception:
        if chosen=='CPU':raise
        chosen='CPU-fallback'; scene.cycles.device='CPU'; bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,'project.blend'), check_existing=False)
u=resource.getrusage(resource.RUSAGE_SELF)
state={'schema':'kingmaker.blender-project-state/1','objects':[{'id':o.name,'type':o.type,'position':list(o.location),'scale':list(o.scale),'dimensions':list(o.dimensions),'vertices':len(o.data.vertices) if o.type=='MESH' else 0,'materials':[m.name for m in o.data.materials if m] if o.type=='MESH' else [],'modifiers':[m.type for m in o.modifiers]} for o in sorted(scene.objects,key=lambda x:x.name)],'device':chosen,'availableGPUs':available,'metrics':{'wallSeconds':time.monotonic()-start,'cpuUserSeconds':u.ru_utime-usage0.ru_utime,'cpuSystemSeconds':u.ru_stime-usage0.ru_stime,'maxRssBytes':u.ru_maxrss if sys.platform=='darwin' else u.ru_maxrss*1024,'inputBlocks':u.ru_inblock-usage0.ru_inblock,'outputBlocks':u.ru_oublock-usage0.ru_oublock,'gpuUtilizationMeasured':False},'rendered':plan['render'],'qualityCertified':False}
json.dump(state,open(os.path.join(out,'state.json'),'w'),indent=2)
