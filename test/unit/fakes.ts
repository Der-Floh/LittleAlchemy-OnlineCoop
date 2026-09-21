// In-memory stand-ins for PeerJS and the game, for testing RoomSession.
// FakeNetwork mimics the PeerJS behaviour the session relies on: unique ids on
// the broker ('unavailable-id'), connecting to a missing id ('peer-unavailable'),
// broker disconnects that keep data connections alive, and reconnect().

import { EventEmitter } from 'node:events';
import type { ConnLike, ConnectOptions, PeerLike } from '../../src/net/peer.ts';
import type { ApplyMeta, GameLike, Timing } from '../../src/net/session.ts';
import type { Tuple } from '../../src/sync/pairs.ts';

export { setTimeout as sleep } from 'node:timers/promises';

export class FakeNetwork {
    readonly registry = new Map<string, FakePeer>();
    readonly latency: number;
    seq = 0;
    readonly peers: FakePeer[] = [];
    private readonly partitions = new Set<unknown>();

    constructor({ latency = 1 } = {}) {
        this.latency = latency;
    }

    createPeer(id: string | undefined): FakePeer {
        const peer = new FakePeer(this, id);
        this.peers.push(peer);
        return peer;
    }

    later(fn: () => void): void {
        setTimeout(fn, this.latency);
    }

    holderOf(id: string): FakePeer | null {
        return this.registry.get(id) ?? null;
    }

    // Messages between these two peers are silently dropped.
    partition(a: PeerLike | null, b: PeerLike | null): void {
        this.partitions.add(a);
        this.partitions.add(b);
    }

    isPartitioned(a: FakePeer, b: FakePeer): boolean {
        return this.partitions.has(a) && this.partitions.has(b);
    }
}

export class FakePeer extends EventEmitter implements PeerLike {
    readonly net: FakeNetwork;
    id: string | null = null;
    open = false;
    disconnected = false;
    destroyed = false;
    private lastServerId: string | null = null;
    readonly conns = new Set<FakeConn>();

    constructor(net: FakeNetwork, id: string | undefined) {
        super();
        this.net = net;
        net.later(() => this.register(id ?? 'rand-' + ++net.seq));
    }

    private register(id: string): void {
        if (this.destroyed) return;
        const holder = this.net.registry.get(id);
        if (holder && holder !== this) {
            this.abort('unavailable-id');
            return;
        }
        this.net.registry.set(id, this);
        this.id = id;
        this.lastServerId = id;
        this.open = true;
        this.disconnected = false;
        this.emit('open', id);
    }

    private abort(type: string): void {
        this.emit('error', { type });
        if (!this.lastServerId) this.destroy();
        else this.disconnect();
    }

    connect(targetId: string, options: ConnectOptions = {}): FakeConn {
        const local = new FakeConn(this, targetId, options);
        this.conns.add(local);
        this.net.later(() => {
            if (this.destroyed || local.closed) return;
            const target = this.net.registry.get(targetId);
            if (!target || target.destroyed) {
                this.emit('error', { type: 'peer-unavailable' });
                return;
            }
            const remote = new FakeConn(target, this.id ?? '', options);
            local.other = remote;
            remote.other = local;
            target.conns.add(remote);
            target.emit('connection', remote);
            if (this.net.isPartitioned(this, target)) return; // never opens
            this.net.later(() => {
                if (local.closed || remote.closed) return;
                local.markOpen();
                remote.markOpen();
            });
        });
        return local;
    }

    // Lost the broker: the id is released, data connections survive.
    disconnect(): void {
        if (this.disconnected) return;
        if (this.id && this.net.registry.get(this.id) === this) this.net.registry.delete(this.id);
        this.disconnected = true;
        this.open = false;
        this.id = null;
        this.emit('disconnected');
    }

    reconnect(): void {
        if (this.destroyed) throw new Error('destroyed');
        if (!this.disconnected) throw new Error('not disconnected');
        this.disconnected = false;
        const id = this.lastServerId;
        if (id) this.net.later(() => this.register(id));
    }

