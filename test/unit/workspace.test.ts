import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOps, parseSnapshot, MAX_OPS_PER_BATCH, MAX_ELEMENTS, type Op } from '../../src/workspace/ops.ts';
import { WorkspaceState } from '../../src/workspace/state.ts';
import { toShared, toLocal, pointToShared, pointToLocal } from '../../src/workspace/projection.ts';

// ---- ops ---------------------------------------------------------------------

test('parseOps accepts every op kind and clamps coordinates', () => {
    assert.deepEqual(
        parseOps([
            ['a', 'x1', 5, 0.25, 1.7],
            ['m', 'x1', -3, 0.123456],
            ['h', 'x1'],
            ['r', 'x1'],
            ['d', 'x1'],
        ]),
        [
            ['a', 'x1', 5, 0.25, 1],
            ['m', 'x1', 0, 0.1235],
            ['h', 'x1'],
            ['r', 'x1'],
            ['d', 'x1'],
        ],
    );
});

test('parseOps rejects a batch with any malformed op', () => {
    const bad = [
        [['z', 'x1']],
        [['a', 'X1', 5, 0, 0]], // oids are lowercase
        [['a', 'x1', 0, 0, 0]], // not an element id
        [['a', 'x1', 5, NaN, 0]],
        [['m', 'x1', '0.5', 0]],
        [['d']],
        [],
        'ops',
        Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => ['d', 'x1']),
    ];
    for (const ops of bad) assert.equal(parseOps(ops), null, JSON.stringify(ops).slice(0, 60));
});

test('parseSnapshot validates elements and drops holds on unknown elements', () => {
    const snap = parseSnapshot({
        elements: [
            ['a1', 5, 0.5, 0.5, 'p1'],
            ['a2', 6, 2, -1, 42],
        ],
        holds: [
            ['a1', 'p2'],
            ['zz', 'p2'],
        ],
        ack: 7,
    });
    assert.deepEqual(snap, {
        elements: [
            ['a1', 5, 0.5, 0.5, 'p1'],
            ['a2', 6, 1, 0, ''],
        ],
        holds: [['a1', 'p2']],
        ack: 7,
    });
    assert.equal(parseSnapshot({ elements: [['a1', 5, 0, 0], ['a1', 6, 0, 0]] }), null); // duplicate id
    assert.equal(parseSnapshot({ elements: 'x' }), null);
    assert.equal(parseSnapshot({ elements: [] })?.ack, 0);
});

// ---- state -------------------------------------------------------------------

const A = 'alice';
const B = 'bob';

function stateWith(...adds: [oid: string, el: number][]) {
    const s = new WorkspaceState();
    s.applyBatch(adds.map(([oid, el]) => ['a', oid, el, 0.5, 0.5]), A, { authoritative: true });
    return s;
}

test('adds record the owner; moves and deletes update the canvas', () => {
    const s = new WorkspaceState();
    assert.deepEqual(s.applyBatch([['a', 'e1', 1, 0.1, 0.2]], B, { authoritative: true }), { ok: true });
    assert.deepEqual(s.get('e1'), { el: 1, x: 0.1, y: 0.2, owner: B });
    s.applyBatch([['m', 'e1', 0.3, 0.4]], A, { authoritative: true });
    assert.deepEqual([s.get('e1')?.x, s.get('e1')?.y, s.get('e1')?.owner], [0.3, 0.4, B]);
    s.applyBatch([['d', 'e1']], A, { authoritative: true });
    assert.equal(s.size, 0);
});

test('an authoritative batch is all or nothing', () => {
    const s = stateWith(['e1', 1]);
    const before = s.hash();
    // A combination whose ingredient was already used by someone else.
    const result = s.applyBatch([['a', 'c1', 5, 0.5, 0.5], ['d', 'e1'], ['d', 'gone']], A, { authoritative: true });
    assert.deepEqual(result, { ok: false, reason: 'missing' });
    assert.equal(s.hash(), before);
    assert.equal(s.get('c1'), null);
});

test("holds protect an element from other players, not from its holder", () => {
    const s = stateWith(['e1', 1]);
    assert.ok(s.applyBatch([['h', 'e1'], ['m', 'e1', 0.9, 0.9]], B, { authoritative: true }).ok);
    assert.equal(s.holderOf('e1'), B);
    const refused: Op[] = [['m', 'e1', 0.1, 0.1], ['d', 'e1'], ['h', 'e1']];
    for (const op of refused) {
        assert.deepEqual(s.applyBatch([op], A, { authoritative: true }), { ok: false, reason: 'held' }, op[0]);
    }
    // Releasing someone else's hold is a harmless no-op.
    assert.ok(s.applyBatch([['r', 'e1']], A, { authoritative: true }).ok);
    assert.equal(s.holderOf('e1'), B);
    // The holder may use it in a combination.
    assert.ok(s.applyBatch([['d', 'e1']], B, { authoritative: true }).ok);
    assert.equal(s.holderOf('e1'), null);
});

test('ids cannot be reused and the canvas has a cap', () => {
    const s = stateWith(['e1', 1]);
    assert.deepEqual(s.applyBatch([['a', 'e1', 2, 0, 0]], B, { authoritative: true }), { ok: false, reason: 'exists' });
    const full = new WorkspaceState();
    const adds = Array.from({ length: MAX_ELEMENTS }, (_, i): Op => ['a', 'f' + i, 1, 0, 0]);
    for (let i = 0; i < adds.length; i += 150) full.applyBatch(adds.slice(i, i + 150), A, { authoritative: true });
    assert.equal(full.size, MAX_ELEMENTS);
    assert.deepEqual(full.applyBatch([['a', 'one', 1, 0, 0]], A, { authoritative: true }), { ok: false, reason: 'full' });
});

