// Builds the extension into dist/: copies public/, writes the manifest with
// package.json's version, renders the icons and bundles src/ into the content script.
//   node build.ts          one-off build
//   node build.ts --watch  rebuild on change (with inline source maps)
import * as esbuild from 'esbuild';
import { Resvg } from '@resvg/resvg-js';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const outDir = 'dist';
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const watch = process.argv.includes('--watch');

// A browser with dist/ loaded as an unpacked extension can hold its icons open,
// and rewriting even an unchanged one then fails.
function writeIfChanged(file: string, data: Buffer): void {
    if (existsSync(file) && readFileSync(file).equals(data)) return;
    writeFileSync(file, data);
}

cpSync('public', outDir, { recursive: true });
const template = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as { icons: Record<string, string> };
const manifest = { ...template, version: pkg.version };
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');

// Chromium browsers take no SVG icons, so render each PNG the manifest lists from the SVG.
const iconSvg = readFileSync('assets/icon.svg');
for (const [size, file] of Object.entries(manifest.icons)) {
    const target = join(outDir, file);
    const png = new Resvg(iconSvg, { fitTo: { mode: 'width', value: Number(size) } }).render().asPng();
    mkdirSync(dirname(target), { recursive: true });
    writeIfChanged(target, png);
}

const options: esbuild.BuildOptions = {
    entryPoints: ['src/main.ts'],
    bundle: true,
    format: 'iife',
    outfile: join(outDir, 'coop.js'),
    target: ['chrome111', 'firefox128'],
    loader: { '.css': 'text' },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { __LA_COOP_VERSION__: JSON.stringify(pkg.version) },
    // Readable output: easier to debug, and store reviewers can read it.
    minify: false,
    legalComments: 'inline',
    sourcemap: watch ? 'inline' : false,
    banner: { js: '/* Little Alchemy Co-op ' + pkg.version + '. Built from src/ with esbuild. */' },
    logLevel: 'info',
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
} else {
    await esbuild.build(options);
}
