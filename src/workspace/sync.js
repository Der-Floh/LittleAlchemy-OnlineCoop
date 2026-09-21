// WorkspaceSync: keeps everyone's canvas the same.
//
// The host is the referee. Every change is a batch of ops (see ops.js):
// - The host applies its own and its clients' batches authoritatively (all or
//   nothing, see state.js) and relays accepted ones to the others. A refused
//   batch earns the sender a snapshot, which snaps their screen back.
// - Clients apply their own batches right away (so dragging feels instant),
//   remember them until the host has seen them, and rebuild from snapshots:
//   snapshot + their own not-yet-acknowledged batches.
// - A joining player gets a snapshot that replaces their canvas.
// - Every 30 s an idle client sends a fingerprint of its canvas; two mismatches
//   in a row and the host sends a fresh snapshot (a safety net).
//
// App message kinds: 'ws' (a batch), 'wsnap' (snapshot), 'wshash' (fingerprint).

import { Emitter } from '../emitter.js';
import { WorkspaceState } from './state.js';
import { parseOps, parseSnapshot } from './ops.js';

const PENDING_TTL_MS = 10_000;
const MAX_PENDING = 200;
const HASH_INTERVAL_MS = 30_000;

export class WorkspaceSync extends Emitter {
  constructor({ session, bridge, log = () => {}, hashIntervalMs = HASH_INTERVAL_MS }) {
    super();
    this.session = session;
    this.bridge = bridge;
    this.log = log;
    this.hashIntervalMs = hashIntervalMs;
    this.state = new WorkspaceState();
    this.active = false;
    this.role = null; // 'host' | 'client' | null while (re)connecting
    this._seq = 0;
    this._pending = []; // client: [{seq, ops, clear, sent, at}]
    this._lastSeq = new Map(); // host: playerId -> last batch seq processed
    this._mismatches = new Map(); // host: playerId -> consecutive fingerprint mismatches
    this._seeded = false; // our state reflects the room's canvas
    this._awaitingSnapshot = false;
    this._hashTimer = null;

    bridge.ownerOf = (oid) => {
      const element = this.state.get(oid);
      return element ? element.owner : null;
    };
    bridge.on('ops', (batch) => this._onLocal(batch));
    session.on('status', (status) => this._onStatus(status));
    session.on('app', (message) => this._onApp(message));
    session.on('welcomed', ({ member }) => this._onWelcomed(member));
    session.on('departed', (member) => this._onDeparted(member));
  }

  get me() {
    return this.session.playerId;
  }

  // Called when joining a room (before the session connects).
  start() {
    if (this.active) this.stop();
    this.active = true;
    this.role = null;
    this.state = new WorkspaceState();
    this._pending = [];
    this._lastSeq.clear();
    this._mismatches.clear();
    this._seeded = false;
    this._awaitingSnapshot = false;
    this.bridge.activate(this.me);
    this._hashTimer = setInterval(() => this._sendFingerprint(), this.hashIntervalMs);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.role = null;
    clearInterval(this._hashTimer);
    this._hashTimer = null;
    this.bridge.deactivate();
    this.state = new WorkspaceState();
    this._pending = [];
  }

  _memberInfo() {
    const map = new Map();
    for (const m of this.session.members) map.set(m.id, { name: m.name, color: m.color });
    return map;
  }

  // ---- roles --------------------------------------------------------------------

  _onStatus({ state }) {
    if (!this.active) return;
    if (state === 'idle' || state === 'rejected') this.stop();
    else if (state === 'hosting' && this.role !== 'host') this._becomeHost();
    else if (state === 'connected' && this.role !== 'client') this._becomeClient();
    else if (state === 'connecting' || state === 'reconnecting') this.role = null;
  }

  _becomeHost() {
    this.role = 'host';
    this._awaitingSnapshot = false;
    if (!this._seeded) {
      // A new room: whatever is on our canvas becomes the room's canvas.
      this.state = new WorkspaceState();
      const ops = this.bridge.currentElements();
      for (let i = 0; i < ops.length; i += 200) this.state.applyBatch(ops.slice(i, i + 200), this.me);
      this._seeded = true;
    } else {
      // Taking over: our copy is the truth now; other players' grabs ended
      // with their old connections.
      for (const [oid, who] of [...this.state.holds]) if (who !== this.me) this.state.holds.delete(oid);
    }
    this._pending = [];
    this._lastSeq.clear();
    this._mismatches.clear();
    this.bridge.reconcile(this.state, this._memberInfo());
  }

  _becomeClient() {
    this.role = 'client';
    // The host sends a snapshot right after welcoming us; until then we only queue.
    this._awaitingSnapshot = true;
  }

  // ---- local changes ------------------------------------------------------------