test('lenient application follows the host and skips what cannot apply', () => {
    const s = stateWith(['e1', 1]);
    s.applyBatch([['h', 'e1']], A, { authoritative: true }); // we predicted our own grab
    // The host says Bob got it first, moved it, and something we never saw vanished.
    s.applyBatch([['h', 'e1'], ['m', 'e1', 0.7, 0.7], ['d', 'unknown']], B);
    assert.equal(s.holderOf('e1'), B);
    assert.equal(s.get('e1')?.x, 0.7);
});

test('releaseAll frees a departed player\'s grabs; ownedBy lists their elements', () => {
    const s = new WorkspaceState();
    s.applyBatch([['a', 'b1', 1, 0, 0], ['a', 'b2', 2, 0, 0], ['h', 'b1']], B, { authoritative: true });
    s.applyBatch([['a', 'a1', 3, 0, 0]], A, { authoritative: true });
    assert.deepEqual(s.ownedBy(B).sort(), ['b1', 'b2']);
    assert.deepEqual(s.releaseAll(B), ['b1']);
    assert.equal(s.holderOf('b1'), null);
});

test('snapshots round-trip and the hash ignores insertion order', () => {
    const s1 = new WorkspaceState();
    s1.applyBatch([['a', 'x', 1, 0.1, 0.1], ['a', 'y', 2, 0.2, 0.2], ['h', 'y']], A, { authoritative: true });
    const snap = parseSnapshot(s1.snapshot());
    assert.ok(snap);
    const s2 = WorkspaceState.fromSnapshot(snap);
    assert.equal(s2.hash(), s1.hash());
    assert.equal(s2.holderOf('y'), A);
    const s3 = new WorkspaceState();
    s3.applyBatch([['a', 'y', 2, 0.2, 0.2], ['a', 'x', 1, 0.1, 0.1]], A, { authoritative: true });
    assert.equal(s3.hash(), s1.hash());
    s3.applyBatch([['m', 'x', 0.5, 0.1]], A, { authoritative: true });
    assert.notEqual(s3.hash(), s1.hash());
});

test('client prediction converges with the host after a rejected batch', () => {
    // Host and Bob agree on a canvas with element e1.
    const host = stateWith(['e1', 1]);
    const bob = WorkspaceState.fromSnapshot(host.snapshot());
    // Alice grabs e1 first (host has processed it).
    host.applyBatch([['h', 'e1']], A, { authoritative: true });

    // Bob, not knowing yet, predicts: 1) add b1, 2) grab + move e1, 3) add b2.
    const pending: [seq: number, ops: Op[]][] = [
        [1, [['a', 'b1', 5, 0.1, 0.1]]],
        [2, [['h', 'e1'], ['m', 'e1', 0.9, 0.9]]],
        [3, [['a', 'b2', 6, 0.2, 0.2]]],
    ];
    for (const [, ops] of pending) bob.applyBatch(ops, B);
    const [first, second, third] = pending.map(([, ops]) => ops) as [Op[], Op[], Op[]];

    // The host processes 1 (ok) and 2 (refused: Alice holds e1) and answers
    // with a snapshot acknowledging everything up to 2. Batch 3 is still in flight.
    assert.ok(host.applyBatch(first, B, { authoritative: true }).ok);
    assert.equal(host.applyBatch(second, B, { authoritative: true }).ok, false);
    const snap = parseSnapshot({ ...host.snapshot(), ack: 2 });
    assert.ok(snap);

    // Bob rebuilds: snapshot + his batches after the ack.
    const rebuilt = WorkspaceState.fromSnapshot(snap);
    for (const [seq, ops] of pending) if (seq > snap.ack) rebuilt.applyBatch(ops, B);

    // Then the host processes batch 3 too.
    assert.ok(host.applyBatch(third, B, { authoritative: true }).ok);
    assert.equal(rebuilt.hash(), host.hash());
    assert.equal(rebuilt.holderOf('e1'), A);
    assert.deepEqual([rebuilt.get('e1')?.x, rebuilt.get('b2')?.el], [0.5, 6]);
});

// ---- projection ----------------------------------------------------------------

const BIG = { playW: 1470, playH: 900, elemW: 74, elemH: 74 };
const SMALL = { playW: 440, playH: 700, elemW: 58, elemH: 58 };

test('positions round-trip exactly on the same screen', () => {
    const corners: [number, number][] = [[0, 0], [123, 456], [1396, 826], [700, 13]];
    for (const [left, top] of corners) {
        const { x, y } = toShared(left, top, BIG);
        assert.deepEqual(toLocal(x, y, BIG), { left, top }, `${left},${top}`);
    }
});

test('the same arrangement fits a smaller screen, fully visible', () => {
    const centre = toShared(BIG.playW / 2 - 37, BIG.playH / 2 - 37, BIG);
    assert.deepEqual(centre, { x: 0.5, y: 0.5 });
    assert.deepEqual(toLocal(centre.x, centre.y, SMALL), { left: 220 - 29, top: 350 - 29 });
    // Elements at the far edges stay on screen and out from under the library.
    const corner = toLocal(1, 1, SMALL);
    assert.deepEqual(corner, { left: SMALL.playW - SMALL.elemW, top: SMALL.playH - SMALL.elemH });
    assert.deepEqual(toLocal(0, 0, SMALL), { left: 0, top: 0 });
});

test('pointers map by position and are off over the library', () => {
    assert.deepEqual(pointToShared(735, 450, BIG), { x: 0.5, y: 0.5 });
    assert.equal(pointToShared(BIG.playW + 5, 100, BIG), null);
    assert.deepEqual(pointToLocal(0.5, 0.5, SMALL), { left: 220, top: 350 });
});
