// Integration tests for the shared-workspace bridge on the real game canvas:
// real drags must produce the right ops, and ops from other players must show
// up correctly (and stay usable for local drops). One player, no network: the
// bridge is activated directly and "remote" ops are applied by the test.
import { test, expect, type Page } from '@playwright/test';
import type { Who } from '../../src/net/session.ts';
import type { Op } from '../../src/workspace/ops.ts';
import type { LocalBatch } from '../../src/workspace/sync.ts';
import {
  E,
  launchPlayer,
  closePlayer,
  openGame,
  resetGame,
  recordEvents,
  recorded,
  dragLibraryToWorkspace,
  dragCanvasElement,
  canvasElements,
  type Player,
} from '../e2e/helpers.ts';

const BOB: Who = { id: 'bob', name: 'Bob', color: 1 };
let player: Player;
let page: Page;

test.beforeAll(async () => {
  player = await launchPlayer('workspace');
  page = player.page;
  await openGame(player);
});

test.afterAll(async () => {
  await closePlayer(player);
});

test.beforeEach(async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await resetGame(page);
  await page.evaluate(() => window.__laCoop!.bridge.activate('me'));
  await recordEvents(page, 'bridge', ['ops']);
});

// All batches, and all ops emitted so far, flattened.
const batches = () => recorded<LocalBatch>(page, 'ops');
const sentOps = async () => (await batches()).flatMap((batch) => batch.ops);
const remote = (ops: Op[], by: Who = BOB) => page.evaluate(([o, b]) => window.__laCoop!.bridge.applyOps(o, b), [ops, by] as const);
// Where a shared position lands on this screen (same maths as projection.ts).
const projected = (x: number, y: number) =>
  page.evaluate(
    ([sx, sy]) => {
      const m = window.__laCoop!.bridge.metrics();
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      return {
        left: Math.round(clamp(sx * m.playW - m.elemW / 2, 0, m.playW - m.elemW)),
        top: Math.round(clamp(sy * m.playH - m.elemH / 2, 0, m.playH - m.elemH)),
      };
    },
    [x, y] as const,
  );
// The id of the n-th op sent (an 'a', 'd', ... op).
const oidOf = async (index: number) => {
  const op = (await sentOps())[index];
  if (!op) throw new Error('no op #' + index);
  return op[1];
};

test('dropping an element from the library adds it at its shared position', async () => {
  await dragLibraryToWorkspace(page, E.water, 500, 400);
  await expect.poll(sentOps).toHaveLength(1);
  const [op] = await sentOps();
  if (op?.[0] !== 'a') throw new Error('expected an add, got ' + JSON.stringify(op));
  expect(op[2]).toBe(E.water);
  const [element] = await canvasElements(page);
  expect(element?.oid).toBe(op[1]);
  expect(await projected(op[3], op[4])).toEqual({ left: element?.left, top: element?.top });
});

test('moving an element sends hold, moves and release, ending where it landed', async () => {
  await dragLibraryToWorkspace(page, E.water, 400, 400);
  await expect.poll(sentOps).toHaveLength(1);
  const oid = await oidOf(0);
  await dragCanvasElement(page, oid, 700, 250);
  await expect.poll(async () => (await sentOps()).at(-1)?.[0]).toBe('r');
  const ops = (await sentOps()).slice(1);
  expect(ops[0]).toEqual(['h', oid]);
  expect(ops.filter((o) => o[0] === 'm').length).toBeGreaterThanOrEqual(1);
  const lastMove = ops.at(-2);
  if (lastMove?.[0] !== 'm') throw new Error('expected a move, got ' + JSON.stringify(lastMove));
  const [element] = await canvasElements(page);
  // The game keeps fractional pixels after a drag; shared positions round them.
  const landed = await projected(lastMove[2], lastMove[3]);
  expect(Math.abs(landed.left - (element?.left ?? NaN))).toBeLessThanOrEqual(1);
  expect(Math.abs(landed.top - (element?.top ?? NaN))).toBeLessThanOrEqual(1);
});

test('a combination is one batch: the result is added and the ingredient removed', async () => {
  await dragLibraryToWorkspace(page, E.water, 500, 400);
  await expect.poll(sentOps).toHaveLength(1);
  const waterOid = await oidOf(0);
  await dragLibraryToWorkspace(page, E.fire, 500, 400); // fire from the library onto the water
  await expect.poll(async () => (await batches()).length).toBe(2);
  const batch = (await batches())[1]?.ops ?? [];
  expect(batch.map((o) => o[0]).sort()).toEqual(['a', 'd']);
  expect(batch.find((o) => o[0] === 'a')?.[2]).toBe(E.steam);
  expect(batch.find((o) => o[0] === 'd')?.[1]).toBe(waterOid);
  expect((await canvasElements(page)).map((e) => e.el)).toEqual([E.steam]);
});

test('combining two canvas elements deletes both in the same batch as the result', async () => {
  await dragLibraryToWorkspace(page, E.water, 400, 400);
  await dragLibraryToWorkspace(page, E.fire, 650, 300);
  await expect.poll(sentOps).toHaveLength(2);
  const waterOid = await oidOf(0);
  const fireOid = await oidOf(1);
  const water = (await canvasElements(page)).find((e) => e.oid === waterOid);
  if (!water) throw new Error('water is not on the canvas');
  await dragCanvasElement(page, fireOid, water.left + 37, water.top + 37);
  await expect.poll(async () => (await sentOps()).some((o) => o[0] === 'a' && o[2] === E.steam)).toBe(true);
  const last = (await batches()).at(-1)?.ops ?? [];
  expect(
    last
      .filter((o) => o[0] === 'd')
      .map((o) => o[1])
      .sort(),
  ).toEqual([waterOid, fireOid].sort());
  expect(last.some((o) => o[0] === 'a' && o[2] === E.steam)).toBe(true);
});

