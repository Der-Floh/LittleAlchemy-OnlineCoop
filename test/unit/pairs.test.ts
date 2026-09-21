import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizePair,
    parseTuple,
    parseTuples,
    tuplesFromHistory,
    missingTuples,
    tupleKey,
    MAX_ELEMENT_ID,
} from '../../src/sync/pairs.ts';

test('normalizePair orders ids and accepts numeric strings', () => {
    assert.deepEqual(normalizePair(12, 3), [3, 12]);
    assert.deepEqual(normalizePair('7', '7'), [7, 7]);
    assert.deepEqual(normalizePair(1, 2), [1, 2]);
});

test('normalizePair rejects anything that is not an element id', () => {
    const bad: unknown[][] = [[0, 1], [-1, 2], [1.5, 2], [NaN, 1], [1, MAX_ELEMENT_ID + 1], [null, 1], [{}, 1], ['x', 1]];
    for (const [a, b] of bad) {
        assert.equal(normalizePair(a, b), null, JSON.stringify([a, b]));
    }
});

test('parseTuple keeps a valid timestamp and fills in a missing one', () => {
    assert.deepEqual(parseTuple([5, 2, 1234]), [2, 5, 1234]);
    assert.deepEqual(parseTuple([5, 2], 99), [2, 5, 99]);
    assert.deepEqual(parseTuple([5, 2, 'soon'], 99), [2, 5, 99]);
    assert.deepEqual(parseTuple([5, 2, -4], 99), [2, 5, 99]);
    assert.equal(parseTuple([5]), null);
    assert.equal(parseTuple('5,2'), null);
});

test('parseTuples drops invalid entries and duplicates (either order), keeps order', () => {
    const out = parseTuples([[2, 1, 10], 'junk', [1, 2, 20], [3, 4, 30], [0, 1], [4, 3, 40]], Infinity, 1);
    assert.deepEqual(out, [
        [1, 2, 10],
        [3, 4, 30],
    ]);
});

test('parseTuples respects the max count and non-arrays', () => {
    assert.equal(parseTuples([[1, 2], [1, 3], [1, 4]], 2).length, 2);
    assert.deepEqual(parseTuples(null), []);
    assert.deepEqual(parseTuples({ length: 3 }), []);
});

test('tuplesFromHistory reads the game save format', () => {
    const history = { parents: [[2, 1], [1, 3], [1, 2], 'bad'], date: [100, 200, 300, 400] };
    assert.deepEqual(tuplesFromHistory(history), [
        [1, 2, 100],
        [1, 3, 200],
    ]);
    assert.deepEqual(tuplesFromHistory(null), []);
    assert.deepEqual(tuplesFromHistory({ parents: [[1, 2]] }).map(tupleKey), ['1+2']);
});

test('missingTuples returns what the known set lacks, without duplicates', () => {
    const known = new Set(['1+2']);
    assert.deepEqual(missingTuples(known, [[1, 2, 1], [1, 3, 2], [1, 3, 3]]), [[1, 3, 2]]);
});
