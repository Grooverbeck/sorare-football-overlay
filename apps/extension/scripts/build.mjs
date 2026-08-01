import 'dotenv/config';
import { context } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const targetFlag = process.argv.find((argument) =>
  argument.startsWith('--target='),
);
const targetOptionIndex = process.argv.indexOf('--target');
const targetValue = targetFlag
  ? targetFlag.slice('--target='.length)
  : targetOptionIndex >= 0
    ? process.argv[targetOptionIndex + 1]
    : undefined;
const target = targetValue ?? 'chromium';
if (target !== 'chromium' && target !== 'firefox') {
  throw new Error(`Unknown extension target: ${target}`);
}

const targetConfig = {
  chromium: {
    manifest: 'chromium.json',
    outdir: 'dist',
    backgroundEntryName: 'service-worker',
    esbuildTarget: ['chrome120', 'edge120'],
  },
  firefox: {
    manifest: 'firefox.json',
    outdir: 'dist-firefox',
    backgroundEntryName: 'background',
    esbuildTarget: ['firefox142'],
  },
}[target];

const apiBaseUrl = (process.env.EXTENSION_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const marketOddsPreview = process.env.EXTENSION_MARKET_ODDS_PREVIEW === 'true';
const apiUrl = new URL(apiBaseUrl);
if (!['http:', 'https:'].includes(apiUrl.protocol)) {
  throw new Error('EXTENSION_API_BASE_URL must use http or https');
}

// Match patterns do not include a port. A host permission such as
// http://127.0.0.1/* covers every port on that host, while the actual fetch
// URL below still keeps its configured development port.
const apiHostPermission = `${apiUrl.protocol}//${apiUrl.hostname}/*`;

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
const outdir = path.join(root, targetConfig.outdir);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await mkdir(path.join(outdir, 'icons'), { recursive: true });

const manifest = JSON.parse(
  await readFile(
    path.join(root, 'manifests', targetConfig.manifest),
    'utf8',
  ),
);
manifest.version = packageJson.version;
manifest.host_permissions = [apiHostPermission];
await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

await Promise.all([
  copyFile(path.join(root, 'src', 'popup.html'), path.join(outdir, 'popup.html')),
  copyFile(path.join(root, 'src', 'popup.css'), path.join(outdir, 'popup.css')),
  copyFile(
    path.join(root, 'src', 'sorare-native.css'),
    path.join(outdir, 'sorare-native.css'),
  ),
  ...[16, 32, 48, 128].map((size) =>
    copyFile(
      path.join(root, 'assets', 'icons', `icon-${size}.png`),
      path.join(outdir, 'icons', `icon-${size}.png`),
    ),
  ),
]);

const buildContext = await context({
  absWorkingDir: root,
  entryPoints: {
    content: 'src/content.ts',
    popup: 'src/popup.ts',
    [targetConfig.backgroundEntryName]: 'src/service-worker.ts',
  },
  outdir,
  entryNames: '[name]',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: targetConfig.esbuildTarget,
  define: {
    __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    __MARKET_ODDS_PREVIEW__: JSON.stringify(marketOddsPreview),
    __EXTENSION_BROWSER__: JSON.stringify(target),
  },
  logLevel: 'info',
  sourcemap: watch,
});

if (watch) {
  await buildContext.watch();
  console.log(
    `Watching ${target} extension sources (backend: ${apiBaseUrl}, market preview: ${marketOddsPreview})`,
  );
} else {
  await buildContext.rebuild();
  await buildContext.dispose();
  console.log(
    `Built ${target} extension in ${targetConfig.outdir} (backend: ${apiBaseUrl}, market preview: ${marketOddsPreview})`,
  );
}
