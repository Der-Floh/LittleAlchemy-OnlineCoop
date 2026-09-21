import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    decode,
    encode,
    makeRoomCode,
    normalizeRoomCode,
    sanitizeName,
    hostPeerId,
    ROOM_CODE_ALPHABET,
    ROOM_CODE_LENGTH,
    MAX_MESSAGE_CHARS,
    MAX_PAIRS_PER_MESSAGE,
    PROTOCOL_VERSION,
    type Message,
    type MessageOf,
    type Outgoing,
} from '../../src/net/protocol.ts';

// What a (possibly misbehaving) peer puts on the wire.
const wire = (msg: unknown): string => JSON.stringify(msg);

// Decodes and checks the message type.
function decodeAs<T extends Message['t']>(raw: string, t: T): MessageOf<T> {
    const { msg, error } = decode(raw);
    assert.equal(error, undefined);
    assert.equal(msg?.t, t);
    return msg as MessageOf<T>;
}

test('room codes use the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
        const code = makeRoomCode();
        assert.equal(code.length, ROOM_CODE_LENGTH);
        for (const ch of code) assert.ok(ROOM_CODE_ALPHABET.includes(ch), code);
        assert.equal(normalizeRoomCode(code), code);
    }
    assert.ok(!/[ILO01]/.test(ROOM_CODE_ALPHABET));
});

test('normalizeRoomCode is forgiving about case, spaces and dashes', () => {
    assert.equal(normalizeRoomCode(' k7m-4px '), 'K7M4PX');
    assert.equal(normalizeRoomCode('K7M 4PX'), 'K7M4PX');
    assert.equal(normalizeRoomCode('K7M4P'), null);
    assert.equal(normalizeRoomCode('K7M4PXX'), null);
    assert.equal(normalizeRoomCode('K7M4P0'), null); // zero is not in the alphabet
    assert.equal(normalizeRoomCode(42), null);
});

test('host peer ids are namespaced', () => {
    assert.equal(hostPeerId('K7M4PX'), 'lacoop1-K7M4PX');
});

test('sanitizeName strips control characters and caps the length', () => {
    assert.equal(sanitizeName('  Bob \n the\tbuilder '), 'Bob the builder');
    assert.equal(sanitizeName('\u0000\u0007'), null);
    assert.equal(sanitizeName(''), null);
    assert.equal(sanitizeName(12), null);
    assert.equal(Array.from(sanitizeName('🧪'.repeat(40)) ?? '').length, 24);
});

test('decode rejects non-strings, oversized and malformed input', () => {
    assert.equal(decode({ t: 'ping' }).error, 'not-a-string');
    assert.equal(decode('x'.repeat(MAX_MESSAGE_CHARS + 1)).error, 'too-large');
    assert.equal(decode('{nope').error, 'bad-json');
    assert.equal(decode('[]').error, 'no-type');
    assert.equal(decode('null').error, 'no-type');
    assert.equal(decode('{"t":5}').error, 'no-type');
});

test('decode normalizes a hello and cleans its pairs', () => {
    const raw = wire({
        t: 'hello',
        v: PROTOCOL_VERSION,
        build: '580',
        player: { id: 'abc', name: ' Alice\u0000 ' },
        pairs: [[2, 1, 5], [1, 2, 6], ['x'], [0, 3]],
        extra: 'ignored',
    });
    assert.deepEqual(decode(raw).msg, {
        t: 'hello',
        v: PROTOCOL_VERSION,
        build: '580',
        player: { id: 'abc', name: 'Alice' },
        pairs: [[1, 2, 5]],
    });
});

test('decode refuses a hello without a player id or version', () => {
    assert.equal(decode(wire({ t: 'hello', v: 1, player: {} })).error, 'bad-hello');
    assert.equal(decode(wire({ t: 'hello', player: { id: 'a' } })).error, 'bad-hello');
    assert.equal(decode(wire({ t: 'hello', v: 1, player: { id: 'x'.repeat(65) } })).error, 'bad-hello');
});

