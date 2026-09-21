// WorkspaceSync: keeps everyone's canvas the same.
//
// The host is the referee. Every change is a batch of ops (see ops.ts):
// - The host applies its own and its clients' batches authoritatively (all or
//   nothing, see state.ts) and relays accepted ones to the others. A refused
//   batch earns the sender a snapshot, which snaps their screen back.
// - Clients apply their own batches right away (so dragging feels instant),
//   remember them until the host has seen them, and rebuild from snapshots:
//   snapshot + their own not-yet-acknowledged batches.
// - A joining player gets a snapshot that replaces their canvas.
// - Every 30 s an idle client sends a fingerprint of its canvas; two mismatches
//   in a row and the host sends a fresh snapshot (a safety net).
//
// App message kinds: 'ws' (a batch), 'wsnap' (snapshot), 'wshash' (fingerprint).

import { Emitter } from '../emitter.ts';
import { WorkspaceState } from './state.ts';
import { parseBatch, parseFingerprint, parseWsSnapshot, type AddOp, type Op, type WsBatch } from './ops.ts';
import type { AppMessage, RoomSession, Status, Who } from '../net/session.ts';

const PENDING_TTL_MS = 10_000;
const MAX_PENDING = 200;
const HASH_INTERVAL_MS = 30_000;

export type LocalBatch = { ops: Op[]; clear: boolean };
export type MemberInfo = Map<string, { name: string; color: number }>;

// The canvas side of the sync: the WorkspaceBridge, or a fake in tests.
export interface BridgeLike {
  // Set by the sync: who placed an element (for "clear only mine").
  ownerOf: (oid: string) => string | null;
  on(type: 'ops', fn: (batch: LocalBatch) => void): unknown;
  activate(me: string): void;
  deactivate(): void;
  currentElements(): AddOp[];
  isDragging(): boolean;
  applyOps(ops: Op[], by: Who): void;
  reconcile(state: WorkspaceState, members: MemberInfo): void;
}

export type SyncEvents = {
  // A player cleared their elements.
  cleared: Who;
  // A snapshot from the host was applied.
  snapshot: { size: number };
};

type Pending = { seq: number; ops: Op[]; clear: boolean; sent: boolean; at: number };

export type SyncOptions = {
  session: RoomSession;
  bridge: BridgeLike;
  log?: (...args: unknown[]) => void;
  hashIntervalMs?: number;
};

export class WorkspaceSync extends Emitter<SyncEvents> {
  readonly session: RoomSession;
  readonly bridge: BridgeLike;
  private readonly log: (...args: unknown[]) => void;
  private readonly hashIntervalMs: number;
  state = new WorkspaceState();
  active = false;
  role: 'host' | 'client' | null = null; // null while (re)connecting
  private _seq = 0;
  private _pending: Pending[] = []; // client
  private readonly _lastSeq = new Map<string, number>(); // host: playerId -> last batch seq processed
  private readonly _mismatches = new Map<string, number>(); // host: playerId -> consecutive fingerprint mismatches
  private _seeded = false; // our state reflects the room's canvas
  private _awaitingSnapshot = false;
  private _stopHashTimer: (() => void) | null = null;

  constructor({ session, bridge, log = () => {}, hashIntervalMs = HASH_INTERVAL_MS }: SyncOptions) {
    super();
    this.session = session;
    this.bridge = bridge;
    this.log = log;
    this.hashIntervalMs = hashIntervalMs;

    bridge.ownerOf = (oid) => this.state.get(oid)?.owner ?? null;
    bridge.on('ops', (batch) => this._onLocal(batch));
    session.on('status', (status) => this._onStatus(status));
    session.on('app', (message) => this._onApp(message));
    session.on('welcomed', ({ member }) => this._onWelcomed(member));
    session.on('departed', (member) => this._onDeparted(member));
  }

  get me(): string {
    return this.session.playerId;
  }

  // True between joining and the host's first snapshot (tests use it).
  get awaitingSnapshot(): boolean {
    return this._awaitingSnapshot;
  }

  // Called when joining a room (before the session connects).
  start(): void {
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
    const timer = setInterval(() => this._sendFingerprint(), this.hashIntervalMs);
    this._stopHashTimer = () => clearInterval(timer);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.role = null;
    this._stopHashTimer?.();
    this._stopHashTimer = null;
    this.bridge.deactivate();
    this.state = new WorkspaceState();
    this._pending = [];
  }

  private _memberInfo(): MemberInfo {
    const map: MemberInfo = new Map();
    for (const m of this.session.members) map.set(m.id, { name: m.name, color: m.color });
    return map;
  }

  // ---- roles --------------------------------------------------------------------

  private _onStatus({ state }: Status): void {
    if (!this.active) return;
    if (state === 'idle' || state === 'rejected') this.stop();
    else if (state === 'hosting' && this.role !== 'host') this._becomeHost();
    else if (state === 'connected' && this.role !== 'client') this._becomeClient();
    else if (state === 'connecting' || state === 'reconnecting') this.role = null;
  }

