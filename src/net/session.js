// RoomSession: peer-to-peer room membership and replication.
//
// Topology is a star: whoever holds the PeerJS id `lacoop1-<CODE>` on the
// broker is the host and relays messages; everyone else connects to it.
// Joining is "join or host": connect to the host id, and if nobody holds it,
// claim it. If the host goes away, the remaining players race to claim the id
// and the losers connect to the winner. Because every player's game save holds
// the full union of recipe pairs, any player can become host without losing
// anything, and a hello/welcome exchange re-syncs everyone after each change.
//
// Besides recipes, the session carries "app" messages for features such as
// the shared workspace and cursors (sendApp / relayApp / sendAppTo + 'app'
// events), and enforces room flags set by the host: kicked (banned) players
// and a locked room. Every member keeps a copy of the flags so a new host
// keeps enforcing them. The host can also hand hosting over to another player.
//
// Dependencies are injected so the whole state machine can be unit-tested
// against an in-memory fake of PeerJS:
//   createPeer(id|undefined) -> PeerJS-like Peer
//   game.getTuples() -> [[a,b,ts], ...]      (full local set)
//   game.applyTuples(tuples, meta) -> added   (the tuples that were new)

import { Emitter } from '../emitter.js';
import {
  PROTOCOL_VERSION,
  MAX_MEMBERS,
  PLAYER_COLOR_COUNT,
  hostPeerId,
  encode,
  decode,
} from './protocol.js';

export const DEFAULT_TIMING = {
  heartbeatMs: 10_000,
  // Generous, because background tabs throttle timers.
  deadAfterMs: 90_000,
  connectTimeoutMs: 20_000,
  helloTimeoutMs: 20_000,
  retryBaseMs: 1_000,
  retryMaxMs: 15_000,
  jitterMs: 1_000,
  claimRetryMs: 1_500,
  hostLostDelayMs: 200,
  rtcDisconnectGraceMs: 10_000,
  brokerRetryBaseMs: 2_000,
  brokerRetryMaxMs: 30_000,
  demoteDelayMs: 300,
  rejoinGraceMs: 60_000,
  addWindowMs: 10_000,
  addMaxPerWindow: 40,
  // App messages (workspace, cursors): token bucket per client on the host.
  appBucketSize: 120,
  appRefillPerSec: 60,
  // Handover: the old host releases the room id, the chosen player claims it
  // (retrying while the id is still taken), everyone else waits a bit longer.
  handoverReleaseMs: 300,
  handoverRejoinMs: 1_500,
  handoverClaimDelayMs: 400,
  handoverClaimRetryMs: 300,
  handoverClaimRetries: 16,
  handoverFollowerDelayMs: 1_800,
};

function emptyRoom() {
  return { locked: false, banned: new Set(), allowed: new Set() };
}

const BROKER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable']);

export class RoomSession extends Emitter {
  constructor({ createPeer, game, player, build = null, timing = {}, clock = globalThis, random = Math.random, log = () => {} }) {
    super();
    this._createPeer = createPeer;
    this._game = game;
    this._player = { id: player.id, name: player.name };
    this._build = build;
    this._t = { ...DEFAULT_TIMING, ...timing };
    this._clock = clock;
    this._random = random;
    this._log = log;

    this._gen = 0;
    this._state = 'idle';
    this._detail = null;
    this._code = null;
    this._role = null;
    this._peer = null;
    this._timers = new Set();
    this._connectTimer = null;
    this._failures = 0;
    this._everConnected = false;
    this._memberList = [];
    // Members we knew before the host went away; used to avoid announcing
    // everyone as "left" and "joined" again during a host migration.
    this._stash = null;
    // Client side: players from before a host change who haven't reconnected
    // yet; announced as gone only if they stay away (rejoinGraceMs).
    this._expected = new Map();
    this._room = emptyRoom();
    // > 0 while claiming the host id after a handover (the old host may not
    // have released it yet).
    this._claimRetriesLeft = 0;

    // client side
    this._hostConn = null;
    this._helloSent = false;
    this._welcomed = false;
    this._lastHostMsgAt = 0;

    // host side
    this._clients = new Map(); // conn -> client record
    this._colorsById = new Map();
    this._brokerFailures = 0;
  }

