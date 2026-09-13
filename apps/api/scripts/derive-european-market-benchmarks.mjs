// Reads frozen local exports only. This command never accesses the network.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LEAGUES, buildRoster, deriveMarkets, deriveHistory, deriveHistorySample, summarize } from './lib/european-market-calibration.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node --import tsx derive-european-market-benchmarks.mjs EXPORT_DIRECTORY [FROM] [TO]');
const from = process.argv[3] ?? '2026-08-30T00:00:00Z';
const to = process.argv[4] ?? '2026-09-14T00:00:00Z';
const raw = await readFile(resolve(directory, 'cache.json'), 'utf8');
const cache = JSON.parse(raw);
const exports = await Promise.all(LEAGUES.map(async league => JSON.parse(await readFile(resolve(directory, `roster-${league}.json`), 'utf8'))));
const roster = buildRoster(exports);
const market = deriveMarkets(cache, roster, { from, to });
const historyExport = await readFile(resolve(directory, 'history-sample.json'), 'utf8').then(JSON.parse).catch(() => null);
const history = historyExport?.complete ? deriveHistorySample(historyExport, roster) : deriveHistory(cache, roster);
const summary = {
  asOf: cache.exportedAt, from, to,
  cacheSha256: createHash('sha256').update(raw).digest('hex'),
  rosterSha256: createHash('sha256').update(JSON.stringify(exports)).digest('hex'),
  roster: roster.size,
  historicalSource: historyExport?.complete ? 'independent-stratified-roster-sample' : 'cached-subset-diagnostic-only',
  historicalSampleSeed: historyExport?.complete ? historyExport.seed : null,
  historySha256: historyExport?.complete ? createHash('sha256').update(JSON.stringify(historyExport)).digest('hex') : null,
  clubs: Object.fromEntries(LEAGUES.map(league => [league, new Set([...roster.values()].filter(p => p.league === league).map(p => p.activeClub.slug)).size])),
  market: summarize(market.rows), historical: summarize(history),
  fixtureDates: Object.fromEntries([...new Set(market.rows.map(r => r.date.slice(0, 10)))].sort().map(date => [date, new Set(market.rows.filter(r => r.date.startsWith(date)).map(r => r.fixture)).size])),
  rejected: market.rejected, unresolvedCount: market.unresolved.length,
  historicalPlayers: new Set(history.map(r => r.slug)).size,
};
await writeFile(resolve(directory, 'analysis.json'), JSON.stringify({ summary, marketRows: market.rows, historicalRows: history, unresolved: market.unresolved }, null, 2));
console.log(JSON.stringify(summary, null, 2));
