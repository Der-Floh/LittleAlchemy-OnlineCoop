// Integration tests for live cursors on the real game page: how other
// players' cursors are drawn, and what our own pointer sends. No network: the
// session's sendApp is replaced by a recorder.
import { test, expect } from '@playwright/test';
import { E, launchPlayer, closePlayer, openGame, resetGame } from '../e2e/helpers.mjs';

const BOB = { id: 'bob', name: 'Bob', color: 1 };
let player;
let page;

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
    const { cursors, session } = window.__laCoop;
    window.__sent = [];
    session.sendApp = (k, d) => {
      window.__sent.push([k, d]);
      return true;
    };
    cursors._connected = () => true;
    cursors.start();
  });
});

const receive = (d, by = BOB) => page.evaluate(([b, data]) => window.__laCoop.cursors.receive(b, data), [by, d]);
const cursor = (id = 'bob') =>
  page.evaluate((pid) => {
    const node = document.getElementById('la-coop-root').shadowRoot.querySelector(`.cursor[data-player="${pid}"]`);
    if (!node) return null;
    const ghost = node.querySelector('.ghost');
    return {
      hidden: node.hidden,
      transform: node.style.transform,
      name: node.querySelector('.name').textContent,
      color: node.querySelector('path').getAttribute('fill'),
      ghost: ghost.hidden ? null : ghost.getAttribute('src'),
    };
  }, id);
const metrics = () => page.evaluate(() => window.__laCoop.bridge.metrics());
const sent = () => page.evaluate(() => window.__sent.filter(([k]) => k === 'cur').map(([, d]) => d));

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
  expect((await cursor()).ghost).toMatch(/^data:image\/png;base64,/);
  await receive({ x: 0.31, y: 0.3 });
  expect((await cursor()).ghost).toBeNull();
  await receive({ off: true });
  expect((await cursor()).hidden).toBe(true);
  await receive({ x: 2, y: 'nope' }); // junk is ignored
  expect((await cursor()).hidden).toBe(true);
});

test('our pointer is sent in shared coordinates, and "off" over the library', async () => {
  const m = await metrics();
  await page.mouse.move(300, 200);
  await expect.poll(async () => (await sent()).at(-1)).toEqual({
    x: Math.round((300 / m.playW) * 10000) / 10000,
    y: Math.round((200 / m.playH) * 10000) / 10000,
  });
  await page.mouse.move(m.playW + 60, 300); // over the library
  await expect.poll(async () => (await sent()).at(-1)).toEqual({ off: true });
});

test('while dragging from the library, our cursor carries that element', async () => {
  const img = page.locator(`#library > .element[data-elementid="${E.fire}"] img`);
  const box = await img.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 12 });
  await expect.poll(async () => (await sent()).at(-1).h).toBe(E.fire);
  await page.mouse.up();
  await page.mouse.move(430, 390);
  await expect.poll(async () => 'h' in (await sent()).at(-1)).toBe(false);
});

test('turning cursors off removes them and ignores new ones', async () => {
  await receive({ x: 0.5, y: 0.5 });
  await page.evaluate(() => window.__laCoop.cursors.setEnabled(false));
  expect(await cursor()).toBeNull();
  await receive({ x: 0.6, y: 0.6 });
  expect(await cursor()).toBeNull();
});
