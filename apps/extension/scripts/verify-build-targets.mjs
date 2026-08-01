import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const targets = [
  {
    name: 'Chromium',
    directory: 'dist',
    backgroundFile: 'service-worker.js',
    manifestCheck(manifest) {
      if (manifest.background?.service_worker !== 'service-worker.js') {
        throw new Error('Chromium manifest must use service-worker.js');
      }
      if (manifest.background?.scripts) {
        throw new Error('Chromium manifest must not use background.scripts');
      }
      if (manifest.browser_specific_settings) {
        throw new Error('Chromium manifest must not contain Gecko settings');
      }
    },
  },
  {
    name: 'Firefox',
    directory: 'dist-firefox',
    backgroundFile: 'background.js',
    manifestCheck(manifest) {
      if (!manifest.background?.scripts?.includes('background.js')) {
        throw new Error('Firefox manifest must use background.scripts');
      }
      if (manifest.background?.service_worker) {
        throw new Error('Firefox manifest must not use background.service_worker');
      }
      if (!manifest.browser_specific_settings?.gecko?.id) {
        throw new Error('Firefox manifest must define a Gecko extension ID');
      }
      if (
        manifest.browser_specific_settings.gecko.strict_min_version !== '142.0'
      ) {
        throw new Error('Firefox manifest must require Firefox 142 or newer');
      }
    },
  },
];

for (const target of targets) {
  const outputDirectory = path.join(root, target.directory);
  const manifest = JSON.parse(
    await readFile(path.join(outputDirectory, 'manifest.json'), 'utf8'),
  );
  target.manifestCheck(manifest);
  for (const file of [
    target.backgroundFile,
    'content.js',
    'popup.js',
    'popup.html',
    'popup.css',
    'sorare-native.css',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
  ]) {
    await readFile(path.join(outputDirectory, file));
  }
  console.log(`${target.name} build verified: ${outputDirectory}`);
}
