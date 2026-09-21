import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession, type SessionEvents, type Timing } from '../../src/net/session.ts';
import { decode, hostPeerId, PROTOCOL_VERSION, type Decoded } from '../../src/net/protocol.ts';
import type { Tuple } from '../../src/sync/pairs.ts';
import { FakeNetwork, FakeGame, FAST_TIMING, sleep, waitFor } from './fakes.ts';

const CODE = 'K7M4PX';

const EVENTS = ['remote', 'joined', 'left', 'rejected', 'app', 'welcomed', 'kicked', 'departed', 'room'] as const;
type Recorded = { [K in (typeof EVENTS)[number]]: SessionEvents[K][] };

type PlayerOptions = { build?: string; isRecipe?: (tuple: Tuple) => boolean; timing?: Partial<Timing>; id?: string };
type Spec = readonly [name: string, tuples?: Tuple[], opts?: PlayerOptions];
type TestPlayer = {
  name: string;
  game: FakeGame;
  session: RoomSession;
  events: Recorded;
  discover(a: number, b: number): Tuple | null;
};

let players: TestPlayer[] = [];

afterEach(() => {
  for (const p of players) p.session.leave({ immediate: true });
  players = [];
});

function record<K extends keyof Recorded>(session: RoomSession, events: Recorded, type: K): void {
  session.on(type, (e) => events[type].push(e));
}

function makePlayer(net: FakeNetwork, name: string, tuples: Tuple[] = [], { build = '580', isRecipe, timing = {}, id }: PlayerOptions = {}): TestPlayer {
  const game = new FakeGame(tuples, { isRecipe });
  const session = new RoomSession({
    createPeer: (peerId) => net.createPeer(peerId),
    game,
    player: { id: id ?? 'id-' + name, name },
    build,
    timing: { ...FAST_TIMING, ...timing },
  });
  const events: Recorded = { remote: [], joined: [], left: [], rejected: [], app: [], welcomed: [], kicked: [], departed: [], room: [] };
  for (const type of EVENTS) record(session, events, type);
  const player: TestPlayer = {
    name,
    game,
    session,
    events,
    discover(a, b) {
      const tuple = game.discover(a, b);
      if (tuple) session.broadcastLocal([tuple]);
      return tuple;
    },
  };
  players.push(player);
  return player;
}

const connected = (p: TestPlayer) => p.session.state === 'hosting' || p.session.state === 'connected';
const hosts = (list: TestPlayer[]) => list.filter((p) => p.session.role === 'host');
const names = (list: { name: string }[]) => list.map((m) => m.name);

async function room<const S extends readonly Spec[]>(net: FakeNetwork, specs: S): Promise<{ [I in keyof S]: TestPlayer }> {
  const list = specs.map(([name, tuples, opts]) => makePlayer(net, name, tuples, opts));
  const [first, ...rest] = list;
  assert.ok(first);
  first.session.join(CODE);
  await waitFor(() => first.session.state === 'hosting', { what: 'first player hosting' });
  for (const p of rest) {
    p.session.join(CODE);
    await waitFor(() => p.session.state === 'connected', { what: p.name + ' connected' });
  }
  await waitFor(() => list.every((p) => p.session.members.length === list.length), { what: 'member lists' });
  return list as { [I in keyof S]: TestPlayer };
}

async function converged(list: TestPlayer[]): Promise<string[]> {
  const first = list[0];
  assert.ok(first);
  await waitFor(() => list.every((p) => p.game.pairs().join() === first.game.pairs().join()), { what: 'converged saves' });
  return first.game.pairs();
}

// A raw connection to the room's host, speaking the protocol by hand.
async function rawConnection(net: FakeNetwork) {
  const peer = net.createPeer(undefined);
  await new Promise((resolve) => peer.once('open', resolve));
  const conn = peer.connect(hostPeerId(CODE), { serialization: 'raw' });
  await new Promise((resolve) => conn.once('open', resolve));
  return { peer, conn };
}