    destroy(): void {
        if (this.destroyed) return;
        this.disconnect();
        for (const conn of this.conns) conn.close();
        this.destroyed = true;
        this.emit('close');
    }
}

export class FakeConn extends EventEmitter implements ConnLike {
    readonly owner: FakePeer;
    readonly peer: string;
    readonly metadata: unknown;
    readonly serialization: string | undefined;
    open = false;
    closed = false;
    other: FakeConn | null = null;
    readonly peerConnection = null;
    readonly sent: string[] = [];

    constructor(owner: FakePeer, remoteId: string, options: ConnectOptions) {
        super();
        this.owner = owner;
        this.peer = remoteId;
        this.metadata = options.metadata;
        this.serialization = options.serialization;
    }

    markOpen(): void {
        this.open = true;
        this.emit('open');
    }

    send(data: string): void {
        if (!this.open) throw new Error('connection not open');
        this.sent.push(data);
        const other = this.other;
        const net = this.owner.net;
        if (!other || net.isPartitioned(this.owner, other.owner)) return;
        setTimeout(() => {
            if (!other.closed) other.emit('data', data);
        }, net.latency);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.open = false;
        this.emit('close');
        const other = this.other;
        if (other && !other.closed) setTimeout(() => other.close(), this.owner.net.latency);
    }
}

export class FakeGame implements GameLike {
    readonly tuples: Tuple[] = [];
    readonly keys = new Set<string>();
    readonly isRecipe: (tuple: Tuple) => boolean;
    readonly applied: { added: Tuple[]; meta: ApplyMeta }[] = [];

    constructor(tuples: Tuple[] = [], { isRecipe }: { isRecipe?: ((tuple: Tuple) => boolean) | undefined } = {}) {
        this.isRecipe = isRecipe ?? (() => true);
        for (const t of tuples) this.add(t);
    }

    private add(tuple: Tuple): boolean {
        const key = tuple[0] + '+' + tuple[1];
        if (this.keys.has(key)) return false;
        this.keys.add(key);
        this.tuples.push(tuple);
        return true;
    }

    getTuples(): Tuple[] {
        return this.tuples.slice();
    }

    applyTuples(tuples: readonly Tuple[], meta: ApplyMeta): Tuple[] {
        const added: Tuple[] = [];
        for (const tuple of tuples) {
            if (!this.isRecipe(tuple)) continue;
            if (this.add(tuple)) added.push(tuple);
        }
        if (added.length) this.applied.push({ added, meta });
        return added;
    }

    // A local discovery; the caller forwards it to session.broadcastLocal().
    discover(a: number, b: number, ts = Date.now()): Tuple | null {
        const tuple: Tuple = [Math.min(a, b), Math.max(a, b), ts];
        return this.add(tuple) ? tuple : null;
    }

    pairs(): string[] {
        return [...this.keys].sort();
    }
}

export const FAST_TIMING: Timing = {
    heartbeatMs: 20,
    deadAfterMs: 200,
    connectTimeoutMs: 250,
    helloTimeoutMs: 250,
    retryBaseMs: 10,
    retryMaxMs: 60,
    jitterMs: 10,
    claimRetryMs: 10,
    hostLostDelayMs: 5,
    rtcDisconnectGraceMs: 20,
    brokerRetryBaseMs: 10,
    brokerRetryMaxMs: 60,
    demoteDelayMs: 10,
    rejoinGraceMs: 300,
    addWindowMs: 1000,
    addMaxPerWindow: 40,
    appBucketSize: 120,
    appRefillPerSec: 60,
    handoverReleaseMs: 10,
    handoverRejoinMs: 80,
    handoverClaimDelayMs: 15,
    handoverClaimRetryMs: 10,
    handoverClaimRetries: 16,
    handoverFollowerDelayMs: 60,
};

export async function waitFor(predicate: () => boolean, { timeout = 4000, interval = 5, what = 'condition' } = {}): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + what);
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}
