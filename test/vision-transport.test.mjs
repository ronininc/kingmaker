import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { colorImage, PROBES } from '../lib/soak-fixtures.mjs';
import { chat } from '../lib/tool-call.mjs';
const vision = PROBES.find(p => p.lane === 'vision');
function decode(encoded) {
  const png = Buffer.from(encoded, 'base64');
  assert.equal(png.toString('base64'), encoded);
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  let width, height; const data = [];
  for (let off = 8; off < png.length;) {
    const n = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8), bytes = png.subarray(off + 8, off + 8 + n);
    if (type === 'IHDR') { width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4); assert.equal(bytes[8], 8); assert.equal(bytes[9], 2); }
    if (type === 'IDAT') data.push(bytes);
    off += n + 12;
  }
  return { width, height, pixels: inflateSync(Buffer.concat(data)), hash: createHash('sha256').update(png).digest('hex') };
}
test('PNG fixtures decode to distinct complete red and blue RGB images', () => {
  const hashes = [];
  for (const red of [true, false]) {
    const { width, height, pixels, hash } = decode(colorImage(red)); hashes.push(hash);
    assert.equal(width, 64); assert.equal(height, 64); assert.equal(pixels.length, 64 * 193);
    for (let y = 0; y < height; y++) {
      assert.equal(pixels[y * 193], 0);
      for (let x = 0; x < width; x++) assert.deepEqual([...pixels.subarray(y * 193 + 1 + x * 3, y * 193 + 4 + x * 3)], red ? [255,0,0] : [0,0,255]);
    }
  }
  assert.notEqual(...hashes);
});
for (const retry of [false, true]) test(`chat preserves raw PNG base64 and isolated prompts${retry ? ' through thinking fallback' : ''}`, async () => {
  const requests = [];
  for (const red of [true, false]) {
    let attempt = 0;
    const result = await chat({ model: 'fixture-vision', base: 'http://127.0.0.1:11435', messages: [{ role: 'user', content: vision.prompt, images: [colorImage(red)] }], fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11435/api/chat'); assert.equal(init.headers['content-type'], 'application/json');
      const body = JSON.parse(init.body); requests.push(body);
      assert.equal(body.messages.length, 1); assert.equal(body.messages[0].content, vision.prompt);
      assert.deepEqual(body.messages[0].images, [colorImage(red)]); assert.equal(body.stream, false);
      decode(body.messages[0].images[0]);
      if (retry && attempt++ === 0) return new Response('{"error":"think unsupported"}', {status:400});
      return new Response(JSON.stringify({message:{content:red ? 'red' : 'blue'}}));
    }});
    assert.equal(vision.validate(result.message.content, red), true);
  }
  assert.equal(requests.length, retry ? 4 : 2);
  assert.notEqual(requests[0].messages[0].images[0], requests.at(-1).messages[0].images[0]);
});
test('constant red response never validates the blue fixture', () => { assert.equal(vision.validate('Red', false), false); });
