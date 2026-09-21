import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession } from '../../src/net/session.js';
import { WorkspaceSync } from '../../src/workspace/sync.js';
import { WorkspaceState } from '../../src/workspace/state.js';
import { Emitter } from '../../src/emitter.js';
import { FakeNetwork, FakeGame, FAST_TIMING, sleep, waitFor } from './fakes.js';

const CODE = 'K7M4PX';
let players = [];

afterEach(() => {
  for (const p of players) {
    p.sync.stop();
    p.session.leave({ immediate: true });
  }
  players = [];
});

// Stands in for the game canvas: a WorkspaceState we can poke at.
class FakeBridge extends Emitter {
  constructor(initial = []) {
    super();
    this.canvas = new WorkspaceState();
    if (initial.length) this.canvas.applyBatch(initial, 'local');
    this.active = false;
    this.dragging = false;
    this.ownerOf = () => null;
  }
  activate(me) {
    this.active = true;
    this.me = me;
  }
  deactivate() {
    this.active = false;
  }
  currentElements() {
    return [...this.canvas.elements].map(([oid, e]) => ['a', oid, e.el, e.x, e.y]);
  }
  isDragging() {
    return this.dragging;
  }
  applyOps(ops, by) {
    this.canvas.applyBatch(ops, by.id);
  }
  reconcile(state) {
    this.canvas = state.clone();
  }
  // What the real bridge does when the player changes the canvas.
  local(ops, clear = false) {
    this.canvas.applyBatch(ops, this.me);
    this.emit('ops', { ops, clear });
  }
  oids() {
    return [...this.canvas.elements.keys()].sort();
  }
}

function makePlayer(net, name, canvas = [], { hashIntervalMs = 60_000 } = {}) {
  const session = new RoomSession({
    createPeer: (id) => net.createPeer(id),
    game: new FakeGame(),
    player: { id: 'id-' + name, name },
    build: '580',
    timing: FAST_TIMING,
  });
  const bridge = new FakeBridge(canvas);
  const sync = new WorkspaceSync({ session, bridge, hashIntervalMs });
  const events = { cleared: [], snapshot: [] };
  for (const type of Object.keys(events)) sync.on(type, (e) => events[type].push(e));
  const player = { name, session, bridge, sync, events };
  players.push(player);
  return player;
}

async function join(player) {
  player.sync.start();
  player.session.join(CODE);
  await waitFor(() => ['hosting', 'connected'].includes(player.session.state), { what: player.name + ' in' });
}

const same = (list) => list.every((p) => p.bridge.canvas.hash() === list[0].bridge.canvas.hash());

test("the host's canvas becomes the room's, and replaces a joiner's", async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'al1', 5, 0.2, 0.3]]);
  const bob = makePlayer(net, 'Bob', [['a', 'bo1', 6, 0.5, 0.5]]);
  await join(alice);
  await join(bob);
  await waitFor(() => same([alice, bob]), { what: 'same canvas' });
  assert.deepEqual(bob.bridge.oids(), ['al1']);
  assert.equal(bob.sync.state.get('al1').owner, 'id-Alice');
});

test('changes flow through the host to everyone, stamped with their owner', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map((n) => makePlayer(net, n));
  for (const p of [alice, bob, carol]) await join(p);
  await waitFor(() => bob.sync.role === 'client' && carol.sync.role === 'client' && !bob.sync._awaitingSnapshot && !carol.sync._awaitingSnapshot);

  bob.bridge.local([['a', 'b1', 5, 0.1, 0.1]]);
  carol.bridge.local([['a', 'c1', 6, 0.9, 0.9]]);
  alice.bridge.local([['a', 'a1', 7, 0.5, 0.5]]);
  await waitFor(() => same([alice, bob, carol]) && alice.bridge.canvas.size === 3, { what: 'three elements everywhere' });
  assert.equal(alice.sync.state.get('b1').owner, 'id-Bob');
  assert.equal(carol.sync.state.get('b1').owner, 'id-Bob');

  bob.bridge.local([['h', 'c1'], ['m', 'c1', 0.4, 0.4], ['r', 'c1']]);
  await waitFor(() => carol.bridge.canvas.get('c1').x === 0.4, { what: 'move reaches Carol' });
  bob.bridge.local([['d', 'b1']], true);
  await waitFor(() => same([alice, bob, carol]) && alice.bridge.canvas.size === 2);
  assert.deepEqual(carol.events.cleared.map((b) => b.name), ['Bob']);
  assert.deepEqual(alice.events.cleared.map((b) => b.name), ['Bob']);
});

