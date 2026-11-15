// Real FFmpeg/FFprobe integration proof with synthetic Blender-frame fixtures.
// This does NOT prove Blender works, model planning, aesthetics, or final reel capability.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { produceFilm, runFilmTool } from '../lib/film-production.mjs';
function crc(buf) { let c=0xffffffff; for(const b of buf){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; }
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,data])),data.length+8);return out;}
const header=Buffer.alloc(13);header.writeUInt32BE(128,0);header.writeUInt32BE(128,4);header[8]=8;header[9]=2;
const pixels=Buffer.alloc(128*(128*3+1));for(let y=0;y<128;y++)for(let x=0;x<128;x++){const p=y*385+1+x*3;pixels[p]=20;pixels[p+1]=80;pixels[p+2]=190;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const plan={schema:'kingmaker.film-plan/1',title:'Synthetic media-contract proof',width:128,height:128,fps:2,shots:[{id:'fixture',frames:4,camera:{position:[3,-5,3],target:[0,0,0]},objects:[{kind:'cube',position:[0,0,0],scale:[1,1,1],color:[0,0.3,0.8]}]}]};
let ffmpegCalls=0,ffprobeCalls=0;
const result=await produceFilm({plan,workDir:process.argv[2],tools:{blender:'/fixture/blender',ffmpeg:process.argv[3],ffprobe:process.argv[4]},run:async(bin,args,opts)=>{if(bin==='/fixture/blender'){const dir=args.at(-3);for(let f=Number(args.at(-2));f<=Number(args.at(-1));f++)await writeFile(join(dir,String(f).padStart(4,'0')+'.png'),png);return {stdout:'synthetic Blender frames',stderr:''};}if(bin===process.argv[3])ffmpegCalls++;else ffprobeCalls++;return runFilmTool(bin,args,opts);}});
assert.equal(result.record.deliverable.frames,4);assert.equal(result.record.deliverable.duration,2);assert.equal(result.record.audio,'not-run');assert.equal(ffmpegCalls,2);assert.equal(ffprobeCalls,2);assert.deepEqual(JSON.parse(await readFile(result.recordPath)),result.record);
console.log(JSON.stringify({proof:'real FFmpeg and FFprobe, synthetic Blender frames',...result},null,2));
