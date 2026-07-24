const url = process.env.SORARE_GRAPHQL_URL ?? 'https://api.sorare.com/graphql';
const seasonStart =
  process.env.MLS_SEASON_START ?? `${new Date().getUTCFullYear()}-01-01T00:00:00Z`;
const referenceProbability = Number(process.env.REFERENCE_WIN_PROBABILITY ?? 0.46);
// Keeps the anonymous Sorare query below its GraphQL complexity limit.
const pageSize = 20;
const query = `
  query MlsWinProbabilityHistory($first: Int!, $after: String) {
    football {
      competition(slug: "mlspa") {
        displayName
        pastGames(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            date
            homeGoals
            awayGoals
            homeTeam {
              __typename
              ... on Club { slug name }
            }
            awayTeam {
              __typename
              ... on Club { slug name }
            }
            homeStats {
              __typename
              ... on FootballTeamGameStats {
                winOddsBasisPoints
                drawOddsBasisPoints
                loseOddsBasisPoints
              }
            }
            awayStats {
              __typename
              ... on FootballTeamGameStats {
                winOddsBasisPoints
                drawOddsBasisPoints
                loseOddsBasisPoints
              }
            }
          }
        }
      }
    }
  }
`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchPage(after) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'sorare-football-overlay-win-probability-benchmark/0.1',
        ...(process.env.SORARE_API_KEY ? { APIKEY: process.env.SORARE_API_KEY } : {}),
      },
      body: JSON.stringify({ query, variables: { first: pageSize, after } }),
    });
    if (response.status === 429 && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new Error(`Sorare returned HTTP ${response.status}`);
    const envelope = await response.json();
    if (envelope.errors?.length) {
      throw new Error(envelope.errors.map(({ message }) => message).join('; '));
    }
    return envelope.data.football.competition;
  }
  throw new Error('Sorare retry budget exhausted');
}

function normalizeBasisPoints(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value / 10_000 : null;
}

