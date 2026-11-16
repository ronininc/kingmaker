// Tool sessions with REAL tools (Blender, python3, jq): honest state, live activity, measurable-only progress, input
// routing, two-tool coordination, completion, failure, mid-task cancellation, an unresponsive process, theme rendering,
// and a user-started process left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolSessions, renderToolPanels } from '../lib/tool-sessions.mjs';

const BLENDER = ['/opt/homebrew/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender'].find(existsSync);
const registry = { tools: { python3: { path: '/usr/bin/python3' }, jq: { path: '/opt/homebrew/bin/jq' }, ...(BLENDER ? { blender: { path: BLENDER } } : {}) } };
const dir = () => mkdtempSync(join(tmpdir(), 'km-sessions-'));
const RENDER = (samples) => `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\ns=bpy.context.scene\nbpy.ops.mesh.primitive_monkey_add()\nbpy.ops.object.light_add(type='SUN',location=(3,-3,5))\nbpy.ops.object.camera_add(location=(0,-5,1),rotation=(1.45,0,0));s.camera=bpy.context.object\ns.render.engine='CYCLES';s.cycles.device='CPU';s.cycles.samples=${samples};s.cycles.use_denoising=False\ns.cycles.use_adaptive_sampling=False\ns.render.resolution_x,s.render.resolution_y=320,180;s.render.filepath='out.png'\nbpy.ops.render.render(write_still=True)\n`;

