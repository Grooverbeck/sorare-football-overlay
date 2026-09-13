// Public roster metadata, not a user's collection. No odds-provider requests.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SorareGraphqlClient } from '../dist/graphql/client.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node --env-file=apps/api/.dev.vars export-european-benchmark-roster.mjs OUTPUT_DIRECTORY');
const leagues = ['premier-league-gb-eng', 'bundesliga-de', 'laliga-es', 'ligue-1-fr'];
const client = new SorareGraphqlClient({
  url: process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql',
  apiKey: process.env.SORARE_API_KEY, authToken: process.env.SORARE_AUTH_TOKEN,
  jwtAud: process.env.SORARE_JWT_AUD, requestTimeoutMs: 30000, maxRetries: 1,
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
});
const query = `query EuropeanBenchmarkRoster($league: String!, $after: String) {
  football { competition(slug: $league) {
    slug
    orderedPlayers(first: 100, after: $after, limit: LAST_15) {
      pageInfo { hasNextPage endCursor }
      nodes { slug displayName position cardPositions
        activeClub { slug name shortName domesticLeague { slug } }
        commonPlayer(rarity: common) { positions anyTeam { slug } }
      }
    }
  } }
}`;
await mkdir(resolve(output), { recursive: true });
for (const league of leagues) {
  const path = resolve(output, `roster-${league}.json`);
  const previous = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.complete) { console.log(`${league}: reuse ${previous.players.length}`); continue; }
  let after = previous?.after ?? null;
  const players = previous?.players ?? [];
  for (let page = 0; page < 40; page++) {
    try {
      const data = await client.request(query, { league, after });
      const connection = data.football?.competition?.orderedPlayers;
      if (!connection) throw new Error('Missing roster');
      players.push(...connection.nodes);
      const complete = !connection.pageInfo.hasNextPage;
      const next = connection.pageInfo.endCursor;
      if (!complete && (!next || next === after)) throw new Error('Non-advancing cursor');
      after = next;
      await writeFile(path, JSON.stringify({ exportedAt: new Date().toISOString(), league, players, after, complete }));
      console.log(`${league}: ${players.length}${complete ? ' complete' : ''}`);
      if (complete) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch (error) {
      // Client errors are sanitized; never serialize headers or environment.
      console.error(`${league}: ${error.code ?? 'ROSTER_EXPORT_FAILED'} ${error.message}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode) break;
}
