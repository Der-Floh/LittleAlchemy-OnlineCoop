// End-to-end: two real Chrome profiles with the extension play together on
// the live littlealchemy.com, connected through the public PeerJS broker.
import { test, expect } from '@playwright/test';
import {
  E,
  launchPlayer,
  closePlayer,
  openGame,
  waitForCoop,
  dismissLoadingScreen,
  seedProgress,
  combine,
  waitForElement,
  savedPairs,
} from './helpers.mjs';

const t0 = Date.now();
const mark = (label) => console.log('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + label);
const state = (page) => page.evaluate(() => window.__laCoop.session.state);

test('two players share discoveries live, survive a reload and a host change', async () => {
  const alice = await launchPlayer('alice');
  const bob = await launchPlayer('bob');
  try {
    await Promise.all([openGame(alice), openGame(bob)]);

    mark('launched + game open');
    // Bob already played a little on his own: mud (water + earth) and dust (earth + air).
    await seedProgress(bob.page, [
      [E.water, E.earth],
      [E.earth, E.air],
    ]);
    await Promise.all([dismissLoadingScreen(alice.page), dismissLoadingScreen(bob.page)]);

    mark('seeded + loading screens gone');
    // Alice creates a room.
    await alice.page.locator('.pill').click();
    await alice.page.getByRole('button', { name: 'Create room' }).click();
    await expect.poll(() => state(alice.page)).toBe('hosting');
    const code = (await alice.page.locator('.room-code').textContent()).trim();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    mark('room created');
    // Bob types the code with real key presses, fixes a typo with Backspace,
    // and joins. The game's type-to-search must not swallow the keys.
    await bob.page.locator('.pill').click();
    const input = bob.page.locator('.code-input');
    await input.click();
    await bob.page.keyboard.type(code.toLowerCase() + 'q');
    await bob.page.keyboard.press('Backspace');
    await expect(input).toHaveValue(code.toLowerCase());
    await expect(bob.page.locator('#searchBar')).toHaveAttribute('type', 'hidden');
    await bob.page.getByRole('button', { name: 'Join', exact: true }).click();

    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('connected');
    await expect(alice.page.locator('.players li')).toHaveCount(2);
    await expect(bob.page.locator('.players li')).toHaveCount(2);

    mark('bob connected');
    // Bob's solo progress was merged into Alice's game and save.
    await waitForElement(alice.page, E.mud);
    await waitForElement(alice.page, E.dust);
    await expect.poll(() => savedPairs(alice.page)).toEqual(['1+3', '3+4']);
    await expect(alice.page.locator('.feed')).toContainText('shared their progress');

    mark('merge verified');
    // Alice combines water + fire by drag and drop: steam appears for Bob.
    await combine(alice.page, E.water, E.fire);
    await waitForElement(alice.page, E.steam);
    await waitForElement(bob.page, E.steam);
    await expect(bob.page.locator('.toast').first()).toContainText('discovered steam');
    await expect(bob.page.locator('.feed')).toContainText('water + fire → steam');

    mark('steam synced');
    // Bob combines fire + earth: lava appears for Alice.
    await combine(bob.page, E.fire, E.earth);
    await waitForElement(bob.page, E.lava);
    await waitForElement(alice.page, E.lava);

    mark('lava synced');
    // Bob reloads the page: he rejoins on his own and keeps receiving.
    await bob.page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCoop(bob.page);
    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('connected');
    await dismissLoadingScreen(bob.page);
    await combine(alice.page, E.air, E.fire);
    await waitForElement(alice.page, E.energy);
    await waitForElement(bob.page, E.energy);

    mark('bob rejoined after reload + energy synced');
    // Alice leaves: Bob becomes the host and keeps playing.
    await alice.page.getByRole('button', { name: 'Leave room' }).click();
    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('hosting');
    await combine(bob.page, E.water, E.water);
    await waitForElement(bob.page, E.sea);

    mark('bob hosting after alice left + sea made');
    // Alice comes back and catches up on what she missed.
    await alice.page.locator('.code-input').fill(code);
    await alice.page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect.poll(() => state(alice.page), { timeout: 60_000 }).toBe('connected');
    await waitForElement(alice.page, E.sea);

    mark('alice rejoined + caught up');
    // Both saves hold exactly the same recipes.
    await expect.poll(async () => JSON.stringify(await savedPairs(alice.page))).toBe(JSON.stringify(await savedPairs(bob.page)));
    expect(await savedPairs(bob.page)).toEqual(['1+1', '1+2', '1+3', '2+3', '2+4', '3+4']);
  } finally {
    await closePlayer(alice);
    await closePlayer(bob);
  }
});

test('invite links, one co-op tab per browser, and restoring the pre-co-op backup', async () => {
  const alice = await launchPlayer('alice');
  const bob = await launchPlayer('bob');
  try {
    await Promise.all([openGame(alice), openGame(bob)]);
    await seedProgress(alice.page, [[E.water, E.fire]]); // steam
    await seedProgress(bob.page, [[E.water, E.earth]]); // mud
    await dismissLoadingScreen(alice.page);

    mark('T2 seeded');
    await alice.page.locator('.pill').click();
    await alice.page.getByRole('button', { name: 'Create room' }).click();
    await expect.poll(() => state(alice.page)).toBe('hosting');
    const code = (await alice.page.locator('.room-code').textContent()).trim();

    mark('T2 room created');
    // Bob opens the invite link in a fresh page load: the panel opens with a
    // one-click join, and the link is cleaned up.
    await bob.page.goto('about:blank');
    await bob.page.goto('https://littlealchemy.com/#coop=' + code, { waitUntil: 'domcontentloaded' });
    await waitForCoop(bob.page);
    expect(await bob.page.evaluate(() => location.hash)).toBe('');
    await expect(bob.page.locator('.code-input')).toHaveValue(code);
    await dismissLoadingScreen(bob.page);
    mark('T2 invite banner ok');
    await bob.page.getByRole('button', { name: 'Join ' + code }).click();
    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('connected');
    await waitForElement(bob.page, E.steam);
    await waitForElement(alice.page, E.mud);

    mark('T2 bob joined via invite');
    // A second Little Alchemy tab in Bob's browser stays passive until asked to take over.
    const second = await bob.context.newPage();
    mark('T2 second page created');
    await second.goto('https://littlealchemy.com/', { waitUntil: 'domcontentloaded' });
    await second.waitForFunction(() => window.__laCoop && window.__laCoop.panel.available === 'passive', null, { timeout: 90_000 });
    mark('T2 second passive');
    await expect(second.locator('.banner')).toContainText('already running in another Little Alchemy tab');
    await second.locator('.pill').click();
    await second.getByRole('button', { name: 'Use co-op in this tab' }).click();
    await expect.poll(() => state(second), { timeout: 60_000 }).toBe('connected');
    await expect.poll(() => state(bob.page)).toBe('idle');
    await expect(bob.page.locator('.banner')).toContainText('moved to another Little Alchemy tab');
    await expect(alice.page.locator('.players li')).toHaveCount(2);

    mark('T2 takeover done');
    // An invite link pasted into an open game tab (hash change, no reload) is noticed too.
    await second.goto('https://littlealchemy.com/#coop=ABCDEF');
    await expect(second.locator('.banner')).toBeVisible();
    await expect(second.locator('.banner')).toContainText('invited to co-op room ABCDEF');
    await expect.poll(() => second.evaluate(() => location.hash)).toBe('');
    await second.close();

    mark('T2 hashchange invite ok');
    // Back in the first tab: take over again, leave, and restore the backup
    // taken just before Bob's first merge (only mud, no steam).
    await bob.page.getByRole('button', { name: 'Use co-op in this tab' }).click();
    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('connected');
    await bob.page.getByRole('button', { name: 'Leave room' }).click();
    await expect.poll(() => state(bob.page)).toBe('idle');
    mark('T2 left room');
    bob.page.once('dialog', (dialog) => dialog.accept());
    await bob.page.locator('.panel button[title="Settings"]').click();
    await bob.page.getByRole('button', { name: 'Restore backup' }).click();
    await expect(bob.page.locator('.banner')).toContainText('Backup restored');
    expect(await savedPairs(bob.page)).toEqual(['1+3']);
    expect(await bob.page.evaluate(() => [window.game.progress.includes(5), window.game.progress.includes(12)])).toEqual([false, true]);
    expect(await bob.page.locator('#library > .element[data-elementid="5"]').count()).toBe(0);
  } finally {
    await closePlayer(alice);
    await closePlayer(bob);
  }
});
