// Bundles src/ into the single content script the extension injects.
//   node build.ts          one-off build
//   node build.ts --watch  rebuild on change (with inline source maps)
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const watch = process.argv.includes('--watch');

// Keep the manifest version in sync with package.json.
const manifestPath = 'extension/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const options: esbuild.BuildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'extension/dist/coop.js',
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