test('two players grabbing the same element: the first wins, the second snaps back', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]]);
  const bob = makePlayer(net, 'Bob');
  const carol = makePlayer(net, 'Carol');
  for (const p of [alice, bob, carol]) await join(p);
  await waitFor(() => same([alice, bob, carol]) && carol.bridge.canvas.size === 1);

  // Both grab and move x before hearing about the other.
  bob.bridge.local([['h', 'x'], ['m', 'x', 0.1, 0.1]]);
  carol.bridge.local([['h', 'x'], ['m', 'x', 0.9, 0.9]]);
  await waitFor(() => same([alice, bob, carol]), { what: 'agreement' });
  const winner = alice.sync.state.holderOf('x');
  assert.ok(['id-Bob', 'id-Carol'].includes(winner));
  const expectedX = winner === 'id-Bob' ? 0.1 : 0.9;
  for (const p of [alice, bob, carol]) assert.equal(p.bridge.canvas.get('x').x, expectedX, p.name);
  const loser = winner === 'id-Bob' ? carol : bob;
  assert.ok(loser.events.snapshot.length >= 2, 'loser got a correcting snapshot');
});

test("a player's grab ends when they disconnect", async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]]);
  const bob = makePlayer(net, 'Bob');
  const carol = makePlayer(net, 'Carol');
  for (const p of [alice, bob, carol]) await join(p);
  await waitFor(() => same([alice, bob, carol]) && carol.bridge.canvas.size === 1);
  bob.bridge.local([['h', 'x']]);
  await waitFor(() => carol.bridge.canvas.holderOf('x') === 'id-Bob');
  bob.session.leave();
  await waitFor(() => carol.bridge.canvas.holderOf('x') === null && alice.sync.state.holderOf('x') === null);
});

test('when the host leaves, the canvas carries on with the new host', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]]);
  const bob = makePlayer(net, 'Bob');
  const carol = makePlayer(net, 'Carol');
  for (const p of [alice, bob, carol]) await join(p);
  await waitFor(() => same([alice, bob, carol]) && carol.bridge.canvas.size === 1);
  bob.bridge.local([['a', 'b1', 6, 0.2, 0.2]]);
  await waitFor(() => carol.bridge.canvas.size === 2);

  alice.sync.stop();
  alice.session.leave();
  await waitFor(() => [bob, carol].some((p) => p.sync.role === 'host') && [bob, carol].every((p) => p.sync.role), {
    what: 'new host',
  });
  const client = bob.sync.role === 'host' ? carol : bob;
  await waitFor(() => !client.sync._awaitingSnapshot, { what: 'snapshot from new host' });
  client.bridge.local([['a', 'n1', 7, 0.7, 0.7]]);
  await waitFor(() => same([bob, carol]) && bob.bridge.canvas.size === 3, { what: 'converged after migration' });
});

test('a drifted client is corrected by the fingerprint check', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]], { hashIntervalMs: 40 });
  const bob = makePlayer(net, 'Bob', [], { hashIntervalMs: 40 });
  await join(alice);
  await join(bob);
  await waitFor(() => same([alice, bob]) && bob.bridge.canvas.size === 1);
  // Corrupt Bob's copy behind the protocol's back.
  bob.sync.state.applyBatch([['d', 'x']], 'nobody');
  bob.bridge.canvas.applyBatch([['d', 'x']], 'nobody');
  await waitFor(() => bob.bridge.canvas.size === 1 && bob.sync.state.size === 1, { what: 'repaired', timeout: 3000 });
});

test("changes made while connecting reach the room once we're in", async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice');
  await join(alice);
  const bob = makePlayer(net, 'Bob');
  bob.sync.start();
  bob.session.join(CODE);
  bob.bridge.local([['a', 'early', 5, 0.3, 0.3]]); // before the welcome
  await waitFor(() => alice.bridge.canvas.get('early') !== null, { what: 'early change delivered' });
  await sleep(30);
  assert.equal(bob.bridge.canvas.get('early').x, 0.3);
});
