// Bundles src/ into the single content script the extension injects.
//   node build.mjs          one-off build
//   node build.mjs --watch  rebuild on change
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Keep the manifest version in sync with package.json.
const manifestPath = 'extension/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'extension/dist/coop.js',
  target: ['chrome111', 'firefox128'],
  loader: { '.css': 'text' },
  define: { __LA_COOP_VERSION__: JSON.stringify(pkg.version) },
  // Readable output: easier to debug, and store reviewers can read it.
  minify: false,
  legalComments: 'inline',
  banner: { js: '/* Little Alchemy Co-op ' + pkg.version + ' (unofficial). Built from src/ with esbuild. */' },
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
