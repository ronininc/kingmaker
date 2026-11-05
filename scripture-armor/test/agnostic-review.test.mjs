import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectAgnostic} from '../agnostic-review.mjs';
function zip(name,content){
  const n=Buffer.from(name),data=Buffer.from(content),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);
  const prefix=Buffer.concat([local,n,data]),directory=Buffer.concat([central,n]);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(prefix.length,16);
  return Buffer.concat([prefix,directory,end]);
}
test('content identifies renamed executables, BOM JSON and delimited text',()=>{
  assert.equal(inspectAgnostic(Buffer.from([0x7f,0x45,0x4c,0x46,0,0,0,0]),'photo.txt').kind,'binary');
  assert.equal(inspectAgnostic(Buffer.from('\uFEFF{"inert":true}'),'unknown').format,'JSON');
  assert.equal(inspectAgnostic(Buffer.from('a\tb\n1\t2'),'renamed').format,'TSV');
});
test('Office XML extraction is bounded and never resolves external entities',()=>{
  const doc=inspectAgnostic(zip('word/document.xml','<w:document><w:t>Inert text</w:t></w:document>'),'wrong.bin');
  assert.equal(doc.format,'DOCX');assert.match(doc.texts[0].text,/Inert text/);assert.ok(doc.limitations.length);
  const entity=inspectAgnostic(zip('content.xml','<!DOCTYPE inert><!ENTITY x SYSTEM "file:///inert-fixture">'),'x.zip');
  assert.equal(entity.activeContent,true);assert.equal(entity.texts.length,0);
});
test('unsafe archive paths, PDFs, encrypted or opaque content never receive a clean claim',()=>{
  const traversal=inspectAgnostic(zip('../outside.mjs','inert'),'x.zip');assert.match(traversal.limitations.join(' '),/unsafe/);
  const pdf=inspectAgnostic(Buffer.from('%PDF-1.7 /Encrypt /JavaScript'),'x');assert.equal(pdf.format,'PDF');assert.equal(pdf.activeContent,true);assert.ok(pdf.limitations.length);
  const opaque=inspectAgnostic(Buffer.from([0,1,2,3,4]),'inert');assert.equal(opaque.texts.length,0);assert.ok(opaque.limitations.length);
});
test('ordinary review does not return private key material as extracted text',()=>{
  const r=inspectAgnostic(Buffer.from('{"seal_priv":"inert-secret-fixture"}'),'secret.json');assert.equal(r.texts.length,0);assert.ok(r.limitations.length);
  const archived=inspectAgnostic(zip('nested/notes.json','{"sign_priv":"inert-secret-fixture"}'),'x.zip');
  assert.equal(archived.format,'Sensitive key material');assert.equal(archived.texts.length,0);
});
