// Renders assets/icon.svg into the extension's PNG icons with the installed
// Chrome: Chromium browsers don't accept SVG icons in the manifest.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { findChrome } from '../test/e2e/helpers.ts';

const SOURCE = 'assets/icon.svg';
const SIZES = [16, 32, 48, 128];
const OUT = 'extension/icons';

const svg = readFileSync(SOURCE).toString('base64');
const browser = await chromium.launch({ executablePath: findChrome() });
try {
    const page = await browser.newPage();
    await page.setContent(
        `<body style="margin: 0"><img src="data:image/svg+xml;base64,${svg}" style="display: block; width: 100vw; height: 100vh"></body>`,
    );
    for (const size of SIZES) {
        await page.setViewportSize({ width: size, height: size });
        await page.screenshot({ path: `${OUT}/icon${size}.png`, omitBackground: true });
        console.log(`wrote ${OUT}/icon${size}.png`);
    }
} finally {
    await browser.close();
}
