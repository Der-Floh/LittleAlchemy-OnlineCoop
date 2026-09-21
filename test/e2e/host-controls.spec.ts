// End-to-end: host controls (lock, hand over, kick) with three real Chrome
// profiles on the live game, connected through the public PeerJS broker.
import { test, expect, type Page } from '@playwright/test';
import { launchPlayer, closePlayer, openGame, dismissLoadingScreen } from './helpers.ts';

const state = (page: Page) => page.evaluate(() => window.__laCoop!.session.state);
const playerId = (page: Page) => page.evaluate(() => window.__laCoop!.session.playerId);
const memberCount = (page: Page) => page.evaluate(() => window.__laCoop!.session.members.length);

async function openPanel(page: Page): Promise<void> {
  if (!(await page.locator('section.panel').isVisible())) await page.locator('.pill').click();
}

async function join(page: Page, code: string): Promise<void> {
  await openPanel(page);
  await page.locator('.code-input').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
}

async function hostAction(page: Page, targetId: string, label: string): Promise<void> {
  await openPanel(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator(`.players li[data-player="${targetId}"] button`, { hasText: label }).click();
}

test('lock, hand over and kick', async () => {
  const [alice, bob, carol] = await Promise.all([launchPlayer('alice'), launchPlayer('bob'), launchPlayer('carol')]);
  try {
    await Promise.all([openGame(alice), openGame(bob), openGame(carol)]);
    await Promise.all([alice, bob, carol].map((p) => dismissLoadingScreen(p.page)));
    const [bobId, carolId] = await Promise.all([playerId(bob.page), playerId(carol.page)]);

    await openPanel(alice.page);
    await alice.page.getByRole('button', { name: 'Create room' }).click();
    await expect.poll(() => state(alice.page)).toBe('hosting');
    const code = ((await alice.page.locator('.room-code').textContent()) ?? '').trim();
    await join(bob.page, code);
    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('connected');

    // Only the host sees the controls.
    await expect(alice.page.getByRole('button', { name: 'Lock room' })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Lock room' })).toBeHidden();
    await expect(bob.page.locator('.players li button')).toHaveCount(0);

    // Locked: Carol is turned away, and everyone sees the lock.
    await alice.page.getByRole('button', { name: 'Lock room' }).click();
    await expect(bob.page.locator('.lock-badge')).toBeVisible();
    await join(carol.page, code);
    await expect.poll(() => state(carol.page), { timeout: 60_000 }).toBe('rejected');
    await expect(carol.page.locator('.banner')).toContainText('locked by its host');

    // Unlocked: Carol gets in.
    await alice.page.getByRole('button', { name: 'Unlock room' }).click();
    await join(carol.page, code);
    await expect.poll(() => state(carol.page), { timeout: 60_000 }).toBe('connected');
    await expect.poll(() => memberCount(alice.page)).toBe(3);

    // Alice hands the room to Bob; everyone follows him.
    await hostAction(alice.page, bobId, 'Make host');
    await expect.poll(() => state(bob.page), { timeout: 60_000 }).toBe('hosting');
    await expect.poll(() => state(alice.page), { timeout: 60_000 }).toBe('connected');
    await expect.poll(() => state(carol.page), { timeout: 60_000 }).toBe('connected');
    for (const p of [alice, bob, carol]) await expect.poll(() => memberCount(p.page), { timeout: 30_000 }).toBe(3);
    await expect(carol.page.locator('.feed')).toContainText('is now the host');
    await expect(bob.page.getByRole('button', { name: 'Lock room' })).toBeVisible();

    // Bob kicks Carol: she's out and can't come back while the room is open.
    await hostAction(bob.page, carolId, 'Kick');
    await expect.poll(() => state(carol.page), { timeout: 30_000 }).toBe('rejected');
    await expect(carol.page.locator('.banner')).toContainText('The host removed you from this room');
    await expect.poll(() => memberCount(alice.page)).toBe(2);
    await expect(alice.page.locator('.feed')).toContainText('was removed by the host');
    await join(carol.page, code);
    await expect.poll(() => carol.page.evaluate(() => window.__laCoop!.session.state), { timeout: 60_000 }).toBe('rejected');
    await expect(carol.page.locator('.banner')).toContainText('The host removed you from this room');
  } finally {
    await Promise.all([closePlayer(alice), closePlayer(bob), closePlayer(carol)]);
  }
});