test('dragging an element back onto the library deletes it', async () => {
  await dragLibraryToWorkspace(page, E.air, 500, 400);
  await expect.poll(sentOps).toHaveLength(1);
  const oid = await oidOf(0);
  await dragCanvasElement(page, oid, 1150, 400);
  await expect.poll(async () => (await sentOps()).some((o) => o[0] === 'd' && o[1] === oid)).toBe(true);
  expect(await canvasElements(page)).toEqual([]);
});

test("another player's add, move and delete show up at the right place", async () => {
  await remote([['a', 'r1', E.fire, 0.5, 0.5]]);
  let [element] = await canvasElements(page);
  expect(element).toMatchObject({ oid: 'r1', el: E.fire, ...(await projected(0.5, 0.5)) });
  await remote([['m', 'r1', 0.2, 0.3]]);
  [element] = await canvasElements(page);
  expect({ left: element?.left, top: element?.top }).toEqual(await projected(0.2, 0.3));
  await remote([['d', 'r1']]);
  expect(await canvasElements(page)).toEqual([]);
  await page.waitForTimeout(150);
  expect(await sentOps()).toEqual([]); // remote changes are not echoed
});

test('dropping onto an element another player moved still combines', async () => {
  await remote([['a', 'r1', E.water, 0.3, 0.5]]);
  await remote([['m', 'r1', 0.6, 0.35]]);
  const [water] = await canvasElements(page);
  if (!water) throw new Error('water is not on the canvas');
  await dragLibraryToWorkspace(page, E.fire, water.left + 37, water.top + 37);
  await expect.poll(async () => (await canvasElements(page)).map((e) => e.el)).toEqual([E.steam]);
  await expect.poll(async () => (await sentOps()).some((o) => o[0] === 'd' && o[1] === 'r1')).toBe(true);
});

test("an element another player is dragging can't be picked up or combined with", async () => {
  await remote([['a', 'r1', E.water, 0.4, 0.5], ['h', 'r1']]);
  let [water] = await canvasElements(page);
  expect(water?.held).toBe(true);
  await expect(page.locator('#workspace > .element[data-coop-oid="r1"]')).toHaveAttribute('data-coop-holder', 'Bob');

  await dragCanvasElement(page, 'r1', 800, 200); // blocked
  [water] = await canvasElements(page);
  if (!water) throw new Error('water is not on the canvas');
  expect({ left: water.left, top: water.top }).toEqual(await projected(0.4, 0.5));

  await dragLibraryToWorkspace(page, E.fire, water.left + 37, water.top + 37); // lands next to it instead
  await page.waitForTimeout(200);
  expect((await canvasElements(page)).map((e) => e.el).sort()).toEqual([E.water, E.fire].sort());
  expect((await sentOps()).some((o) => o[0] === 'd')).toBe(false);

  await remote([['r', 'r1']]); // Bob lets go
  expect((await canvasElements(page)).find((e) => e.oid === 'r1')?.held).toBe(false);
});

test('resizing the window re-fits elements without sending anything', async () => {
  await remote([['a', 'r1', E.earth, 0.95, 0.95], ['a', 'r2', E.air, 0.05, 0.05]]);
  await page.setViewportSize({ width: 700, height: 600 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => window.__laCoop!.bridge.metrics());
  for (const element of await canvasElements(page)) {
    expect(element.visible).toBe(true);
    expect(element.left + metrics.elemW).toBeLessThanOrEqual(metrics.playW);
    expect(element.top + metrics.elemH).toBeLessThanOrEqual(metrics.playH);
  }
  expect((await canvasElements(page)).find((e) => e.oid === 'r1')).toMatchObject(await projected(0.95, 0.95));
  expect(await sentOps()).toEqual([]);
});

test('in a room, the clear button removes only my own elements', async () => {
  await dragLibraryToWorkspace(page, E.water, 400, 300);
  await expect.poll(sentOps).toHaveLength(1);
  const mine = await oidOf(0);
  await remote([['a', 'r1', E.fire, 0.7, 0.7]]);
  await page.evaluate((oid) => {
    window.__laCoop!.bridge.ownerOf = (id) => (id === oid ? 'me' : 'bob');
  }, mine);
  await page.locator('#clearWorkspace').click();
  await expect.poll(async () => (await canvasElements(page)).map((e) => e.oid)).toEqual(['r1']);
  await expect.poll(async () => (await batches()).at(-1)).toEqual({ ops: [['d', mine]], clear: true });
});

test('reconcile replaces the canvas with the room’s, silently', async () => {
  await dragLibraryToWorkspace(page, E.water, 400, 300);
  await dragLibraryToWorkspace(page, E.fire, 700, 300);
  await expect.poll(sentOps).toHaveLength(2);
  const before = (await batches()).length;
  await page.evaluate(() => {
    const { bridge, sync } = window.__laCoop!;
    const State = sync.state.constructor as new () => typeof sync.state;
    const room = new State();
    room.applyBatch([['a', 'h1', 6, 0.5, 0.5], ['h', 'h1']], 'bob');
    bridge.reconcile(room, new Map([['bob', { name: 'Bob', color: 1 }]]));
  });
  const elements = await canvasElements(page);
  expect(elements.map((e) => [e.oid, e.el, e.held])).toEqual([['h1', E.lava, true]]);
  await page.waitForTimeout(150);
  expect((await batches()).length).toBe(before);
});