test('completion and failure are reported from the real exit, never assumed; no percentage when the tool gives none', async () => {
  const cwd = dir(); const events = [];
  try {
    writeFileSync(join(cwd, 'd.json'), '{"a":1}');
    const ts = createToolSessions({ registry, emit: (e) => events.push(e.toolPanel) });
    const ok = ts.start({ tool: 'jq', args: ['.a', 'd.json'], cwd });
    const okEnd = await ts.wait(ok.id);
    assert.equal(okEnd.state, 'completed'); assert.equal(okEnd.exitCode, 0); assert.equal(okEnd.progress, null, 'jq reports no progress: none invented');
    const bad = ts.start({ tool: 'python3', args: ['-c', 'import sys; print("working"); sys.exit(3)'], cwd });
    const badEnd = await ts.wait(bad.id);
    assert.equal(badEnd.state, 'failed'); assert.equal(badEnd.exitCode, 3); assert.equal(badEnd.activity, 'working');
    assert(() => ts.start({ tool: 'rm', args: ['-rf', cwd], cwd }));
    assert.throws(() => ts.start({ tool: 'rm', args: ['-rf', cwd], cwd }), /TOOL_NOT_SELECTED/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('real Blender render: live activity and progress from Blender\'s own sample counter, completed on exit', { skip: !BLENDER && 'Blender not installed' }, async () => {
  const cwd = dir();
  try {
    writeFileSync(join(cwd, 'r.py'), RENDER(32));
    const ts = createToolSessions({ registry });
    const s = ts.start({ tool: 'blender', args: ['-b', '--factory-startup', '-noaudio', '--python', 'r.py'], cwd, progress: 'blender', label: 'Blender: monkey render' });
    const seen = []; ts.events.on('update', (k, v) => { if (v.progress != null) seen.push(v.progress); });
    const end = await ts.wait(s.id);
    assert.equal(end.state, 'completed', JSON.stringify(ts.get(s.id).output.slice(-5)));
    assert(seen.length > 3 && seen.some((p) => p > 0 && p < 100), `progress came from Blender's own counter: ${seen.slice(0, 8)}`);
    assert(existsSync(join(cwd, 'out.png')), 'the render file exists');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('two tools as a team: concurrent Blender + python sessions keep separate state and output; dismissing one mid-task cancels only it, verified gone, files kept', { skip: !BLENDER && 'Blender not installed' }, async () => {
  const cwd = dir();
  try {
    writeFileSync(join(cwd, 'r.py'), RENDER(4000));
    const ts = createToolSessions({ registry });
    const b = ts.start({ tool: 'blender', args: ['-b', '--factory-startup', '-noaudio', '--python', 'r.py'], cwd, progress: 'blender' });
    const p = ts.start({ tool: 'python3', args: ['-u', '-c', 'import time\nfor i in range(1,6):\n  print(f"step {i}/5"); time.sleep(0.2)'], cwd });
    await new Promise((r) => { const on = (k, v) => { if (v.id === b.id && v.progress != null && v.progress > 0) { ts.events.off('update', on); r(); } }; ts.events.on('update', on); });
    const pEnd = await ts.wait(p.id);
    assert.equal(pEnd.state, 'completed'); assert.equal(pEnd.progress, 100);
    assert.equal(ts.get(b.id).state, 'running', 'blender still running while python finished');
    const d = await ts.dismiss(b.id);
    assert.equal(d.ok, true); assert.equal(d.verifiedGone, true); assert.equal(ts.get(b.id).state, 'cancelled'); assert.equal(ts.get(b.id).visible, false);
    assert(existsSync(join(cwd, 'r.py')), 'files preserved');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('an unresponsive process (ignores SIGTERM) is escalated to SIGKILL and only reported cancelled once verified gone; a user-started process is untouched', async () => {
  const cwd = dir();
  const user = spawn('/usr/bin/python3', ['-c', 'import time; time.sleep(30)'], { stdio: 'ignore' });
  try {
    const ts = createToolSessions({ registry, graceMs: 500 });
    const s = ts.start({ tool: 'python3', args: ['-u', '-c', 'import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("ignoring SIGTERM", flush=True)\nwhile True: time.sleep(0.1)'], cwd });
    await new Promise((r) => { const on = (k, v) => { if (v.id === s.id && v.activity === 'ignoring SIGTERM') { ts.events.off('update', on); r(); } }; ts.events.on('update', on); });
    const d = await ts.dismiss(s.id);
    assert.equal(d.ok, true); assert.equal(d.verifiedGone, true); assert.match(d.note, /SIGKILL/);
    assert.equal(ts.get(s.id).state, 'cancelled');
    assert.doesNotThrow(() => process.kill(user.pid, 0), 'the user-started python is still running');
  } finally { user.kill('SIGKILL'); rmSync(cwd, { recursive: true, force: true }); }
});

test('typed/spoken input is routed to the right interactive tool; non-interactive tools refuse it', async () => {
  const cwd = dir();
  try {
    const ts = createToolSessions({ registry });
    const echo = ts.start({ tool: 'python3', args: ['-u', '-c', 'import sys\nfor l in sys.stdin:\n  print("tool heard:", l.strip(), flush=True)'], cwd, interactive: true });
    const other = ts.start({ tool: 'python3', args: ['-u', '-c', 'import time; time.sleep(5)'], cwd });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ts.send(echo.id, 'render the next frame').ok, true);
    assert.equal(ts.send(other.id, 'hello').ok, false);
    await new Promise((r) => { const on = (k, v) => { if (v.id === echo.id && /tool heard/.test(v.activity)) { ts.events.off('update', on); r(); } }; ts.events.on('update', on); });
    assert.equal(ts.get(echo.id).activity, 'tool heard: render the next frame');
    await ts.dismiss(echo.id); await ts.dismiss(other.id);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the panel follows the user\'s look, accent, size and font; dismissed panels disappear', () => {
  const views = [{ id: 't1', tool: 'blender', state: 'running', activity: 'Sample 12/64', progress: 18, lines: 40, visible: true }, { id: 't2', tool: 'jq', state: 'completed', activity: 'done', progress: null, lines: 1, visible: false }];
  const black = renderToolPanels(views, { look: 'black', accent: '#ff8800', textSize: 15, font: 'Menlo' });
  const sys = renderToolPanels(views, { look: 'system', accent: '#00aa55', textSize: 12, font: 'Avenir' });
  assert.match(black, /background:#000/); assert.match(black, /font:15px Menlo/); assert.match(black, /color:#ff8800">running/); assert.match(black, /18%/);
  assert.match(sys, /background:Canvas/); assert.match(sys, /font:12px Avenir/); assert.match(sys, /color:#00aa55">running/);
  assert.doesNotMatch(black, /data-id="t2"/, 'dismissed panel not rendered');
});