  // ---- public API --------------------------------------------------------

  get state() {
    return this._state;
  }

  get role() {
    return this._role;
  }

  get code() {
    return this._code;
  }

  get members() {
    return this._memberList.map((m) => ({ ...m, you: m.id === this._player.id }));
  }

  get playerId() {
    return this._player.id;
  }

  get room() {
    return { locked: this._room.locked, banned: [...this._room.banned], allowed: [...this._room.allowed] };
  }

  join(code) {
    if (this._code) this._shutdown({ notify: true, immediate: false });
    this._code = code;
    this._failures = 0;
    this._detail = null;
    this._everConnected = false;
    this._stash = null;
    this._expected.clear();
    this._claimRetriesLeft = 0;
    this._setRoom(null);
    this._setMembers([], false);
    this._start(0);
  }

  // Graceful leave. With immediate=true (page unload) the peer is destroyed
  // synchronously instead of giving the goodbye messages a moment to flush.
  leave({ immediate = false } = {}) {
    if (!this._code) return;
    this._shutdown({ notify: true, immediate });
    this._code = null;
    this._stash = null;
    this._expected.clear();
    this._detail = null;
    this._setRoom(null);
    this._setMembers([], false);
    this._setState('idle');
  }

  // ---- app messages (features built on top of the room) ------------------

  // Client: to the host. Host: to every client, as coming from the host.
  sendApp(k, d) {
    if (this._role === 'host') {
      this._broadcast({ t: 'app', k, d, by: this._player.id }, null);
      return true;
    }
    if (this._hostConn && this._welcomed) {
      this._send(this._hostConn, { t: 'app', k, d });
      return true;
    }
    return false;
  }

  // Host only: forward a client's message to everyone else.
  relayApp(k, d, fromId) {
    if (this._role !== 'host') return;
    const data = encode({ t: 'app', k, d, by: fromId });
    for (const client of this._clients.values()) {
      if (!client.helloDone || client.player.id === fromId) continue;
      this._sendRaw(client.conn, data);
    }
  }

  // Host only: a message for one player.
  sendAppTo(playerId, k, d) {
    const client = this._clientById(playerId);
    if (this._role !== 'host' || !client) return false;
    this._send(client.conn, { t: 'app', k, d, by: this._player.id });
    return true;
  }

  // ---- host controls -------------------------------------------------------

  // Removes a player; they can't rejoin while the room stays open.
  kick(playerId) {
    if (this._role !== 'host' || playerId === this._player.id) return false;
    this._room.banned.add(playerId);
    this._room.allowed.delete(playerId);
    const client = this._clientById(playerId);
    if (client) {
      const view = this._clientView(client);
      this._rejectClient(client, 'kicked', 'The host removed you from this room.', { silent: true });
      this.emit('kicked', view);
    } else {
      this._publishHostMembers();
    }
    this._emitRoom();
    return true;
  }

  // A locked room only lets current (and recently dropped) players back in.
  setLocked(locked) {
    if (this._role !== 'host') return false;
    this._room.locked = !!locked;
    this._room.allowed = locked
      ? new Set([...this._memberList, ...(this._stash || [])].map((m) => m.id))
      : new Set();
    this._publishHostMembers();
    this._emitRoom();
    return true;
  }

  // Makes another player the host: we release the room id, they claim it,
  // and everyone (including us) reconnects to them.
  handOver(playerId) {
    const target = this._clientById(playerId);
    if (this._role !== 'host' || !target) return false;
    const gen = this._gen;
    this._broadcast({ t: 'handover', to: playerId }, null);
    this.emit('handover', { to: this._clientView(target) });
    this._later(gen, this._t.handoverReleaseMs, () => {
      this._stash = this._memberList;
      this._failures = 0;
      this._detail = 'handover';
      this._start(this._t.handoverRejoinMs + this._random() * this._t.jitterMs);
    });
    return true;
  }