  private _becomeHost(): void {
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

  private _becomeClient(): void {
    this.role = 'client';
    // The host sends a snapshot right after welcoming us; until then we only queue.
    this._awaitingSnapshot = true;
  }

  // ---- local changes ------------------------------------------------------------

  private _onLocal({ ops, clear }: LocalBatch): void {
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
    const entry: Pending = { seq: ++this._seq, ops, clear, sent: false, at: Date.now() };
    this._pending.push(entry);
    this._prunePending();
    if (this.role === 'client' && !this._awaitingSnapshot) this._send(entry);
  }

  private _send(entry: Pending): void {
    if (this.session.sendApp('ws', { seq: entry.seq, ops: entry.ops, clear: entry.clear })) {
      entry.sent = true;
      entry.at = Date.now();
    }
  }

  private _prunePending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    this._pending = this._pending.filter((p) => !p.sent || p.at >= cutoff);
    if (this._pending.length > MAX_PENDING) this._pending = this._pending.slice(-MAX_PENDING);
  }

  // ---- messages -------------------------------------------------------------------

  private _onApp({ k, d, by, fromHost }: AppMessage): void {
    if (!this.active) return;
    if (k === 'ws') {
      if (fromHost) this._onRelayed(parseBatch(d), by);
      else this._onClientBatch(parseBatch(d), by);
    } else if (k === 'wsnap' && fromHost) {
      this._onSnapshot(d);
    } else if (k === 'wshash' && !fromHost) {
      this._onFingerprint(d, by);
    }
  }

  // Host: a client's batch.
  private _onClientBatch({ seq, ops, clear }: WsBatch, by: Who): void {
    if (this.role !== 'host') return;
    if (seq !== null) this._lastSeq.set(by.id, Math.max(seq, this._lastSeq.get(by.id) ?? 0));
    const result = ops ? this.state.applyBatch(ops, by.id, { authoritative: true }) : null;
    if (!ops || !result?.ok) {
      this.log('workspace change from', by.name, 'refused:', result?.ok === false ? result.reason : 'malformed');
      this._sendSnapshot(by.id, false);
      return;
    }
    this.bridge.applyOps(ops, by);
    this.session.relayApp('ws', { ops, clear }, by.id);
    if (clear) this.emit('cleared', by);
  }

  // Client: a batch the host accepted, from the host or another player.
  private _onRelayed({ ops, clear }: WsBatch, by: Who): void {
    if (this.role !== 'client' || !ops) return;
    this.state.applyBatch(ops, by.id);
    if (!this._awaitingSnapshot) this.bridge.applyOps(ops, by);
    if (clear) this.emit('cleared', by);
  }

  // Client: the host's canvas. Ours = snapshot + our batches it hasn't seen yet.
  private _onSnapshot(d: unknown): void {
    if (this.role !== 'client') return;
    const snap = parseWsSnapshot(d);
    if (!snap) return;
    const target = WorkspaceState.fromSnapshot(snap);
    this._pending = this._pending.filter((p) => p.seq > snap.ack);
    for (const p of this._pending) target.applyBatch(p.ops, this.me);
    this.state = target;
    this._seeded = true;
    this._awaitingSnapshot = false;
    this.bridge.reconcile(this.state, this._memberInfo());
    // A fresh snapshot comes from a host that may never have seen our batches.
    for (const p of this._pending) if (snap.fresh || !p.sent) this._send(p);
    this.emit('snapshot', { size: this.state.size });
  }

  private _sendSnapshot(playerId: string, fresh: boolean): void {
    this.session.sendAppTo(playerId, 'wsnap', { ...this.state.snapshot(), ack: this._lastSeq.get(playerId) ?? 0, fresh });
  }

  // Host: someone joined (or came back): their canvas becomes ours.
  private _onWelcomed(member: Who): void {
    if (!this.active || this.role !== 'host') return;
    this._lastSeq.delete(member.id);
    this._mismatches.delete(member.id);
    this._sendSnapshot(member.id, true);
  }

  // Host: someone's connection ended; whatever they were dragging stays put.
  private _onDeparted(member: Who): void {
    if (!this.active || this.role !== 'host') return;
    this._lastSeq.delete(member.id);
    this._mismatches.delete(member.id);
    const released = this.state.releaseAll(member.id);
    if (released.length === 0) return;
    const ops = released.map((oid): Op => ['r', oid]);
    this.bridge.applyOps(ops, member);
    this.session.relayApp('ws', { ops }, member.id);
  }

  // ---- safety net ------------------------------------------------------------------

  private _sendFingerprint(): void {
    if (!this.active || this.role !== 'client' || this._awaitingSnapshot || this.bridge.isDragging()) return;
    if (this._pending.some((p) => Date.now() - p.at < 2_000)) return;
    this.session.sendApp('wshash', { h: this.state.hash() });
  }

  private _onFingerprint(d: unknown, by: Who): void {
    const h = parseFingerprint(d);
    if (this.role !== 'host' || h === null) return;
    if (h === this.state.hash()) {
      this._mismatches.delete(by.id);
      return;
    }
    const count = (this._mismatches.get(by.id) ?? 0) + 1;
    this._mismatches.set(by.id, count);
    if (count >= 2) {
      this._mismatches.delete(by.id);
      this.log('canvas of', by.name, 'drifted; sending a snapshot');
      this._sendSnapshot(by.id, false);
    }
  }
}
