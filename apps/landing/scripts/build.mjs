import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(appRoot, 'dist');

await rm(distDir, { force: true, recursive: true });
await mkdir(distDir, { recursive: true });
await cp(resolve(appRoot, 'src'), distDir, { recursive: true });
await cp(resolve(appRoot, 'public'), distDir, { recursive: true });

console.log(`Landingpage built in ${distDir}`);
