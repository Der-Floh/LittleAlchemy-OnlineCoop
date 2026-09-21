// Dev tool: opens the game with the extension in Chromium and saves
// screenshots of the co-op UI.  Usage: node scripts/ui-preview.mjs <outDir>
import path from 'node:path';
import fs from 'node:fs';
import { launchPlayer, closePlayer, openGame, dismissLoadingScreen } from '../test/e2e/helpers.mjs';

const out = path.resolve(process.argv[2] || 'test-results/ui-preview');
fs.mkdirSync(out, { recursive: true });

const player = await launchPlayer('preview');
try {
  const { page } = player;
  await openGame(player);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, '0-loading.png') });
  await dismissLoadingScreen(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, '1-pill.png') });

  await page.locator('.pill').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, '2-lobby.png') });

  await page.locator('.panel button[title="Settings"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, '3-settings.png') });
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  await page.locator('.panel button', { hasText: 'Create room' }).click();
  await page.waitForFunction(() => window.__laCoop.session.state === 'hosting', null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '4-hosting.png') });

  await page.evaluate(() => {
    const { panel } = window.__laCoop;
    panel.toast({ image: window.__laCoop.adapter.elementInfo(5).image, parts: [{ who: { name: 'Bob', color: 1 } }, ' discovered ', { el: 'steam', bold: true }] });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, '5-toast.png') });

  await page.evaluate(() => {
    document.body.className += ' nightMode';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '6-night.png') });
  console.log('screenshots in', out);
} finally {
  await closePlayer(player);
}
