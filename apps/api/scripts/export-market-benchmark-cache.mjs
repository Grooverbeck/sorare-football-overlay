// Offline calibration input only. All remote statements are bounded SELECTs;
// this script neither changes production caches nor calls odds providers.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node export-market-benchmark-cache.mjs OUTPUT.json');
const groups = {
  markets: "cache_key GLOB 'market-odds:v1:*' AND json_extract(value, '$.status') = 'available'",
  forms: "cache_key GLOB 'player-form:v3:*'",
  fixtures: "cache_key GLOB 'player-fixture:v1:*' OR cache_key GLOB 'player-team-fixture:v2:*'",
};
const data = { exportedAt: new Date().toISOString(), groups: {} };
for (const [name, condition] of Object.entries(groups)) {
  const sql = `SELECT cache_key, value, updated_at, expires_at FROM cache_entries WHERE (${condition}) ORDER BY cache_key LIMIT 10001`;
  const raw = execFileSync(process.execPath, [
    resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute',
    'sorare-overlay-cache', '--remote', '--config', 'apps/api/wrangler.jsonc',
    '--command', sql, '--json',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const envelopes = JSON.parse(raw);
  if (envelopes.some(result => !result.success)) throw new Error(`D1 SELECT failed: ${name}`);
  const rows = envelopes.flatMap(result => result.results);
  if (rows.length > 10000) throw new Error(`Export bound exceeded: ${name}`);
  data.groups[name] = rows.map(({ value, ...row }) => ({ ...row, value: JSON.parse(value) }));
  console.log(JSON.stringify({ group: name, entries: rows.length, rowsRead: envelopes.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0) }));
}
const output = resolve(destination);
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(data));
console.log(`Saved read-only cache export to ${output}`);