test('first player hosts, second joins, and both saves become the union', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [
    ['Alice', [[1, 2, 10], [2, 3, 20]]],
    ['Bob', [[1, 3, 30]]],
  ]);
  assert.deepEqual(await converged([alice, bob]), ['1+2', '1+3', '2+3']);
  assert.equal(alice.session.role, 'host');
  assert.equal(bob.session.role, 'client');

  const bobView = bob.session.members;
  assert.deepEqual(
    bobView.map((m) => [m.name, m.host, m.you]),
    [
      ['Alice', true, false],
      ['Bob', false, true],
    ],
  );
  assert.notEqual(bobView[0]?.color, bobView[1]?.color);
  assert.deepEqual(names(alice.events.joined), ['Bob']);
  // Each side learned about the other's recipes as a sync.
  assert.equal(alice.events.remote[0]?.sync, true);
  assert.deepEqual(alice.events.remote[0]?.tuples, [[1, 3, 30]]);
  assert.equal(bob.events.remote[0]?.sync, true);
  assert.equal(bob.events.remote[0]?.tuples.length, 2);
});

test('live discoveries reach everyone through the host, with attribution', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice'], ['Bob'], ['Carol']]);

  carol.discover(10, 11);
  bob.discover(12, 13);
  alice.discover(14, 15);
  assert.deepEqual(await converged([alice, bob, carol]), ['10+11', '12+13', '14+15']);

  const fromCarol = bob.events.remote.find((e) => e.tuples.some((t) => t[0] === 10));
  assert.equal(fromCarol?.by?.name, 'Carol');
  assert.equal(fromCarol?.sync, false);
  const fromAlice = carol.events.remote.find((e) => e.tuples.some((t) => t[0] === 14));
  assert.equal(fromAlice?.by?.name, 'Alice');
});

test('two players opening an empty room at the same time end up with one host', async () => {
  const net = new FakeNetwork();
  const a = makePlayer(net, 'A', [[1, 2, 1]]);
  const b = makePlayer(net, 'B', [[3, 4, 2]]);
  a.session.join(CODE);
  b.session.join(CODE);
  await waitFor(() => connected(a) && connected(b) && a.session.members.length === 2 && b.session.members.length === 2);
  assert.equal(hosts([a, b]).length, 1);
  assert.deepEqual(await converged([a, b]), ['1+2', '3+4']);
});

test('when the host leaves, another player takes over and everyone converges', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice', [[1, 2, 1]]], ['Bob'], ['Carol']]);
  alice.session.leave();

  await waitFor(() => hosts([bob, carol]).length === 1 && connected(bob) && connected(carol), { what: 'new host' });
  await waitFor(() => bob.session.members.length === 2 && carol.session.members.length === 2, { what: 'members after migration' });
  assert.ok(names(bob.events.left).includes('Alice') || names(carol.events.left).includes('Alice'));

  bob.discover(20, 21);
  carol.discover(22, 23);
  assert.deepEqual(await converged([bob, carol]), ['1+2', '20+21', '22+23']);
  // Migration is not announced as everyone leaving and rejoining.
  for (const p of [bob, carol]) {
    assert.ok(!p.events.left.some((m) => m.name === 'Bob' || m.name === 'Carol'), p.name + ' saw a false leave');
  }
});

test('a crashed host (no goodbye) is replaced too', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice'], ['Bob', [[5, 6, 1]]], ['Carol']]);
  net.holderOf(hostPeerId(CODE))?.destroy();
  await waitFor(() => hosts([bob, carol]).length === 1 && connected(bob) && connected(carol), { what: 'new host' });
  carol.discover(30, 31);
  assert.deepEqual(await converged([bob, carol]), ['30+31', '5+6']);
  alice.session.leave({ immediate: true });
});

