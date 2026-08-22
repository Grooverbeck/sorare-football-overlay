import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(appRoot, 'src');
const publicRoot = resolve(appRoot, 'public');
const portFlag = process.argv.indexOf('--port');
const requestedPort = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4173;
const port = Number.isInteger(requestedPort) ? requestedPort : 4173;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function safePath(root, pathname) {
  const target = resolve(root, `.${pathname}`);
  return target === root || target.startsWith(`${root}${sep}`) ? target : null;
}

async function findFile(pathname) {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const roots = normalized.startsWith('/assets/') ? [publicRoot] : [sourceRoot, publicRoot];

  for (const root of roots) {
    const candidate = safePath(root, normalized);
    if (!candidate) continue;
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next root.
    }
  }

  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const file = await findFile(decodeURIComponent(url.pathname));

  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${port}/`);
});
