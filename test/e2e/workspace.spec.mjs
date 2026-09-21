// End-to-end: the shared canvas, live cursors and the while-you-were-away
// card, with two real Chrome profiles on the live game, connected through the
// public PeerJS broker.
import { test, expect } from '@playwright/test';
import {
  E,
  launchPlayer,
  closePlayer,
  openGame,
  dismissLoadingScreen,
  dragLibraryToWorkspace,
  dragCanvasElement,
  canvasElements,
  waitForElement,
} from './helpers.mjs';

const state = (page) => page.evaluate(() => window.__laCoop.session.state);
const els = async (page) => (await canvasElements(page)).map((e) => e.el).sort((a, b) => a - b);
const byEl = async (page, el) => (await canvasElements(page)).find((e) => e.el === el);

async function createRoom(page) {
  await page.locator('.pill').click();
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect.poll(() => state(page)).toBe('hosting');
  return (await page.locator('.room-code').textContent()).trim();
}

async function joinRoom(page, code) {
  if (!(await page.locator('.code-input').isVisible())) await page.locator('.pill').click();
  await page.locator('.code-input').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect.poll(() => state(page), { timeout: 60_000 }).toBe('connected');
}

test('the canvas, cursors and catch-up summary are shared', async () => {
  const alice = await launchPlayer('alice');
  const bob = await launchPlayer('bob');
  try {
    await Promise.all([openGame(alice), openGame(bob)]);
    await Promise.all([dismissLoadingScreen(alice.page), dismissLoadingScreen(bob.page)]);

    // Bob has something lying on his own canvas; joining replaces it with the room's.
    await dragLibraryToWorkspace(bob.page, E.air, 300, 600);
    await dragLibraryToWorkspace(alice.page, E.water, 450, 400);
    const code = await createRoom(alice.page);
    await joinRoom(bob.page, code);
    await expect.poll(() => els(bob.page)).toEqual([E.water]);

    // Same window size, so the water sits at the same spot for both.
    const aliceWater = await byEl(alice.page, E.water);
    const bobWater = await byEl(bob.page, E.water);
    expect(Math.abs(aliceWater.left - bobWater.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(aliceWater.top - bobWater.top)).toBeLessThanOrEqual(1);

    // Bob drags it: while he holds it, Alice sees it marked with his name.
    const img = bob.page.locator(`#workspace > .element[data-coop-oid="${bobWater.oid}"] img`);
    const box = await img.boundingBox();
    await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await bob.page.mouse.down();
    await bob.page.mouse.move(650, 300, { steps: 12 });
    await expect(alice.page.locator(`#workspace > .element[data-coop-oid="${aliceWater.oid}"]`)).toHaveAttribute(
      'data-coop-holder',
      /Alchemist \d+/,
    );
    await bob.page.mouse.move(700, 250, { steps: 5 });
    await bob.page.mouse.up();
    await expect.poll(async () => (await byEl(alice.page, E.water)).held).toBe(false);
    const movedBob = await byEl(bob.page, E.water);
    await expect
      .poll(async () => Math.abs((await byEl(alice.page, E.water)).left - movedBob.left))
      .toBeLessThanOrEqual(1);

    // Bob combines fire (from his library) with the water: steam for both.
    await dragLibraryToWorkspace(bob.page, E.fire, movedBob.left + 37, movedBob.top + 37);
    await expect.poll(() => els(alice.page)).toEqual([E.steam]);
    await waitForElement(alice.page, E.steam);

    // Clear removes only your own elements.
    await dragLibraryToWorkspace(alice.page, E.air, 250, 250);
    await dragLibraryToWorkspace(bob.page, E.earth, 250, 550);
    await expect.poll(() => els(alice.page)).toEqual([E.earth, E.air, E.steam].sort((a, b) => a - b));
    await expect.poll(() => els(bob.page)).toEqual([E.earth, E.air, E.steam].sort((a, b) => a - b));
    await alice.page.locator('#clearWorkspace').click();
    await expect.poll(() => els(bob.page)).toEqual([E.earth, E.steam].sort((a, b) => a - b));
    await expect.poll(() => els(alice.page)).toEqual([E.earth, E.steam].sort((a, b) => a - b));
    await expect(bob.page.locator('.feed')).toContainText('cleared their elements');

    // Live cursors: Bob sees Alice's pointer.
    const aliceId = await alice.page.evaluate(() => window.__laCoop.session.playerId);
    await alice.page.mouse.move(400, 300);
    await alice.page.mouse.move(420, 320, { steps: 4 });
    const bobSees = bob.page.locator(`.cursor[data-player="${aliceId}"]`);
    await expect(bobSees).toBeVisible();
    await expect(bobSees.locator('.name')).toHaveText(/Alchemist \d+/);

    // Bob leaves; Alice keeps discovering; Bob comes back to a summary.
    await bob.page.getByRole('button', { name: 'Leave room' }).click();
    await expect.poll(() => state(bob.page)).toBe('idle');
    await dragLibraryToWorkspace(alice.page, E.earth, 600, 500);
    await dragLibraryToWorkspace(alice.page, E.air, 600, 500); // dust
    await waitForElement(alice.page, E.dust);
    await joinRoom(bob.page, code);
    const card = bob.page.locator('.away');
    await expect(card).toBeVisible();
    await expect(card.locator('.away-title')).toContainText('While you were away');
    await expect(card.locator('.away-item')).toHaveText(['dust']);
    await expect.poll(() => els(bob.page)).toEqual(await els(alice.page));
  } finally {
    await closePlayer(alice);
    await closePlayer(bob);
  }
});
