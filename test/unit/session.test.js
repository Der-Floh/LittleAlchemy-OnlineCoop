import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession } from '../../src/net/session.js';
import { encode, decode, hostPeerId, PROTOCOL_VERSION } from '../../src/net/protocol.js';
import { FakeNetwork, FakeGame, FAST_TIMING, sleep, waitFor } from './fakes.js';

const CODE = 'K7M4PX';
let players = [];

afterEach(() => {
  for (const p of players) p.session.leave({ immediate: true });
  players = [];
});

function makePlayer(net, name, tuples = [], { build = '580', isRecipe, timing = {}, id } = {}) {
  const game = new FakeGame(tuples, isRecipe ? { isRecipe } : {});
  const session = new RoomSession({
    createPeer: (peerId) => net.createPeer(peerId),
    game,
    player: { id: id || 'id-' + name, name },
    build,
    timing: { ...FAST_TIMING, ...timing },
  });
  const events = { remote: [], joined: [], left: [], rejected: [] };
  for (const type of Object.keys(events)) session.on(type, (e) => events[type].push(e));
  const player = {
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

const connected = (p) => p.session.state === 'hosting' || p.session.state === 'connected';
const hosts = (list) => list.filter((p) => p.session.role === 'host');

async function room(net, specs) {
  const list = specs.map(([name, tuples, opts]) => makePlayer(net, name, tuples, opts));
  list[0].session.join(CODE);
  await waitFor(() => list[0].session.state === 'hosting', { what: 'first player hosting' });
  for (const p of list.slice(1)) {
    p.session.join(CODE);
    await waitFor(() => p.session.state === 'connected', { what: p.name + ' connected' });
  }
  await waitFor(() => list.every((p) => p.session.members.length === list.length), { what: 'member lists' });
  return list;
}

async function converged(list) {
  await waitFor(() => list.every((p) => p.game.pairs().join() === list[0].game.pairs().join()), { what: 'converged saves' });
  return list[0].game.pairs();
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
  assert.notEqual(bobView[0].color, bobView[1].color);
  assert.deepEqual(alice.events.joined.map((m) => m.name), ['Bob']);
  // Each side learned about the other's recipes as a sync.
  assert.equal(alice.events.remote[0].sync, true);
  assert.deepEqual(alice.events.remote[0].tuples, [[1, 3, 30]]);
  assert.equal(bob.events.remote[0].sync, true);
  assert.equal(bob.events.remote[0].tuples.length, 2);
});

test('live discoveries reach everyone through the host, with attribution', async () => {
  const net = new FakeNetwork();
  const [alice, bob, carol] = await room(net, [['Alice'], ['Bob'], ['Carol']]);

  carol.discover(10, 11);
  bob.discover(12, 13);
  alice.discover(14, 15);
  assert.deepEqual(await converged([alice, bob, carol]), ['10+11', '12+13', '14+15']);

  const fromCarol = bob.events.remote.find((e) => e.tuples.some((t) => t[0] === 10));
  assert.equal(fromCarol.by.name, 'Carol');
  assert.equal(fromCarol.sync, false);
  const fromAlice = carol.events.remote.find((e) => e.tuples.some((t) => t[0] === 14));
  assert.equal(fromAlice.by.name, 'Alice');
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
  assert.ok(bob.events.left.some((m) => m.name === 'Alice') || carol.events.left.some((m) => m.name === 'Alice'));

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
  net.holderOf(hostPeerId(CODE)).destroy();
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
  net.holderOf(hostPeerId(CODE)).disconnect(); // broker drop: id released, data channels alive
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
  assert.equal(bob.events.rejected[0].reason, 'build');
  await sleep(30);
  assert.equal(alice.session.members.length, 1);
  assert.deepEqual(alice.game.pairs(), []); // nothing merged from a rejected player
});

test('a hello with another protocol version is rejected', async () => {
  const net = new FakeNetwork();
  await room(net, [['Alice']]);
  const raw = net.createPeer(undefined);
  await new Promise((resolve) => raw.once('open', resolve));
  const conn = raw.connect(hostPeerId(CODE), { serialization: 'raw' });
  await new Promise((resolve) => conn.once('open', resolve));
  const reply = new Promise((resolve) => {
    conn.on('data', (raw) => {
      const decoded = decode(raw);
      if (decoded.msg && decoded.msg.t !== 'ping') resolve(decoded);
    });
  });
  conn.send(encode({ t: 'hello', v: PROTOCOL_VERSION + 1, player: { id: 'x', name: 'X' }, pairs: [] }));
  const { msg } = await reply;
  assert.equal(msg.t, 'reject');
  assert.equal(msg.reason, 'version');
  raw.destroy();
});

test('invalid recipes are neither applied nor relayed', async () => {
  const net = new FakeNetwork();
  const isRecipe = (t) => t[0] !== 99;
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
  const raw = net.createPeer(undefined);
  await new Promise((resolve) => raw.once('open', resolve));
  const conn = raw.connect(hostPeerId(CODE), { serialization: 'raw' });
  await new Promise((resolve) => conn.once('open', resolve));
  conn.send(encode({ t: 'add', by: { id: 'x', name: 'X' }, pairs: [[1, 2]] }));
  conn.send('not json');
  await sleep(30);
  assert.deepEqual(alice.game.pairs(), []);
  raw.destroy();
});

test('the same player connecting from a second window replaces the first', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  const bob2 = makePlayer(net, 'Bob', [], { id: 'id-Bob' });
  bob2.session.join(CODE);
  await waitFor(() => bob2.session.state === 'connected', { what: 'second window connected' });
  await waitFor(() => bob.session.state === 'rejected', { what: 'first window stopped' });
  assert.equal(bob.events.rejected[0].reason, 'replaced');
  await sleep(100);
  assert.equal(alice.session.members.length, 2);
  assert.equal(bob.session.state, 'rejected'); // it does not fight back
  assert.deepEqual(alice.events.left, []);
});

test('a silent host is detected by the heartbeat', async () => {
  const net = new FakeNetwork();
  const [alice, bob] = await room(net, [['Alice'], ['Bob']]);
  net.partition(alice.session._peer, bob.session._peer);
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
  assert.deepEqual(alice.events.left.map((m) => m.name), ['Bob']);
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
