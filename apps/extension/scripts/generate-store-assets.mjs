import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const iconSourcePath = path.join(root, 'assets', 'icons', 'icon.svg');
const iconOutputDir = path.join(root, 'assets', 'icons');
const storeAssetsDir = path.join(root, 'store-assets');
const screenshotSourcePath = path.join(storeAssetsDir, 'source', 'sorare-card-grid.png');

await Promise.all([
  mkdir(iconOutputDir, { recursive: true }),
  mkdir(storeAssetsDir, { recursive: true }),
]);

const iconSvg = await readFile(iconSourcePath);
await Promise.all(
  [16, 32, 48, 128].map((size) =>
    sharp(iconSvg)
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(path.join(iconOutputDir, `icon-${size}.png`)),
  ),
);

await sharp(iconSvg)
  .resize(128, 128)
  .png({ compressionLevel: 9 })
  .toFile(path.join(storeAssetsDir, 'store-icon-128.png'));

const screenshotFrame = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#172433"/>
        <stop offset=".48" stop-color="#0a1017"/>
        <stop offset="1" stop-color="#05080c"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop stop-color="#a855f7"/>
        <stop offset=".45" stop-color="#3b82f6"/>
        <stop offset="1" stop-color="#22c55e"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="150%" height="160%">
        <feDropShadow dx="0" dy="22" stdDeviation="24" flood-color="#000" flood-opacity=".55"/>
      </filter>
    </defs>
    <rect width="1280" height="800" fill="url(#bg)"/>
    <circle cx="130" cy="690" r="260" fill="#3b82f6" opacity=".07"/>
    <circle cx="390" cy="60" r="220" fill="#a855f7" opacity=".08"/>
    <rect x="48" y="50" width="84" height="8" rx="4" fill="url(#accent)"/>
    <text x="48" y="118" fill="#fff" font-family="Arial, sans-serif" font-size="44" font-weight="800">Mehr Kontext.</text>
    <text x="48" y="167" fill="#fff" font-family="Arial, sans-serif" font-size="44" font-weight="800">Auf jeder Karte.</text>
    <text x="48" y="211" fill="#9fb0c1" font-family="Arial, sans-serif" font-size="19">
      Inoffizielles Football-Stats-Overlay
    </text>
    <text x="48" y="239" fill="#9fb0c1" font-family="Arial, sans-serif" font-size="19">
      für sorare.com
    </text>
    <g transform="translate(48 278)">
      <rect width="174" height="76" rx="14" fill="#101923" stroke="#a855f7" stroke-width="2"/>
      <text x="18" y="29" fill="#aebdca" font-family="Arial, sans-serif" font-size="16" font-weight="700">AA L10</text>
      <text x="18" y="60" fill="#fff" font-family="Arial, sans-serif" font-size="28" font-weight="800">14.8</text>
    </g>
    <g transform="translate(238 278)">
      <rect width="174" height="76" rx="14" fill="#101923" stroke="#22c55e" stroke-width="2"/>
      <text x="18" y="29" fill="#aebdca" font-family="Arial, sans-serif" font-size="16" font-weight="700">NEXT W%</text>
      <text x="18" y="60" fill="#fff" font-family="Arial, sans-serif" font-size="28" font-weight="800">57</text>
    </g>
    <g fill="#dce7f0" font-family="Arial, sans-serif" font-size="22" font-weight="700">
      <text x="48" y="425">• MLS-Perzentile nach Position</text>
      <text x="48" y="472">• Next W% oder Next CS%</text>
      <text x="48" y="519">• Quoten, Samples und Rang</text>
      <text x="48" y="566">• Tooltips bei Mouseover</text>
    </g>
    <rect x="48" y="649" width="364" height="66" rx="18" fill="#111a24" stroke="#2b3c4d"/>
    <text x="76" y="688" fill="#fff" font-family="Arial, sans-serif" font-size="20" font-weight="800">
      Daten sehen, ohne Sorare zu verlassen
    </text>
    <rect x="516" y="36" width="722" height="728" rx="24" fill="#0d131b" stroke="#33475a" filter="url(#shadow)"/>
  </svg>
`);

const framedScreenshot = await sharp(screenshotSourcePath)
  .resize(694, 700, { fit: 'cover', position: 'top' })
  .png()
  .toBuffer();

await sharp(screenshotFrame)
  .composite([{ input: framedScreenshot, left: 530, top: 50 }])
  .png({ compressionLevel: 9 })
  .toFile(path.join(storeAssetsDir, 'screenshot-1-1280x800.png'));

const promoFrame = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="440" height="280">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#182636"/>
        <stop offset="1" stop-color="#06090e"/>
      </linearGradient>
      <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
        <stop stop-color="#a855f7"/>
        <stop offset=".5" stop-color="#3b82f6"/>
        <stop offset="1" stop-color="#22c55e"/>
      </linearGradient>
    </defs>
    <rect width="440" height="280" fill="url(#bg)"/>
    <circle cx="390" cy="42" r="145" fill="#a855f7" opacity=".10"/>
    <circle cx="38" cy="260" r="150" fill="#22c55e" opacity=".08"/>
    <rect x="150" y="39" width="246" height="7" rx="3.5" fill="url(#line)"/>
    <text x="150" y="91" fill="#fff" font-family="Arial, sans-serif" font-size="29" font-weight="800">Football Stats</text>
    <text x="150" y="125" fill="#fff" font-family="Arial, sans-serif" font-size="29" font-weight="800">Overlay</text>
    <text x="150" y="163" fill="#aebdca" font-family="Arial, sans-serif" font-size="18">AA · Quoten · Kontext</text>
    <text x="150" y="197" fill="#7f93a7" font-family="Arial, sans-serif" font-size="15">Inoffiziell für sorare.com</text>
    <g transform="translate(150 220)">
      <rect width="76" height="30" rx="8" fill="#101923" stroke="#a855f7"/>
      <text x="12" y="20" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="800">AA 14.8</text>
    </g>
    <g transform="translate(236 220)">
      <rect width="76" height="30" rx="8" fill="#101923" stroke="#22c55e"/>
      <text x="12" y="20" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="800">W% 57</text>
    </g>
  </svg>
`);

const promoIcon = await sharp(iconSvg).resize(104, 104).png().toBuffer();
await sharp(promoFrame)
  .composite([{ input: promoIcon, left: 27, top: 77 }])
  .png({ compressionLevel: 9 })
  .toFile(path.join(storeAssetsDir, 'small-promo-tile-440x280.png'));

console.log(`Generated extension and Chrome Web Store assets in ${storeAssetsDir}`);
