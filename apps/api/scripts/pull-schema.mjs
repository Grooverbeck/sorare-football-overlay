import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = 'https://api.sorare.com/graphql/schema';
const response = await fetch(source, { headers: { accept: 'text/plain' } });
if (!response.ok) throw new Error(`Schema download failed: HTTP ${response.status}`);

const schema = await response.text();
const retrievedAt = new Date().toISOString();
const date = retrievedAt.slice(0, 10);
const file = `sorare-${date}.graphql`;
const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const sha256 = createHash('sha256').update(schema).digest('hex');

await writeFile(path.join(schemaDir, file), schema, 'utf8');
await writeFile(
  path.join(schemaDir, 'schema.lock.json'),
  `${JSON.stringify({ source, retrievedAt, file, sha256 }, null, 2)}\n`,
  'utf8',
);
console.log(`Saved ${file} (${sha256})`);
