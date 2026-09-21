// Cross-browser end-to-end check: Alice plays in Chrome (Playwright), Bob in
// Firefox (Selenium + geckodriver, extension installed as a temporary add-on).
// Both use real drag and drop on the live game.  Run: npm run test:e2e:firefox
import { Builder, By, type WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import {
  E,
  EXTENSION_DIR,
  launchPlayer,
  closePlayer,
  openGame,
  dismissLoadingScreen,
  combine,
  dragLibraryToWorkspace,
  waitForElement,
  type Player,
} from './helpers.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const step = (label: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`);

async function launchFirefox(): Promise<WebDriver> {
  const options = new firefox.Options();
  if (!process.env.HEADED) options.addArguments('-headless');
  options.windowSize({ width: 1280, height: 800 });
  // Two browsers on one machine: don't hide local addresses behind mDNS names.
  options.setPreference('media.peerconnection.ice.obfuscate_host_addresses', false);
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  await (driver as firefox.Driver).installAddon(EXTENSION_DIR, true);
  return driver;
}

// Runs a function in the page (where the game and the co-op script live).
// Its source is sent to the browser, so it can only use its arguments.
const run = <A extends unknown[], R>(driver: WebDriver, fn: (...args: A) => R, ...args: A): Promise<R> =>
  driver.executeScript<R>(`return (${fn.toString()}).apply(null, arguments)`, ...args);

async function until<A extends unknown[]>(driver: WebDriver, fn: (...args: A) => unknown, args: A, what: string, timeout = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await run(driver, fn, ...args)) return;
    } catch {
      // page still loading
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for ' + what);
}

async function coopUi(driver: WebDriver) {
  const host = await driver.findElement(By.css('#la-coop-root'));
  return host.getShadowRoot();
}

async function firefoxDrag(driver: WebDriver, elementId: number, x: number, y: number): Promise<void> {
  const img = await driver.findElement(By.css(`#library > .element[data-elementid="${elementId}"] img`));
  await driver.actions({ async: true }).move({ origin: img }).press().move({ x, y, duration: 400 }).release().perform();
}

async function firefoxCombine(driver: WebDriver, a: number, b: number, x = 520, y = 420): Promise<void> {
  await firefoxDrag(driver, a, x, y);
  await sleep(200);
  await firefoxDrag(driver, b, x, y);
}

const alice: Player = await launchPlayer('alice-chrome');
let bob: WebDriver | null = null;
try {
  bob = await launchFirefox();
  step('browsers up');

  await openGame(alice);
  await dismissLoadingScreen(alice.page);
  await bob.get('https://littlealchemy.com/');
  await until(bob, () => window.__laCoop?.panel.available === 'ready', [], 'co-op to start in Firefox', 90_000);
  await run(bob, () => {
    if (document.getElementById('loadingScreen')) window.loadingScreen?.hide();
  });
  await until(bob, () => !document.getElementById('loadingScreen'), [], 'Firefox loading screen');
  step('game open in both browsers');

  // Alice (Chrome) creates a room.
  await alice.page.locator('.pill').click();
  await alice.page.getByRole('button', { name: 'Create room' }).click();
  await alice.page.waitForFunction(() => window.__laCoop?.session.state === 'hosting', null, { timeout: 60_000 });
  const code = ((await alice.page.locator('.room-code').textContent()) ?? '').trim();
  step('Chrome hosts room ' + code);

  // Bob (Firefox) joins through the UI, typing the code.
  let ui = await coopUi(bob);
  await (await ui.findElement(By.css('.pill'))).click();
  await (await ui.findElement(By.css('.code-input'))).sendKeys(code);
  await (await ui.findElement(By.css('.code-input + button'))).click();
  await until(bob, () => window.__laCoop?.session.state === 'connected', [], 'Firefox to connect');
  await alice.page.waitForFunction(() => window.__laCoop?.session.members.length === 2, null, { timeout: 30_000 });
  step('Firefox joined');

  // Chrome -> Firefox.
  await combine(alice.page, E.water, E.fire);
  await waitForElement(alice.page, E.steam);
  await until(bob, (id: number) => window.game.progress.includes(id), [E.steam], 'steam to reach Firefox', 30_000);
  const toast = await run(bob, () => document.getElementById('la-coop-root')?.shadowRoot?.querySelector('.toast')?.textContent ?? null);
  if (!toast?.includes('discovered steam')) throw new Error('No toast in Firefox, got: ' + toast);
  step('steam made in Chrome showed up in Firefox (toast: "' + toast + '")');

  // Firefox -> Chrome, by real drag and drop in Firefox.
  await firefoxCombine(bob, E.fire, E.earth);
  await until(bob, (id: number) => window.game.progress.includes(id), [E.lava], 'lava to be made in Firefox', 15_000);
  await waitForElement(alice.page, E.lava);
  step('lava made in Firefox showed up in Chrome');

  // The shared canvas works both ways.
  await dragLibraryToWorkspace(alice.page, E.air, 300, 250);
  await until(
    bob,
    () => [...document.querySelectorAll('#workspace > .element[data-coop-oid]')].some((n) => n.getAttribute('data-elementid') === '4'),
    [],
    'air on the Firefox canvas',
    15_000,
  );
  await firefoxDrag(bob, E.water, 300, 600);
  await alice.page.waitForFunction(
    () => [...document.querySelectorAll('#workspace > .element[data-coop-oid]')].some((n) => n.getAttribute('data-elementid') === '1'),
    null,
    { timeout: 15_000 },
  );
  step('canvas elements placed in either browser appear in the other');

  // Firefox sees Chrome's cursor.
  const aliceId = await alice.page.evaluate(() => window.__laCoop!.session.playerId);
  await alice.page.mouse.move(500, 300);
  await alice.page.mouse.move(520, 320, { steps: 4 });
  await until(
    bob,
    (id: string) => {
      const node = document.getElementById('la-coop-root')?.shadowRoot?.querySelector<HTMLElement>('.cursor[data-player="' + id + '"]');
      return !!node && !node.hidden;
    },
    [aliceId],
    "Chrome's cursor in Firefox",
    15_000,
  );
  step("Chrome's cursor is visible in Firefox");

  // Bob leaves.
  ui = await coopUi(bob);
  await (await ui.findElement(By.css('button.danger'))).click();
  await alice.page.waitForFunction(() => window.__laCoop?.session.members.length === 1, null, { timeout: 30_000 });
  step('Firefox left, Chrome sees 1 player');

  const saves = await Promise.all([
    alice.page.evaluate(() => localStorage.getItem('progress')),
    run(bob, () => localStorage.getItem('progress')),
  ]);
  const pairs = (json: string | null) =>
    (JSON.parse(json ?? '{"parents":[]}') as LAHistory).parents
      .map((p) => Math.min(...p) + '+' + Math.max(...p))
      .sort()
      .join(',');
  if (pairs(saves[0]) !== pairs(saves[1])) throw new Error('Saves differ: ' + pairs(saves[0]) + ' vs ' + pairs(saves[1]));
  step('saves match: ' + pairs(saves[0]));
  console.log('PASS cross-browser');
} catch (err) {
  console.error('FAIL cross-browser:', err);
  process.exitCode = 1;
} finally {
  if (bob) await bob.quit().catch(() => {});
  await closePlayer(alice);
}
