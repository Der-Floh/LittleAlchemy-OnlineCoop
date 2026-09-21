import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession, type Who } from '../../src/net/session.ts';
import { WorkspaceSync, type BridgeLike, type LocalBatch, type SyncEvents } from '../../src/workspace/sync.ts';
import { WorkspaceState } from '../../src/workspace/state.ts';
import type { AddOp, Op } from '../../src/workspace/ops.ts';
import { Emitter } from '../../src/emitter.ts';
import { FakeNetwork, FakeGame, FAST_TIMING, sleep, waitFor } from './fakes.ts';

const CODE = 'K7M4PX';

type TestPlayer = {
  name: string;
  session: RoomSession;
  bridge: FakeBridge;
  sync: WorkspaceSync;
  events: { [K in keyof SyncEvents]: SyncEvents[K][] };
};

let players: TestPlayer[] = [];

afterEach(() => {
  for (const p of players) {
    p.sync.stop();
    p.session.leave({ immediate: true });
  }
  players = [];
});

// Stands in for the game canvas: a WorkspaceState we can poke at.
class FakeBridge extends Emitter<{ ops: LocalBatch }> implements BridgeLike {
  canvas = new WorkspaceState();
  active = false;
  dragging = false;
  me = '';
  ownerOf: (oid: string) => string | null = () => null;

  constructor(initial: Op[] = []) {
    super();
    if (initial.length) this.canvas.applyBatch(initial, 'local');
  }
  activate(me: string): void {
    this.active = true;
    this.me = me;
  }
  deactivate(): void {
    this.active = false;
  }
  currentElements(): AddOp[] {
    return [...this.canvas.elements].map(([oid, e]): AddOp => ['a', oid, e.el, e.x, e.y]);
  }
  isDragging(): boolean {
    return this.dragging;
  }
  applyOps(ops: Op[], by: Who): void {
    this.canvas.applyBatch(ops, by.id);
  }
  reconcile(state: WorkspaceState): void {
    this.canvas = state.clone();
  }
  // What the real bridge does when the player changes the canvas.
  local(ops: Op[], clear = false): void {
    this.canvas.applyBatch(ops, this.me);
    this.emit('ops', { ops, clear });
  }
  oids(): string[] {
    return [...this.canvas.elements.keys()].sort();
  }
}

function makePlayer(net: FakeNetwork, name: string, canvas: Op[] = [], { hashIntervalMs = 60_000 } = {}): TestPlayer {
  const session = new RoomSession({
    createPeer: (id) => net.createPeer(id),
    game: new FakeGame(),
    player: { id: 'id-' + name, name },
    build: '580',
    timing: FAST_TIMING,
  });
  const bridge = new FakeBridge(canvas);
  const sync = new WorkspaceSync({ session, bridge, hashIntervalMs });
  const events: TestPlayer['events'] = { cleared: [], snapshot: [] };
  sync.on('cleared', (e) => events.cleared.push(e));
  sync.on('snapshot', (e) => events.snapshot.push(e));
  const player = { name, session, bridge, sync, events };
  players.push(player);
  return player;
}

async function join(player: TestPlayer): Promise<void> {
  player.sync.start();
  player.session.join(CODE);
  await waitFor(() => ['hosting', 'connected'].includes(player.session.state), { what: player.name + ' in' });
}

const same = (list: TestPlayer[]) => list.every((p) => p.bridge.canvas.hash() === list[0]?.bridge.canvas.hash());

test("the host's canvas becomes the room's, and replaces a joiner's", async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'al1', 5, 0.2, 0.3]]);
  const bob = makePlayer(net, 'Bob', [['a', 'bo1', 6, 0.5, 0.5]]);
  await join(alice);
  await join(bob);
  await waitFor(() => same([alice, bob]), { what: 'same canvas' });
  assert.deepEqual(bob.bridge.oids(), ['al1']);
  assert.equal(bob.sync.state.get('al1')?.owner, 'id-Alice');
});

test('changes flow through the host to everyone, stamped with their owner', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice');
  const bob = makePlayer(net, 'Bob');
  const carol = makePlayer(net, 'Carol');
  for (const p of [alice, bob, carol]) await join(p);
  await waitFor(
    () => bob.sync.role === 'client' && carol.sync.role === 'client' && !bob.sync.awaitingSnapshot && !carol.sync.awaitingSnapshot,
  );

  bob.bridge.local([['a', 'b1', 5, 0.1, 0.1]]);
  carol.bridge.local([['a', 'c1', 6, 0.9, 0.9]]);
  alice.bridge.local([['a', 'a1', 7, 0.5, 0.5]]);
  await waitFor(() => same([alice, bob, carol]) && alice.bridge.canvas.size === 3, { what: 'three elements everywhere' });
  assert.equal(alice.sync.state.get('b1')?.owner, 'id-Bob');
  assert.equal(carol.sync.state.get('b1')?.owner, 'id-Bob');

  bob.bridge.local([['h', 'c1'], ['m', 'c1', 0.4, 0.4], ['r', 'c1']]);
  await waitFor(() => carol.bridge.canvas.get('c1')?.x === 0.4, { what: 'move reaches Carol' });
  bob.bridge.local([['d', 'b1']], true);
  await waitFor(() => same([alice, bob, carol]) && alice.bridge.canvas.size === 2);
  assert.deepEqual(
    carol.events.cleared.map((b) => b.name),
    ['Bob'],
  );
  assert.deepEqual(
    alice.events.cleared.map((b) => b.name),
    ['Bob'],
  );
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
  assert.ok(winner === 'id-Bob' || winner === 'id-Carol');
  const expectedX = winner === 'id-Bob' ? 0.1 : 0.9;
  for (const p of [alice, bob, carol]) assert.equal(p.bridge.canvas.get('x')?.x, expectedX, p.name);
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
  await waitFor(() => !client.sync.awaitingSnapshot, { what: 'snapshot from new host' });
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
  assert.equal(bob.bridge.canvas.get('early')?.x, 0.3);
});