test('decode caps pairs per message', () => {
    const pairs: number[][] = [];
    for (let a = 1; pairs.length < MAX_PAIRS_PER_MESSAGE + 50; a++) for (let b = a; b < a + 10; b++) pairs.push([a, b]);
    const msg = decodeAs(wire({ t: 'add', by: { id: 'a', name: 'A' }, pairs }), 'add');
    assert.equal(msg.pairs.length, MAX_PAIRS_PER_MESSAGE);
});

test('decode sanitizes member lists and colors', () => {
    const msg = decodeAs(
        wire({
            t: 'presence',
            members: [{ id: 'a', name: 'A', color: 3, host: true }, { id: 'b', name: '', color: 99 }, { name: 'no id' }],
        }),
        'presence',
    );
    assert.deepEqual(msg.members, [
        { id: 'a', name: 'A', color: 3, host: true },
        { id: 'b', name: 'Player', color: 0, host: false },
    ]);
});

test('decode maps unknown reject reasons and message types safely', () => {
    assert.equal(decodeAs(wire({ t: 'reject', reason: '<script>' }), 'reject').reason, 'unknown');
    assert.deepEqual(decode(wire({ t: 'cursor', x: 1 })).msg, { t: 'unknown', type: 'cursor' });
});

test('v2 app messages: envelope checked, payload passed through for the feature', () => {
    assert.deepEqual(decode(encode({ t: 'app', k: 'ws', d: { ops: [['d', 'x1']] }, by: 'p1' })).msg, {
        t: 'app',
        k: 'ws',
        d: { ops: [['d', 'x1']] },
        by: 'p1',
    });
    assert.equal(decode(wire({ t: 'app', k: 'WS', d: {} })).error, 'bad-app');
    assert.equal(decode(wire({ t: 'app', k: 'toolongkindname', d: {} })).error, 'bad-app');
    assert.equal(decode(wire({ t: 'app', k: 'ws', d: 'text' })).error, 'bad-app');
    assert.equal(decodeAs(wire({ t: 'app', k: 'ws', d: { a: 1 } }), 'app').by, null);
});

test('v2 room flags in presence and welcome are sanitized', () => {
    const msg = decodeAs(wire({ t: 'presence', members: [], room: { locked: 'yes', banned: ['a', 'a', 5, 'b'], allowed: 'x' } }), 'presence');
    assert.deepEqual(msg.room, { locked: false, banned: ['a', 'b'], allowed: [] });
    assert.deepEqual(decodeAs(wire({ t: 'presence', members: [] }), 'presence').room, { locked: false, banned: [], allowed: [] });
    assert.deepEqual(decodeAs(wire({ t: 'welcome', v: 2, members: [], room: { locked: true } }), 'welcome').room, {
        locked: true,
        banned: [],
        allowed: [],
    });
});

test('v2 handover and new reject reasons', () => {
    assert.deepEqual(decode(encode({ t: 'handover', to: 'p2' })).msg, { t: 'handover', to: 'p2' });
    assert.equal(decode(wire({ t: 'handover' })).error, 'bad-handover');
    assert.equal(decodeAs(wire({ t: 'reject', reason: 'kicked' }), 'reject').reason, 'kicked');
    assert.equal(decodeAs(wire({ t: 'reject', reason: 'locked' }), 'reject').reason, 'locked');
});

test('everything we send decodes to itself', () => {
    const player = { id: 'p1', name: 'Alice' };
    const member = { ...player, color: 0, host: true };
    const room = { locked: true, banned: ['p9'], allowed: ['p1'] };
    const messages: Outgoing[] = [
        { t: 'hello', v: PROTOCOL_VERSION, build: '580', player, pairs: [[1, 2, 5]] },
        { t: 'welcome', v: PROTOCOL_VERSION, you: { color: 3 }, members: [member], room, pairs: [] },
        { t: 'reject', reason: 'full', detail: 'Rooms hold up to 8 players.' },
        { t: 'add', by: player, pairs: [[3, 4, 9]], sync: true },
        { t: 'presence', members: [member], room },
        { t: 'app', k: 'cur', d: { x: 0.5, y: 0.5 }, by: 'p1' },
        { t: 'handover', to: 'p2' },
        { t: 'rename', name: 'Ally' },
        { t: 'leave' },
        { t: 'ping' },
        { t: 'rehome' },
    ];
    for (const msg of messages) assert.deepEqual(decode(encode(msg)).msg, msg, msg.t);
});