  broadcastLocal(tuples) {
    if (!tuples || tuples.length === 0) return;
    const msg = { t: 'add', by: this._player, pairs: tuples };
    if (this._role === 'host') {
      this._broadcast(msg, null);
    } else if (this._hostConn && this._helloSent) {
      this._send(this._hostConn, msg);
    }
    // Otherwise the tuples go out with the next hello, which always carries the full set.
  }

  rename(name) {
    this._player = { ...this._player, name };
    if (this._role === 'host') {
      this._publishHostMembers();
    } else if (this._hostConn && this._helloSent) {
      this._send(this._hostConn, { t: 'rename', name });
    }
  }

  // ---- connection lifecycle ----------------------------------------------

  _current(gen) {
    return gen === this._gen;
  }

  _start(delayMs) {
    const gen = ++this._gen;
    this._teardown();
    this._setState(this._everConnected || this._failures > 0 ? 'reconnecting' : 'connecting', this._detail);
    if (delayMs > 0) this._later(gen, delayMs, () => this._tryClient(gen));
    else this._tryClient(gen);
  }

  _retry(gen, why) {
    if (!this._current(gen)) return;
    this._failures++;
    this._detail = why;
    const backoff = Math.min(this._t.retryMaxMs, this._t.retryBaseMs * 2 ** (this._failures - 1));
    this._log('retry', why, backoff);
    this._start(backoff + this._random() * this._t.jitterMs);
  }

