import 'dotenv/config';
import { context } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const apiBaseUrl = (process.env.EXTENSION_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const apiUrl = new URL(apiBaseUrl);
if (!['http:', 'https:'].includes(apiUrl.protocol)) {
  throw new Error('EXTENSION_API_BASE_URL must use http or https');
}

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
const outdir = path.join(root, 'dist');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await mkdir(path.join(outdir, 'icons'), { recursive: true });

const manifest = {
  manifest_version: 3,
  name: 'Sorare Football Stats Overlay – Unofficial',
  version: packageJson.version,
  description: 'Unofficial overlay showing position-aware football metrics on Sorare cards.',
  permissions: ['storage'],
  host_permissions: [`${apiUrl.origin}/*`],
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  background: { service_worker: 'service-worker.js' },
  content_scripts: [
    {
      matches: ['https://sorare.com/*', 'https://www.sorare.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    },
  ],
  action: {
    default_title: 'Sorare Football Stats Overlay',
    default_popup: 'popup.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
    },
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
};
await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await Promise.all([
  copyFile(path.join(root, 'src', 'popup.html'), path.join(outdir, 'popup.html')),
  copyFile(path.join(root, 'src', 'popup.css'), path.join(outdir, 'popup.css')),
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
    'service-worker': 'src/service-worker.ts',
  },
  outdir,
  entryNames: '[name]',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  define: {
    __API_BASE_URL__: JSON.stringify(apiBaseUrl),
  },
  logLevel: 'info',
  sourcemap: watch,
});

if (watch) {
  await buildContext.watch();
  console.log(`Watching extension sources (backend: ${apiBaseUrl})`);
} else {
  await buildContext.rebuild();
  await buildContext.dispose();
  console.log(`Built extension in dist (backend: ${apiBaseUrl})`);
}
