import 'dotenv/config';
import { context } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const apiBaseUrl = (process.env.EXTENSION_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const apiUrl = new URL(apiBaseUrl);
if (!['http:', 'https:'].includes(apiUrl.protocol)) {
  throw new Error('EXTENSION_API_BASE_URL must use http or https');
}

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'dist');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const manifest = {
  manifest_version: 3,
  name: 'Sorare Football Stats Overlay',
  version: '0.2.0',
  description: 'Shows position-aware L10 metrics on Sorare football cards.',
  permissions: ['storage'],
  host_permissions: [`${apiUrl.origin}/*`],
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
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
};
await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await Promise.all([
  copyFile(path.join(root, 'src', 'popup.html'), path.join(outdir, 'popup.html')),
  copyFile(path.join(root, 'src', 'popup.css'), path.join(outdir, 'popup.css')),
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
  sourcemap: true,
});

if (watch) {
  await buildContext.watch();
  console.log(`Watching extension sources (backend: ${apiBaseUrl})`);
} else {
  await buildContext.rebuild();
  await buildContext.dispose();
  console.log(`Built extension in dist (backend: ${apiBaseUrl})`);
}
