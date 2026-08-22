import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(appRoot, 'src/index.html'), 'utf8');
const css = await readFile(resolve(appRoot, 'src/styles.css'), 'utf8');

test('contains the required product, installation, trust, and FAQ content', () => {
  const requiredPhrases = [
    'AA L10',
    'mindestens 60 Minuten',
    'Tor- und Assist',
    'Clean-Sheet-Wahrscheinlichkeit',
    'Sieg, Remis und Niederlage',
    'Startelfwahrscheinlichkeit',
    'Compact View',
    'Torquote oder AA',
    'Keine eigenen API-Schlüssel',
    'Keine Sorare-Zugangsdaten',
    'chrome://extensions',
    'edge://extensions',
    'Funktioniert die Extension automatisch?',
    'Werden meine Sorare-Zugangsdaten übertragen?',
  ];

  for (const phrase of requiredPhrases) {
    assert.ok(html.includes(phrase), `missing required phrase: ${phrase}`);
  }
});

test('uses the durable latest-release and installation links', () => {
  assert.match(
    html,
    /https:\/\/github\.com\/Grooverbeck\/sorare-football-overlay\/releases\/latest/,
  );
  assert.match(
    html,
    /https:\/\/github\.com\/Grooverbeck\/sorare-football-overlay\/blob\/main\/docs\/INSTALLATION\.md/,
  );
});

test('keeps every rendered image local and supplies alt text', async () => {
  const imageTags = [...html.matchAll(/<img\s+[^>]*>/g)].map(([tag]) => tag);
  assert.ok(imageTags.length >= 8, 'expected product and brand imagery');

  for (const tag of imageTags) {
    assert.match(tag, /\salt="[^"]*"/, `missing alt attribute: ${tag}`);
    const source = tag.match(/\ssrc="([^"]+)"/)?.[1];
    assert.ok(source, `missing src attribute: ${tag}`);
    assert.ok(source.startsWith('/assets/'), `non-local image source: ${source}`);
    await access(resolve(appRoot, 'public', source.slice(1)));
  }
});

test('ships complete social-preview metadata and an optimized image', async () => {
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, /property="og:image" content="\/assets\/og\.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);

  const socialImage = await stat(resolve(appRoot, 'public/assets/og.png'));
  assert.ok(socialImage.size < 1_500_000, 'social preview should stay below 1.5 MB');
});

test('keeps product screenshots lightweight and includes reduced-motion support', async () => {
  const screenshots = [
    'lineup-builder-live.webp',
    'messi-card-live.webp',
    'defender-forward-live.webp',
    'sort-menu.webp',
  ];

  for (const screenshot of screenshots) {
    const file = await stat(resolve(appRoot, 'public/assets/screenshots', screenshot));
    assert.ok(file.size < 500_000, `${screenshot} should stay below 500 KB`);
  }

  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

test('does not overstate unavailable or private-data behavior', () => {
  assert.match(html, /Tor-oder-Assistquote wird im aktuellen Overlay nicht/);
  assert.match(html, /Das Overlay berechnet dafür keine eigene Prognose/);
  assert.match(html, /Öffentliche Spieler- und Kartenangaben/);
  assert.doesNotMatch(html, /keine Datenübertragung/i);
});
