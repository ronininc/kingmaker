"""Original bounded lighting/camera skill. Plans contain data, never Python code.
Call apply_plan only after loading an independently rights-checked local scene.
No assets, environments, scripts, files or network endpoints are accepted here.
"""
import math

SCHEMA = 'kingmaker.scene-lighting/1'

def fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or not set(value) <= set(required) | set(optional):
        raise ValueError('missing or unknown fields')

def number(value, lo, hi):
    if type(value) not in (int, float) or not math.isfinite(value) or not lo <= value <= hi:
        raise ValueError('finite numeric range')
    return value

def vector(value, lo, hi):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError('three-vector required')
    return [number(x, lo, hi) for x in value]

def validate_plan(plan):
    fields(plan, ('schema', 'units', 'camera', 'lights', 'world', 'render'))
    if plan['schema'] != SCHEMA or plan['units'] != 'meters':
        raise ValueError('schema or units')
    camera = plan['camera']
    fields(camera, ('position', 'target', 'lensMm', 'fStop'))
    p = vector(camera['position'], -100, 100)
    t = vector(camera['target'], -100, 100)
    distance = math.dist(p, t)
    if distance < .05:
        raise ValueError('camera target too close')
    number(camera['lensMm'], 18, 150)
    number(camera['fStop'], 1.4, 32)
    if not isinstance(plan['lights'], list) or not 1 <= len(plan['lights']) <= 6:
        raise ValueError('one to six area lights')
    names = set()
    for light in plan['lights']:
        fields(light, ('name', 'position', 'target', 'watts', 'sizeMeters', 'colorLinear'))
        name = light['name']
        if not isinstance(name, str) or not 1 <= len(name) <= 48 or not name.replace('-', '').replace('_', '').isalnum() or name in names:
            raise ValueError('unique simple light names')
        names.add(name)
        p = vector(light['position'], -100, 100)
        t = vector(light['target'], -100, 100)
        if math.dist(p, t) < .05:
            raise ValueError('light target too close')
        number(light['watts'], .1, 2000)
        number(light['sizeMeters'], .02, 10)
        vector(light['colorLinear'], 0, 1)
    world = plan['world']
    fields(world, ('colorLinear', 'strength'))
    vector(world['colorLinear'], 0, 1)
    number(world['strength'], 0, 2)
    render = plan['render']
    fields(render, ('width', 'height', 'samples', 'exposure'))
    for key, lo, hi in [('width', 128, 1024), ('height', 128, 1024), ('samples', 16, 256)]:
        if type(render[key]) is not int:
            raise ValueError('integer render settings')
        number(render[key], lo, hi)
    number(render['exposure'], -3, 3)
    return plan

def apply_plan(plan, bpy):
    """Apply to current trusted scene. Existing material/geometry data are untouched.
    Existing lights are hidden for render, not removed. A dedicated new collection
    makes all authored additions identifiable. Caller owns output path/render budget.
    """
    validate_plan(plan)
    from mathutils import Vector
    scene = bpy.context.scene
    # Refuse mixed unit systems instead of silently scaling existing assets.
    if scene.unit_settings.scale_length != 1:
        raise ValueError('scene scale_length must equal one meter')
    collection = bpy.data.collections.new('Kingmaker validated lighting')
    scene.collection.children.link(collection)
    disabled = []
    for obj in scene.objects:
        if obj.type == 'LIGHT' and not obj.hide_render:
            obj.hide_render = True
            disabled.append(obj.name)
    light_names = []
    for item in plan['lights']:
        data = bpy.data.lights.new('KM-'+item['name'], 'AREA')
        data.energy = item['watts']
        data.shape = 'DISK'
        data.size = item['sizeMeters']
        data.color = item['colorLinear']
        obj = bpy.data.objects.new(data.name, data)
        collection.objects.link(obj)
        obj.location = item['position']
        obj.rotation_euler = (Vector(item['target'])-obj.location).to_track_quat('-Z', 'Y').to_euler()
        light_names.append(obj.name)
    c = plan['camera']
    data = bpy.data.cameras.new('KM validated camera')
    camera = bpy.data.objects.new(data.name, data)
    collection.objects.link(camera)
    camera.location = c['position']
    camera.rotation_euler = (Vector(c['target'])-camera.location).to_track_quat('-Z', 'Y').to_euler()
    data.lens = c['lensMm']
    data.dof.use_dof = True
    data.dof.focus_distance = math.dist(c['position'], c['target'])
    data.dof.aperture_fstop = c['fStop']
    scene.camera = camera
    scene.world = bpy.data.worlds.new('KM validated world')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get('Background')
    background.inputs['Color'].default_value = (*plan['world']['colorLinear'], 1)
    background.inputs['Strength'].default_value = plan['world']['strength']
    r = plan['render']
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = r['samples']
    scene.cycles.use_denoising = True
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 4
    scene.render.resolution_x = r['width']
    scene.render.resolution_y = r['height']
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.exposure = r['exposure']
    return {'schema': 'kingmaker.scene-lighting-applied/1', 'status': 'applied-not-rendered',
            'lightNames': light_names, 'disabledExistingLights': disabled,
            'cameraName': camera.name, 'qualityCertified': False,
            'limitations': ['No geometry/material acquisition or learning occurs here.',
                            'Physical plausibility and appearance require rendered inspection.',
                            'Wattage uses Blender radiometric power, not household bulb ratings.']}
