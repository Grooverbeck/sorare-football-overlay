import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createZip, listFiles } from './zip.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(root, '..', '..');
const distDir = path.join(root, 'dist-firefox');
const artifactsDir = path.join(workspaceRoot, 'artifacts');
const productionApiUrl =
  process.env.EXTENSION_API_BASE_URL ??
  'https://sorare-football-overlay-api.grooverbeck.workers.dev';

function runNode(script, args = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} exited with code ${code}`));
    });
  });
}

await runNode(path.join(import.meta.dirname, 'build.mjs'), ['--target', 'firefox'], {
  ...process.env,
  EXTENSION_API_BASE_URL: productionApiUrl,
});

const files = await listFiles(distDir);
const manifestEntry = files.find((file) => file.name === 'manifest.json');
if (!manifestEntry) throw new Error('Firefox package has no root manifest.json');
const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
if (!manifest.browser_specific_settings?.gecko?.id) {
  throw new Error('Firefox package has no browser_specific_settings.gecko.id');
}
if (manifest.browser_specific_settings.gecko.strict_min_version !== '140.0') {
  throw new Error('Firefox package must require Firefox 140 or newer');
}
if (
  manifest.browser_specific_settings.gecko_android?.strict_min_version !==
  '142.0'
) {
  throw new Error('Firefox Android package must require Firefox 142 or newer');
}
if (
  JSON.stringify(
    manifest.browser_specific_settings.gecko.data_collection_permissions?.required,
  ) !== JSON.stringify(['websiteContent'])
) {
  throw new Error('Firefox package must declare websiteContent data collection');
}
if (!manifest.background?.scripts?.includes('background.js')) {
  throw new Error('Firefox package must use background.scripts');
}
if (manifest.background.service_worker) {
  throw new Error('Firefox package must not use background.service_worker');
}
if (files.some((file) => file.name.endsWith('.map'))) {
  throw new Error('Firefox package must not contain source maps');
}

await mkdir(artifactsDir, { recursive: true });
const outputPath = path.join(
  artifactsDir,
  `sorare-football-overlay-firefox-${manifest.version}-unsigned.zip`,
);
await writeFile(outputPath, createZip(files));
console.log(`Created unsigned Firefox package: ${outputPath}`);