// ---- untrusted payloads ----------------------------------------------------------

// Snapshots the host sends to this player, seen at the session level.
function snapshotsTo(player: TestPlayer): Record<string, unknown>[] {
  const snaps: Record<string, unknown>[] = [];
  player.session.on('app', ({ k, d }) => {
    if (k === 'wsnap') snaps.push(d as Record<string, unknown>);
  });
  return snaps;
}

test('the host refuses a malformed batch and snaps the sender back', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]]);
  const bob = makePlayer(net, 'Bob');
  await join(alice);
  await join(bob);
  await waitFor(() => same([alice, bob]) && bob.bridge.canvas.size === 1 && !bob.sync.awaitingSnapshot);
  const snaps = snapshotsTo(bob);
  // Sent behind Bob's sync's back: an unknown op kind, and a junk sequence number.
  bob.session.sendApp('ws', { seq: 'x', ops: [['z', 'x']] });
  await waitFor(() => snaps.length === 1, { what: 'snapshot for a malformed batch' });
  assert.equal(snaps[0]?.ack, 0); // a junk seq is never acknowledged
  assert.equal(snaps[0]?.fresh, false);
  assert.deepEqual(snaps[0]?.elements, [['x', 5, 0.5, 0.5, 'id-Alice']]);
  bob.session.sendApp('ws', { seq: 7, ops: 'nope' });
  await waitFor(() => snaps.length === 2, { what: 'snapshot for ops that are not a list' });
  assert.equal(snaps[1]?.ack, 7);
  assert.equal(alice.sync.state.size, 1);
});

test('only clear: true marks a batch as clearing', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice');
  const bob = makePlayer(net, 'Bob');
  const carol = makePlayer(net, 'Carol');
  for (const p of [alice, bob, carol]) await join(p);
  await waitFor(() => !bob.sync.awaitingSnapshot && !carol.sync.awaitingSnapshot);
  bob.session.sendApp('ws', { seq: 50, ops: [['a', 'b9', 5, 0.1, 0.1]], clear: 'yes' });
  await waitFor(() => carol.bridge.canvas.get('b9') !== null, { what: 'batch relayed' });
  assert.deepEqual(alice.events.cleared, []);
  assert.deepEqual(carol.events.cleared, []);
});

test('fingerprints: junk is ignored, two mismatches in a row earn a snapshot', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]]);
  const bob = makePlayer(net, 'Bob');
  await join(alice);
  await join(bob);
  await waitFor(() => same([alice, bob]) && bob.bridge.canvas.size === 1 && !bob.sync.awaitingSnapshot);
  const snaps = snapshotsTo(bob);
  for (let i = 0; i < 3; i++) bob.session.sendApp('wshash', { h: 5 });
  bob.session.sendApp('wshash', { h: alice.sync.state.hash() }); // a match resets the count
  bob.session.sendApp('wshash', { h: 'nope' });
  await sleep(40);
  assert.equal(snaps.length, 0);
  bob.session.sendApp('wshash', { h: 'nope' });
  await waitFor(() => snaps.length === 1, { what: 'snapshot after two mismatches' });
});

test('clients ignore malformed batches and snapshots from the host', async () => {
  const net = new FakeNetwork();
  const alice = makePlayer(net, 'Alice', [['a', 'x', 5, 0.5, 0.5]]);
  const bob = makePlayer(net, 'Bob');
  await join(alice);
  await join(bob);
  await waitFor(() => same([alice, bob]) && bob.bridge.canvas.size === 1 && !bob.sync.awaitingSnapshot);
  const before = bob.events.snapshot.length;
  // Sent by the host's session directly, bypassing its sync.
  alice.session.sendApp('ws', { ops: [['a', 'BAD', 5, 0, 0]] });
  alice.session.sendApp('wsnap', { elements: 'x' });
  alice.session.sendApp('wsnap', { elements: [['a1', 5, 0, 0], ['a1', 6, 0, 0]] });
  alice.session.sendApp('ws', { ops: [['a', 'ok1', 6, 0.2, 0.2]] });
  await waitFor(() => bob.bridge.canvas.get('ok1') !== null, { what: 'the valid batch' });
  assert.deepEqual(bob.bridge.oids(), ['ok1', 'x']);
  assert.equal(bob.events.snapshot.length, before);
});
