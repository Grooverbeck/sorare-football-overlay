import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EUROPEAN_MARKET_BENCHMARKS as frozen } from '@sorare-overlay/shared';
import { LEAGUES, POSITIONS } from './lib/european-market-calibration.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node --import tsx verify-european-market-benchmarks.mjs EXPORT_DIRECTORY');
const { summary } = JSON.parse(await readFile(resolve(directory, 'analysis.json'), 'utf8'));
assert.equal(summary.historicalSource, 'independent-stratified-roster-sample');
for (const source of ['market', 'historical']) for (const market of ['goal', 'assist']) {
  for (const position of POSITIONS) {
    const row = summary[source][market][position];
    assert.deepEqual(frozen[source][market][position], row.rounded, `${source}/${market}/${position}`);
    assert.ok(row.samples >= (source === 'market' ? 400 : 80), 'Insufficient position coverage');
    for (const league of LEAGUES) assert.ok(row.byLeague[league] >= (source === 'market' ? 50 : 15), 'Insufficient league coverage');
  }
  if (source === 'market') assert.equal(frozen.market.samples[market], POSITIONS.reduce((n, position) => n + summary.market[market][position].samples, 0));
}
assert.equal(frozen.historical.eligiblePlayers, summary.historicalPlayers);
console.log('All 60 cut points exactly match the measured, rounded European reference. Coverage gates passed.');