  _onLocal({ ops, clear }) {
    if (!this.active) return;
    if (this.role === 'host') {
      const result = this.state.applyBatch(ops, this.me, { authoritative: true });
      if (result.ok) this.session.sendApp('ws', { ops, clear });
      else {
        this.log('own workspace change refused:', result.reason);
        this.bridge.reconcile(this.state, this._memberInfo());
      }
      return;
    }
    this.state.applyBatch(ops, this.me);
    const entry = { seq: ++this._seq, ops, clear, sent: false, at: Date.now() };
    this._pending.push(entry);
    this._prunePending();
    if (this.role === 'client' && !this._awaitingSnapshot) this._send(entry);
  }

  _send(entry) {
    if (this.session.sendApp('ws', { seq: entry.seq, ops: entry.ops, clear: entry.clear })) {
      entry.sent = true;
      entry.at = Date.now();
    }
  }

  _prunePending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    this._pending = this._pending.filter((p) => !p.sent || p.at >= cutoff);
    if (this._pending.length > MAX_PENDING) this._pending = this._pending.slice(-MAX_PENDING);
  }

  // ---- messages -------------------------------------------------------------------

  _onApp({ k, d, by, fromHost }) {
    if (!this.active) return;
    if (k === 'ws') {
      if (fromHost) this._onRelayed(d, by);
      else this._onClientBatch(d, by);
    } else if (k === 'wsnap' && fromHost) {
      this._onSnapshot(d);
    } else if (k === 'wshash' && !fromHost) {
      this._onFingerprint(d, by);
    }
  }

  // Host: a client's batch.
  _onClientBatch(d, by) {
    if (this.role !== 'host') return;
    if (Number.isInteger(d.seq) && d.seq > 0) this._lastSeq.set(by.id, Math.max(d.seq, this._lastSeq.get(by.id) || 0));
    const ops = parseOps(d.ops);
    const result = ops ? this.state.applyBatch(ops, by.id, { authoritative: true }) : { ok: false, reason: 'malformed' };
    if (!result.ok) {
      this.log('workspace change from', by.name, 'refused:', result.reason);
      this._sendSnapshot(by.id, false);
      return;
    }
    const clear = d.clear === true;
    this.bridge.applyOps(ops, by);
    this.session.relayApp('ws', { ops, clear }, by.id);
    if (clear) this.emit('cleared', by);
  }

  // Client: a batch the host accepted, from the host or another player.
  _onRelayed(d, by) {
    if (this.role !== 'client') return;
    const ops = parseOps(d.ops);
    if (!ops) return;
    this.state.applyBatch(ops, by.id);
    if (!this._awaitingSnapshot) this.bridge.applyOps(ops, by);
    if (d.clear === true) this.emit('cleared', by);
  }

  // Client: the host's canvas. Ours = snapshot + our batches it hasn't seen yet.
  _onSnapshot(d) {
    if (this.role !== 'client') return;
    const snap = parseSnapshot(d);
    if (!snap) return;
    const target = WorkspaceState.fromSnapshot(snap);
    this._pending = this._pending.filter((p) => p.seq > snap.ack);
    for (const p of this._pending) target.applyBatch(p.ops, this.me);
    this.state = target;
    this._seeded = true;
    this._awaitingSnapshot = false;
    this.bridge.reconcile(this.state, this._memberInfo());
    // A fresh snapshot comes from a host that may never have seen our batches.
    for (const p of this._pending) if (d.fresh === true || !p.sent) this._send(p);
    this.emit('snapshot', { size: this.state.size });
  }

  _sendSnapshot(playerId, fresh) {
    this.session.sendAppTo(playerId, 'wsnap', { ...this.state.snapshot(), ack: this._lastSeq.get(playerId) || 0, fresh });
  }

  // Host: someone joined (or came back): their canvas becomes ours.
  _onWelcomed(member) {
    if (!this.active || this.role !== 'host') return;
    this._lastSeq.delete(member.id);
    this._mismatches.delete(member.id);
    this._sendSnapshot(member.id, true);
  }

  // Host: someone's connection ended; whatever they were dragging stays put.
  _onDeparted(member) {
    if (!this.active || this.role !== 'host') return;
    this._lastSeq.delete(member.id);
    this._mismatches.delete(member.id);
    const released = this.state.releaseAll(member.id);
    if (released.length === 0) return;
    const ops = released.map((oid) => ['r', oid]);
    this.bridge.applyOps(ops, member);
    this.session.relayApp('ws', { ops }, member.id);
  }

  // ---- safety net ------------------------------------------------------------------

  _sendFingerprint() {
    if (!this.active || this.role !== 'client' || this._awaitingSnapshot || this.bridge.isDragging()) return;
    if (this._pending.some((p) => Date.now() - p.at < 2_000)) return;
    this.session.sendApp('wshash', { h: this.state.hash() });
  }

  _onFingerprint(d, by) {
    if (this.role !== 'host' || typeof d.h !== 'string') return;
    if (d.h === this.state.hash()) {
      this._mismatches.delete(by.id);
      return;
    }
    const count = (this._mismatches.get(by.id) || 0) + 1;
    this._mismatches.set(by.id, count);
    if (count >= 2) {
      this._mismatches.delete(by.id);
      this.log('canvas of', by.name, 'drifted; sending a snapshot');
      this._sendSnapshot(by.id, false);
    }
  }
}
