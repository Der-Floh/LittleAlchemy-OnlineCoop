// In-memory stand-ins for PeerJS and the game, for testing RoomSession.
// FakeNetwork mimics the PeerJS behaviour the session relies on: unique ids on
// the broker ('unavailable-id'), connecting to a missing id ('peer-unavailable'),
// broker disconnects that keep data connections alive, and reconnect().

import { EventEmitter } from 'node:events';

export class FakeNetwork {
  constructor({ latency = 1 } = {}) {
    this.registry = new Map();
    this.latency = latency;
    this.seq = 0;
    this.peers = [];
    this.partitions = new Set();
  }

  createPeer(id) {
    const peer = new FakePeer(this, id);
    this.peers.push(peer);
    return peer;
  }

  later(fn) {
    setTimeout(fn, this.latency);
  }

  holderOf(id) {
    return this.registry.get(id) || null;
  }

  // Messages between these two peer objects are silently dropped.
  partition(a, b) {
    this.partitions.add(a);
    this.partitions.add(b);
  }

  isPartitioned(a, b) {
    return this.partitions.has(a) && this.partitions.has(b);
  }
}

class FakePeer extends EventEmitter {
  constructor(net, id) {
    super();
    this.net = net;
    this.id = null;
    this.open = false;
    this.disconnected = false;
    this.destroyed = false;
    this._lastServerId = null;
    this.conns = new Set();
    net.later(() => this._register(id === undefined ? 'rand-' + ++net.seq : id));
  }

  _register(id) {
    if (this.destroyed) return;
    const holder = this.net.registry.get(id);
    if (holder && holder !== this) {
      this._abort('unavailable-id');
      return;
    }
    this.net.registry.set(id, this);
    this.id = id;
    this._lastServerId = id;
    this.open = true;
    this.disconnected = false;
    this.emit('open', id);
  }

  _abort(type) {
    this.emit('error', { type });
    if (!this._lastServerId) this.destroy();
    else this.disconnect();
  }

  connect(targetId, options = {}) {
    const local = new FakeConn(this, targetId, options);
    this.conns.add(local);
    this.net.later(() => {
      if (this.destroyed || local.closed) return;
      const target = this.net.registry.get(targetId);
      if (!target || target.destroyed) {
        this.emit('error', { type: 'peer-unavailable' });
        return;
      }
      const remote = new FakeConn(target, this.id, options);
      local.other = remote;
      remote.other = local;
      target.conns.add(remote);
      target.emit('connection', remote);
      if (this.net.isPartitioned(this, target)) return; // never opens
      this.net.later(() => {
        if (local.closed || remote.closed) return;
        local._open();
        remote._open();
      });
    });
    return local;
  }

  // Lost the broker: the id is released, data connections survive.
  disconnect() {
    if (this.disconnected) return;
    if (this.id && this.net.registry.get(this.id) === this) this.net.registry.delete(this.id);
    this.disconnected = true;
    this.open = false;
    this.id = null;
    this.emit('disconnected');
  }

  reconnect() {
    if (this.destroyed) throw new Error('destroyed');
    if (!this.disconnected) throw new Error('not disconnected');
    this.disconnected = false;
    this.net.later(() => this._register(this._lastServerId));
  }

  destroy() {
    if (this.destroyed) return;
    this.disconnect();
    for (const conn of this.conns) conn.close();
    this.destroyed = true;
    this.emit('close');
  }
}

class FakeConn extends EventEmitter {
  constructor(owner, remoteId, options) {
    super();
    this.owner = owner;
    this.peer = remoteId;
    this.metadata = options.metadata;
    this.serialization = options.serialization;
    this.open = false;
    this.closed = false;
    this.other = null;
    this.peerConnection = null;
    this.sent = [];
  }

  _open() {
    this.open = true;
    this.emit('open');
  }

  send(data) {
    if (!this.open) throw new Error('connection not open');
    this.sent.push(data);
    const other = this.other;
    const net = this.owner.net;
    if (net.isPartitioned(this.owner, other.owner)) return;
    setTimeout(() => {
      if (!other.closed) other.emit('data', data);
    }, net.latency);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    const other = this.other;
    if (other && !other.closed) setTimeout(() => other.close(), this.owner.net.latency);
  }
}

export class FakeGame {
  constructor(tuples = [], { isRecipe = () => true } = {}) {
    this.tuples = [];
    this.keys = new Set();
    this.isRecipe = isRecipe;
    this.applied = [];
    for (const t of tuples) this._add(t);
  }

  _add(tuple) {
    const key = tuple[0] + '+' + tuple[1];
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.tuples.push(tuple);
    return true;
  }

  getTuples() {
    return this.tuples.slice();
  }

  applyTuples(tuples, meta) {
    const added = [];
    for (const tuple of tuples) {
      if (!this.isRecipe(tuple)) continue;
      if (this._add(tuple)) added.push(tuple);
    }
    if (added.length) this.applied.push({ added, meta });
    return added;
  }

  // A local discovery; the caller forwards it to session.broadcastLocal().
  discover(a, b, ts = Date.now()) {
    const tuple = [Math.min(a, b), Math.max(a, b), ts];
    return this._add(tuple) ? tuple : null;
  }

  pairs() {
    return [...this.keys].sort();
  }
}

export const FAST_TIMING = {
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
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, { timeout = 4000, interval = 5, what = 'condition' } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + what);
    await sleep(interval);
  }
}
