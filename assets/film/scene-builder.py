"""Trusted data-only Blender builder. Never evals plan text or loads external assets."""
import bpy, sys, json, math, os
from mathutils import Vector
args = sys.argv[sys.argv.index('--') + 1:]
spec_path, output_dir, first, last = args
with open(spec_path, encoding='utf-8') as stream:
    spec = json.load(stream)
shot = spec['shots'][0]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 8
scene.render.threads_mode = 'FIXED'
scene.render.threads = 1
scene.render.resolution_x = spec['width']
scene.render.resolution_y = spec['height']
scene.render.resolution_percentage = 100
scene.render.fps = spec['fps']
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.world.color = shot['background']
scene.frame_start, scene.frame_end = int(first), int(last)
scene.render.filepath = os.path.join(output_dir, '')
for i, data in enumerate(shot['objects']):
    kind = data['kind']
    if kind == 'cube': bpy.ops.mesh.primitive_cube_add(size=1)
    elif kind == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.5)
    elif kind == 'cylinder': bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.5, depth=1)
    elif kind == 'plane': bpy.ops.mesh.primitive_plane_add(size=1)
    elif kind == 'text':
        bpy.ops.object.text_add()
        bpy.context.object.data.body = data['text']
        bpy.context.object.data.align_x = 'CENTER'
        bpy.context.object.data.size = 1
        bpy.context.object.data.extrude = 0.004
    else: raise ValueError('unsupported primitive')
    obj = bpy.context.object
    obj.name = 'Object_%d' % i
    obj.location = data['position']
    obj.scale = data['scale']
    obj.rotation_euler = [math.radians(x) for x in data['rotation']]
    mat = bpy.data.materials.new('Material_%d' % i)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*data['color'], 1)
    bsdf.inputs['Roughness'].default_value = 0.35
    bsdf.inputs['Metallic'].default_value = 0.35
    bsdf.inputs['Emission Color'].default_value = (*data['color'], 1)
    bsdf.inputs['Emission Strength'].default_value = data['emission']
    obj.data.materials.append(mat)
    for field, prop in [('endPosition', 'location'), ('endRotation', 'rotation_euler')]:
        if field in data:
            obj.keyframe_insert(data_path=prop, frame=1)
            setattr(obj, prop, [math.radians(x) for x in data[field]] if prop == 'rotation_euler' else data[field])
            obj.keyframe_insert(data_path=prop, frame=shot['frames'])
    if obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            for key in fc.keyframe_points: key.interpolation = 'LINEAR'
bpy.ops.object.camera_add(location=shot['camera']['position'])
cam = bpy.context.object
cam.rotation_euler = (Vector(shot['camera']['target']) - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.lens = shot['camera']['lens']
scene.camera = cam
for name, loc, power, color in [('Key', (3,-4,6), 600, (0.7,0.85,1)), ('Rim', (-3,2,4), 400, (0.3,0.6,1))]:
    bpy.ops.object.light_add(type='AREA', location=loc)
    light = bpy.context.object
    light.name = name
    light.data.energy = power
    light.data.color = color
    light.data.shape = 'DISK'
    light.data.size = 5
    light.rotation_euler = (-light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output_dir, 'scene.blend'))
bpy.ops.render.render(animation=True)
