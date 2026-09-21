// Shared helpers for the end-to-end tests: a real Chrome with the unpacked
// extension, the live littlealchemy.com, and the public PeerJS broker.
//
// Branded Chrome ignores --load-extension since v137, so each player gets its
// own throwaway Chrome profile and the extension is loaded through the
// DevTools protocol (Extensions.loadUnpacked, enabled by
// --enable-unsafe-extension-debugging). Set CHROME_PATH to use another
// Chromium-based browser.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const EXTENSION_DIR = path.resolve('extension');
const PROFILES_DIR = path.resolve('.e2e-profiles');

// Element ids in Little Alchemy classic (build 580).
export const E = { water: 1, fire: 2, earth: 3, air: 4, steam: 5, lava: 6, pressure: 7, sea: 9, energy: 11, mud: 12, rain: 13, dust: 14 };

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('No Chrome found; set CHROME_PATH');
  return found;
}

async function waitForFile(file, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\n')) return text;
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome did not start (no ' + path.basename(file) + ')');
}

export async function launchPlayer(name, { headless = !process.env.HEADED } = {}) {
  const dir = path.join(PROFILES_DIR, name + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(
    findChrome(),
    [
      `--user-data-dir=${dir}`,
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      // Two browsers on one machine: skip mDNS host-candidate obfuscation.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--window-size=1280,800',
      ...(headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const [port] = (await waitForFile(path.join(dir, 'DevToolsActivePort'), 30_000)).split('\n');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 800 });
  const logs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(`${msg.type()}: ${text}`);
    if (msg.type() === 'error' || text.includes('la-coop')) console.log(`[${name}] ${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror: ${err.message}`));
  return { name, browser, context, page, dir, logs, proc };
}

export async function closePlayer(player) {
  if (!player) return;
  await player.browser.close().catch(() => {});
  player.proc.kill();
  await new Promise((resolve) => (player.proc.exitCode !== null ? resolve() : player.proc.once('exit', resolve)));
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(player.dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300)); // Windows keeps files locked briefly
    }
  }
}

// Opens the game and waits until the co-op script has attached to it.
export async function openGame(player, { url = 'https://littlealchemy.com/' } = {}) {
  await player.page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForCoop(player.page);
}

export async function waitForCoop(page) {
  await page.waitForFunction(() => window.__laCoop && window.__laCoop.session, null, { timeout: 90_000 });
  // The tab guard needs a moment to decide this tab is the active one.
  await page.waitForFunction(() => window.__laCoop.panel.available === 'ready', null, { timeout: 10_000 });
}

export async function dismissLoadingScreen(page) {
  await page.evaluate(() => {
    if (document.getElementById('loadingScreen')) window.loadingScreen.hide();
  });
  await page.waitForSelector('#loadingScreen', { state: 'detached', timeout: 10_000 });
}

// Seeds the game's own save with recipe pairs, then reloads.
export async function seedProgress(page, pairs) {
  await page.evaluate((list) => {
    localStorage.setItem('progress', JSON.stringify({ parents: list, date: list.map((_, i) => 1_600_000_000_000 + i) }));
  }, pairs);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForCoop(page);
}

export async function dragLibraryToWorkspace(page, elementId, x, y) {
  const img = page.locator(`#library > .element[data-elementid="${elementId}"] img`);
  const box = await img.boundingBox();
  if (!box) throw new Error(`Element ${elementId} is not visible in the library`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.up();
}

// Drags an element that is already on the canvas (found by its co-op id).
export async function dragCanvasElement(page, oid, x, y) {
  const img = page.locator(`#workspace > .element[data-coop-oid="${oid}"] img`);
  const box = await img.boundingBox();
  if (!box) throw new Error(`Canvas element ${oid} is not visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.up();
}

// Canvas elements as {oid, el, left, top, held}, read from the page.
export const canvasElements = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#workspace > .element[data-elementtype="workspaceBox"]')].map((node) => ({
      oid: node.dataset.coopOid || null,
      el: Number(node.getAttribute('data-elementid')),
      left: parseFloat(node.style.left),
      top: parseFloat(node.style.top),
      held: node.dataset.coopHeld === '1',
      visible: node.style.visibility !== 'hidden' && node.style.display !== 'none',
    })),
  );

// Combines two library elements the way a player does: drag the first onto
// the workspace, then drag the second on top of it.
export async function combine(page, idA, idB, { x = 520, y = 420 } = {}) {
  await dragLibraryToWorkspace(page, idA, x, y);
  await page.waitForTimeout(200);
  await dragLibraryToWorkspace(page, idB, x, y);
}

export const hasElement = (page, id) => page.evaluate((el) => window.game.progress.includes(el), id);

export async function waitForElement(page, id, timeout = 20_000) {
  await page.waitForFunction((el) => window.game.progress.includes(el), id, { timeout });
  await page.waitForSelector(`#library > .element[data-elementid="${id}"]`, { state: 'attached', timeout: 5_000 });
}

// Wipes the game's and the co-op script's saved state and reloads a fresh game.
export async function resetGame(page) {
  await page.evaluate(() => {
    // The game saves canvas positions on unload; don't let that undo the reset.
    if (window.workspace) window.removeEventListener('beforeunload', window.workspace.save, false);
    localStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForCoop(page);
  await dismissLoadingScreen(page);
}

// A causally valid list of recipe tuples: each pair's parents are primes or
// results of earlier pairs, like a real playthrough.
export const validChain = (page, count) =>
  page.evaluate((n) => {
    const have = new Set(window.game.prime);
    const done = new Set();
    const out = [];
    let grew = true;
    while (grew && out.length < n) {
      grew = false;
      for (const id of Object.keys(window.bases.base)) {
        const base = window.bases.base[id];
        if (!base.parents || base.hidden) continue;
        for (const p of base.parents) {
          const a = Math.min(p[0], p[1]);
          const b = Math.max(p[0], p[1]);
          if (done.has(a + '+' + b) || !have.has(a) || !have.has(b)) continue;
          done.add(a + '+' + b);
          out.push([a, b, 1_600_000_000_000 + out.length]);
          for (const child of window.workspace.sex([a, b])) have.add(child);
          grew = true;
          if (out.length >= n) break;
        }
        if (out.length >= n) break;
      }
    }
    return out;
  }, count);

// Records events of a co-op module (window.__laCoop[target]) into
// window.__rec[type], so tests can read them with recorded().
export const recordEvents = (page, target, types) =>
  page.evaluate(
    ([name, list]) => {
      window.__rec = window.__rec || {};
      for (const type of list) {
        window.__rec[type] = [];
        window.__laCoop[name].on(type, (payload) => window.__rec[type].push(JSON.parse(JSON.stringify(payload))));
      }
    },
    [target, types],
  );

export const recorded = (page, type) => page.evaluate((t) => (window.__rec && window.__rec[t]) || [], type);

export const progressCounter = (page) => page.evaluate(() => document.getElementById('progress').textContent);

export const coopState = (page) =>
  page.evaluate(() => ({
    state: window.__laCoop.session.state,
    role: window.__laCoop.session.role,
    code: window.__laCoop.session.code,
    members: window.__laCoop.session.members.map((m) => m.name),
  }));

export const savedPairs = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('progress'))
      .parents.map((p) => Math.min(p[0], p[1]) + '+' + Math.max(p[0], p[1]))
      .sort(),
  );