  _tryClient(gen) {
    this._destroyPeer();
    this._cancel(this._connectTimer);
    const peer = this._createPeer(undefined);
    this._peer = peer;

    peer.on('open', () => {
      if (!this._current(gen) || this._peer !== peer) return;
      const conn = peer.connect(hostPeerId(this._code), {
        reliable: true,
        serialization: 'raw',
        metadata: { app: 'la-coop', v: PROTOCOL_VERSION },
      });
      this._hostConn = conn;
      this._connectTimer = this._later(gen, this._t.connectTimeoutMs, () => {
        if (!this._welcomed && this._hostConn === conn) this._retry(gen, 'timeout');
      });
      conn.on('open', () => {
        if (!this._current(gen) || this._hostConn !== conn) return;
        this._watchRtc(gen, conn, () => this._onHostLost(gen, 'rtc'));
        this._helloSent = true;
        this._send(conn, {
          t: 'hello',
          v: PROTOCOL_VERSION,
          build: this._build,
          player: this._player,
          pairs: this._game.getTuples(),
        });
      });
      conn.on('data', (raw) => {
        if (this._current(gen) && this._hostConn === conn) this._onHostData(gen, raw);
      });
      conn.on('close', () => {
        if (this._current(gen) && this._hostConn === conn) this._onHostLost(gen, 'closed');
      });
      conn.on('error', () => {
        if (this._current(gen) && this._hostConn === conn) this._onHostLost(gen, 'error');
      });
    });

    peer.on('error', (err) => {
      if (!this._current(gen) || this._peer !== peer) return;
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        // Nobody holds the room id right now: claim it.
        if (!this._welcomed) this._tryHost(gen);
        return;
      }
      if (this._welcomed && BROKER_ERRORS.has(type)) return; // the data channel still works
      this._retry(gen, BROKER_ERRORS.has(type) ? 'broker' : type || 'error');
    });
  }

  _tryHost(gen) {
    this._destroyPeer();
    this._cancel(this._connectTimer);
    const peer = this._createPeer(hostPeerId(this._code));
    this._peer = peer;

    peer.on('open', () => {
      if (!this._current(gen) || this._peer !== peer) return;
      this._brokerFailures = 0;
      this._claimRetriesLeft = 0;
      if (this._role !== 'host') {
        this._role = 'host';
        this._failures = 0;
        this._detail = null;
        this._everConnected = true;
        this._startHeartbeat(gen);
        this._afterBecomingHost(gen);
      }
      this._setState('hosting');
      this._publishHostMembers();
    });

    peer.on('connection', (conn) => {
      if (this._current(gen) && this._peer === peer && this._role === 'host') this._acceptClient(gen, conn);
      else conn.close();
    });

    peer.on('disconnected', () => {
      // Lost the broker; data connections survive. Re-register so new players can find us.
      if (!this._current(gen) || this._peer !== peer || this._role !== 'host') return;
      this._brokerFailures++;
      const delay = Math.min(this._t.brokerRetryMaxMs, this._t.brokerRetryBaseMs * 2 ** (this._brokerFailures - 1));
      this._later(gen, delay, () => {
        if (this._peer === peer && peer.disconnected && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch (err) {
            this._log('reconnect failed', err);
          }
        }
      });
    });

    peer.on('error', (err) => {
      if (!this._current(gen) || this._peer !== peer) return;
      const type = err && err.type;
      if (type === 'unavailable-id') {
        if (this._role === 'host') this._demote(gen);
        else if (this._claimRetriesLeft > 0) {
          // Handed the room: the old host is still releasing the id.
          this._claimRetriesLeft--;
          this._destroyPeer();
          this._later(gen, this._t.handoverClaimRetryMs, () => this._tryHost(gen));
        } else {
          // Lost the race to claim the room: join whoever won.
          this._destroyPeer();
          this._later(gen, this._t.claimRetryMs + this._random() * this._t.jitterMs, () => this._tryClient(gen));
        }
        return;
      }
      if (this._role === 'host') return; // broker trouble while hosting is handled by 'disconnected'
      this._retry(gen, BROKER_ERRORS.has(type) ? 'broker' : type || 'error');
    });
  }

  // After a migration, give the other players a grace period to reconnect to
  // us before announcing them as gone.
  _afterBecomingHost(gen) {
    if (!this._stash) return;
    this._later(gen, this._t.rejoinGraceMs, () => {
      const stash = this._stash;
      this._stash = null;
      if (!stash) return;
      const present = new Set(this._memberList.map((m) => m.id));
      for (const m of stash) if (!present.has(m.id) && m.id !== this._player.id) this.emit('left', m);
    });
  }

  // Our host id was taken while we were off the broker: someone else is the
  // canonical host now. Tell our clients to move and join it ourselves.
  _demote(gen) {
    this._log('demoting: host id taken');
    for (const client of this._clients.values()) this._send(client.conn, { t: 'rehome' });
    this._later(gen, this._t.demoteDelayMs, () => {
      this._stash = this._memberList;
      this._failures = 0;
      this._start(this._random() * this._t.jitterMs);
    });
  }

  _onHostLost(gen, why) {
    if (!this._current(gen)) return;
    const wasWelcomed = this._welcomed;
    this._welcomed = false;
    this._hostConn = null;
    this._helloSent = false;
    if (wasWelcomed) {
      // The host went away: re-run join-or-host quickly; one of us becomes the
      // new host. After a rehome or handover the old host is still around.
      const graceful = why === 'rehome' || why === 'handover';
      const oldHost = this._memberList.find((m) => m.host);
      if (oldHost && !graceful) this.emit('left', oldHost);
      this._stash = [...this._memberList.filter((m) => !m.host || graceful), ...this._expected.values()];
      this._expected.clear();
      this._detail = why;
      this._setMembers([], false);
      const delay = why === 'handover' ? this._t.handoverFollowerDelayMs : this._t.hostLostDelayMs;
      this._start(delay + this._random() * this._t.jitterMs);
    } else {
      this._retry(gen, why);
    }
  }

  // The host handed the room to us: claim the room id (retrying while the old
  // host releases it); the others reconnect to us.
  _takeOverAsHost(gen) {
    if (!this._current(gen)) return;
    this._stash = this._memberList;
    this._detail = 'handover';
    this._setMembers([], false);
    const next = ++this._gen;
    this._teardown();
    this._setState('reconnecting', 'handover');
    this._claimRetriesLeft = this._t.handoverClaimRetries;
    this._later(next, this._t.handoverClaimDelayMs, () => this._tryHost(next));
  }

  // ---- client side ---------------------------------------------------------

  _onHostData(gen, raw) {
    this._lastHostMsgAt = this._now();
    const { msg, error } = decode(raw);
    if (error) {
      this._log('dropped message from host', error);
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        if (this._welcomed) return;
        this._cancel(this._connectTimer);
        this._welcomed = true;
        this._role = 'client';
        this._failures = 0;
        this._detail = null;
        this._everConnected = true;
        const stash = this._stash;
        this._stash = null;
        this._setRoom(msg.room);
        this._setMembers(msg.members, false);
        if (stash) this._announceAfterHostChange(gen, stash);
        this._setState('connected');
        this._startHeartbeat(gen);
        const host = this._memberList.find((m) => m.host) || null;
        this._applyRemote(msg.pairs, host, true);
        break;
      }
      case 'add':
        if (this._welcomed) this._applyRemote(msg.pairs, this._memberView(msg.by), msg.sync);
        break;
      case 'presence':
        if (this._welcomed) {
          const before = this._memberList;
          this._setRoom(msg.room);
          this._setMembers(msg.members, false);
          this._announceDiff(before, this._memberList);
        }
        break;
      case 'app': {
        if (!this._welcomed) break;
        const host = this._memberList.find((m) => m.host);
        const by = msg.by ? this._memberView({ id: msg.by, name: '?' }) : host || { id: '?', name: '?', color: 0 };
        this.emit('app', { k: msg.k, d: msg.d, by, fromHost: true });
        break;
      }
      case 'handover':
        if (!this._welcomed) break;
        if (msg.to === this._player.id) this._takeOverAsHost(gen);
        else this._onHostLost(gen, 'handover');
        break;
      case 'reject':
        this._onRejected(msg.reason, msg.detail);
        break;
      case 'rehome':
      case 'leave':
        this._onHostLost(gen, msg.t === 'rehome' ? 'rehome' : 'host-left');
        break;
      default:
        break; // ping and unknown types
    }
  }

  _onRejected(reason, detail) {
    this._shutdown({ notify: false, immediate: true });
    this._stash = null;
    this._expected.clear();
    this._detail = reason;
    this._setMembers([], false);
    this._setState('rejected', reason);
    this.emit('rejected', { reason, detail });
  }

  // ---- host side -----------------------------------------------------------

  _acceptClient(gen, conn) {
    const client = { conn, player: null, color: 0, helloDone: false, lastSeen: this._now(), addTimes: [] };
    this._clients.set(conn, client);
    this._later(gen, this._t.helloTimeoutMs, () => {
      if (!client.helloDone) this._dropClient(client, 'no-hello');
    });
    conn.on('open', () => {
      if (this._current(gen)) this._watchRtc(gen, conn, () => this._dropClient(client, 'rtc'));
    });
    conn.on('data', (raw) => {
      if (!this._current(gen) || !this._clients.has(conn)) return;
      client.lastSeen = this._now();
      this._onClientData(client, raw);
    });
    conn.on('close', () => {
      if (this._current(gen)) this._dropClient(client, 'closed');
    });
    conn.on('error', () => {
      if (this._current(gen)) this._dropClient(client, 'error');
    });
  }

  _onClientData(client, raw) {
    const { msg, error } = decode(raw);
    if (error) {
      this._log('dropped message from client', error);
      return;
    }
    if (client.rejected) return;
    if (!client.helloDone && msg.t !== 'hello') return;
    switch (msg.t) {
      case 'hello':
        this._onHello(client, msg);
        break;
      case 'add': {
        if (!this._allowAdd(client)) return;
        // Attribute to the connection's player, never to what the message claims.
        const by = this._clientView(client);
        const added = this._game.applyTuples(msg.pairs, { by, sync: msg.sync });
        if (added.length > 0) {
          this._broadcast({ t: 'add', by: client.player, pairs: added, sync: msg.sync }, client);
          this.emit('remote', { by, tuples: added, sync: msg.sync });
        }
        break;
      }
      case 'rename':
        client.player = { ...client.player, name: msg.name };
        this._publishHostMembers();
        break;
      case 'app':
        // Features on the host decide whether to relay (see relayApp).
        if (this._allowApp(client)) this.emit('app', { k: msg.k, d: msg.d, by: this._clientView(client), fromHost: false });
        break;
      case 'leave':
        this._dropClient(client, 'left');
        break;
      default:
        break; // ping and unknown types
    }
  }

  _onHello(client, msg) {
    if (client.helloDone) return;
    if (msg.v !== PROTOCOL_VERSION) {
      this._rejectClient(client, 'version', 'The host uses co-op protocol v' + PROTOCOL_VERSION + '.');
      return;
    }
    if (this._build && msg.build && msg.build !== this._build) {
      this._rejectClient(client, 'build', 'The host plays game build ' + this._build + ', you play ' + msg.build + '.');
      return;
    }
    if (this._room.banned.has(msg.player.id)) {
      this._rejectClient(client, 'kicked', 'The host removed you from this room.');
      return;
    }
    if (this._room.locked && !this._room.allowed.has(msg.player.id)) {
      this._rejectClient(client, 'locked', 'The host locked this room.');
      return;
    }
    // The same player connecting again: either a reconnect while the old
    // connection is still hanging around, or a second window. The newest wins;
    // the old one is told so, which stops it from reconnecting and fighting back.
    let rejoining = !!(this._stash && this._stash.some((m) => m.id === msg.player.id));
    for (const other of [...this._clients.values()]) {
      if (other !== client && other.helloDone && other.player.id === msg.player.id) {
        rejoining = true;
        this._rejectClient(other, 'replaced', 'You joined this room from another window.', { silent: true });
      }
    }
    if (this._memberCount() >= MAX_MEMBERS) {
      this._rejectClient(client, 'full', 'Rooms hold up to ' + MAX_MEMBERS + ' players.');
      return;
    }
    client.player = msg.player;
    client.helloDone = true;
    client.color = this._assignColor(msg.player.id);

    const by = this._clientView(client);
    const added = this._game.applyTuples(msg.pairs, { by, sync: true });
    this._send(client.conn, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: { color: client.color },
      members: this._hostMembers(),
      room: this._roomFlags(),
      pairs: this._game.getTuples(),
    });
    if (added.length > 0) {
      this._broadcast({ t: 'add', by: client.player, pairs: added, sync: true }, client);
      this.emit('remote', { by, tuples: added, sync: true });
    }
    this._publishHostMembers();
    if (!rejoining) this.emit('joined', by);
    // Lets features send their state to the newcomer (e.g. the workspace).
    this.emit('welcomed', { member: by, rejoining });
  }

  _rejectClient(client, reason, detail, { silent = false } = {}) {
    this._send(client.conn, { t: 'reject', reason, detail });
    const wasMember = client.helloDone;
    client.rejected = true;
    client.helloDone = false; // stops broadcasts to it and frees its slot right away
    if (wasMember) {
      const view = this._clientView(client);
      if (!silent) this.emit('left', view);
      this.emit('departed', view);
      this._publishHostMembers();
    }
    // Give the reject message a moment to arrive before closing.
    this._later(this._gen, 500, () => this._dropClient(client, 'rejected', { silent: true }));
  }

  _dropClient(client, why, { silent = false } = {}) {
    if (!this._clients.has(client.conn)) return;
    this._clients.delete(client.conn);
    this._log('drop client', why);
    try {
      client.conn.close();
    } catch {
      // already closed
    }
    if (!client.helloDone) return;
    const view = this._clientView(client);
    if (!silent) this.emit('left', view);
    // Always fired when a member's connection ends, so features can clean up.
    this.emit('departed', view);
    this._publishHostMembers();
  }

  _clientById(playerId) {
    for (const client of this._clients.values()) {
      if (client.helloDone && client.player.id === playerId) return client;
    }
    return null;
  }

  _allowApp(client) {
    const now = this._now();
    const bucket = client.appBucket || (client.appBucket = { tokens: this._t.appBucketSize, at: now });
    bucket.tokens = Math.min(this._t.appBucketSize, bucket.tokens + ((now - bucket.at) / 1000) * this._t.appRefillPerSec);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  _allowAdd(client) {
    const now = this._now();
    client.addTimes = client.addTimes.filter((t) => now - t < this._t.addWindowMs);
    if (client.addTimes.length >= this._t.addMaxPerWindow) return false;
    client.addTimes.push(now);
    return true;
  }

  _memberCount() {
    let count = 1; // the host
    for (const c of this._clients.values()) if (c.helloDone) count++;
    return count;
  }

  _assignColor(playerId) {
    const used = new Set([0]);
    for (const c of this._clients.values()) if (c.helloDone) used.add(c.color);
    const previous = this._colorsById.get(playerId);
    if (previous !== undefined && !used.has(previous)) return previous;
    let color = 1 + (this._colorsById.size % (PLAYER_COLOR_COUNT - 1));
    for (let i = 1; i < PLAYER_COLOR_COUNT; i++) {
      if (!used.has(i)) {
        color = i;
        break;
      }
    }
    this._colorsById.set(playerId, color);
    return color;
  }

  _hostMembers() {
    const list = [{ id: this._player.id, name: this._player.name, color: 0, host: true }];
    for (const c of this._clients.values()) {
      if (c.helloDone) list.push({ id: c.player.id, name: c.player.name, color: c.color, host: false });
    }
    return list;
  }

  _publishHostMembers() {
    if (this._role !== 'host') return;
    const members = this._hostMembers();
    this._broadcast({ t: 'presence', members, room: this._roomFlags() }, null);
    this._setMembers(members, false);
  }

  _roomFlags() {
    return { locked: this._room.locked, banned: [...this._room.banned], allowed: [...this._room.allowed] };
  }

  // Adopts room flags from the host (null resets them, e.g. for a new room).
  _setRoom(flags) {
    const next = flags
      ? { locked: flags.locked === true, banned: new Set(flags.banned || []), allowed: new Set(flags.allowed || []) }
      : emptyRoom();
    const changed = JSON.stringify(this._roomFlags()) !== JSON.stringify({
      locked: next.locked,
      banned: [...next.banned],
      allowed: [...next.allowed],
    });
    this._room = next;
    if (changed) this._emitRoom();
  }

  _emitRoom() {
    this.emit('room', this.room);
  }

  _clientView(client) {
    return { id: client.player.id, name: client.player.name, color: client.color };
  }

  // ---- shared helpers ------------------------------------------------------

  _applyRemote(pairs, by, sync) {
    const added = this._game.applyTuples(pairs, { by, sync });
    if (added.length > 0) this.emit('remote', { by, tuples: added, sync });
  }

  _memberView(player) {
    const known = this._memberList.find((m) => m.id === player.id);
    return { id: player.id, name: known ? known.name : player.name, color: known ? known.color : 0 };
  }

  _announceDiff(before, after) {
    const beforeIds = new Set(before.map((m) => m.id));
    const afterIds = new Set(after.map((m) => m.id));
    for (const m of after) {
      if (beforeIds.has(m.id) || m.id === this._player.id) continue;
      if (this._expected.delete(m.id)) continue; // back after a host change
      this.emit('joined', m);
    }
    for (const m of before) {
      if (afterIds.has(m.id) || m.id === this._player.id) continue;
      this.emit(this._room.banned.has(m.id) ? 'kicked' : 'left', m);
    }
  }

  // After reconnecting to a (new) host: newcomers are announced right away,
  // players we knew who aren't back yet get a grace period.
  _announceAfterHostChange(gen, stash) {
    const present = new Set(this._memberList.map((m) => m.id));
    const known = new Set(stash.map((m) => m.id));
    for (const m of this._memberList) if (!known.has(m.id) && m.id !== this._player.id) this.emit('joined', m);
    for (const m of stash) if (!present.has(m.id) && m.id !== this._player.id) this._expected.set(m.id, m);
    if (this._expected.size === 0) return;
    this._later(gen, this._t.rejoinGraceMs, () => {
      for (const m of this._expected.values()) this.emit(this._room.banned.has(m.id) ? 'kicked' : 'left', m);
      this._expected.clear();
    });
  }

  _setMembers(list) {
    this._memberList = list;
    this.emit('members', this.members);
  }

  _setState(state, detail = null) {
    this._state = state;
    this.emit('status', { state, role: this._role, code: this._code, detail });
  }

  _startHeartbeat(gen) {
    this._lastHostMsgAt = this._now();
    const tick = () => {
      if (!this._current(gen)) return;
      const now = this._now();
      if (this._role === 'host') {
        for (const client of [...this._clients.values()]) {
          if (!client.helloDone) continue; // covered by the hello timeout
          if (now - client.lastSeen > this._t.deadAfterMs) this._dropClient(client, 'timeout');
          else this._send(client.conn, { t: 'ping' });
        }
      } else if (this._hostConn && this._welcomed) {
        if (now - this._lastHostMsgAt > this._t.deadAfterMs) this._onHostLost(gen, 'timeout');
        else this._send(this._hostConn, { t: 'ping' });
      }
    };
    const timer = { id: this._clock.setInterval(tick, this._t.heartbeatMs), interval: true };
    this._timers.add(timer);
  }

  // Detects dead connections faster than the heartbeat, via the RTC state.
  _watchRtc(gen, conn, onDead) {
    const pc = conn.peerConnection;
    if (!pc || typeof pc.addEventListener !== 'function') return;
    const check = () => {
      if (!this._current(gen)) return;
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === 'failed' || state === 'closed') onDead();
      else if (state === 'disconnected') {
        this._later(gen, this._t.rtcDisconnectGraceMs, () => {
          const now = pc.connectionState || pc.iceConnectionState;
          if (now === 'disconnected' || now === 'failed' || now === 'closed') onDead();
        });
      }
    };
    pc.addEventListener('connectionstatechange', check);
    pc.addEventListener('iceconnectionstatechange', check);
  }

  _send(conn, msg) {
    this._sendRaw(conn, encode(msg));
  }

  _sendRaw(conn, data) {
    try {
      if (conn && conn.open !== false) conn.send(data);
    } catch (err) {
      this._log('send failed', err);
    }
  }

  _broadcast(msg, except) {
    const data = encode(msg);
    for (const client of this._clients.values()) {
      if (client === except || !client.helloDone) continue;
      try {
        if (client.conn.open !== false) client.conn.send(data);
      } catch (err) {
        this._log('broadcast failed', err);
      }
    }
  }

  _now() {
    return Date.now();
  }

  _later(gen, ms, fn) {
    const timer = { id: null, interval: false };
    timer.id = this._clock.setTimeout(() => {
      this._timers.delete(timer);
      if (this._current(gen)) fn();
    }, ms);
    this._timers.add(timer);
    return timer;
  }

  _cancel(timer) {
    if (!timer || !this._timers.has(timer)) return;
    this._timers.delete(timer);
    if (timer.interval) this._clock.clearInterval(timer.id);
    else this._clock.clearTimeout(timer.id);
  }

  _clearTimers() {
    for (const timer of this._timers) {
      if (timer.interval) this._clock.clearInterval(timer.id);
      else this._clock.clearTimeout(timer.id);
    }
    this._timers.clear();
    this._connectTimer = null;
  }

  _destroyPeer() {
    const peer = this._peer;
    this._peer = null;
    // Detach first: destroying a Peer synchronously emits 'close' on its
    // connections, which must not be mistaken for losing the host.
    this._hostConn = null;
    this._helloSent = false;
    if (peer) {
      try {
        peer.destroy();
      } catch {
        // ignore
      }
    }
  }

  // Drops the current peer, connections and timers (not the room code).
  _teardown() {
    this._clearTimers();
    this._destroyPeer();
    this._clients.clear();
    this._hostConn = null;
    this._helloSent = false;
    this._welcomed = false;
    this._role = null;
  }

  _shutdown({ notify, immediate }) {
    this._gen++;
    if (notify) {
      if (this._role === 'client' && this._hostConn) this._send(this._hostConn, { t: 'leave' });
      if (this._role === 'host') this._broadcast({ t: 'leave' }, null);
    }
    const peer = this._peer;
    this._peer = null;
    this._clearTimers();
    this._clients.clear();
    this._hostConn = null;
    this._helloSent = false;
    this._welcomed = false;
    this._role = null;
    if (!peer) return;
    const destroy = () => {
      try {
        peer.destroy();
      } catch {
        // ignore
      }
    };
    if (immediate || !notify) destroy();
    else this._clock.setTimeout(destroy, 150);
  }
}
