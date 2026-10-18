import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrfFuse, toRanked, DEFAULT_K } from '../lib/rrf.mjs';

test('fuses by rank, not score: a doc high in both lists beats one that only tops one list', () => {
  const keyword = ['a', 'b', 'c', 'd'];
  const vector = ['b', 'a', 'e', 'f'];
  const out = rrfFuse([keyword, vector], { k: 60 });
  assert.deepEqual(out.map((r) => r.docId).slice(0, 2), ['a', 'b'], 'a and b appear in both, so they lead');
  // a: 1/(60+1)+1/(60+2); b: 1/(60+2)+1/(60+1) -> equal score, tie-break by id puts a first.
  assert.ok(Math.abs(out[0].score - out[1].score) < 1e-12);
});

test('RRF score matches the formula with the default k', () => {
  const out = rrfFuse([['x', 'y'], ['y']]);
  const x = out.find((r) => r.docId === 'x').score;
  const y = out.find((r) => r.docId === 'y').score;
  assert.ok(Math.abs(x - 1 / (DEFAULT_K + 1)) < 1e-12);
  assert.ok(Math.abs(y - (1 / (DEFAULT_K + 2) + 1 / (DEFAULT_K + 1))) < 1e-12);
  assert.ok(y > x, 'y is in both lists, so it outranks x');
});

test('weights lean a list without recalibrating scores', () => {
  const keyword = ['k1', 'shared'];
  const vector = ['v1', 'shared'];
  const leanVector = rrfFuse([keyword, vector], { weights: [0.1, 1] });
  assert.equal(leanVector[0].docId, 'shared');
  // v1 (weighted 1, rank 1) should beat k1 (weighted 0.1, rank 1).
  assert.ok(leanVector.findIndex((r) => r.docId === 'v1') < leanVector.findIndex((r) => r.docId === 'k1'));
});

test('a missing list contributes nothing; fusing one list just reproduces it', () => {
  const only = rrfFuse([['a', 'b', 'c']]);
  assert.deepEqual(only.map((r) => r.docId), ['a', 'b', 'c']);
});

test('limit caps the results; ranks are recorded per list', () => {
  const out = rrfFuse([['a', 'b', 'c', 'd'], ['d', 'c']], { limit: 2 });
  assert.equal(out.length, 2);
  const d = rrfFuse([['a', 'b', 'c', 'd'], ['d', 'c']]).find((r) => r.docId === 'd');
  assert.deepEqual(d.ranks, [4, 1]);
});

test('objects carrying an id work, as do numeric ids, and a repeat in one list counts only its best rank', () => {
  const out = rrfFuse([[{ docId: 7 }, { id: 8 }], [{ doc_id: 8 }, { docId: 8 }]]);
  const eight = out.find((r) => r.docId === 8);
  assert.deepEqual(eight.ranks, [2, 1], 'the duplicate 8 in list B keeps its first (best) rank only');
});

test('ties always break the same way (deterministic by id)', () => {
  const a = rrfFuse([['m', 'n'], ['n', 'm']]).map((r) => r.docId);
  const b = rrfFuse([['n', 'm'], ['m', 'n']]).map((r) => r.docId);
  assert.deepEqual(a, b, 'equal scores -> same order regardless of input order');
});

test('toRanked sorts scored hits best-first and drops bad entries', () => {
  assert.deepEqual(toRanked([{ docId: 'a', score: 0.2 }, { docId: 'b', score: 0.9 }, { docId: 'c', score: NaN }]), ['b', 'a']);
  assert.deepEqual(toRanked([{ id: 1, score: 1 }, { id: 2, score: 5 }], { desc: false }), [1, 2]);
});

test('bad input never throws', () => {
  assert.deepEqual(rrfFuse(null), []);
  assert.deepEqual(rrfFuse([null, undefined, []]), []);
  assert.deepEqual(rrfFuse([['a']], { k: -5, limit: -1 }).map((r) => r.docId), ['a'], 'invalid k and limit fall back to defaults, not nothing');
});
