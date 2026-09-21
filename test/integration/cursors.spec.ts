// Integration tests for live cursors on the real game page: how other
// players' cursors are drawn, and what our own pointer sends. No network: the
// session's sendApp is replaced by a recorder.
import { test, expect, type Page } from '@playwright/test';
import type { Who } from '../../src/net/session.ts';
import { E, launchPlayer, closePlayer, openGame, resetGame, type Player } from '../e2e/helpers.ts';

const BOB: Who = { id: 'bob', name: 'Bob', color: 1 };
let player: Player;
let page: Page;

test.beforeAll(async () => {
  player = await launchPlayer('cursors');
  page = player.page;
  await openGame(player);
});

test.afterAll(async () => {
  await closePlayer(player);
});

test.beforeEach(async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await resetGame(page);
  await page.evaluate(() => {
    const { cursors, session } = window.__laCoop!;
    const sent: [string, unknown][] = (window.__sent = []);
    session.sendApp = (k, d) => {
      sent.push([k, d]);
      return true;
    };
    cursors.connected = () => true;
    cursors.start();
  });
});

type SentCursor = { x?: number; y?: number; h?: number; off?: true };

const receive = (d: unknown, by: Who = BOB) => page.evaluate(([b, data]) => window.__laCoop!.cursors.receive(b, data), [by, d] as const);
const cursor = (id = 'bob') =>
  page.evaluate((pid) => {
    const node = document.getElementById('la-coop-root')?.shadowRoot?.querySelector<HTMLElement>(`.cursor[data-player="${pid}"]`);
    if (!node) return null;
    const ghost = node.querySelector<HTMLImageElement>('.ghost');
    return {
      hidden: node.hidden,
      transform: node.style.transform,
      name: node.querySelector('.name')?.textContent,
      color: node.querySelector('path')?.getAttribute('fill'),
      ghost: !ghost || ghost.hidden ? null : ghost.getAttribute('src'),
    };
  }, id);
const metrics = () => page.evaluate(() => window.__laCoop!.bridge.metrics());
const sent = () => page.evaluate(() => (window.__sent ?? []).filter(([k]) => k === 'cur').map(([, d]) => d as SentCursor));
const lastSent = async () => (await sent()).at(-1);

test("another player's cursor is drawn at the shared position, in their colour", async () => {
  await receive({ x: 0.5, y: 0.25 });
  const m = await metrics();
  expect(await cursor()).toEqual({
    hidden: false,
    transform: `translate(${Math.round(m.playW * 0.5)}px, ${Math.round(m.playH * 0.25)}px)`,
    name: 'Bob',
    color: '#1c7ed6',
    ghost: null,
  });
});

test('a cursor carries the element being dragged from the library, and hides when off', async () => {
  await receive({ x: 0.3, y: 0.3, h: E.steam });
  expect((await cursor())?.ghost).toMatch(/^data:image\/png;base64,/);
  await receive({ x: 0.31, y: 0.3 });
  expect((await cursor())?.ghost).toBeNull();
  await receive({ off: true });
  expect((await cursor())?.hidden).toBe(true);
  await receive({ x: 2, y: 'nope' }); // junk is ignored
  expect((await cursor())?.hidden).toBe(true);
});

test('our pointer is sent in shared coordinates, and "off" over the library', async () => {
  const m = await metrics();
  await page.mouse.move(300, 200);
  await expect.poll(lastSent).toEqual({
    x: Math.round((300 / m.playW) * 10000) / 10000,
    y: Math.round((200 / m.playH) * 10000) / 10000,
  });
  await page.mouse.move(m.playW + 60, 300); // over the library
  await expect.poll(lastSent).toEqual({ off: true });
});

test('while dragging from the library, our cursor carries that element', async () => {
  const img = page.locator(`#library > .element[data-elementid="${E.fire}"] img`);
  const box = await img.boundingBox();
  if (!box) throw new Error('fire is not in the library');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 12 });
  await expect.poll(async () => (await lastSent())?.h).toBe(E.fire);
  await page.mouse.up();
  await page.mouse.move(430, 390);
  await expect.poll(async () => 'h' in ((await lastSent()) ?? {})).toBe(false);
});

test('turning cursors off removes them and ignores new ones', async () => {
  await receive({ x: 0.5, y: 0.5 });
  await page.evaluate(() => window.__laCoop!.cursors.setEnabled(false));
  expect(await cursor()).toBeNull();
  await receive({ x: 0.6, y: 0.6 });
  expect(await cursor()).toBeNull();
});

test('cursor positions are clamped; junk payloads and element ids are ignored', async () => {
  const m = await metrics();
  await receive({ x: 1.5, y: -0.2 });
  expect((await cursor())?.transform).toBe(`translate(${m.playW}px, 0px)`);
  await receive({ x: 0.5, y: 0.5, h: 99999 });
  expect((await cursor())?.ghost).toBeNull();
  await receive({ x: 0.5, y: 0.5, h: '5' });
  expect((await cursor())?.ghost).toBeNull();
  await receive('junk');
  await receive({ x: 0.1 }); // no y
  expect((await cursor())?.transform).toBe(`translate(${Math.round(m.playW * 0.5)}px, ${Math.round(m.playH * 0.5)}px)`);
  const myId = await page.evaluate(() => window.__laCoop!.session.playerId);
  await receive({ x: 0.2, y: 0.2 }, { id: myId, name: 'Me', color: 0 }); // our own cursor is never drawn
  expect(await cursor(myId)).toBeNull();
});
