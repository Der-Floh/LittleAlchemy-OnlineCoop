// Integration tests for the game adapter: the real Little Alchemy page in
// Chrome with the extension, one player, no networking.
import { test, expect, type Page } from '@playwright/test';
import type { AdapterEvents } from '../../src/game/adapter.ts';
import type { ApplyMeta } from '../../src/net/session.ts';
import {
    E,
    launchPlayer,
    closePlayer,
    openGame,
    resetGame,
    validChain,
    recordEvents,
    recorded,
    progressCounter,
    combine,
    waitForElement,
    savedPairs,
    type Player,
} from '../e2e/helpers.ts';

let player: Player;
let page: Page;

test.beforeAll(async () => {
    player = await launchPlayer('adapter');
    page = player.page;
    await openGame(player);
});

test.afterAll(async () => {
    await closePlayer(player);
});

test.beforeEach(async () => {
    await resetGame(page);
    await recordEvents(page, 'adapter', ['applied', 'local', 'reset']);
});

const REMOTE: ApplyMeta = { by: { id: 'x', name: 'Remote', color: 1 }, sync: false };

const apply = (tuples: unknown[], meta: ApplyMeta = REMOTE) =>
    page.evaluate(([t, m]) => window.__laCoop!.adapter.applyTuples(t, m), [tuples, meta] as const);
const applied = () => recorded<AdapterEvents['applied']>(page, 'applied');
const local = () => recorded<AdapterEvents['local']>(page, 'local');

test('reports the game build and element info', async () => {
    expect(await page.evaluate(() => window.__laCoop!.adapter.getBuild())).toBe('580');
    const steam = await page.evaluate(() => window.__laCoop!.adapter.elementInfo(5));
    expect(steam.name).toBe('steam');
    expect(steam.image).toMatch(/^data:image\/png;base64,/);
});

test('a small batch goes through the game itself: library, counter and save', async () => {
    expect(await progressCounter(page)).toBe('4/580');
    const added = await apply([[E.water, E.fire, 1234]]);
    expect(added).toEqual([[1, 2, 1234]]);
    await waitForElement(page, E.steam);
    expect(await progressCounter(page)).toBe('5/580');
    expect(await savedPairs(page)).toEqual(['1+2']);
    await expect.poll(applied).toHaveLength(1);
    const [event] = await applied();
    expect(event).toMatchObject({ bulk: false, newElements: [E.steam], meta: { sync: false } });
    expect(event?.recipes[0]?.children).toEqual([E.steam]);
    // Remote discoveries are not reported back as local ones.
    expect(await local()).toEqual([]);
});

test('duplicates and pairs that are not recipes are ignored', async () => {
    await apply([[E.water, E.fire, 1]]);
    await waitForElement(page, E.steam);
    expect(await apply([[E.fire, E.water, 2]])).toEqual([]);
    expect(await apply([[E.fire, E.fire, 3]])).toEqual([]); // fire + fire makes nothing
    await page.waitForTimeout(100);
    expect(await savedPairs(page)).toEqual(['1+2']);
    expect(await applied()).toHaveLength(1);
});

test('a big sync is rebuilt in one go, but not while the player is dragging', async () => {
    const chain = await validChain(page, 40);
    expect(chain).toHaveLength(40);
    await page.mouse.move(450, 420);
    await page.mouse.down();
    expect(await apply(chain, { by: { id: 'x', name: 'Remote', color: 1, host: true }, sync: true })).toHaveLength(40);
    await page.waitForTimeout(400);
    expect(await progressCounter(page)).toBe('4/580'); // deferred until the pointer is released
    await page.mouse.up();
    await expect.poll(() => savedPairs(page).then((p) => p.length)).toBe(40);
    const counter = Number((await progressCounter(page))?.split('/')[0]);
    expect(counter).toBeGreaterThan(30);
    const events = await applied();
    expect(events).toHaveLength(1);
    expect(events[0]?.bulk).toBe(true);
    expect(events[0]?.newElements.length).toBe(counter - 4);
    // The library shows exactly the known elements.
    expect(await page.locator('#library > .element').count()).toBe(counter);
});

test('local discoveries by drag and drop are reported once, with new elements', async () => {
    await combine(page, E.water, E.fire);
    await waitForElement(page, E.steam);
    await expect.poll(local).toHaveLength(1);
    const [event] = await local();
    expect(event?.tuple.slice(0, 2)).toEqual([1, 2]);
    expect(event?.children).toEqual([E.steam]);
    expect(event?.newElements).toEqual([E.steam]);
    expect(await page.evaluate(() => window.__laCoop!.adapter.getTuples().length)).toBe(1);

    // Making the same recipe again is not a new discovery.
    await combine(page, E.water, E.fire, { x: 300, y: 300 });
    await page.waitForTimeout(300);
    expect(await local()).toHaveLength(1);
});

test('the pre-co-op backup restores the old save, library and counter', async () => {
    await apply([[E.water, E.earth, 1]]); // mud
    await waitForElement(page, E.mud);
    expect(await page.evaluate(() => window.__laCoop!.adapter.ensureBackup())).toBe(true);
    expect(await page.evaluate(() => window.__laCoop!.adapter.ensureBackup())).toBe(false); // only once
    const info = await page.evaluate(() => window.__laCoop!.adapter.backupInfo());
    expect(info?.count).toBe(5);

    await apply([[E.water, E.fire, 2]]); // steam
    await waitForElement(page, E.steam);
    await page.evaluate(() => window.__laCoop!.adapter.restoreBackup());
    expect(await savedPairs(page)).toEqual(['1+3']);
    expect(await progressCounter(page)).toBe('5/580');
    expect(await page.locator(`#library > .element[data-elementid="${E.steam}"]`).count()).toBe(0);
    expect(await page.evaluate(() => window.__laCoop!.adapter.getTuples().map((t) => t[0] + '+' + t[1]))).toEqual(['1+3']);
    expect((await recorded<AdapterEvents['reset']>(page, 'reset')).map((e) => e.reason)).toEqual(['backup-restored']);

    await page.evaluate(() => window.__laCoop!.adapter.discardBackup());
    expect(await page.evaluate(() => window.__laCoop!.adapter.backupInfo())).toBeNull();
});

test("the game's own reset empties the co-op state too", async () => {
    await apply([[E.water, E.fire, 1]]);
    await waitForElement(page, E.steam);
    await page.evaluate(() => window.game.resetProgress());
    expect(await page.evaluate(() => window.__laCoop!.adapter.getTuples())).toEqual([]);
    expect((await recorded<AdapterEvents['reset']>(page, 'reset')).map((e) => e.reason)).toEqual(['game-reset']);
    expect(await progressCounter(page)).toBe('4/580');
});