test('a host that lost its broker id to someone else demotes itself and rejoins', async () => {
  const net = new FakeNetwork();
  // Alice is slow to re-register, so Carol claims the room id first.
  const [alice, bob] = await room(net, [
    ['Alice', [[1, 2, 1]], { timing: { brokerRetryBaseMs: 400, brokerRetryMaxMs: 400 } }],
    ['Bob', [[3, 4, 2]]],
  ]);
  net.holderOf(hostPeerId(CODE))?.disconnect(); // broker drop: id released, data channels alive
  const carol = makePlayer(net, 'Carol', [[5, 6, 3]]);
  carol.session.join(CODE);
  await waitFor(() => carol.session.state === 'hosting', { what: 'Carol hosting' });

  await waitFor(() => connected(alice) && connected(bob) && alice.session.role === 'client' && bob.session.role === 'client', {
    what: 'Alice and Bob rehomed',
  });
  assert.equal(hosts([alice, bob, carol]).length, 1);
  await waitFor(() => carol.session.members.length === 3, { what: 'three members' });
  assert.deepEqual(await converged([alice, bob, carol]), ['1+2', '3+4', '5+6']);
});

test('a player on a different game build is rejected', async () => {
  const net = new FakeNetwork();
  const [alice] = await room(net, [['Alice']]);
  const bob = makePlayer(net, 'Bob', [[1, 2, 1]], { build: '999' });
  bob.session.join(CODE);
  await waitFor(() => bob.session.state === 'rejected', { what: 'rejection' });
  assert.equal(bob.events.rejected[0]?.reason, 'build');
  await sleep(30);
  assert.equal(alice.session.members.length, 1);
  assert.deepEqual(alice.game.pairs(), []); // nothing merged from a rejected player
});

test('a hello with another protocol version is rejected', async () => {
  const net = new FakeNetwork();
  await room(net, [['Alice']]);
  const { peer, conn } = await rawConnection(net);
  const reply = new Promise<Decoded>((resolve) => {
    conn.on('data', (raw: unknown) => {
      const decoded = decode(raw);
      if (decoded.msg && decoded.msg.t !== 'ping') resolve(decoded);
    });
  });
  conn.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 1, player: { id: 'x', name: 'X' }, pairs: [] }));
  const { msg } = await reply;
  assert.equal(msg?.t, 'reject');
  assert.equal(msg.t === 'reject' && msg.reason, 'version');
  peer.destroy();
});

test('invalid recipes are neither applied nor relayed', async () => {
  const net = new FakeNetwork();
  const isRecipe = (t: Tuple) => t[0] !== 99;
  const [alice, bob, carol] = await room(net, [
    ['Alice', [], { isRecipe }],
    ['Bob', [], { isRecipe }],
    ['Carol', [], { isRecipe }],
  ]);
  bob.discover(99, 100); // Bob's own game accepted it, the others must not
  bob.discover(7, 8);
  await waitFor(() => carol.game.keys.has('7+8'));
  await sleep(30);
  assert.ok(!alice.game.keys.has('99+100'));
  assert.ok(!carol.game.keys.has('99+100'));
});

test('messages without a hello are ignored by the host', async () => {
  const net = new FakeNetwork();
  const [alice] = await room(net, [['Alice']]);
  const { peer, conn } = await rawConnection(net);
  conn.send(JSON.stringify({ t: 'add', by: { id: 'x', name: 'X' }, pairs: [[1, 2]] }));
  conn.send('not json');
  await sleep(30);
  assert.deepEqual(alice.game.pairs(), []);
  peer.destroy();
});

test('the same player connecting from a second window replaces the first', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  const bob2 = makePlayer(net, 'Bob', [], { id: 'id-Bob' });
  bob2.session.join(CODE);
  await waitFor(() => bob2.session.state === 'connected', { what: 'second window connected' });
  await waitFor(() => bob.session.state === 'rejected', { what: 'first window stopped' });
  assert.equal(bob.events.rejected[0]?.reason, 'replaced');
  await sleep(100);
  assert.equal(alice.session.members.length, 2);
  assert.equal(bob.session.state, 'rejected'); // it does not fight back
  assert.deepEqual(alice.events.left, []);
});

