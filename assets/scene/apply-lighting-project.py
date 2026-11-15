"""Trusted headless entry point: blender --background --factory-startup
--disable-autoexec --python this.py -- job.json new-output-directory
Input must be an already approved, locally authored .blend project, not arbitrary
third-party content. SHA256 binds identity; it does not establish trust or rights.
"""
import bpy,sys,json,hashlib,os,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from lighting_plan import validate_plan,apply_plan
args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=2:raise ValueError('job and new output directory required')
jobpath,out=map(lambda x:Path(x).resolve(),args)
if jobpath.stat().st_size>65536:raise ValueError('job budget')
j=json.loads(jobpath.read_text())
if set(j)!={'schema','project','plan'} or j['schema']!='kingmaker.lighting-project-job/1':raise ValueError('job schema')
source=j['project']
if set(source)!={'path','sha256','trust'} or source['trust']!='approved-local-authored':raise ValueError('approved local authored project required')
src=Path(source['path']).resolve()
if src.suffix!='.blend' or src.stat().st_size>32*1024*1024:raise ValueError('project size/type')
if hashlib.file_digest(src.open('rb'),'sha256').hexdigest()!=source['sha256']:raise ValueError('project digest')
validate_plan(j['plan'])
if out.exists():raise ValueError('new output directory required')
v=os.statvfs(out.parent)
if v.f_bavail*v.f_frsize<512*1024*1024:raise ValueError('512 MiB disk reserve required')
started=time.monotonic();out.mkdir()
# Snapshot approved bytes before Blender opens them; retain source untouched.
snapshot=out/'source.blend';snapshot.write_bytes(src.read_bytes())
if hashlib.file_digest(snapshot.open('rb'),'sha256').hexdigest()!=source['sha256']:raise ValueError('source changed')
bpy.ops.wm.open_mainfile(filepath=str(snapshot),load_ui=False,use_scripts=False)
def asset_digest():
 payload={'meshes':[(m.name,[list(v.co) for v in m.vertices],[list(p.vertices) for p in m.polygons]) for m in sorted(bpy.data.meshes,key=lambda m:m.name)],'materials':[(m.name,[(n.name,n.bl_idname) for n in m.node_tree.nodes] if m.use_nodes else []) for m in sorted(bpy.data.materials,key=lambda m:m.name)]}
 return hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
def settings():
 s=bpy.context.scene;c=s.camera
 return {'camera':{'name':c.name,'position':list(c.location),'rotation':list(c.rotation_euler),'lensMm':c.data.lens,'fStop':c.data.dof.aperture_fstop,'focusDistance':c.data.dof.focus_distance},'lights':[{'name':o.name,'position':list(o.location),'watts':o.data.energy,'sizeMeters':o.data.size,'colorLinear':list(o.data.color)} for o in s.objects if o.type=='LIGHT' and not o.hide_render],'render':{'width':s.render.resolution_x,'height':s.render.resolution_y,'samples':s.cycles.samples,'exposure':s.view_settings.exposure,'viewTransform':s.view_settings.view_transform}}
def inventory():
 return {'objects':[{'name':o.name,'type':o.type,'location':list(o.location),'dimensions':list(o.dimensions),'materials':[s.material.name if s.material else None for s in o.material_slots]} for o in sorted(bpy.context.scene.objects,key=lambda o:o.name)],'meshes':len(bpy.data.meshes),'materials':len(bpy.data.materials),'packedImages':sum(bool(i.packed_file) for i in bpy.data.images)}
beforeDigest=asset_digest();before=inventory();applied=apply_plan(j['plan'],bpy)
project=out/'project.blend';bpy.ops.wm.save_as_mainfile(filepath=str(project))
after=inventory();expectedSettings=settings()
if asset_digest()!=beforeDigest:raise ValueError('geometry/material content changed')
if before['meshes']!=after['meshes'] or before['materials']!=after['materials'] or before['packedImages']!=after['packedImages']:raise ValueError('asset inventory changed')
# Read the persisted file back, rather than infer save correctness from memory.
bpy.ops.wm.open_mainfile(filepath=str(project),load_ui=False,use_scripts=False)
readback=inventory()
if asset_digest()!=beforeDigest or settings()!=expectedSettings:raise ValueError('asset/settings readback mismatch')
if readback!=after:raise ValueError('project readback mismatch')
receipt={'schema':'kingmaker.lighting-project-receipt/1','status':'project-persisted-not-rendered','sourceSha256':source['sha256'],'plan':j['plan'],'applied':applied,'before':before,'readback':readback,'settings':expectedSettings,'assetContentSha256':beforeDigest,'project':str(project),'sha256':hashlib.file_digest(project.open('rb'),'sha256').hexdigest(),'elapsedSec':time.monotonic()-started,'renderer':bpy.app.version_string,'compute':{'device':'CPU','threads':4,'reason':'Conservative bounded execution; GPU selection not inferred from host branding.'},'qualityCertified':False}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2));print('LIGHTING_PROJECT_PERSISTED')
