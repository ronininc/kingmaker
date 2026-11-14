# Generative capacity beyond language-model weights

Owner, 2026-11-11: weights are "pure 'generative' capacity"; a renderer "should be a tool call from its second brain"; "pipelines and method files being written in the background … by learning from videos".

## What is built

| Piece | File | What it does |
|---|---|---|
| Capacity plan | `lib/generative-capacity.mjs` | Classifies what is being asked for (text, picture, 3D render, video) and finds something on this Mac that can make it: a library model, the local image weights, or a method file plus the tool it uses. Says exactly what is missing when nothing can. |
| Render method | `catalog/methods/blender-still-render.method.md` | Turns a subject and its camera, light and frame dials into a real Blender scene script and a job record, verifies both, and declares the render command. |
| Background drafts | `lib/method-drafts.mjs` | Turns an observation of reference footage into a draft method file while the owner is away. Drafts go to a drafts folder with status `awaiting-owner`, never into the catalog. |
| App wiring | `lib/cli.mjs`, `lib/calibration.mjs` | A "Generative capacity" switch, off by default. When on and the image weights are not set up, a picture or render request is planned and conducted instead of handed off. |

## What it does not do

- **It never starts a program.** The method conductor has no step that runs a tool, so the render is a declared step: the trace and the bar give the exact command, and no picture is claimed. Adding a step that runs a tool is the owner's decision and is not made here.
- **It does not analyse video.** The drafts loop reads observation files (`*.json`: a title, a source, and a `look` with lens, camera and light numbers) from an inbox folder. The video-analysis code that would write those files is on the `#128` branch, which is marked do-not-merge; nothing here depends on it.
- **The drafts loop is not started by the app yet.** `createIdleMethodDrafts` is built and tested; `lib/cli.mjs` does not call it, because there is nothing writing observations yet.
- **No render has been run.** The scene script is valid Python and was produced by a real conduction, but Blender is not on the machine this was built on.

## Try it

```bash
cd ~/Projects/kingmaker-private && node --test test/generative-capacity.test.mjs
```

To see the files a render request produces, with nothing started:

```bash
cd ~/Projects/kingmaker-private && mkdir -p ~/Downloads/kingmaker-render-check && node --input-type=module -e "import { createMethodConductor } from './lib/method-conductor.mjs'; const r = await createMethodConductor().conduct('blender-still-render', { workDir: process.env.HOME + '/Downloads/kingmaker-render-check', inputs: { subject: 'Mountain range at dawn' } }); console.log(r.status);"
```

That writes `scene.py` and `job.json` into `~/Downloads/kingmaker-render-check`.

## Limits worth knowing

- **Video has no method yet.** A request for an animation or a video is reported as missing a video method. The Blender still-render method is not offered for it, because it can only make one frame.
- **The subject is cleaned before it is written into a script.** Quotes, backslashes, hash signs, braces and line breaks are removed from the request text, so it cannot add code to the generated scene script.
- **The command shown is the bare command.** It is taken from the conductor's own list of declared steps and can be pasted as is.
- **A draft keeps the base method's values** for any dial the observation did not give, and says which ones were not observed.