function quantile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function rounded(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(observations) {
  if (observations.length === 0) {
    return {
      sampleSize: 0,
      meanPredicted: null,
      actualWinRate: null,
      brierScore: null,
    };
  }
  return {
    sampleSize: observations.length,
    meanPredicted: rounded(
      observations.reduce((sum, item) => sum + item.winProbability, 0) /
        observations.length,
    ),
    actualWinRate: rounded(
      observations.filter((item) => item.won).length / observations.length,
    ),
    brierScore: rounded(
      observations.reduce(
        (sum, item) => sum + (item.winProbability - Number(item.won)) ** 2,
        0,
      ) / observations.length,
    ),
  };
}

function describeBands(observations, definitions) {
  return definitions.map(({ label, tone, minimum, maximum }) => {
    const members = observations.filter(
      ({ winProbability }) =>
        winProbability >= minimum && winProbability < maximum,
    );
    return {
      label,
      tone,
      minimum: rounded(minimum),
      maximum: rounded(Math.min(1, maximum)),
      ...summarize(members),
    };
  });
}

const games = [];
let after = null;
let competitionName = 'Major League Soccer';
let reachedPreviousSeason = false;
do {
  const competition = await fetchPage(after);
  competitionName = competition.displayName;
  const currentSeasonGames = competition.pastGames.nodes.filter(
    ({ date }) => Date.parse(date) >= Date.parse(seasonStart),
  );
  games.push(...currentSeasonGames);
  reachedPreviousSeason = currentSeasonGames.length < competition.pastGames.nodes.length;
  after =
    !reachedPreviousSeason && competition.pastGames.pageInfo.hasNextPage
      ? competition.pastGames.pageInfo.endCursor
      : null;
  if (after) await sleep(100);
} while (after);

const observations = games.flatMap((game) => {
  const homeTeam =
    game.homeTeam?.__typename === 'Club'
      ? { slug: game.homeTeam.slug, name: game.homeTeam.name }
      : null;
  const awayTeam =
    game.awayTeam?.__typename === 'Club'
      ? { slug: game.awayTeam.slug, name: game.awayTeam.name }
      : null;
  const homeStats =
    game.homeStats?.__typename === 'FootballTeamGameStats' ? game.homeStats : null;
  const awayStats =
    game.awayStats?.__typename === 'FootballTeamGameStats' ? game.awayStats : null;
  return [
    {
      gameId: game.id,
      date: game.date,
      venue: 'home',
      team: homeTeam,
      opponent: awayTeam,
      winProbability: normalizeBasisPoints(homeStats?.winOddsBasisPoints),
      drawProbability: normalizeBasisPoints(homeStats?.drawOddsBasisPoints),
      lossProbability: normalizeBasisPoints(homeStats?.loseOddsBasisPoints),
      won: game.homeGoals > game.awayGoals,
    },
    {
      gameId: game.id,
      date: game.date,
      venue: 'away',
      team: awayTeam,
      opponent: homeTeam,
      winProbability: normalizeBasisPoints(awayStats?.winOddsBasisPoints),
      drawProbability: normalizeBasisPoints(awayStats?.drawOddsBasisPoints),
      lossProbability: normalizeBasisPoints(awayStats?.loseOddsBasisPoints),
      won: game.awayGoals > game.homeGoals,
    },
  ];
});

const quoted = observations.filter(
  (observation) =>
    observation.winProbability !== null &&
    observation.drawProbability !== null &&
    observation.lossProbability !== null,
);
if (quoted.length === 0) throw new Error('No historical MLS match probabilities were returned');

const probabilities = quoted
  .map(({ winProbability }) => winProbability)
  .sort((left, right) => left - right);
const thresholds = {
  p20: quantile(probabilities, 0.2),
  p40: quantile(probabilities, 0.4),
  p60: quantile(probabilities, 0.6),
  p80: quantile(probabilities, 0.8),
  p90: quantile(probabilities, 0.9),
};
const percentileDefinitions = [
  { label: 'P0–20', tone: 'red', minimum: 0, maximum: thresholds.p20 },
  {
    label: 'P20–40',
    tone: 'orange',
    minimum: thresholds.p20,
    maximum: thresholds.p40,
  },
  {
    label: 'P40–60',
    tone: 'yellow',
    minimum: thresholds.p40,
    maximum: thresholds.p60,
  },
  {
    label: 'P60–80',
    tone: 'green',
    minimum: thresholds.p60,
    maximum: thresholds.p80,
  },
  {
    label: 'P80–90',
    tone: 'blue',
    minimum: thresholds.p80,
    maximum: thresholds.p90,
  },
  { label: 'P90–100', tone: 'purple', minimum: thresholds.p90, maximum: 1.000001 },
];
const currentDefinitions = [
  { label: '<30%', tone: 'red', minimum: 0, maximum: 0.3 },
  { label: '30–44%', tone: 'orange', minimum: 0.3, maximum: 0.45 },
  { label: '45–54%', tone: 'yellow', minimum: 0.45, maximum: 0.55 },
  { label: '55–64%', tone: 'green', minimum: 0.55, maximum: 0.65 },
  { label: '65–74%', tone: 'blue', minimum: 0.65, maximum: 0.75 },
  { label: '≥75%', tone: 'purple', minimum: 0.75, maximum: 1.000001 },
];
const favoriteSides = quoted.filter(
  ({ winProbability, lossProbability }) => winProbability > lossProbability,
);
const referencePercentile =
  probabilities.filter((probability) => probability <= referenceProbability).length /
  probabilities.length;
const referenceBand = percentileDefinitions.find(
  ({ minimum, maximum }) =>
    referenceProbability >= minimum && referenceProbability < maximum,
);
const currentReferenceBand = currentDefinitions.find(
  ({ minimum, maximum }) =>
    referenceProbability >= minimum && referenceProbability < maximum,
);

process.stdout.write(
  `${JSON.stringify(
    {
      competition: competitionName,
      competitionSlug: 'mlspa',
      seasonStart,
      through: games[0]?.date ?? null,
      retrievedAt: new Date().toISOString(),
      methodology: {
        prediction: 'Sorare winOddsBasisPoints / 10000 for each team side',
        outcome: 'team goals > opponent goals',
        population: 'home and away team sides in completed MLS matches',
      },
      matches: games.length,
      possibleTeamSides: observations.length,
      quotedTeamSides: quoted.length,
      oddsCoverage: rounded(quoted.length / observations.length),
      overall: summarize(quoted),
      home: summarize(quoted.filter(({ venue }) => venue === 'home')),
      away: summarize(quoted.filter(({ venue }) => venue === 'away')),
      favorites: summarize(favoriteSides),
      distribution: {
        min: rounded(probabilities[0]),
        p10: rounded(quantile(probabilities, 0.1)),
        p20: rounded(thresholds.p20),
        p40: rounded(thresholds.p40),
        median: rounded(quantile(probabilities, 0.5)),
        p60: rounded(thresholds.p60),
        p80: rounded(thresholds.p80),
        p90: rounded(thresholds.p90),
        max: rounded(probabilities.at(-1)),
      },
      reference: {
        probability: referenceProbability,
        percentileRank: rounded(referencePercentile),
        currentBand: currentReferenceBand?.label ?? null,
        currentTone: currentReferenceBand?.tone ?? null,
        percentileBand: referenceBand?.label ?? null,
        percentileTone: referenceBand?.tone ?? null,
      },
      currentFixedBands: describeBands(quoted, currentDefinitions),
      proposedPercentileBands: describeBands(quoted, percentileDefinitions),
    },
    null,
    2,
  )}\n`,
);
