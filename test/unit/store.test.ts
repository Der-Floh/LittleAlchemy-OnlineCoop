import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, saveSettings, sanitizePeerServer, peerOptions } from '../../src/store.ts';
import { ROOM_CODE_ALPHABET } from '../../src/net/protocol.ts';

const KEY = 'laCoopSettings';

// A localStorage stand-in.
function memoryStorage(initial?: unknown) {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(KEY, typeof initial === 'string' ? initial : JSON.stringify(initial));
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
        saved: (): unknown => JSON.parse(data.get(KEY) ?? 'null'),
    };
}

test('fresh settings get defaults and are saved right away', () => {
    const storage = memoryStorage();
    const settings = loadSettings(storage);
    assert.equal(typeof settings.playerId, 'string');
    assert.ok(settings.playerId.length > 0 && settings.playerId.length <= 64);
    assert.match(settings.name, /^Alchemist \d{3}$/);
    assert.equal(settings.room, null);
    assert.equal(settings.toasts, true);
    assert.equal(settings.cursors, true);
    assert.deepEqual(settings.lastSeen, {});
    assert.equal(settings.peerServer, null);
    assert.deepEqual(storage.saved(), settings);
    // The id stays the same on the next load.
    assert.equal(loadSettings(storage).playerId, settings.playerId);
});

test('valid saved settings are kept as they are', () => {
    const saved = {
        playerId: 'p-1',
        name: 'Bob',
        room: { code: 'K7M4PX', active: true },
        toasts: false,
        cursors: false,
        lastSeen: { K7M4PX: 1_700_000_000_000 },
        peerServer: { host: 'peer.example.com', port: 9000, path: '/myapp', secure: false, key: 'k' },
    };
    assert.deepEqual(loadSettings(memoryStorage(saved)), saved);
});

test('bad saved values fall back to defaults, one field at a time', () => {
    const settings = loadSettings(
        memoryStorage({
            playerId: 'x'.repeat(65),
            name: '\u0000\u0007',
            room: { code: 'nope', active: true },
            toasts: 'no',
            cursors: 0,
            lastSeen: 'yesterday',
            peerServer: { host: 'bad host!', port: 80 },
        }),
    );
    assert.notEqual(settings.playerId, 'x'.repeat(65));
    assert.match(settings.name, /^Alchemist \d{3}$/);
    assert.equal(settings.room, null);
    assert.equal(settings.toasts, true); // only an explicit false turns them off
    assert.equal(settings.cursors, true);
    assert.deepEqual(settings.lastSeen, {});
    assert.equal(settings.peerServer, null);

    const other = loadSettings(memoryStorage({ playerId: '', name: '  Ann \n Lee ', room: { code: ' k7m-4px ', active: 'yes' } }));
    assert.ok(other.playerId.length > 0);
    assert.equal(other.name, 'Ann Lee');
    assert.deepEqual(other.room, { code: 'K7M4PX', active: false });
});

test('corrupt or empty storage gives defaults', () => {
    for (const raw of ['{nope', 'null', '[]', '42']) {
        const settings = loadSettings(memoryStorage(raw));
        assert.equal(settings.room, null, raw);
        assert.equal(settings.toasts, true, raw);
    }
});

test('last-seen times keep the 20 most recent valid rooms, newest first', () => {
    const lastSeen: Record<string, unknown> = { nope: 5, K7M4PX: 'soon', K7M4PQ: Infinity };
    const codes: string[] = [];
    for (let i = 0; i < 25; i++) {
        const code = 'AAAAA' + ROOM_CODE_ALPHABET[i];
        codes.push(code);
        lastSeen[code] = 1000 + i;
    }
    const settings = loadSettings(memoryStorage({ lastSeen }));
    const expected = codes.slice(5).reverse();
    assert.deepEqual(Object.keys(settings.lastSeen), expected);
    assert.equal(Object.values(settings.lastSeen)[0], 1024);
});

test('sanitizePeerServer normalizes a self-hosted PeerJS server', () => {
    assert.deepEqual(sanitizePeerServer({ host: ' peer.example.com ', port: '9000' }), {
        host: 'peer.example.com',
        port: 9000,
        path: '/',
        secure: true,
        key: 'peerjs',
    });
    assert.deepEqual(sanitizePeerServer({ host: 'localhost', port: 443, path: 'app', secure: false, key: ' k'.repeat(40) }), {
        host: 'localhost',
        port: 443,
        path: '/app',
        secure: false,
        key: ' k'.repeat(40).trim().slice(0, 64),
    });
    for (const bad of [null, 'peer.example.com', { host: '', port: 9000 }, { host: 'a b', port: 9000 }, { host: 'x', port: 0 }, { host: 'x', port: 70000 }, { host: 'x', port: 'http' }, { host: 'x', port: 1.5 }]) {
        assert.equal(sanitizePeerServer(bad), null, JSON.stringify(bad));
    }
});

test('peerOptions uses the configured server and keeps PeerJS quiet unless debugging', () => {
    const server = { host: 'peer.example.com', port: 9000, path: '/', secure: true, key: 'peerjs' };
    assert.deepEqual(peerOptions({ peerServer: null }), { debug: 0 });
    assert.deepEqual(peerOptions({ peerServer: server }, { debug: true }), { debug: 2, ...server });
});

test('saveSettings survives a full or blocked storage', () => {
    const broken = {
        setItem: () => {
            throw new Error('QuotaExceededError');
        },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.doesNotThrow(() => saveSettings(loadSettings(memoryStorage()), broken));
    } finally {
        console.warn = warn;
    }
});