test('a silent host is detected by the heartbeat', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  net.partition(alice.session.peer, bob.session.peer);
  await waitFor(() => bob.session.state === 'reconnecting', { what: 'Bob noticing', timeout: 2000 });
  await waitFor(() => alice.session.members.length === 1, { what: 'Alice dropping Bob', timeout: 2000 });
});

test('renames show up for everyone', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  bob.session.rename('Bobby');
  alice.session.rename('Ally');
  await waitFor(() => alice.session.members.some((m) => m.name === 'Bobby'));
  await waitFor(() => bob.session.members.some((m) => m.name === 'Ally'));
});

test('floods of adds are rate limited', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  for (let i = 0; i < 60; i++) bob.discover(200 + i, 300 + i);
  await sleep(80);
  assert.equal(alice.game.pairs().length, FAST_TIMING.addMaxPerWindow);
});

test('leave() says goodbye and resets the session', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  bob.session.leave();
  assert.equal(bob.session.state, 'idle');
  assert.equal(bob.session.code, null);
  assert.deepEqual(bob.session.members, []);
  await waitFor(() => alice.session.members.length === 1);
  assert.deepEqual(names(alice.events.left), ['Bob']);
});

test('discoveries made while reconnecting are delivered with the next hello', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  alice.session.leave();
  // Bob is alone now and becomes host; discoveries keep flowing into his save.
  await waitFor(() => bob.session.state === 'hosting');
  bob.discover(40, 41);
  alice.session.join(CODE);
  await waitFor(() => alice.session.state === 'connected');
  assert.deepEqual(await converged([alice, bob]), ['40+41']);
});

// ---- v2: app messages, room flags, host controls ---------------------------

test('app messages reach the host, which can relay, broadcast or address one player', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice'], ['Bob'], ['Carol']]);

  assert.equal(bob.session.sendApp('cur', { x: 0.5 }), true);
  await waitFor(() => alice.events.app.length === 1, { what: 'host receiving' });
  const fromBob = alice.events.app[0];
  assert.ok(fromBob);
  assert.deepEqual([fromBob.k, fromBob.d, fromBob.by.name, fromBob.fromHost], ['cur', { x: 0.5 }, 'Bob', false]);
  assert.equal(carol.events.app.length, 0); // no automatic relay

  alice.session.relayApp('cur', { x: 0.5 }, fromBob.by.id);
  await waitFor(() => carol.events.app.length === 1, { what: 'relay' });
  assert.equal(carol.events.app[0]?.by.name, 'Bob');
  await sleep(20);
  assert.equal(bob.events.app.length, 0); // not echoed to the sender

  alice.session.sendApp('ws', { ops: [] });
  await waitFor(() => bob.events.app.length === 1 && carol.events.app.length === 2, { what: 'broadcast' });
  assert.equal(bob.events.app[0]?.by.name, 'Alice');
  assert.equal(bob.events.app[0]?.fromHost, true);

  assert.equal(alice.session.sendAppTo('id-Carol', 'wsnap', { n: 1 }), true);
  await waitFor(() => carol.events.app.length === 3, { what: 'direct message' });
  await sleep(20);
  assert.equal(bob.events.app.length, 1);
  assert.equal(alice.session.sendAppTo('id-Nobody', 'wsnap', {}), false);
});

test('the host hears when a player has been welcomed, including after a rejoin', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  assert.deepEqual(
    alice.events.welcomed.map((e) => [e.member.name, e.rejoining]),
    [['Bob', false]],
  );
  bob.session.leave();
  await waitFor(() => alice.events.departed.length === 1, { what: 'departed' });
  bob.session.join(CODE);
  await waitFor(() => alice.events.welcomed.length === 2, { what: 'welcomed again' });
});

test('app messages are rate limited per player', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  for (let i = 0; i < 300; i++) bob.session.sendApp('cur', { i });
  await sleep(100);
  assert.ok(alice.events.app.length >= FAST_TIMING.appBucketSize, 'burst allowed');
  assert.ok(alice.events.app.length < 200, 'flood capped, got ' + alice.events.app.length);
});

