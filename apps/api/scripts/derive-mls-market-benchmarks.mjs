import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizePlayerName,
  normalizeTeamName,
  playerNameMatchScore,
} from '../src/providers/market-odds-provider.ts';

const namespaceId = process.env.MARKET_KV_NAMESPACE_ID;
if (!namespaceId) {
  throw new Error('MARKET_KV_NAMESPACE_ID is required.');
}

const sorareUrl =
  process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql';
const wranglerExecutable = process.execPath;
const wranglerScript = join(
  process.cwd(),
  'node_modules',
  'wrangler',
  'bin',
  'wrangler.js',
);
const marketPrefix = 'market-odds:v1:';
const marketKinds = new Map([
  ['player_goal_scorer_anytime', 'goal'],
  ['player_assists', 'assist'],
]);
const positions = ['Defender', 'Midfielder', 'Forward'];

function wranglerJson(args) {
  const output = execFileSync(
    wranglerExecutable,
    [wranglerScript, ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return JSON.parse(output);
}

function loadStoredMarketEntries() {
  const keys = wranglerJson([
    'kv',
    'key',
    'list',
    '--namespace-id',
    namespaceId,
    '--prefix',
    marketPrefix,
    '--remote',
  ]).map(({ name }) => name);
  if (keys.length === 0) return [];

  const directory = mkdtempSync(join(tmpdir(), 'sorare-market-benchmarks-'));
  const filename = join(directory, 'keys.json');
  try {
    writeFileSync(filename, JSON.stringify(keys));
    const values = wranglerJson([
      'kv',
      'bulk',
      'get',
      filename,
      '--namespace-id',
      namespaceId,
      '--remote',
    ]);
    return Object.entries(values).flatMap(([key, serialized]) => {
      if (!serialized) return [];
      const snapshot = JSON.parse(serialized);
      if (snapshot.status !== 'available') return [];
      const separator = key.lastIndexOf(':');
      const fixtureKey = decodeURIComponent(
        key.slice(marketPrefix.length, separator),
      );
      const [, homeTeam, awayTeam] = fixtureKey.split('|');
      const market = marketKinds.get(snapshot.market);
      if (!homeTeam || !awayTeam || !market) return [];
      return Object.entries(snapshot.players).flatMap(
        ([playerName, probability]) =>
          normalizePlayerName(playerName) === 'no scorer'
            ? []
            : [{
                playerName,
                probability: probability.probability,
                bookmakerCount: probability.bookmakerCount,
                market,
                homeTeam,
                awayTeam,
              }],
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

const rosterQuery = `
  query MlsMarketBenchmarkRoster($first: Int!, $after: String) {
    football {
      competition(slug: "mlspa") {
        orderedPlayers(first: $first, after: $after, limit: LAST_10) {
          pageInfo { hasNextPage endCursor }
          nodes {
            slug
            displayName
            position
            cardPositions
            activeClub { shortName }
          }
        }
      }
    }
  }
`;

async function loadMlsRoster() {
  const players = [];
  let after = null;
  do {
    const envelope = await fetchJson(sorareUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'sorare-football-overlay-market-benchmarks/0.1',
      },
      body: JSON.stringify({
        query: rosterQuery,
        variables: { first: 30, after },
      }),
    });
    if (envelope.errors?.length) {
      throw new Error(envelope.errors.map(({ message }) => message).join('; '));
    }
    const connection = envelope.data?.football?.competition?.orderedPlayers;
    if (!connection) throw new Error('Sorare MLS roster is unavailable.');
    players.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);
  return players;
}

function resolveRosterPlayer(entry, roster) {
  const fixtureTeams = new Set([
    normalizeTeamName(entry.homeTeam),
    normalizeTeamName(entry.awayTeam),
  ]);
  const fixtureRoster = roster.filter(
    (player) =>
      player.activeClub?.shortName &&
      fixtureTeams.has(normalizeTeamName(player.activeClub.shortName)),
  );
  const candidates = fixtureRoster
    .map((player) => ({
      player,
      score: playerNameMatchScore(player.displayName, entry.playerName),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (
    !best ||
    candidates.filter(({ score }) => score === best.score).length !== 1
  ) {
    return null;
  }
  return best.player;
}

function quantile(values, percentile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}

function roundedProbability(value) {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
}

const [entries, roster] = await Promise.all([
  Promise.resolve(loadStoredMarketEntries()),
  loadMlsRoster(),
]);
const unresolved = [];
const resolved = entries.flatMap((entry) => {
  const player = resolveRosterPlayer(entry, roster);
  if (!player) {
    unresolved.push(entry.playerName);
    return [];
  }
  return [{
    ...entry,
    slug: player.slug,
    position: player.cardPositions?.[0] ?? player.position,
  }];
});

const decisiveByPlayer = new Map();
for (const entry of resolved) {
  const key = `${entry.homeTeam}|${entry.awayTeam}|${entry.slug}`;
  const combined = decisiveByPlayer.get(key) ?? {
    position: entry.position,
    goal: null,
    assist: null,
  };
  combined[entry.market] = entry.probability;
  decisiveByPlayer.set(key, combined);
}
const decisive = [...decisiveByPlayer.values()].flatMap((entry) =>
  entry.goal === null || entry.assist === null
    ? []
    : [{
        market: 'decisive',
        position: entry.position,
        probability: 1 - (1 - entry.goal) * (1 - entry.assist),
      }],
);
const benchmarkEntries = [...resolved, ...decisive];

const result = Object.fromEntries(
  ['goal', 'assist', 'decisive'].map((market) => [
    market,
    Object.fromEntries(
      positions.map((position) => {
        const values = benchmarkEntries
          .filter(
            (entry) =>
              entry.market === market && entry.position === position,
          )
          .map(({ probability }) => probability);
        return [
          position,
          {
            sampleSize: values.length,
            p20: roundedProbability(quantile(values, 0.2)),
            p40: roundedProbability(quantile(values, 0.4)),
            p60: roundedProbability(quantile(values, 0.6)),
            p80: roundedProbability(quantile(values, 0.8)),
            p90: roundedProbability(quantile(values, 0.9)),
          },
        ];
      }),
    ),
  ]),
);

console.log(JSON.stringify({
  snapshots: entries.length,
  matched: resolved.length,
  unresolved: [...new Set(unresolved)].sort(),
  bands: result,
}, null, 2));
