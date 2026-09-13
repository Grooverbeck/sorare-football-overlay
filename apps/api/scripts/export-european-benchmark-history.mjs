// Deterministic public-roster sample; read-only Sorare requests and local output.
// Reuses the production history loader/calculations; no odds-provider requests.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SorareDataSource } from '../dist/graphql/sorare-data-source.js';
import { SorareGraphqlClient } from '../dist/graphql/client.js';
import { calculateHistoricalGoalMetrics, calculateHistoricalAssistMetrics } from '@sorare-overlay/shared';
import { LEAGUES, POSITIONS, buildRoster } from './lib/european-market-calibration.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node --import tsx --env-file=apps/api/.dev.vars export-european-benchmark-history.mjs EXPORT_DIRECTORY');
const exports = await Promise.all(LEAGUES.map(async league => JSON.parse(await readFile(resolve(directory, `roster-${league}.json`), 'utf8'))));
const roster = buildRoster(exports);
const seed = 'european-set-history-v1-2026-09-13';
const hash = slug => createHash('sha256').update(`${seed}|${slug}`).digest('hex');
const sample = LEAGUES.flatMap(league => POSITIONS.flatMap(position =>
  [...roster.values()].filter(p => p.league === league && p.positions.includes(position))
    .sort((a, b) => hash(a.slug).localeCompare(hash(b.slug))).slice(0, 30)
    .map(p => ({ slug: p.slug, position, league, teamSlug: p.activeClub.slug })),
));
const path = resolve(directory, 'history-sample.json');
const saved = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
if (saved && saved.seed !== seed) throw new Error('Different sample seed in checkpoint');
const rows = saved?.rows ?? [];
let requests = saved?.requests ?? 0, throttled = false;
const client = new SorareGraphqlClient({
  url: process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql',
  apiKey: process.env.SORARE_API_KEY, authToken: process.env.SORARE_AUTH_TOKEN,
  jwtAud: process.env.SORARE_JWT_AUD, requestTimeoutMs: 20000, maxRetries: 0,
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  fetchImpl: async (...args) => {
    if (throttled || requests >= 1100) throw new Error('Read-only history request budget exhausted');
    requests++;
    const response = await fetch(...args);
    if (response.status === 429) throttled = true;
    return response;
  },
});
const source = new SorareDataSource(client, 2, false);
const completed = new Set(rows.map(row => `${row.slug}|${row.position}`));
const pending = sample.filter(row => !completed.has(`${row.slug}|${row.position}`));
for (let i = 0; i < pending.length; i += 2) {
  const batch = pending.slice(i, i + 2);
  try {
    const result = await source.fetchPlayers(batch.map(p => ({ ...p, includeHistoricalAssists: true })));
    for (const player of result) {
      const target = batch.find(p => p.slug === player.slug && p.position === player.position);
      if (!target || player.historyStatus !== 'complete') throw new Error('Incomplete history; checkpoint retained');
      rows.push({ ...target, displayName: player.displayName,
        historicalGoals: calculateHistoricalGoalMetrics(player.appearances, player.position, true),
        historicalAssists: calculateHistoricalAssistMetrics(player.appearances, player.position, true),
        capturedAt: new Date().toISOString(),
      });
    }
    if (result.length !== batch.length) throw new Error('Missing player history');
    await writeFile(path, JSON.stringify({ seed, selection: sample, requests, rows, complete: rows.length === sample.length }));
    if (i % 20 === 0 || i + 2 >= pending.length) console.log(JSON.stringify({ completed: rows.length, total: sample.length, requests }));
    if (throttled) throw new Error('Sorare throttled; stopping');
    await new Promise(resolve => setTimeout(resolve, 300));
  } catch (error) {
    await writeFile(path, JSON.stringify({ seed, selection: sample, requests, rows, complete: false }));
    console.error(error.code ?? error.message);
    process.exitCode = 1;
    break;
  }
}