test('a kicked player is removed and stays out, even after the host changes', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice'], ['Bob'], ['Carol']]);
  assert.equal(bob.session.kick('id-Carol'), false); // only the host can kick
  assert.equal(alice.session.kick('id-Bob'), true);

  await waitFor(() => bob.session.state === 'rejected', { what: 'Bob removed' });
  assert.equal(bob.events.rejected[0]?.reason, 'kicked');
  await waitFor(() => carol.session.members.length === 2, { what: 'Carol sees Bob gone' });
  assert.deepEqual(names(carol.events.kicked), ['Bob']);
  assert.deepEqual(names(alice.events.kicked), ['Bob']);
  assert.deepEqual(carol.session.room.banned, ['id-Bob']);

  bob.session.join(CODE);
  await waitFor(() => bob.events.rejected.length === 2, { what: 'rejoin refused' });
  assert.equal(bob.events.rejected[1]?.reason, 'kicked');

  // Carol takes over when Alice leaves, and still keeps Bob out.
  alice.session.leave();
  await waitFor(() => carol.session.state === 'hosting', { what: 'Carol hosting' });
  bob.session.join(CODE);
  await waitFor(() => bob.events.rejected.length === 3, { what: 'refused by the new host' });
  assert.equal(bob.events.rejected[2]?.reason, 'kicked');
});

test('a locked room turns newcomers away but lets its players reconnect', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  assert.equal(alice.session.setLocked(true), true);
  await waitFor(() => bob.session.room.locked, { what: 'Bob sees the lock' });
  assert.ok(bob.events.room.some((r) => r.locked));

  const dave = makePlayer(net, 'Dave');
  dave.session.join(CODE);
  await waitFor(() => dave.session.state === 'rejected', { what: 'Dave refused' });
  assert.equal(dave.events.rejected[0]?.reason, 'locked');

  bob.session.leave();
  await waitFor(() => alice.session.members.length === 1);
  bob.session.join(CODE);
  await waitFor(() => bob.session.state === 'connected', { what: 'Bob back in' });

  alice.session.setLocked(false);
  dave.session.join(CODE);
  await waitFor(() => dave.session.state === 'connected', { what: 'Dave in after unlock' });
});

test('handing over makes the chosen player host and everyone follows', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice', [[1, 2, 1]]], ['Bob'], ['Carol']]);
  alice.session.setLocked(true);
  await waitFor(() => bob.session.room.locked && carol.session.room.locked);

  assert.equal(bob.session.handOver('id-Carol'), false); // only the host can
  assert.equal(alice.session.handOver('id-Bob'), true);

  await waitFor(() => bob.session.state === 'hosting', { what: 'Bob hosting', timeout: 6000 });
  await waitFor(() => alice.session.state === 'connected' && carol.session.state === 'connected', {
    what: 'Alice and Carol following',
    timeout: 6000,
  });
  await waitFor(() => [alice, bob, carol].every((p) => p.session.members.length === 3), { what: 'all three' });
  assert.equal(bob.session.members.find((m) => m.host)?.name, 'Bob');
  assert.equal(bob.session.room.locked, true); // room flags survive the handover
  // Nobody was announced as leaving.
  for (const p of [alice, bob, carol]) assert.deepEqual(p.events.left, [], p.name + ' saw a leave');

  carol.discover(7, 8);
  alice.discover(9, 10);
  assert.deepEqual(await converged([alice, bob, carol]), ['1+2', '7+8', '9+10']);
});

test('handing over to a player who vanishes falls back to a normal host change', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice'], ['Bob'], ['Carol']]);
  alice.session.handOver('id-Bob');
  bob.session.leave({ immediate: true });
  await waitFor(() => hosts([alice, carol]).length === 1 && connected(alice) && connected(carol), {
    what: 'someone hosting',
    timeout: 8000,
  });
  await waitFor(() => alice.session.members.length === 2 && carol.session.members.length === 2, { what: 'two left' });
});
